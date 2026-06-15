import fs from "fs";
import path from "path";
import { getBool, getNumber } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { pLimit } from "../plimit";
import { ensureBaseAssets, runFfmpeg, type BaseAssets } from "./ffmpeg";
import { buildAss, escapeSubtitlePath, sliceCues, type SubtitleCue } from "./subtitles";
import { ensureDir } from "../paths";
import type { Scene } from "./scenes";

/* ── deterministic particle field ───────────────────────────────────────────
 * One fixed table (seeded PRNG) shared by every segment. Motion expressions
 * use (t + segmentStartOffset), so particles drift CONTINUOUSLY across cuts —
 * segment boundaries are invisible.
 */

interface Particle {
  kind: "dot" | "ember";
  size: number;
  xc: number; // horizontal center, fraction of W
  amp: number; // sway amplitude px
  period: number; // sway period s
  phase: number;
  speed: number; // upward px/s
  init: number; // initial scatter px
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function particleTable(count: number): Particle[] {
  const rnd = mulberry32(1337);
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const ember = rnd() < 0.4;
    out.push({
      kind: ember ? "ember" : "dot",
      size: Math.round(ember ? 8 + rnd() * 10 : 10 + rnd() * 14),
      xc: 0.05 + rnd() * 0.9,
      amp: 30 + rnd() * 45,
      period: 6 + rnd() * 7,
      phase: rnd() * 6.283,
      speed: 22 + rnd() * 38,
      init: rnd() * 1200,
    });
  }
  return out;
}

export interface RenderOptions {
  runId: string;
  sceneIndex: number;
  durationSec: number;
  /** subtitle cues for THIS clip, already offset to clip-local time */
  cues?: SubtitleCue[];
  imagePath: string | null;
  /** sum of durations of all previous scenes — keeps FX phase continuous */
  startOffsetSec: number;
  outFile: string;
  width: number;
  height: number;
  fps: number;
  assets: BaseAssets;
  /** pre-rendered FX overlay loop (particles + glow); null = no FX */
  fxLoopPath: string | null;
  fxLoopSec: number;
}

function f3(n: number): string {
  return n.toFixed(3);
}

/**
 * Render one segment clip (VIDEO ONLY — audio is muxed once at assembly):
 *   dark gradient backdrop
 *   + AI image with slow Ken Burns zoom, alpha fade-in, fade-out into darkness
 *   + floating dust/ember particles (screen blend, done in RGB — blending in
 *     YUV shifts chroma toward magenta)
 *   + subtle candle-like brightness flicker
 */
