import fs from "fs";
import path from "path";
import { geminiImage } from "./gemini";
import { imageToFile as genaiproImage } from "./genaipro";
import { getNumber, getSetting } from "../settings";
import { getPalette } from "../palettes";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { pLimit } from "../plimit";
import { ensureDir } from "../paths";

/** Minimal shape the image pool needs from a scene. */
interface ImageScene {
  index: number;
  visual_prompt: string;
}

/** Full AI image prompt = scene visual + style suffix + palette (palette LAST
 *  so it wins over any color words in the scene prompt). */
export function buildImagePrompt(visualPrompt: string): string {
  const styleSuffix = getSetting("IMAGE_STYLE_SUFFIX").trim();
  const palette = getPalette();
  return `${visualPrompt}. ${styleSuffix}. ${palette.prompt}`;
}

export interface PoolPrompt {
  /** filename stem (no extension) — stable so a Retry reuses the on-disk image */
  stem: string;
  prompt: string;
}

/** Returns a pool image already on disk (png/jpg) for a stem, if non-empty. */
function findExisting(imagesDir: string, stem: string): string | null {
  for (const ext of ["png", "jpg", "jpeg"]) {
    const file = path.join(imagesDir, `${stem}.${ext}`);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 500) return file;
    } catch {
      // ignore and try next ext
    }
  }
  return null;
}

/**
 * Generate a pool of unique AI images from explicit prompts (one per stem).
 * Reuses any image already on disk (Retry never re-pays) and degrades
 * gracefully: a failed generation is dropped, not fatal. Returns the paths that
 * succeeded (order preserved, nulls removed).
 */
export async function generateAiImagePool(
  runId: string,
  imagesDir: string,
  prompts: PoolPrompt[],
  opts: { concurrency?: number; label?: string } = {}
): Promise<string[]> {
  ensureDir(imagesDir);
  const label = opts.label ?? "Image";
  const provider = getSetting("IMAGE_PROVIDER") === "genaipro" ? "genaipro" : "gemini";
  const concurrency = Math.max(1, Math.round(opts.concurrency ?? getNumber("IMAGE_CONCURRENCY", 2)));
  const limit = pLimit(concurrency);
  const out = new Array<string | null>(prompts.length).fill(null);
  let done = 0;
  let failed = 0;
  let reused = 0;

  await Promise.all(
    prompts.map((pp, i) =>
      limit(async () => {
        checkCancelled(runId);
        const existing = findExisting(imagesDir, pp.stem);
        if (existing) {
          out[i] = existing;
          reused++;
          return;
        }
        try {
          let file: string;
          if (provider === "genaipro") {
            file = path.join(imagesDir, `${pp.stem}.png`);
            await genaiproImage(pp.prompt, file);
          } else {
            const { bytes, mimeType } = await geminiImage(pp.prompt);
            const ext = mimeType.includes("jpeg") ? "jpg" : "png";
            file = path.join(imagesDir, `${pp.stem}.${ext}`);
            fs.writeFileSync(file, bytes);
          }
          out[i] = file;
          done++;
          log(runId, "info", `${label} ${done}/${prompts.length} ready`, "images");
        } catch (e) {
          failed++;
          log(runId, "warn", `${label} ${i + 1}/${prompts.length} failed (${e instanceof Error ? e.message : e})`, "images");
        }
      })
    )
  );

  if (reused > 0) log(runId, "info", `Reused ${reused} ${label.toLowerCase()}(s) already generated in a previous run`, "images");
  if (failed > 0) log(runId, "warn", `${failed} ${label.toLowerCase()}(s) failed`, "images");
  return out.filter((p): p is string => p !== null);
}

/**
 * LEGACY all-AI-images path (used when VISUAL_MIX_ENABLED=false). Builds a pool
 * of unique images from evenly-spaced segments and assigns them round-robin to
 * every segment, which keeps a long video's image-gen cost flat (the reference
 * 4-hour channel cycles a few dozen visuals).
 *
 * Returns: map segmentIndex -> absolute image path.
 */
export async function generateImages(
  runId: string,
  runDirPath: string,
  segments: ImageScene[]
): Promise<Map<number, string>> {
  const imagesDir = ensureDir(path.join(runDirPath, "images"));
  const maxUnique = Math.max(1, Math.round(getNumber("MAX_UNIQUE_IMAGES", 60)));
  const provider = getSetting("IMAGE_PROVIDER") === "genaipro" ? "genaipro" : "gemini";

  const poolSize = Math.min(segments.length, maxUnique);
  log(
    runId,
    "info",
    `Generating ${poolSize} unique image(s) via ${provider} for ${segments.length} segment(s)` +
      (poolSize < segments.length ? " (round-robin reuse)" : ""),
    "images"
  );

  // Pool prompts = evenly spaced segments, so reused visuals still follow the
  // script's overall arc instead of all coming from the opening.
  const prompts: PoolPrompt[] = [];
  for (let p = 0; p < poolSize; p++) {
    const seg = segments[Math.floor((p * segments.length) / poolSize)];
    prompts.push({ stem: `img_${String(p).padStart(3, "0")}`, prompt: buildImagePrompt(seg.visual_prompt) });
  }

  const available = await generateAiImagePool(runId, imagesDir, prompts);
  if (available.length === 0) {
    throw new Error(
      provider === "genaipro"
        ? "All image generations failed — check GENAIPRO_API_KEY and Veo credits in Settings"
        : "All image generations failed — check GOOGLE_API_KEY and IMAGE_MODEL in Settings"
    );
  }

  // Assign pool images to segments round-robin (over the AVAILABLE pool).
  const assignment = new Map<number, string>();
  for (const seg of segments) {
    assignment.set(seg.index, available[seg.index % available.length]);
  }

  fs.writeFileSync(
    path.join(runDirPath, "images.json"),
    JSON.stringify({ pool: available, assignment: Object.fromEntries(assignment) }, null, 2),
    "utf8"
  );
  log(runId, "success", `Images ready: ${available.length} unique`, "images");
  return assignment;
}
