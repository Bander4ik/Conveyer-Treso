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

/**
 * Generates a POOL of unique images and assigns one to every segment.
 * Long scripts reuse images round-robin (the reference channel does exactly
 * this — a 4-hour video cycles a few dozen visuals), which keeps API cost flat.
 *
 * Returns: map segmentIndex -> absolute image path (missing = render dark filler).
 */
export async function generateImages(
  runId: string,
  runDirPath: string,
  segments: ImageScene[]
): Promise<Map<number, string>> {
  const imagesDir = ensureDir(path.join(runDirPath, "images"));
  const palette = getPalette();
  const styleSuffix = getSetting("IMAGE_STYLE_SUFFIX").trim();
  const maxUnique = Math.max(1, Math.round(getNumber("MAX_UNIQUE_IMAGES", 60)));
  const concurrency = Math.max(1, Math.round(getNumber("IMAGE_CONCURRENCY", 2)));
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
  const poolSegmentIndexes: number[] = [];
  for (let p = 0; p < poolSize; p++) {
    poolSegmentIndexes.push(Math.floor((p * segments.length) / poolSize));
  }

  const limit = pLimit(concurrency);
  const poolPaths = new Array<string | null>(poolSize).fill(null);
  let done = 0;
  let failed = 0;
  let reused = 0;

  await Promise.all(
    poolSegmentIndexes.map((segIdx, p) =>
      limit(async () => {
        checkCancelled(runId);
        // RESUME: an image already on disk from a previous run is reused as-is,
        // so a retry never re-pays for images that already generated.
        const existing = findExistingPoolImage(imagesDir, p);
        if (existing) {
          poolPaths[p] = existing;
          done++;
          reused++;
          return;
        }
        const seg = segments[segIdx];
        // palette goes LAST so it wins over any color words in the segment prompt
        const prompt = `${seg.visual_prompt}. ${styleSuffix}. ${palette.prompt}`;
        try {
          let file: string;
          if (provider === "genaipro") {
            file = path.join(imagesDir, `img_${String(p).padStart(3, "0")}.png`);
            await genaiproImage(prompt, file);
          } else {
            const { bytes, mimeType } = await geminiImage(prompt);
            const ext = mimeType.includes("jpeg") ? "jpg" : "png";
            file = path.join(imagesDir, `img_${String(p).padStart(3, "0")}.${ext}`);
            fs.writeFileSync(file, bytes);
          }
          poolPaths[p] = file;
          done++;
          log(runId, "info", `Image ${done}/${poolSize} ready`, "images");
        } catch (e) {
          failed++;
          log(
            runId,
            "warn",
            `Image ${p + 1}/${poolSize} failed (${e instanceof Error ? e.message : e}) — segment will use dark ambient background`,
            "images"
          );
        }
      })
    )
  );

  if (reused > 0) {
    log(runId, "info", `Reused ${reused} image(s) already generated in a previous run`, "images");
  }

  const available = poolPaths.filter((p): p is string => p !== null);
  if (available.length === 0) {
    throw new Error(
      provider === "genaipro"
        ? "All image generations failed — check GENAIPRO_API_KEY and Veo credits in Settings"
        : "All image generations failed — check GOOGLE_API_KEY and IMAGE_MODEL in Settings"
    );
  }
  if (failed > 0) {
    log(runId, "warn", `${failed} image(s) failed, continuing with ${available.length}`, "images");
  }

  // Assign pool images to segments round-robin (over the AVAILABLE pool).
  const assignment = new Map<number, string>();
  for (const seg of segments) {
    assignment.set(seg.index, available[seg.index % available.length]);
  }

  fs.writeFileSync(
    path.join(runDirPath, "images.json"),
    JSON.stringify(
      { pool: available, assignment: Object.fromEntries(assignment) },
      null,
      2
    ),
    "utf8"
  );
  log(runId, "success", `Images ready: ${available.length} unique`, "images");
  return assignment;
}

/** Returns a pool image already on disk (png/jpg) for slot p, if non-empty. */
function findExistingPoolImage(imagesDir: string, p: string | number): string | null {
  const base = `img_${String(p).padStart(3, "0")}`;
  for (const ext of ["png", "jpg", "jpeg"]) {
    const file = path.join(imagesDir, `${base}.${ext}`);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 500) return file;
    } catch {
      // ignore and try next ext
    }
  }
  return null;
}