export async function renderSegmentClip(opts: RenderOptions): Promise<void> {
  const { runId, sceneIndex, durationSec, cues, imagePath, startOffsetSec, outFile, width, height, fps, assets, fxLoopPath, fxLoopSec } = opts;
  const dur = durationSec;
  const frames = Math.max(2, Math.round(dur * fps));
  const off = startOffsetSec;

  const zoomAmount = getNumber("ZOOM_AMOUNT", 0.12);
  const hold = getNumber("IMAGE_HOLD_SECONDS", 30);
  const fadeIn = getNumber("FADE_IN_SECONDS", 1.0);
  const fadeOut = getNumber("FADE_OUT_SECONDS", 2.5);
  const edgeFade = getNumber("EDGE_FADE_SECONDS", 0.8);
  const flickerOn = getBool("FLICKER_ENABLED");
  const flicker = getNumber("FLICKER_STRENGTH", 0.015);

  const args: string[] = [];
  const filters: string[] = [];

  let imageInput = -1;
  let fxInput = -1;
  let nextInput = 0;

  if (imagePath) {
    imageInput = nextInput++;
    args.push("-i", imagePath);
  }
  // dark backdrop: looped still for the whole clip
  const bgInput = nextInput++;
  args.push("-loop", "1", "-framerate", String(fps), "-t", f3(dur), "-i", assets.darkbg);

  // pre-rendered FX overlay: seek into the loop at this scene's absolute start
  // (so motion stays continuous across cuts) and let it loop if the clip is
  // longer than the remaining loop tail
  if (fxLoopPath) {
    fxInput = nextInput++;
    const seek = fxLoopSec > 0 ? (off % fxLoopSec) : 0;
    args.push("-stream_loop", "-1", "-ss", f3(seek), "-i", fxLoopPath);
  }

  // ── backdrop ──
  filters.push(`[${bgInput}:v]scale=${width}:${height},setsar=1[bg]`);

  // ── image layer with Ken Burns + alpha fades ──
  let composed = "bg";
  if (imagePath) {
    const zoomIn = sceneIndex % 2 === 0;
    const zExpr = zoomIn
      ? `1+${zoomAmount.toFixed(4)}*on/${frames}`
      : `${(1 + zoomAmount).toFixed(4)}-${zoomAmount.toFixed(4)}*on/${frames}`;
    // long narration → image dissolves into darkness at `hold`; otherwise a
    // short dip right before the cut keeps segment edges dark and seamless
    const longTail = dur > hold + fadeOut + 2;
    const foStart = longTail ? hold : Math.max(fadeIn + 0.2, dur - edgeFade);
    const foDur = longTail ? fadeOut : edgeFade;
    filters.push(
      // only ~1.35x upscale is needed (zoom max ≈ 1.12) — scaling to 2x was
      // wasted pixels and a big chunk of the per-frame cost
      `[${imageInput}:v]scale=${Math.round((width * 1.35) / 2) * 2}:-2:flags=lanczos,` +
        `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},` +
        `format=rgba,` +
        `fade=t=in:st=0:d=${f3(fadeIn)}:alpha=1,` +
        `fade=t=out:st=${f3(foStart)}:d=${f3(foDur)}:alpha=1[img]`
    );
    filters.push(`[bg][img]overlay=0:0[withimg]`);
    composed = "withimg";
  }

  // ── FX overlay: screen-blend the PRE-RENDERED particles+glow loop ──
  // The expensive per-frame particle/glow/blur work was done once up front
  // (prerenderFxLoop). Here each clip just composites a slice of that loop.
  let blended = composed;
  if (fxLoopPath && fxInput >= 0) {
    // screen blend MUST happen in RGB planes — in YUV it shifts chroma to magenta
    filters.push(`[${composed}]format=gbrp[cg]`);
    filters.push(`[${fxInput}:v]scale=${width}:${height},format=gbrp[fx]`);
    filters.push(`[cg][fx]blend=all_mode=screen[blended]`);
    blended = "blended";
  }

  // ── flicker + output format ──
  if (flickerOn && flicker > 0) {
    const tt = `(t+${f3(off)})`;
    filters.push(
      `[${blended}]format=yuv420p,eq=brightness='${f3(flicker)}*sin(2*PI*${tt}*0.4)+${f3(flicker * 0.65)}*sin(2*PI*${tt}*1.3)':eval=frame[vout]`
    );
  } else {
    filters.push(`[${blended}]format=yuv420p[vout]`);
  }

  // ── burned subtitles (speech-aligned cues — empty during narrator pauses) ──
  let finalLabel = "vout";
  if (getBool("SUBTITLES_ENABLED") && (cues?.length ?? 0) > 0) {
    const assPath = outFile.replace(/\.mp4$/i, ".ass");
    fs.writeFileSync(assPath, buildAss(cues!, dur), "utf8");
    filters.push(`[vout]subtitles='${escapeSubtitlePath(assPath)}'[vsub]`);
    finalLabel = "vsub";
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${finalLabel}]`,
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-r", String(fps),
    "-t", f3(dur),
    "-movflags", "+faststart",
    "-y", outFile
  );

  await runFfmpeg(args, 30 * 60 * 1000);
  checkCancelled(runId);
}

export interface RenderedClip {
  index: number;
  file: string;
  durationSec: number;
}

/**
 * Render the particles + edge-glow + blur FX to a short LOOPING video ONCE per
 * run. Every scene then just screen-blends a slice of it instead of recomputing
 * the whole per-frame field — this is the single biggest render speedup. The
 * loop length equals the glow's lap time so the (most visible) glow is seamless.
 * Returns null when all FX are disabled.
 */
async function prerenderFxLoop(
  runId: string,
  runDirPath: string,
  assets: BaseAssets,
  width: number,
  height: number,
  fps: number
): Promise<{ path: string; loopSec: number } | null> {
  const particlesOn = getBool("PARTICLES_ENABLED") && getNumber("PARTICLE_COUNT", 8) > 0;
  const glowOn = getBool("EDGE_GLOW_ENABLED");
  if (!particlesOn && !glowOn) return null;

  const glowStrength = Math.min(1, Math.max(0, getNumber("EDGE_GLOW_STRENGTH", 0.55)));
  const glowSize = Math.min(1.5, Math.max(0.15, getNumber("EDGE_GLOW_SIZE", 0.62)));
  const glowPeriod = Math.max(6, getNumber("EDGE_GLOW_PERIOD", 26));
  const particleCount = Math.min(16, Math.max(0, Math.round(getNumber("PARTICLE_COUNT", 8))));
  const loopSec = Math.round(glowOn ? glowPeriod : 30);

  const fxDir = ensureDir(path.join(runDirPath, "fx"));
  const out = path.join(fxDir, "fxloop.mp4");
  if (fs.existsSync(out) && fs.statSync(out).size > 10000) {
    return { path: out, loopSec }; // reuse on retry
  }

  const args: string[] = [];
  const filters: string[] = [];
  let nextInput = 0;
  let dotInput = -1;
  let emberInput = -1;
  let glowInput = -1;
  if (particlesOn) {
    dotInput = nextInput++;
    args.push("-loop", "1", "-i", assets.dot);
    emberInput = nextInput++;
    args.push("-loop", "1", "-i", assets.ember);
  }
  if (glowOn) {
    glowInput = nextInput++;
    args.push("-loop", "1", "-i", assets.glow);
  }

  filters.push(`color=black:s=${width}x${height}:r=${fps}:d=${f3(loopSec)}[pc]`);
  let chain = "pc";
  let labelN = 0;

  if (glowOn) {
    const gw = Math.round(width * glowSize);
    filters.push(
      `[${glowInput}:v]scale=${gw}:-1,format=rgba,colorchannelmixer=aa=${glowStrength.toFixed(3)}[glowb]`
    );
    const u = `mod(t/${glowPeriod.toFixed(2)},1)`;
    const x =
      `if(lt(${u},0.25),W*(${u}/0.25),` +
      `if(lt(${u},0.5),W,` +
      `if(lt(${u},0.75),W*(1-(${u}-0.5)/0.25),0)))-w/2`;
    const y =
      `if(lt(${u},0.25),0,` +
      `if(lt(${u},0.5),H*((${u}-0.25)/0.25),` +
      `if(lt(${u},0.75),H,H*(1-(${u}-0.75)/0.25))))-h/2`;
    const o = `fx${labelN++}`;
    filters.push(`[${chain}][glowb]overlay=x='${x}':y='${y}'[${o}]`);
    chain = o;
  }

  if (particlesOn) {
    const parts = particleTable(particleCount);
    const dots = parts.filter((p) => p.kind === "dot");
    const embers = parts.filter((p) => p.kind === "ember");
    if (dots.length > 0) {
      filters.push(`[${dotInput}:v]split=${dots.length}${dots.map((_, i) => `[dsrc${i}]`).join("")}`);
      dots.forEach((p, i) => filters.push(`[dsrc${i}]scale=${p.size}:${p.size}[d${i}]`));
    }
    if (embers.length > 0) {
      filters.push(`[${emberInput}:v]split=${embers.length}${embers.map((_, i) => `[esrc${i}]`).join("")}`);
      embers.forEach((p, i) => filters.push(`[esrc${i}]scale=${p.size}:${p.size}[e${i}]`));
    }
    const overlayAll = [
      ...dots.map((p, i) => ({ p, label: `d${i}` })),
      ...embers.map((p, i) => ({ p, label: `e${i}` })),
    ];
    overlayAll.forEach(({ p, label }) => {
      const x = `W*${p.xc.toFixed(3)}+${p.amp.toFixed(1)}*sin(2*PI*t/${p.period.toFixed(2)}+${p.phase.toFixed(2)})-w/2`;
      const y = `H+90-mod(t*${p.speed.toFixed(1)}+${p.init.toFixed(0)},H+180)-h/2`;
      const o = `fx${labelN++}`;
      filters.push(`[${chain}][${label}]overlay=x='${x}':y='${y}'[${o}]`);
      chain = o;
    });
  }

  filters.push(`[${chain}]gblur=sigma=0.8,format=yuv420p[v]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-r", String(fps), "-t", f3(loopSec),
    "-y", out
  );
  log(runId, "info", `Pre-rendering ${loopSec}s FX loop (once for the whole video)…`, "render");
  await runFfmpeg(args, 20 * 60 * 1000);
  return { path: out, loopSec };
}

