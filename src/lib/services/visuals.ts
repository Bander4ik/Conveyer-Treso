import fs from "fs";
import path from "path";
import { getNumber, getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { pLimit } from "../plimit";
import { ensureDir } from "../paths";
import { buildImagePrompt, generateAiImagePool, type PoolPrompt } from "./image-gen";
import { framesToVideoFile } from "./genaipro";
import { acquireFootage } from "./footage";
import type { Scene } from "./scenes";

/** A resolved per-scene visual: a still (Ken-Burns at render) or a video clip. */
export type VisualKind = "still" | "video";
export interface VisualAsset {
  kind: VisualKind;
  path: string;
}

function pad(n: number, w = 3): string {
  return String(n).padStart(w, "0");
}

function fileReady(p: string, minBytes: number): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > minBytes;
  } catch {
    return false;
  }
}

/**
 * MIXED-media visual builder. Returns map sceneIndex → VisualAsset (a missing
 * entry renders as the dark ambient background, exactly like a failed image).
 *
 * Pools (capped + reused round-robin, like the AI-image pool) for the types
 * where reuse is safe; per-scene acquisition for stock VIDEO (whose length must
 * cover its specific scene). Anything that fails degrades to an AI-image still,
 * so a video always assembles even with no Pexels key / no Veo credits.
 */
