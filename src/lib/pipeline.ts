import fs from "fs";
import path from "path";
import { getBool, getNumber, getSetting } from "./settings";
import { log, bindLogFile } from "./logger";
import { CancelledError, checkCancelled, clearCancel, requestCancel } from "./cancellation";
import { getRunDir, readRun, updateRun } from "./runs-store";
import { generateVoiceTimeline, buildWordTimeline, type VoiceTimeline } from "./services/voice";
import { cutScenes, describeScenes, loadScenesIfPresent, type Scene } from "./services/scenes";
import { generateImages } from "./services/image-gen";
import { buildVisuals, type VisualAsset } from "./services/visuals";
import { renderAllScenes } from "./services/render";
import { assembleVideo } from "./services/assemble";
import { runFfmpeg } from "./services/ffmpeg";
import type { SubtitleCue } from "./services/subtitles";
import { ensureDir } from "./paths";

function parseResolution(): { width: number; height: number } {
  const m = getSetting("VIDEO_RESOLUTION").match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!m) return { width: 1920, height: 1080 };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

export interface PipelineFlags {
  /** smoke test: no external APIs — synthetic images + silent voiceover */
  smoke?: boolean;
}

/** Fire-and-forget entry point (called from POST /api/runs). */
export function startPipeline(runId: string, flags: PipelineFlags = {}): void {
  runPipeline(runId, flags).catch((e) => {
    console.error(`pipeline crash for ${runId}:`, e);
  });
}

/**
 * SINGLE-SHOT pipeline:
 *   1. voice the WHOLE script in one continuous take (large chunks if long)
 *   2. cut it into 12–20s scenes by the real speech timecodes
 *   3. write one image prompt per scene, generate images
 *   4. render each scene to its time window, lay the single voiceover on top
 * This gives natural continuous narration (no per-scene prosody resets) and
 * accurate timing + subtitles from the speech timeline.
 */
async function runPipeline(runId: string, flags: PipelineFlags): Promise<void> {
  const dir = getRunDir(runId);
  bindLogFile(runId, dir);
  const meta = readRun(runId);
  if (!meta) {
    console.error(`run ${runId} has no metadata`);
    return;
  }

  const { width, height } = parseResolution();
  const fps = Math.max(10, Math.round(getNumber("VIDEO_FPS", 30)));

  // Clean slate for the cancellation flag — lets a Retry re-run this same runId
  // without inheriting a stale "cancelled" flag from the prior attempt.
  clearCancel(runId);

  try {
    updateRun(runId, { status: "running", error: undefined });
    const resuming = !flags.smoke && fs.existsSync(path.join(dir, "voice.json"));
    log(
      runId,
      "info",
      flags.smoke
        ? "Smoke test started (no API keys needed)"
        : resuming
          ? "Pipeline restarted — reusing everything already generated"
          : "Pipeline started",
      "pipeline"
    );

    // 1) VOICE — one continuous take for the whole script
    const voice: VoiceTimeline = flags.smoke
      ? await smokeVoice(dir)
      : await generateVoiceTimeline(runId, dir, meta.script, meta.voiceMode, meta.voiceoverFile);
    checkCancelled(runId);

    // 2) SCENES — cut the narration into 12–20s windows by timecodes
    let scenes: Scene[] = loadScenesIfPresent(dir) ?? cutScenes(runId, dir, voice, meta.script);

    // 3) VISUALS — AI images, AI video, stock footage/photos per the mix ratio
    let visuals: Map<number, VisualAsset>;
    if (flags.smoke) {
      scenes = scenes.map((s) => ({ ...s, visual_prompt: "synthetic test" }));
      visuals = await smokeVisuals(dir, scenes, width, height, fps);
      log(runId, "info", "Smoke: synthetic stills + one synthetic video clip (ffmpeg, no APIs)", "images");
    } else {
      scenes = await describeScenes(runId, dir, scenes);
      checkCancelled(runId);
      if (getBool("VISUAL_MIX_ENABLED")) {
        const context = meta.script.replace(/\s+/g, " ").trim().slice(0, 400);
        visuals = await buildVisuals(runId, dir, scenes, context);
      } else {
        const images = await generateImages(runId, dir, scenes);
        visuals = new Map([...images].map(([i, p]) => [i, { kind: "still" as const, path: p }]));
      }
    }
    checkCancelled(runId);

    // 4) RENDER each scene to its window
    log(runId, "info", `Rendering ${scenes.length} clips at ${width}x${height}@${fps}…`, "render");
    const clips = await renderAllScenes(runId, dir, scenes, voice.cues, visuals, width, height, fps);
    checkCancelled(runId);

    // 5) ASSEMBLE — clips + single voiceover + music + intro
    const result = await assembleVideo(runId, dir, clips, voice.voiceoverFile, width, height, fps);

    updateRun(runId, {
      status: "done",
      outputPath: result.outputPath,
      stats: {
        segments: scenes.length,
        uniqueImages: new Set([...visuals.values()].map((v) => v.path)).size,
        durationSec: Math.round(result.durationSec),
      },
    });
    log(runId, "success", "Done — final.mp4 is ready to download", "pipeline");
  } catch (e) {
    // Stop sibling in-flight API polls so they don't log as zombies after the
    // run failed. The flag stays set until the next start (which clears it).
    requestCancel(runId);
    if (e instanceof CancelledError) {
      updateRun(runId, { status: "cancelled" });
      log(runId, "warn", "Run cancelled", "pipeline");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      updateRun(runId, { status: "error", error: msg });
      log(runId, "error", msg, "pipeline");
      log(runId, "info", "Nothing already generated is lost — press Retry to continue from here", "pipeline");
    }
  }
}

