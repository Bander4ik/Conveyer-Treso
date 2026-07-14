import fs from "fs";
import path from "path";
import { getBool, getNumber, getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { ensureDir } from "../paths";
import { pLimit } from "../plimit";
import { probeDuration, runFfmpeg } from "./ffmpeg";
import { ttsToFile as genaiproTts, exportSubtitlesRaw } from "./genaipro";
import { elevenLabsToFile } from "./elevenlabs";
import { parseSubtitleFile, type SubtitleCue } from "./subtitles";

export type VoiceMode = "manual" | "elevenlabs" | "genaipro";

/** A spoken word with its start time in the full continuous voiceover. */
export interface TimedWord {
  t: number;
  word: string;
}

/** One continuous voiceover for the whole video + its speech timeline. */
export interface VoiceTimeline {
  /** single audio file laid over the entire video */
  voiceoverFile: string;
  totalSec: number;
  /** subtitle cues over the WHOLE narration (empty if no timecodes available) */
  cues: SubtitleCue[];
  /** per-word timestamps over the whole narration (empty if no timecodes) */
  words: TimedWord[];
}

function splitSentences(text: string): string[] {
  // keep the delimiter with the sentence
  const parts = text.trim().split(/(?<=[.!?…])\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Split a script into chunks no larger than maxChars, only at sentence ends. */
export function chunkScript(script: string, maxChars: number): string[] {
  const sentences = splitSentences(script);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur.length + 1 + s.length) > maxChars) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length > 0 ? chunks : [script.trim()];
}

/** Linear-interpolate per-word timestamps inside each cue, concatenated. */
export function buildWordTimeline(cues: SubtitleCue[]): TimedWord[] {
  const words: TimedWord[] = [];
  for (const cue of cues) {
    const cueWords = cue.text.split(/\s+/).filter(Boolean);
    if (cueWords.length === 0) continue;
    const span = Math.max(0.001, cue.end - cue.start);
    cueWords.forEach((w, i) => {
      words.push({ t: cue.start + (i / cueWords.length) * span, word: w });
    });
  }
  return words;
}

async function toWav(src: string, dest: string): Promise<void> {
  await runFfmpeg(["-i", src, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", "-y", dest]);
}

/** Voice a single chunk (provider-specific), returning mp3 + optional cues. */
async function synthChunk(
  runId: string,
  audioDir: string,
  mode: "genaipro" | "elevenlabs",
  index: number,
  text: string,
  wantSubs: boolean,
  voiceId?: string
): Promise<{ wav: string; cues: SubtitleCue[] }> {
  const pad = String(index).padStart(3, "0");
  const wav = path.join(audioDir, `chunk_${pad}.wav`);
  const srt = path.join(audioDir, `chunk_${pad}.srt`);

  // resume: a finished chunk wav (and its srt, if subs) is reused as-is
  if (fs.existsSync(wav) && fs.statSync(wav).size > 1000) {
    const cues = wantSubs && fs.existsSync(srt) ? parseSubtitleFile(fs.readFileSync(srt, "utf8")) : [];
    return { wav, cues };
  }

  const mp3 = path.join(audioDir, `chunk_${pad}.mp3`);
  let cues: SubtitleCue[] = [];
  if (mode === "genaipro") {
    const taskIdFile = path.join(audioDir, `chunk_${pad}.task`);
    const { taskId } = await genaiproTts(text, mp3, { runId, taskIdFile, voiceId });
    if (wantSubs) {
      try {
        const raw = await exportSubtitlesRaw(taskId, runId);
        if (raw) {
          fs.writeFileSync(srt, raw, "utf8");
          cues = parseSubtitleFile(raw);
        }
      } catch (e) {
        log(runId, "warn", `Subtitle timecodes failed for chunk ${index + 1} (${e instanceof Error ? e.message : e})`, "voice");
      }
    }
  } else {
    await elevenLabsToFile(text, mp3);
  }
  await toWav(mp3, wav);
  return { wav, cues };
}

function concatListFile(dir: string, name: string, files: string[]): string {
  const list = path.join(dir, name);
  const body = files
    .map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(list, body, "utf8");
  return list;
}

/**
 * Produces ONE continuous voiceover for the whole script (single-shot for short
 * scripts; large sentence-aligned chunks for long ones) plus a speech timeline.
 * Fully resumable: finished chunks and the whole timeline are cached on disk.
 */
export async function generateVoiceTimeline(
  runId: string,
  runDirPath: string,
  script: string,
  mode: VoiceMode,
  uploadedVoiceover: string | undefined,
  opts: { voiceId?: string } = {}
): Promise<VoiceTimeline> {
  const cacheFile = path.join(runDirPath, "voice.json");
  const cached = readVoiceCache(cacheFile);
  if (cached) {
    log(runId, "info", "Reusing voiceover from a previous run", "voice");
    return cached;
  }

  // Manual upload: a single ready file, no speech timecodes → even-time scenes.
  if (mode === "manual") {
    if (!uploadedVoiceover || !fs.existsSync(uploadedVoiceover)) {
      throw new Error("Manual voice mode requires an uploaded voiceover file");
    }
    const totalSec = await probeDuration(uploadedVoiceover);
    const result: VoiceTimeline = { voiceoverFile: uploadedVoiceover, totalSec, cues: [], words: [] };
    fs.writeFileSync(cacheFile, JSON.stringify(result), "utf8");
    log(runId, "info", `Voiceover (uploaded): ${fmt(totalSec)}`, "voice");
    return result;
  }

  const audioDir = ensureDir(path.join(runDirPath, "audio"));
  const maxChars = Math.max(1500, Math.round(getNumber("MAX_TTS_CHARS", 9000)));
  const wantSubs = getBool("SUBTITLES_ENABLED");
  const chunks = chunkScript(script, maxChars);
  log(
    runId,
    "info",
    `Single-shot voiceover via ${mode}: ${chunks.length === 1 ? "1 continuous take" : `${chunks.length} large continuous chunks`}${wantSubs ? " + speech timecodes" : ""}`,
    "voice"
  );

  // voice chunks in PARALLEL (a long 4h script is ~20+ chunks — doing them
  // serially is the main reason voicing dragged on)
  const concurrency = Math.max(1, Math.round(getNumber("TTS_CONCURRENCY", 3)));
  const limit = pLimit(concurrency);
  let voicedCount = 0;
  const chunkResults = await Promise.all(
    chunks.map((text, i) =>
      limit(async () => {
        checkCancelled(runId);
        const r = await synthChunk(runId, audioDir, mode, i, text, wantSubs, opts.voiceId);
        voicedCount++;
        if (chunks.length > 1) log(runId, "info", `Voiced chunk ${voicedCount}/${chunks.length}`, "voice");
        return r;
      })
    )
  );

  // then stitch in order: offset each chunk's cues by the running duration
  const wavs: string[] = [];
  const allCues: SubtitleCue[] = [];
  let offset = 0;
  for (const { wav, cues } of chunkResults) {
    for (const c of cues) {
      allCues.push({ start: c.start + offset, end: c.end + offset, text: c.text });
    }
    offset += await probeDuration(wav);
    wavs.push(wav);
  }

  // concatenate chunk wavs into one continuous voiceover (sample-exact)
  let voiceoverFile: string;
  if (wavs.length === 1) {
    voiceoverFile = wavs[0];
  } else {
    const list = concatListFile(runDirPath, "voice_concat.txt", wavs);
    voiceoverFile = path.join(runDirPath, "voiceover.wav");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-y", voiceoverFile]);
  }

  const totalSec = await probeDuration(voiceoverFile);
  const words = buildWordTimeline(allCues);
  const result: VoiceTimeline = { voiceoverFile, totalSec, cues: allCues, words };
  fs.writeFileSync(cacheFile, JSON.stringify(result), "utf8");
  log(
    runId,
    "success",
    `Voiceover ready — ${fmt(totalSec)}${allCues.length ? `, ${allCues.length} subtitle cues` : ""}`,
    "voice"
  );
  return result;
}

function readVoiceCache(cacheFile: string): VoiceTimeline | null {
  try {
    const v = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as VoiceTimeline;
    if (v && typeof v.voiceoverFile === "string" && fs.existsSync(v.voiceoverFile) && v.totalSec > 0) {
      return { voiceoverFile: v.voiceoverFile, totalSec: v.totalSec, cues: v.cues ?? [], words: v.words ?? [] };
    }
    return null;
  } catch {
    return null;
  }
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
