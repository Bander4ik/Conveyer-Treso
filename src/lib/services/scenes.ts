import fs from "fs";
import path from "path";
import { getBool, getNumber, getSetting } from "../settings";
import { log } from "../logger";
import { geminiText } from "./gemini";
import type { VoiceTimeline, TimedWord } from "./voice";

/** What a scene's visuals come from. */
export type SceneSource = "ai-image" | "ai-video" | "stock-video" | "stock-image";

export interface Scene {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  visual_prompt: string;
  /** planned visual source (ai-image when the mix is disabled) */
  source: SceneSource;
  /** short literal real-world search phrase for stock libraries (Gemini-written) */
  real_query?: string;
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
      const prev = bounds[i - 1];
      const slackDown = Math.min(target - (prev + minSec), maxSec - (target - prev), 1.0);
      const slackUp = Math.min(maxSec - (snapped - prev), 1.0, even);
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

/** Text for a window when there is NO speech timeline (manual upload): split the
 *  script words proportionally to the window's share of the total duration. */
function textByProportion(scriptWords: string[], start: number, end: number, totalSec: number): string {
  if (totalSec <= 0) return "";
  const a = Math.floor((start / totalSec) * scriptWords.length);
  const b = Math.floor((end / totalSec) * scriptWords.length);
  return scriptWords.slice(a, b).join(" ");
}

/**
 * Deterministic ratio picker (water-filling): emits scene sources so that, at
 * every step, the type with the largest deficit vs its target share wins. This
 * spreads the four sources evenly through the video instead of clumping them.
 */
function makeTypePicker(): () => SceneSource {
  const raw: [SceneSource, number][] = [
    ["ai-image", getNumber("MIX_AI_IMAGE_PCT", 30)],
    ["ai-video", getNumber("MIX_AI_VIDEO_PCT", 20)],
    ["stock-video", getNumber("MIX_STOCK_VIDEO_PCT", 25)],
    ["stock-image", getNumber("MIX_STOCK_IMAGE_PCT", 25)],
  ];
  const weights = raw.filter(([, w]) => w > 0);
  if (weights.length === 0) return () => "ai-image";
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const fracs = weights.map(([s, w]) => [s, w / total] as [SceneSource, number]);
  const emitted = new Map<SceneSource, number>(fracs.map(([s]) => [s, 0]));
  let n = 0;
  return () => {
    n++;
    let best = fracs[0][0];
    let bestDeficit = -Infinity;
    for (const [s, frac] of fracs) {
      const deficit = frac * n - (emitted.get(s) ?? 0);
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = s;
      }
    }
    emitted.set(best, (emitted.get(best) ?? 0) + 1);
    return best;
  };
}

/**
 * MIXED-media cut: walk the timeline, picking a source per scene by the ratio.
 * AI-video scenes are cut SHORT (≈ the Veo clip's own length) so the clip fills
 * them without stretch/freeze; every other scene stays the normal 12–20s.
 */
function cutScenesMixed(voice: VoiceTimeline, script: string): Scene[] {
  const minSec = Math.max(4, getNumber("SCENE_MIN_SEC", 12));
  const maxSec = Math.max(minSec + 1, getNumber("SCENE_MAX_SEC", 20));
  const midSec = (minSec + maxSec) / 2;
  const aiVidSec = clamp(getNumber("AI_VIDEO_SCENE_SEC", 8), 4, maxSec);
  const total = voice.totalSec;
  const words = voice.words;
  const haveTimeline = words.length > 0;
  const scriptWords = script.trim().split(/\s+/).filter(Boolean);

  const pick = makeTypePicker();
  const scenes: Scene[] = [];
  let cursor = 0;
  let idx = 0;

  while (total - cursor > 0.5) {
    const remaining = total - cursor;
    const source = pick();
    const floorSec = source === "ai-video" ? 4 : minSec;

    // small tail → make it the final single scene
    if (remaining <= maxSec + 0.5) {
      scenes.push(buildScene(idx++, cursor, total, source, haveTimeline, words, scriptWords, total));
      cursor = total;
      break;
    }

    let end = cursor + (source === "ai-video" ? aiVidSec : midSec);
    if (haveTimeline) {
      const snapped = nearestWordTime(words, end);
      if (snapped !== null) {
        const dur = snapped - cursor;
        if (Math.abs(snapped - end) <= 1.0 && dur >= floorSec && dur <= maxSec) end = snapped;
      }
    }
    end = Math.min(end, total);
    scenes.push(buildScene(idx++, cursor, end, source, haveTimeline, words, scriptWords, total));
    cursor = end;
  }

  // merge a too-short trailing scene into its predecessor
  if (scenes.length >= 2) {
    const last = scenes[scenes.length - 1];
    if (last.endSec - last.startSec < 4) {
      const prev = scenes[scenes.length - 2];
      prev.endSec = last.endSec;
      prev.text = haveTimeline
        ? textForWindow(words, prev.startSec, prev.endSec) || prev.text
        : textByProportion(scriptWords, prev.startSec, prev.endSec, total) || prev.text;
      scenes.pop();
    }
  }
  return scenes;
}

