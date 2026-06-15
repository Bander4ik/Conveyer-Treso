import { getNumber, getSetting } from "../settings";

export interface SubtitleCue {
  /** seconds from segment start */
  start: number;
  end: number;
  text: string;
}

/**
 * Parses WebVTT or SRT into cues. Timings come from the GenAIPro/ElevenLabs
 * subtitle exporter, which aligns to actual speech — so cues naturally end
 * when the narrator pauses (Vlad's hard requirement: no text during silence).
 */
export function parseSubtitleFile(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // normalize line endings, split into blocks
  const blocks = raw.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx === -1) continue;
    const m = lines[timeLineIdx].match(
      /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/
    );
    if (!m) continue;
    const start = toSeconds(m[1], m[2], m[3], m[4]);
    const end = toSeconds(m[5], m[6], m[7], m[8]);
    const text = lines
      .slice(timeLineIdx + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "") // strip VTT inline tags
      .trim();
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues;
}

function toSeconds(h: string | undefined, m: string, s: string, ms: string): number {
  const hours = h ? parseInt(h.replace(":", ""), 10) : 0;
  return hours * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms.padEnd(3, "0"), 10) / 1000;
}

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(Math.min(99, cs)).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\n/g, "\\N");
}

/**
 * Builds a styled ASS file matching the reference channel: white bold-italic
 * serif with black outline and soft shadow, bottom-centered.
 */
export function buildAss(cues: SubtitleCue[], clipDurationSec: number): string {
  const font = getSetting("SUBTITLE_FONT") || "Georgia";
  const size = Math.round(getNumber("SUBTITLE_FONT_SIZE", 72));
  const marginV = Math.round(getNumber("SUBTITLE_MARGIN_V", 70));

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,1,0,0,100,100,0,0,1,3,1.5,2,80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues
    .filter((c) => c.start < clipDurationSec && c.text.trim() !== "")
    .map((c) => {
      const start = assTime(c.start);
      const end = assTime(Math.min(c.end, clipDurationSec));
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${escapeAssText(c.text)}`;
    })
    .join("\n");

  return header + events + "\n";
}

/**
 * Slice global cues to a scene window [startSec, endSec] and re-base them to
 * clip-local time (0 = clip start). A cue overlapping the window is kept and
 * clamped; cues fully outside are dropped.
 */
export function sliceCues(globalCues: SubtitleCue[], startSec: number, endSec: number): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const c of globalCues) {
    if (c.end <= startSec || c.start >= endSec) continue;
    const s = Math.max(c.start, startSec) - startSec;
    const e = Math.min(c.end, endSec) - startSec;
    if (e > s && c.text.trim()) out.push({ start: s, end: e, text: c.text });
  }
  return out;
}

/** Escapes a file path for ffmpeg's subtitles= filter (Windows-safe). */
export function escapeSubtitlePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
