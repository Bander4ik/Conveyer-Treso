import fs from "fs";
import path from "path";
import { DATA_DIR, ensureDir } from "./paths";

export const SETTING_KEYS = [
  // ── API keys ──
  "GOOGLE_API_KEY",
  "GENAIPRO_API_KEY",
  "ELEVENLABS_API_KEY",
  // ── Models ──
  "TEXT_MODEL",
  "IMAGE_MODEL",
  // ── Scenes (single-shot: voice first, then cut into timed scenes) ──
  "SCENE_MIN_SEC",
  "SCENE_MAX_SEC",
  "MAX_TTS_CHARS",
  "SCENE_DESCRIBE_PROMPT",
  // legacy (per-segment split) — kept for back-compat, unused by the pipeline
  "SEGMENT_TARGET_WORDS",
  "SEGMENT_PROMPT",
  // ── Images ──
  "IMAGE_PROVIDER", // "gemini" | "genaipro"
  "GENAIPRO_IMAGE_MODEL",
  "IMAGE_STYLE_SUFFIX",
  "MAX_UNIQUE_IMAGES",
  "IMAGE_CONCURRENCY",
  // ── Voice ──
  "VOICE_MODE", // "genaipro" | "manual" | "elevenlabs"
  "GENAIPRO_VOICE_ID",
  "GENAIPRO_TTS_MODEL",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_MODEL",
  "TTS_SPEED",
  "TTS_STABILITY",
  "TTS_SIMILARITY",
  "TTS_CONCURRENCY",
  "TTS_TASK_TIMEOUT_MIN",
  "TAIL_SILENCE",
  // ── Look & motion ──
  "VIDEO_PALETTE",
  "VIDEO_RESOLUTION",
  "VIDEO_FPS",
  "ZOOM_AMOUNT",
  "IMAGE_HOLD_SECONDS",
  "FADE_IN_SECONDS",
  "FADE_OUT_SECONDS",
  "EDGE_FADE_SECONDS",
  "PARTICLES_ENABLED",
  "PARTICLE_COUNT",
  "EDGE_GLOW_ENABLED",
  "EDGE_GLOW_STRENGTH",
  "EDGE_GLOW_SIZE",
  "EDGE_GLOW_PERIOD",
  "FLICKER_ENABLED",
  "FLICKER_STRENGTH",
  // ── Subtitles ──
  "SUBTITLES_ENABLED",
  "SUBTITLE_FONT",
  "SUBTITLE_FONT_SIZE",
  "SUBTITLE_MAX_CHARS",
  "SUBTITLE_MARGIN_V",
  // ── Audio bed ──
  "MUSIC_VOLUME",
  "MUSIC_FADE_OUT",
  // ── System ──
  "FFMPEG_PATH",
  "RUNS_OUTPUT_DIR",
  "RENDER_CONCURRENCY",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const DEFAULT_SEGMENT_PROMPT = `You are the editor of a faceless YouTube channel about manifestation, universal energy, spirituality and ancient wisdom (similar to "hermetic secrets" channels). The narration language of the script must be preserved exactly as written (it may be Spanish, English or any other language).

Split the provided script into SEGMENTS for an automated "animated stills" video pipeline. Each segment will be shown as ONE mystical AI-generated image with a slow cinematic zoom while the narration plays.

CRITICAL RULES:
1. Cover the ENTIRE script verbatim with NO omissions, no summarizing, no paraphrasing, no reordering.
2. The concatenation of every segment's "text" (joined by spaces) MUST equal the original script word-for-word.
3. NEVER split a sentence in the middle. Segments end only at sentence boundaries (. ? ! …).
4. TARGET SEGMENT LENGTH: about {TARGET_WORDS} words (roughly 15-25 seconds of narration). Hard range: 25 to {MAX_WORDS} words unless a single sentence is longer by itself.
5. Group sentences that belong to the same idea into the same segment.

For EACH segment return:
- "text": the exact verbatim slice of the script.
- "visual_prompt": a 40-80 word ENGLISH prompt for an AI image generator. The image MUST VISUALLY MATCH this exact segment: take the segment's key idea, subject or metaphor and express it through this visual world: ancient ornate grimoires and spellbooks, glowing runes and sigils, magic circles, candlelight, golden energy, cosmic light, old libraries, hourglasses, keys, scrolls, hands holding glowing objects, starry skies, temples. Someone watching with the narration should feel the picture talks about the same thing. NO text or letters in the image, no real people's faces, no modern objects. Composition must look epic and cinematic with a clear central subject and deep shadows around it.

Return STRICTLY a valid JSON array of objects with keys "text" and "visual_prompt" — no markdown, no commentary.`;

export const DEFAULT_IMAGE_STYLE_SUFFIX =
  "dark mystical occult atmosphere, ancient magical aesthetic, ornate intricate details, glowing golden-orange energy and embers, deep shadows surrounding the subject, rich textures, volumetric candlelight, epic cinematic digital painting, centered composition";

/**
 * Single-shot pipeline: the script is voiced first, then cut into timed scenes
 * by the real speech timecodes. Gemini only writes ONE image prompt per scene
 * (it does NOT split or re-time anything).
 */
export const DEFAULT_SCENE_DESCRIBE_PROMPT = `You write image prompts for a faceless YouTube channel about manifestation, universal energy, spirituality and ancient wisdom (like "hermetic secrets" channels).

You receive a JSON array of narration scenes, each: {"index": number, "text": "<the exact narration spoken during this scene>"}.

For EACH scene, write ONE image prompt that VISUALLY MATCHES that scene's narration — take its key idea, subject or metaphor and express it through this visual world: ancient ornate grimoires and spellbooks, glowing runes and sigils, magic circles, candlelight, golden energy, cosmic light, old libraries, hourglasses, keys, scrolls, hands holding glowing objects, starry skies, temples. Someone watching with the narration must feel the picture is about the same thing.

Each prompt: 40-80 words, ENGLISH, no text or letters in the image, no real people's faces, no modern objects, epic cinematic composition with a clear central subject and deep shadows.

Return STRICTLY a valid JSON array of objects {"index": number, "visual_prompt": "..."} with one entry per input scene, same indexes — no markdown, no commentary.`;

export const DEFAULTS: Record<SettingKey, string> = {
  GOOGLE_API_KEY: "",
  GENAIPRO_API_KEY: "",
  ELEVENLABS_API_KEY: "",
  TEXT_MODEL: "gemini-flash-latest",
  IMAGE_MODEL: "gemini-2.5-flash-image",
  SCENE_MIN_SEC: "12",
  SCENE_MAX_SEC: "20",
  MAX_TTS_CHARS: "9000",
  SCENE_DESCRIBE_PROMPT: DEFAULT_SCENE_DESCRIBE_PROMPT,
  SEGMENT_TARGET_WORDS: "45",
  SEGMENT_PROMPT: DEFAULT_SEGMENT_PROMPT,
  IMAGE_PROVIDER: "gemini",
  GENAIPRO_IMAGE_MODEL: "nano_banana_pro",
  IMAGE_STYLE_SUFFIX: DEFAULT_IMAGE_STYLE_SUFFIX,
  MAX_UNIQUE_IMAGES: "60",
  IMAGE_CONCURRENCY: "2",
  VOICE_MODE: "genaipro",
  GENAIPRO_VOICE_ID: "",
  GENAIPRO_TTS_MODEL: "eleven_multilingual_v2",
  ELEVENLABS_VOICE_ID: "",
  ELEVENLABS_MODEL: "eleven_multilingual_v2",
  TTS_SPEED: "1.0",
  TTS_STABILITY: "0.5",
  TTS_SIMILARITY: "0.75",
  TTS_CONCURRENCY: "3",
  TTS_TASK_TIMEOUT_MIN: "15",
  TAIL_SILENCE: "0.35",
  VIDEO_PALETTE: "golden-fire",
  VIDEO_RESOLUTION: "1920x1080",
  VIDEO_FPS: "30",
  ZOOM_AMOUNT: "0.12",
  IMAGE_HOLD_SECONDS: "30",
  FADE_IN_SECONDS: "1.0",
  FADE_OUT_SECONDS: "2.5",
  EDGE_FADE_SECONDS: "0.8",
  PARTICLES_ENABLED: "true",
  PARTICLE_COUNT: "8",
  EDGE_GLOW_ENABLED: "true",
  EDGE_GLOW_STRENGTH: "0.55",
  EDGE_GLOW_SIZE: "0.62",
  EDGE_GLOW_PERIOD: "26",
  FLICKER_ENABLED: "true",
  FLICKER_STRENGTH: "0.015",
  SUBTITLES_ENABLED: "true",
  SUBTITLE_FONT: "Georgia",
  SUBTITLE_FONT_SIZE: "72",
  SUBTITLE_MAX_CHARS: "34",
  SUBTITLE_MARGIN_V: "70",
  MUSIC_VOLUME: "0.10",
  MUSIC_FADE_OUT: "4",
  FFMPEG_PATH: "",
  RUNS_OUTPUT_DIR: "",
  RENDER_CONCURRENCY: "3",
};

const SECRET_HINTS = ["KEY", "TOKEN", "SECRET"];

function settingsFile(): string {
  ensureDir(DATA_DIR);
  return path.join(DATA_DIR, "settings.json");
}

function readAll(): Partial<Record<SettingKey, string>> {
  try {
    const raw = fs.readFileSync(settingsFile(), "utf8");
    return JSON.parse(raw) as Partial<Record<SettingKey, string>>;
  } catch {
    return {};
  }
}

export function getSetting(key: SettingKey): string {
  const all = readAll();
  const v = all[key];
  if (v !== undefined && v !== "") return v;
  const env = process.env[key];
  if (env !== undefined && env !== "") return env;
  return DEFAULTS[key];
}

export function getNumber(key: SettingKey, fallback?: number): number {
  const n = parseFloat(getSetting(key));
  if (Number.isFinite(n)) return n;
  const d = parseFloat(DEFAULTS[key]);
  return Number.isFinite(d) ? d : (fallback ?? 0);
}

export function getBool(key: SettingKey): boolean {
  return getSetting(key).trim().toLowerCase() === "true";
}

export function setSettings(patch: Partial<Record<SettingKey, string>>): void {
  const all = readAll();
  for (const [k, v] of Object.entries(patch)) {
    if (!SETTING_KEYS.includes(k as SettingKey)) continue;
    if (typeof v !== "string") continue;
    // Never overwrite a stored secret with its masked representation.
    if (v.includes("…")) continue;
    all[k as SettingKey] = v;
  }
  fs.writeFileSync(settingsFile(), JSON.stringify(all, null, 2), "utf8");
}

function isSecret(key: string): boolean {
  return SECRET_HINTS.some((h) => key.includes(h));
}

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••…";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Settings as sent to the UI: secrets masked, defaults filled in. */
export function getMaskedSettings(): Record<SettingKey, string> {
  const out = {} as Record<SettingKey, string>;
  for (const key of SETTING_KEYS) {
    const v = getSetting(key);
    out[key] = isSecret(key) && v ? mask(v) : v;
  }
  return out;
}