function buildScene(
  index: number,
  startSec: number,
  endSec: number,
  source: SceneSource,
  haveTimeline: boolean,
  words: TimedWord[],
  scriptWords: string[],
  totalSec: number
): Scene {
  const text = haveTimeline
    ? textForWindow(words, startSec, endSec)
    : textByProportion(scriptWords, startSec, endSec, totalSec);
  return { index, startSec: round3(startSec), endSec: round3(endSec), text: text || "(no narration)", visual_prompt: "", source, real_query: "" };
}

/** Cut the continuous narration into timed scenes (mixed sources when enabled,
 *  else 12–20s all-AI-image scenes). */
export function cutScenes(runId: string, runDirPath: string, voice: VoiceTimeline, script: string): Scene[] {
  const mix = getBool("VISUAL_MIX_ENABLED");
  let scenes: Scene[];

  if (mix) {
    scenes = cutScenesMixed(voice, script);
  } else {
    const minSec = Math.max(4, getNumber("SCENE_MIN_SEC", 12));
    const maxSec = Math.max(minSec + 1, getNumber("SCENE_MAX_SEC", 20));
    const n = sceneCount(voice.totalSec, minSec, maxSec);
    const haveTimeline = voice.words.length > 0;
    const bounds = haveTimeline
      ? sceneBoundaries(voice.words, voice.totalSec, n, minSec, maxSec)
      : Array.from({ length: n + 1 }, (_, i) => (i * voice.totalSec) / n);
    const scriptWords = script.trim().split(/\s+/).filter(Boolean);
    scenes = [];
    for (let i = 0; i < n; i++) {
      scenes.push(
        buildScene(i, bounds[i], bounds[i + 1], "ai-image", haveTimeline, voice.words, scriptWords, voice.totalSec)
      );
    }
  }

  const durs = scenes.map((s) => s.endSec - s.startSec);
  const counts = scenes.reduce<Record<string, number>>((m, s) => ((m[s.source] = (m[s.source] ?? 0) + 1), m), {});
  const mixLabel = mix ? ` — mix ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}` : "";
  log(
    runId,
    "info",
    `Cut into ${scenes.length} scenes of ${Math.min(...durs).toFixed(1)}–${Math.max(...durs).toFixed(1)}s` +
      (voice.words.length > 0 ? " (real speech timecodes)" : " (even split — no timecodes)") +
      mixLabel,
    "scenes"
  );
  fs.writeFileSync(path.join(runDirPath, "scenes.json"), JSON.stringify(scenes, null, 2), "utf8");
  return scenes;
}

/** Loads scenes.json for resume; null if absent/invalid. */
export function loadScenesIfPresent(runDirPath: string): Scene[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runDirPath, "scenes.json"), "utf8")) as Scene[];
    if (Array.isArray(data) && data.length > 0 && typeof data[0]?.startSec === "number") {
      // back-compat: older runs have no `source` — default to ai-image
      return data.map((s) => ({ ...s, source: s.source ?? "ai-image" }));
    }
    return null;
  } catch {
    return null;
  }
}

/** One Gemini call: write an image prompt (+ a stock search query) per scene. */
export async function describeScenes(runId: string, runDirPath: string, scenes: Scene[]): Promise<Scene[]> {
  if (scenes.every((s) => s.visual_prompt && s.real_query !== undefined && s.real_query !== "")) return scenes; // already described (resume)
  const system = getSetting("SCENE_DESCRIBE_PROMPT");
  const input = JSON.stringify(scenes.map((s) => ({ index: s.index, text: s.text })));
  log(runId, "info", `Writing image prompts for ${scenes.length} scenes…`, "scenes");

  const raw = await geminiText(system, `Scenes:\n${input}`, { temperature: 0.7 });
  let parsed: { index?: number; visual_prompt?: string; real_query?: string }[] = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) parsed = JSON.parse(m[0]);
  }
  const byIndex = new Map<number, { visual_prompt: string; real_query: string }>();
  for (const p of Array.isArray(parsed) ? parsed : []) {
    if (typeof p.index === "number" && typeof p.visual_prompt === "string") {
      byIndex.set(p.index, { visual_prompt: p.visual_prompt.trim(), real_query: (p.real_query ?? "").trim() });
    }
  }

  const styleFallback =
    "ancient ornate glowing grimoire on a pedestal, magic circle, golden mystical energy, deep shadows, epic cinematic";
  let missing = 0;
  const out = scenes.map((s) => {
    const got = byIndex.get(s.index);
    if (!got) missing++;
    return {
      ...s,
      visual_prompt: got?.visual_prompt || s.visual_prompt || styleFallback,
      real_query: got?.real_query || s.real_query || "",
    };
  });
  if (missing > 0) log(runId, "warn", `${missing} scene(s) had no prompt — used a generic mystical one`, "scenes");

  fs.writeFileSync(path.join(runDirPath, "scenes.json"), JSON.stringify(out, null, 2), "utf8");
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