/* ── smoke-test synthetic stages (no external APIs) ── */

/** Silent 48s voiceover + synthetic cues with pause gaps → ~3 scenes of ~16s. */
async function smokeVoice(dir: string): Promise<VoiceTimeline> {
  const totalSec = 48;
  const wav = path.join(dir, "smoke_voiceover.wav");
  await runFfmpeg([
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", String(totalSec), "-c:a", "pcm_s16le", "-y", wav,
  ]);

  const phrases = [
    "This is the single-shot smoke test.",
    "The whole script is voiced in one take.",
    "Scenes are cut by the speech timecodes,",
    "each one between twelve and twenty seconds.",
    "Subtitles appear only while the voice speaks,",
    "and vanish during the pauses between phrases.",
  ];
  const cues: SubtitleCue[] = [];
  const slot = totalSec / phrases.length; // 8s per phrase
  phrases.forEach((text, i) => {
    const start = i * slot + 0.5;
    cues.push({ start, end: start + slot - 2.0, text }); // ~1.5s gap after each
  });
  const words = buildWordTimeline(cues);
  return { voiceoverFile: wav, totalSec, cues, words };
}

async function smokeVisuals(
  runDirPath: string,
  scenes: Scene[],
  width: number,
  height: number,
  fps: number
): Promise<Map<number, VisualAsset>> {
  const imagesDir = ensureDir(path.join(runDirPath, "images"));
  const videosDir = ensureDir(path.join(runDirPath, "videos"));
  // Real reference frames (dev machine) make the smoke test look like a real
  // video; only subtitle-free frames are used. Fallback: warm gradients.
  const refFrames = ["p0_t0005.jpg", "p0_t0110.jpg", "p3600_t0090.jpg"].map((n) =>
    path.join(process.cwd(), "_reference", "frames", n)
  );
  const colors: Array<[string, string]> = [
    ["0xf0a040", "0x1c0703"],
    ["0xe06820", "0x170502"],
    ["0xc8b04a", "0x140b02"],
  ];

  // One synthetic moving clip exercises the new VIDEO render branch with no APIs.
  const vidPath = path.join(videosDir, "smoke_clip.mp4");
  if (!fs.existsSync(vidPath) || fs.statSync(vidPath).size < 10000) {
    await runFfmpeg([
      "-f", "lavfi", "-i", `testsrc2=s=854x480:r=${fps}:d=10`,
      "-vf", "hue=h=25:s=0.55,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-t", "10", "-y", vidPath,
    ]);
  }

  const map = new Map<number, VisualAsset>();
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    // exercise the video branch for any video-source scene, and force ≥1 video
    const wantVideo = sc.source === "ai-video" || sc.source === "stock-video" || i === 1;
    if (wantVideo) {
      map.set(sc.index, { kind: "video", path: vidPath });
      continue;
    }
    const ref = refFrames[i % refFrames.length];
    if (fs.existsSync(ref)) {
      map.set(sc.index, { kind: "still", path: ref });
      continue;
    }
    const [c0, c1] = colors[i % colors.length];
    const file = path.join(imagesDir, `img_${String(i).padStart(3, "0")}.png`);
    await runFfmpeg([
      "-f", "lavfi", "-i",
      `gradients=s=1280x720:c0=${c0}:c1=${c1}:x0=640:y0=300:x1=80:y1=720`,
      "-vf", "vignette=PI/3.5",
      "-frames:v", "1", "-y", file,
    ]);
    map.set(sc.index, { kind: "still", path: file });
  }
  return map;
}