export async function buildVisuals(
  runId: string,
  runDirPath: string,
  scenes: Scene[],
  videoContext: string
): Promise<Map<number, VisualAsset>> {
  const imagesDir = ensureDir(path.join(runDirPath, "images"));
  const videosDir = ensureDir(path.join(runDirPath, "videos"));
  const stockDir = ensureDir(path.join(runDirPath, "stock"));

  const bySource: Record<Scene["source"], number[]> = { "ai-image": [], "ai-video": [], "stock-video": [], "stock-image": [] };
  for (const s of scenes) bySource[s.source].push(s.index);

  // ── 1) AI-IMAGE POOL — covers ai-image scenes, the ai-video START frames, and
  //       the universal fallback. Prompts taken from evenly-spaced scenes so the
  //       reused imagery follows the script's arc. ──
  const maxImg = Math.max(1, Math.round(getNumber("MAX_UNIQUE_IMAGES", 60)));
  const aiPoolSize = Math.min(scenes.length, maxImg);
  const aiPrompts: PoolPrompt[] = [];
  for (let p = 0; p < aiPoolSize; p++) {
    const sc = scenes[Math.floor((p * scenes.length) / aiPoolSize)];
    aiPrompts.push({ stem: `img_${pad(p)}`, prompt: buildImagePrompt(sc.visual_prompt) });
  }
  log(runId, "info", `Visual mix: building pools for ${scenes.length} scenes…`, "images");
  const aiImages = await generateAiImagePool(runId, imagesDir, aiPrompts, { label: "AI image" });
  checkCancelled(runId);

  // ── 2) AI-VIDEO POOL — animate the first K AI images via genaipro Veo. All
  //       ai-video scenes share one short length, so a pooled clip fits any of
  //       them (no stretch/freeze). ──
  let aiVideos: string[] = [];
  const aiVideoCount = bySource["ai-video"].length;
  if (aiVideoCount > 0 && aiImages.length > 0) {
    const k = Math.min(aiVideoCount, Math.max(1, Math.round(getNumber("MAX_UNIQUE_AI_VIDEOS", 12))));
    const motion = getSetting("AI_VIDEO_MOTION_PROMPT");
    const limit = pLimit(Math.max(1, Math.round(getNumber("VIDEO_CONCURRENCY", 1))));
    const slots = new Array<string | null>(k).fill(null);
    log(runId, "info", `Animating ${k} AI image(s) into video clips (genaipro Veo)…`, "video");
    await Promise.all(
      Array.from({ length: k }, (_, j) =>
        limit(async () => {
          checkCancelled(runId);
          const out = path.join(videosDir, `aivid_${pad(j)}.mp4`);
          if (fileReady(out, 10000)) {
            slots[j] = out;
            return;
          }
          const start = aiImages[j % aiImages.length];
          try {
            await framesToVideoFile(start, motion, out, { runId, taskIdFile: path.join(videosDir, `aivid_${pad(j)}.task`) });
            slots[j] = out;
            log(runId, "info", `AI video ${j + 1}/${k} ready`, "video");
          } catch (e) {
            log(runId, "warn", `AI video ${j + 1}/${k} failed (${e instanceof Error ? e.message : e}) — those scenes fall back to an AI image`, "video");
          }
        })
      )
    );
    aiVideos = slots.filter((p): p is string => p !== null);
  }
  checkCancelled(runId);

  // ── 3) STOCK-IMAGE POOL — stills fill any length, so pool + reuse. ──
  let stockImages: string[] = [];
  const stockImgIdx = bySource["stock-image"];
  if (stockImgIdx.length > 0) {
    const k = Math.min(stockImgIdx.length, Math.max(1, Math.round(getNumber("MAX_UNIQUE_STOCK_IMAGES", 15))));
    const used = new Set<string>();
    const limit = pLimit(Math.max(1, Math.round(getNumber("STOCK_CONCURRENCY", 2))));
    const slots = new Array<string | null>(k).fill(null);
    log(runId, "info", `Finding ${k} stock photo(s)…`, "footage");
    await Promise.all(
      Array.from({ length: k }, (_, j) =>
        limit(async () => {
          checkCancelled(runId);
          const out = path.join(stockDir, `stockimg_${pad(j)}.jpg`);
          if (fileReady(out, 500)) {
            slots[j] = out;
            return;
          }
          const sc = scenes[stockImgIdx[j % stockImgIdx.length]];
          const r = await acquireFootage({ runId, want: "image", query: sc.real_query || "", fallbackQuery: sc.visual_prompt, sceneText: sc.text, videoContext, outPath: out, usedIds: used });
          if (r) slots[j] = r.path;
        })
      )
    );
    stockImages = slots.filter((p): p is string => p !== null);
  }
  checkCancelled(runId);

  // ── 4) STOCK-VIDEO — per scene (the clip must cover THAT scene's length). ──
  const stockVideoByScene = new Map<number, string>();
  const stockVidIdx = bySource["stock-video"];
  if (stockVidIdx.length > 0) {
    const used = new Set<string>();
    const limit = pLimit(Math.max(1, Math.round(getNumber("STOCK_CONCURRENCY", 2))));
    log(runId, "info", `Finding stock footage for ${stockVidIdx.length} scene(s)…`, "footage");
    await Promise.all(
      stockVidIdx.map((si) =>
        limit(async () => {
          checkCancelled(runId);
          const sc = scenes[si];
          const out = path.join(stockDir, `stockvid_${pad(si, 4)}.mp4`);
          if (fileReady(out, 10000)) {
            stockVideoByScene.set(si, out);
            return;
          }
          const dur = sc.endSec - sc.startSec;
          const r = await acquireFootage({ runId, want: "video", query: sc.real_query || "", fallbackQuery: sc.visual_prompt, sceneText: sc.text, videoContext, outPath: out, usedIds: used, minDurSec: dur });
          if (r) stockVideoByScene.set(si, r.path);
        })
      )
    );
  }
  checkCancelled(runId);

  // ── 5) ASSIGN pool assets to scenes; degrade to an AI-image still. ──
  const assets = new Map<number, VisualAsset>();
  const rr = { ai: 0, si: 0, av: 0 };
  const nextAiImage = (): VisualAsset | null => (aiImages.length ? { kind: "still", path: aiImages[rr.ai++ % aiImages.length] } : null);

  for (const sc of scenes) {
    let a: VisualAsset | null = null;
    switch (sc.source) {
      case "ai-image":
        a = nextAiImage();
        break;
      case "stock-image":
        if (stockImages.length) a = { kind: "still", path: stockImages[rr.si++ % stockImages.length] };
        break;
      case "ai-video":
        if (aiVideos.length) a = { kind: "video", path: aiVideos[rr.av++ % aiVideos.length] };
        break;
      case "stock-video": {
        const v = stockVideoByScene.get(sc.index);
        if (v) a = { kind: "video", path: v };
        break;
      }
    }
    if (!a) a = nextAiImage(); // universal fallback (still); null ⇒ dark ambient
    if (a) assets.set(sc.index, a);
  }

  const tally = { still: 0, video: 0 };
  for (const a of assets.values()) tally[a.kind]++;
  log(
    runId,
    "success",
    `Visuals ready: ${assets.size}/${scenes.length} scenes (${tally.video} video, ${tally.still} still) — ` +
      `${aiImages.length} AI img, ${aiVideos.length} AI vid, ${stockImages.length} stock img, ${stockVideoByScene.size} stock vid`,
    "images"
  );
  fs.writeFileSync(
    path.join(runDirPath, "visuals.json"),
    JSON.stringify({ assignment: Object.fromEntries([...assets].map(([k, v]) => [k, v])) }, null, 2),
    "utf8"
  );
  return assets;
}
