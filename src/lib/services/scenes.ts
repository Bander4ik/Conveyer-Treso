import fs from "fs";
import path from "path";
import { getNumber, getSetting } from "../settings";
import { log } from "../logger";
import { geminiText } from "./gemini";
import type { VoiceTimeline, TimedWord } from "./voice";

export interface Scene {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  visual_prompt: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Number of scenes so every scene lands in [min,max] seconds, aiming for the
 * midpoint (~16s). N must satisfy min ≤ T/N ≤ max ⇒ N ∈ [ceil(T/max), floor(T/min)].
 */
function sceneCount(totalSec: number, minSec: number, maxSec: number): number {
  const target = (minSec + maxSec) / 2;
  const nRaw = Math.round(totalSec / target);
  const nMin = Math.max(1, Math.ceil(totalSec / maxSec));
  const nMax = Math.max(1, Math.floor(totalSec / minSec));
  if (nMax < nMin) return nMin; // total shorter than minSec → a single short scene
  return clamp(nRaw, nMin, nMax);
}

function nearestWordTime(words: TimedWord[], target: number): number | null {
  if (words.length === 0) return null;
  let best = words[0].t;
  let bestD = Math.abs(words[0].t - target);
  for (const w of words) {
    const d = Math.abs(w.t - target);
    if (d < bestD) {
      bestD = d;
      best = w.t;
    }
  }
  return best;
}

/** Even time boundaries, each nudged to the nearest word — but only within a
 *  slack that keeps every scene inside [min,max]. Guarantees the duration rule. */
function sceneBoundaries(words: TimedWord[], totalSec: number, n: number, minSec: number, maxSec: number): number[] {
  const bounds: number[] = [0];
  const even = totalSec / n;
  for (let i = 1; i < n; i++) {
    const target = i * even;
    let cut = target;
    const snapped = nearestWordTime(words, target);
    if (snapped !== null) {
      // how far we may move this cut without pushing the prev/next scene out of range
      const prev = bounds[i - 1];
      const slackDown = Math.min(target - (prev + minSec), maxSec - (target - prev), 1.0);
      const slackUp = Math.min(maxSec - (snapped - prev), 1.0, even); // keep prev ≤ max
      const lo = target - Math.max(0, slackDown);
      const hi = target + Math.max(0, slackUp);
      if (snapped >= lo && snapped <= hi) cut = snapped;
    }
    bounds.push(cut);
  }
  bounds.push(totalSec);
  return bounds;
}

function textForWindow(words: TimedWord[], start: number, end: number): string {
  return words
    .filter((w) => w.t >= start - 0.001 && w.t < end - 0.001)
    .map((w) => w.word)
    .join(" ")
    .trim();
}

/** Cut the continuous narration into timed scenes (12–20s each by default). */
export function cutScenes(runId: string, runDirPath: string, voice: VoiceTimeline, script: string): Scene[] {
  const minSec = Math.max(4, getNumber("SCENE_MIN_SEC", 12));
  const maxSec = Math.max(minSec + 1, getNumber("SCENE_MAX_SEC", 20));
  const n = sceneCount(voice.totalSec, minSec, maxSec);
  const haveTimeline = voice.words.length > 0;

  const bounds = haveTimeline
    ? sceneBoundaries(voice.words, voice.totalSec, n, minSec, maxSec)
    : Array.from({ length: n + 1 }, (_, i) => (i * voice.totalSec) / n);

  // text per scene: from the speech timeline if we have it, else split the
  // script's words evenly (manual upload has no timecodes)
  const scriptWords = script.trim().split(/\s+/).filter(Boolean);
  const scenes: Scene[] = [];
  for (let i = 0; i < n; i++) {
    const startSec = round3(bounds[i]);
    const endSec = round3(bounds[i + 1]);
    let text: string;
    if (haveTimeline) {
      text = textForWindow(voice.words, bounds[i], bounds[i + 1]);
    } else {
      const a = Math.floor((i * scriptWords.length) / n);
      const b = Math.floor(((i + 1) * scriptWords.length) / n);
      text = scriptWords.slice(a, b).join(" ");
    }
    scenes.push({ index: i, startSec, endSec, text: text || "(no narration)", visual_prompt: "" });
  }

  const durs = scenes.map((s) => s.endSec - s.startSec);
  log(
    runId,
    "info",
    `Cut into ${scenes.length} scenes of ${Math.min(...durs).toFixed(1)}–${Math.max(...durs).toFixed(1)}s` +
      (haveTimeline ? " (real speech timecodes)" : " (even split — no timecodes)"),
    "scenes"
  );
  fs.writeFileSync(path.join(runDirPath, "scenes.json"), JSON.stringify(scenes, null, 2), "utf8");
  return scenes;
}

/** Loads scenes.json for resume; null if absent/invalid. */
export function loadScenesIfPresent(runDirPath: string): Scene[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runDirPath, "scenes.json"), "utf8")) as Scene[];
    if (Array.isArray(data) && data.length > 0 && typeof data[0]?.startSec === "number") return data;
    return null;
  } catch {
    return null;
  }
}

/** One Gemini call: write an image prompt for each scene's narration. */
export async function describeScenes(runId: string, runDirPath: string, scenes: Scene[]): Promise<Scene[]> {
  if (scenes.every((s) => s.visual_prompt)) return scenes; // already described (resume)
  const system = getSetting("SCENE_DESCRIBE_PROMPT");
  const input = JSON.stringify(scenes.map((s) => ({ index: s.index, text: s.text })));
  log(runId, "info", `Writing image prompts for ${scenes.length} scenes…`, "scenes");

  const raw = await geminiText(system, `Scenes:\n${input}`, { temperature: 0.7 });
  let parsed: { index?: number; visual_prompt?: string }[] = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) parsed = JSON.parse(m[0]);
  }
  const byIndex = new Map<number, string>();
  for (const p of Array.isArray(parsed) ? parsed : []) {
    if (typeof p.index === "number" && typeof p.visual_prompt === "string") {
      byIndex.set(p.index, p.visual_prompt.trim());
    }
  }

  const styleFallback =
    "ancient ornate glowing grimoire on a pedestal, magic circle, golden mystical energy, deep shadows, epic cinematic";
  let missing = 0;
  const out = scenes.map((s) => {
    const vp = byIndex.get(s.index);
    if (!vp) missing++;
    return { ...s, visual_prompt: vp || styleFallback };
  });
  if (missing > 0) log(runId, "warn", `${missing} scene(s) had no prompt — used a generic mystical one`, "scenes");

  fs.writeFileSync(path.join(runDirPath, "scenes.json"), JSON.stringify(out, null, 2), "utf8");
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
