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

/** The unique, language-INDEPENDENT visual assets — generated once and reused
 *  across every channel in a multi-language run. */
export interface VisualPool {
  aiImages: string[];
  aiVideos: string[];
  stockImages: string[];
  stockVideos: string[];
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
 * Build the visual POOL once (capped + reused). Because it's language-independent,
 * a multi-language run builds this from the SOURCE script's scenes and reuses it
 * for every channel. Assets are written under poolDir (the run root). Stock VIDEO
 * is pooled too (each clip long enough to cover any scene → trimmed per scene at
 * render), so it's reused across channels instead of re-fetched per scene.
 * Anything that fails just shrinks its pool (scenes fall back to an AI-image
 * still at assignment).
 */
export async function buildVisualPool(
  runId: string,
  poolDir: string,
  scenes: Scene[],
  videoContext: string
): Promise<VisualPool> {
  const imagesDir = ensureDir(path.join(poolDir, "images"));
  const videosDir = ensureDir(path.join(poolDir, "videos"));
  const stockDir = ensureDir(path.join(poolDir, "stock"));
  const count = (s: Scene["source"]) => scenes.filter((x) => x.source === s).length;

  // ── AI-IMAGE POOL (also ai-video start frames + universal fallback) ──
  const maxImg = Math.max(1, Math.round(getNumber("MAX_UNIQUE_IMAGES", 60)));
  const aiPoolSize = Math.min(scenes.length, maxImg);
  const aiPrompts: PoolPrompt[] = [];
  for (let p = 0; p < aiPoolSize; p++) {
    const sc = scenes[Math.floor((p * scenes.length) / aiPoolSize)];
    aiPrompts.push({ stem: `img_${pad(p)}`, prompt: buildImagePrompt(sc.visual_prompt) });
  }
  log(runId, "info", `Building visual pool from ${scenes.length} source scenes…`, "images");
  const aiImages = await generateAiImagePool(runId, imagesDir, aiPrompts, { label: "AI image" });
  checkCancelled(runId);

  // ── AI-VIDEO POOL (animate the first K AI images) ──
  let aiVideos: string[] = [];
  const aiVideoCount = count("ai-video");
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
          try {
            await framesToVideoFile(aiImages[j % aiImages.length], motion, out, { runId, taskIdFile: path.join(videosDir, `aivid_${pad(j)}.task`) });
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

  // ── STOCK-IMAGE POOL (stills fill any length) ──
  const stockImages = await buildStockPool(runId, stockDir, scenes, "image", count("stock-image"), Math.round(getNumber("MAX_UNIQUE_STOCK_IMAGES", 15)), videoContext, 0);
  checkCancelled(runId);

  // ── STOCK-VIDEO POOL (each clip ≥ the longest scene, so it covers any scene) ──
  const minVid = Math.max(4, Math.round(getNumber("SCENE_MAX_SEC", 20)));
  const stockVideos = await buildStockPool(runId, stockDir, scenes, "video", count("stock-video"), Math.round(getNumber("MAX_UNIQUE_STOCK_VIDEOS", 15)), videoContext, minVid);
  checkCancelled(runId);

  log(
    runId,
    "success",
    `Visual pool ready: ${aiImages.length} AI img, ${aiVideos.length} AI vid, ${stockImages.length} stock img, ${stockVideos.length} stock vid`,
    "images"
  );
  return { aiImages, aiVideos, stockImages, stockVideos };
}

async function buildStockPool(
  runId: string,
  stockDir: string,
  scenes: Scene[],
  want: "image" | "video",
  sceneCount: number,
  maxUnique: number,
  videoContext: string,
  minDurSec: number
): Promise<string[]> {
  if (sceneCount === 0) return [];
  const wantSource = want === "image" ? "stock-image" : "stock-video";
  const idx = scenes.map((s, i) => (s.source === wantSource ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return [];
  const k = Math.min(idx.length, Math.max(1, maxUnique));
  const used = new Set<string>();
  const limit = pLimit(Math.max(1, Math.round(getNumber("STOCK_CONCURRENCY", 2))));
  const slots = new Array<string | null>(k).fill(null);
  const ext = want === "image" ? "jpg" : "mp4";
  const prefix = want === "image" ? "stockimg" : "stockvid";
  const minBytes = want === "image" ? 500 : 10000;
  log(runId, "info", `Finding ${k} stock ${want}(s)…`, "footage");
  await Promise.all(
    Array.from({ length: k }, (_, j) =>
      limit(async () => {
        checkCancelled(runId);
        const out = path.join(stockDir, `${prefix}_${pad(j)}.${ext}`);
        if (fileReady(out, minBytes)) {
          slots[j] = out;
          return;
        }
        // evenly-spaced source scenes of this type → the pool follows the arc
        const sc = scenes[idx[Math.floor((j * idx.length) / k)]];
        const r = await acquireFootage({ runId, want, query: sc.real_query || "", fallbackQuery: sc.visual_prompt, sceneText: sc.text, videoContext, outPath: out, usedIds: used, minDurSec });
        if (r) slots[j] = r.path;
      })
    )
  );
  return slots.filter((p): p is string => p !== null);
}

/**
 * Assign a pool to ANY scene set, round-robin by source type. A type with an
 * empty pool (or any miss) degrades to an AI-image still; no AI images at all →
 * that scene is left unset (renders as the dark ambient background).
 */
export function assignPoolToScenes(runId: string, pool: VisualPool, scenes: Scene[]): Map<number, VisualAsset> {
  const assets = new Map<number, VisualAsset>();
  const rr = { ai: 0, si: 0, av: 0, sv: 0 };
  const nextAiImage = (): VisualAsset | null =>
    pool.aiImages.length ? { kind: "still", path: pool.aiImages[rr.ai++ % pool.aiImages.length] } : null;

  for (const sc of scenes) {
    let a: VisualAsset | null = null;
    switch (sc.source) {
      case "ai-image":
        a = nextAiImage();
        break;
      case "stock-image":
        if (pool.stockImages.length) a = { kind: "still", path: pool.stockImages[rr.si++ % pool.stockImages.length] };
        break;
      case "ai-video":
        if (pool.aiVideos.length) a = { kind: "video", path: pool.aiVideos[rr.av++ % pool.aiVideos.length] };
        break;
      case "stock-video":
        if (pool.stockVideos.length) a = { kind: "video", path: pool.stockVideos[rr.sv++ % pool.stockVideos.length] };
        break;
    }
    if (!a) a = nextAiImage();
    if (a) assets.set(sc.index, a);
  }

  const tally = { still: 0, video: 0 };
  for (const a of assets.values()) tally[a.kind]++;
  log(runId, "info", `Assigned visuals: ${assets.size}/${scenes.length} scenes (${tally.video} video, ${tally.still} still)`, "images");
  return assets;
}

/**
 * SINGLE-video path: build the pool and assign it to the scenes (the multi-
 * language pipeline calls buildVisualPool once + assignPoolToScenes per channel).
 */
export async function buildVisuals(
  runId: string,
  runDirPath: string,
  scenes: Scene[],
  videoContext: string
): Promise<Map<number, VisualAsset>> {
  const pool = await buildVisualPool(runId, runDirPath, scenes, videoContext);
  const assets = assignPoolToScenes(runId, pool, scenes);
  fs.writeFileSync(
    path.join(runDirPath, "visuals.json"),
    JSON.stringify({ assignment: Object.fromEntries([...assets].map(([k, v]) => [k, v])) }, null, 2),
    "utf8"
  );
  return assets;
}