export async function renderAllScenes(
  runId: string,
  runDirPath: string,
  scenes: Scene[],
  globalCues: SubtitleCue[],
  images: Map<number, string>,
  width: number,
  height: number,
  fps: number
): Promise<RenderedClip[]> {
  const clipsDir = ensureDir(path.join(runDirPath, "clips"));
  const assets = await ensureBaseAssets(width, height);
  const fxLoop = await prerenderFxLoop(runId, runDirPath, assets, width, height, fps);
  checkCancelled(runId);
  const concurrency = Math.max(1, Math.round(getNumber("RENDER_CONCURRENCY", 2)));
  const limit = pLimit(concurrency);

  let done = 0;
  const clips = new Array<RenderedClip>(scenes.length);
  await Promise.all(
    scenes.map((scene, i) =>
      limit(async () => {
        checkCancelled(runId);
        const dur = Math.max(0.5, scene.endSec - scene.startSec);
        const file = path.join(clipsDir, `clip_${String(scene.index).padStart(4, "0")}.mp4`);
        await renderSegmentClip({
          runId,
          sceneIndex: scene.index,
          durationSec: dur,
          // cues are sliced from the global timeline and offset to clip-local time
          cues: sliceCues(globalCues, scene.startSec, scene.endSec),
          imagePath: images.get(scene.index) ?? null,
          // FX phase stays continuous across cuts: offset = scene's start in the video
          startOffsetSec: scene.startSec,
          outFile: file,
          width,
          height,
          fps,
          assets,
          fxLoopPath: fxLoop?.path ?? null,
          fxLoopSec: fxLoop?.loopSec ?? 0,
        });
        clips[i] = { index: scene.index, file, durationSec: dur };
        done++;
        log(runId, "info", `Rendered clip ${done}/${scenes.length}`, "render");
      })
    )
  );
  return clips;
}
