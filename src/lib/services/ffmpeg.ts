import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getSetting } from "../settings";
import { baseAssetsDir } from "../paths";
import { getPalette } from "../palettes";

export function ffmpegBin(): string {
  const p = getSetting("FFMPEG_PATH").trim();
  return p || "ffmpeg";
}

export function ffprobeBin(): string {
  const p = getSetting("FFMPEG_PATH").trim();
  if (!p) return "ffprobe";
  // sibling of the configured ffmpeg binary
  const dir = path.dirname(p);
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidate = path.join(dir, `ffprobe${ext}`);
  return fs.existsSync(candidate) ? candidate : "ffprobe";
}

/** Run ffmpeg/ffprobe with args (no shell — safe for paths with spaces). */
export function runBin(bin: string, args: string[], timeoutMs = 30 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 60_000) stderr = stderr.slice(-30_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to start ${bin}: ${e.message}. Is FFmpeg installed and on PATH (or set FFMPEG_PATH in Settings)?`
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(bin)} exited with code ${code}:\n${stderr.slice(-2500)}`));
    });
  });
}

export function runFfmpeg(args: string[], timeoutMs?: number): Promise<string> {
  return runBin(ffmpegBin(), ["-hide_banner", "-loglevel", "error", ...args], timeoutMs);
}

/** Media duration in seconds via ffprobe. */
export async function probeDuration(file: string): Promise<number> {
  const out = await runBin(
    ffprobeBin(),
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    60_000
  );
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Could not read duration of ${file}`);
  return d;
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const out = await runBin(
    ffprobeBin(),
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
    60_000
  );
  return out.trim().length > 0;
}

export interface BaseAssets {
  dot: string;
  ember: string;
  darkbg: string;
  glow: string;
}

/**
 * Generate the reusable FX assets once (pure ffmpeg — no binary files shipped):
 *  - dot / ember: tiny RGBA sprites with gaussian alpha (composite cleanly
 *    over the edge glow, no black-square halos)
 *  - darkbg: palette-tinted dark gradient backdrop
 *  - glow: big soft palette-colored blob for the travelling edge glow
 */
export async function ensureBaseAssets(width: number, height: number): Promise<BaseAssets> {
  const dir = baseAssetsDir();
  const pal = getPalette();
  const dot = path.join(dir, "dot_rgba.png");
  const ember = path.join(dir, "ember_rgba.png");
  const darkbg = path.join(dir, `darkbg_${pal.id}_${width}x${height}.png`);
  const glow = path.join(dir, `glow_${pal.id}.png`);

  if (!fs.existsSync(dot)) {
    await runFfmpeg([
      "-f", "lavfi", "-i", "color=black:s=64x64,format=gbrap",
      "-vf", "geq=r='255':g='255':b='255':a='255*exp(-((X-32)*(X-32)+(Y-32)*(Y-32))/180)'",
      "-frames:v", "1", "-y", dot,
    ]);
  }
  if (!fs.existsSync(ember)) {
    await runFfmpeg([
      "-f", "lavfi", "-i", "color=black:s=64x64,format=gbrap",
      "-vf",
      "geq=r='255':g='150':b='40':a='255*exp(-((X-32)*(X-32)+(Y-32)*(Y-32))/150)'",
      "-frames:v", "1", "-y", ember,
    ]);
  }
  if (!fs.existsSync(darkbg)) {
    const x0 = Math.round(width * 0.885);
    const y0 = Math.round(height * 0.88);
    const x1 = Math.round(width * 0.21);
    const y1 = Math.round(height * 0.074);
    await runFfmpeg([
      "-f", "lavfi", "-i",
      `gradients=s=${width}x${height}:c0=0x${pal.bg0}:c1=0x000000:x0=${x0}:y0=${y0}:x1=${x1}:y1=${y1}`,
      "-frames:v", "1", "-y", darkbg,
    ]);
  }
  if (!fs.existsSync(glow)) {
    // 512x512 soft gaussian blob in the palette color; semi-transparent peak —
    // it gets scaled up to ~60% of frame width at render time
    await runFfmpeg([
      "-f", "lavfi", "-i", "color=black:s=512x512,format=gbrap",
      "-vf",
      `geq=r='${pal.glow.r}':g='${pal.glow.g}':b='${pal.glow.b}':a='200*exp(-((X-256)*(X-256)+(Y-256)*(Y-256))/20000)'`,
      "-frames:v", "1", "-y", glow,
    ]);
  }
  return { dot, ember, darkbg, glow };
}
