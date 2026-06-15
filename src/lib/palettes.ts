import { getSetting } from "./settings";

/**
 * One palette = one consistent color world for the WHOLE video (the reference
 * channel keeps each video in a single warm gamma; other videos may go violet
 * or blue for variety). The palette drives: the image prompts, the dark
 * ambient backdrop and the edge-glow color.
 */
export interface Palette {
  id: string;
  label: string;
  /** appended to every image prompt to lock the gamma */
  prompt: string;
  /** darkest backdrop gradient color (hex, no #) */
  bg0: string;
  /** edge glow / magic smoke color */
  glow: { r: number; g: number; b: number };
}

export const PALETTES: Record<string, Palette> = {
  "golden-fire": {
    id: "golden-fire",
    label: "Golden Fire — orange / gold / red (reference channel default)",
    prompt:
      "STRICT COLOR PALETTE: warm golden-orange, amber, fiery red and deep brown tones only; glowing golden-orange energy and embers; dark warm shadows",
    bg0: "2a0a06",
    glow: { r: 255, g: 120, b: 30 },
  },
  "violet-storm": {
    id: "violet-storm",
    label: "Violet Storm — purple / magenta",
    prompt:
      "STRICT COLOR PALETTE: deep violet, purple and electric magenta tones with golden ornament accents; dark purple shadows",
    bg0: "1c0826",
    glow: { r: 170, g: 70, b: 255 },
  },
  "mystic-blue": {
    id: "mystic-blue",
    label: "Mystic Blue — deep blue / teal with warm accents",
    prompt:
      "STRICT COLOR PALETTE: deep midnight blue and teal tones with warm golden light accents; cold blue energy; dark blue shadows",
    bg0: "06121f",
    glow: { r: 70, g: 150, b: 255 },
  },
  "emerald-ritual": {
    id: "emerald-ritual",
    label: "Emerald Ritual — dark green / gold",
    prompt:
      "STRICT COLOR PALETTE: dark emerald and forest green tones with glowing golden accents; dark green shadows",
    bg0: "07190c",
    glow: { r: 90, g: 220, b: 120 },
  },
};

export function getPalette(): Palette {
  const id = getSetting("VIDEO_PALETTE");
  return PALETTES[id] ?? PALETTES["golden-fire"];
}
