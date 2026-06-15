import fs from "fs";
import path from "path";
import { getNumber } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { findUserAsset, listMusicTracks, ensureDir } from "../paths";
import { probeDuration, runFfmpeg } from "./ffmpeg";
import type { RenderedClip } from "./render";

function concatListFile(dir: string, name: string, files: string[]): string {
  const list = path.join(dir, name);
  const body = files
    .map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(list, body, "utf8");
  return list;
}

/**
 * One or more user tracks → a single playlist file that the final mux loops
 * endlessly (track1, track2, …, track1, …). Tracks are normalized to one
 * format first so the concat is gapless and codec-safe.
 */
async function buildMusicPlaylist(runId: string, runDirPath: string): Promise<string | null> {
  const tracks = listMusicTracks();
  if (tracks.length === 0) return null;
  if (tracks.length === 1) {
    log(runId, "info", `Music bed: ${path.basename(tracks[0])} (looped)`, "assemble");
    return tracks[0];
  }
  const wavDir = ensureDir(path.join(runDirPath, "audio", "music"));
  const wavs: string[] = [];
  for (let i = 0; i < tracks.length; i++) {
    checkCancelled(runId);
    const wav = path.join(wavDir, `track_${String(i).padStart(2, "0")}.wav`);
    await runFfmpeg(["-i", tracks[i], "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", "-y", wav]);
    wavs.push(wav);
  }
  const list = concatListFile(runDirPath, "music_concat.txt", wavs);
  const playlist = path.join(runDirPath, "music_playlist.m4a");
  await runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", list,
    "-c:a", "aac", "-b:a", "192k", "-y", playlist,
  ]);
  log(
    runId,
    "info",
    `Music bed: playlist of ${tracks.length} tracks (${tracks.map((t) => path.basename(t)).join(" → ")}), looped`,
    "assemble"
  );
  return playlist;
}

/** Normalize the user's intro clip to match body encoding (video only). */
async function normalizeIntro(
  runId: string,
  runDirPath: string,
  introSrc: string,
  width: number,
  height: number,
  fps: number
): Promise<{ file: string; durationSec: number }> {
  const out = path.join(runDirPath, "intro_normalized.mp4");
  await runFfmpeg([
    "-i", introSrc,
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},setsar=1,format=yuv420p`,
    "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-r", String(fps), "-movflags", "+faststart",
    "-y", out,
  ]);
  const durationSec = await probeDuration(out);
  log(runId, "info", `Intro attached (${durationSec.toFixed(1)}s)`, "assemble");
  return { file: out, durationSec };
}

export interface AssembleResult {
  outputPath: string;
  durationSec: number;
}

export async function assembleVideo(
  runId: string,
  runDirPath: string,
  clips: RenderedClip[],
  voiceoverFile: string,
  width: number,
  height: number,
  fps: number
): Promise<AssembleResult> {
  // 1) concat all scene clips (video-only, identical encode params → stream copy)
  log(runId, "info", `Concatenating ${clips.length} clips…`, "assemble");
  const ordered = [...clips].sort((a, b) => a.index - b.index);
  const bodyList = concatListFile(runDirPath, "clips_concat.txt", ordered.map((c) => c.file));
  const body = path.join(runDirPath, "body.mp4");
  await runFfmpeg(["-f", "concat", "-safe", "0", "-i", bodyList, "-c", "copy", "-movflags", "+faststart", "-y", body]);
  checkCancelled(runId);

  // 2) optional intro splash (заставка) — video joins silently; the whoosh,
  //    if wanted, should be part of the music bed
  let full = body;
  let introDur = 0;
  const introSrc = findUserAsset("intro", ["mp4", "mov", "webm"]);
  if (introSrc) {
    const intro = await normalizeIntro(runId, runDirPath, introSrc, width, height, fps);
    introDur = intro.durationSec;
    const fullList = concatListFile(runDirPath, "full_concat.txt", [intro.file, body]);
    full = path.join(runDirPath, "full.mp4");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", fullList, "-c", "copy", "-movflags", "+faststart", "-y", full]);
  } else {
    log(runId, "info", "No intro.mp4 in assets folder — skipping splash", "assemble");
  }
  checkCancelled(runId);

  // 3) final mux: video (copy) + single continuous voiceover (delayed past
  //    intro) + looped music bed
  const voiceFile = voiceoverFile;
  const totalDur = await probeDuration(full);
  const musicSrc = await buildMusicPlaylist(runId, runDirPath);
  const musicVol = Math.max(0, getNumber("MUSIC_VOLUME", 0.1));
  const musicFade = Math.max(0.5, getNumber("MUSIC_FADE_OUT", 4));
  const introMs = Math.round(introDur * 1000);

  const outputPath = path.join(runDirPath, "final.mp4");
  const args: string[] = ["-i", full, "-i", voiceFile];
  // aformat upmixes a mono voiceover to stereo so adelay/amix behave predictably
  let filter = `[1:a]aresample=44100,aformat=channel_layouts=stereo`;
  if (introMs > 0) filter += `,adelay=${introMs}|${introMs}`;
  filter += `[vo]`;

  if (musicSrc) {
    args.push("-stream_loop", "-1", "-i", musicSrc);
    filter +=
      `;[2:a]aresample=44100,aformat=channel_layouts=stereo,volume=${musicVol.toFixed(3)}[mu]` +
      `;[vo][mu]amix=inputs=2:duration=longest:normalize=0` +
      `,afade=t=out:st=${Math.max(0, totalDur - musicFade).toFixed(2)}:d=${musicFade.toFixed(2)}[aout]`;
  } else {
    filter += `;[vo]apad[aout]`;
    log(runId, "info", "No music in assets folder (music.mp3 or assets/music/*) — voice only", "assemble");
  }

  args.push(
    "-filter_complex", filter,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
    "-t", totalDur.toFixed(3),
    "-movflags", "+faststart",
    "-y", outputPath
  );
  await runFfmpeg(args, 60 * 60 * 1000);

  const finalDur = await probeDuration(outputPath);
  log(runId, "success", `Final video ready: ${finalDur.toFixed(1)}s`, "assemble");
  return { outputPath, durationSec: finalDur };
}
