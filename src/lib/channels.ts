import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR, ensureDir } from "./paths";

/**
 * A channel = one language edition of the same video. Multi-language hybrid runs
 * generate the visual pool ONCE, then produce a finished video per channel using
 * the channel's own voice + language (script auto-translated, scenes re-cut to
 * that voice's timecodes, its own burned subtitles). Stored as JSON outside the
 * repo, next to settings.
 */
export interface Channel {
  id: string;
  name: string;
  /** GenAIPro voice id used to narrate this channel */
  voiceId: string;
  /** human language name, e.g. "Spanish", "German" — used for translation + display */
  language: string;
}

function channelsFile(): string {
  ensureDir(DATA_DIR);
  return path.join(DATA_DIR, "channels.json");
}

export function listChannels(): Channel[] {
  try {
    const arr = JSON.parse(fs.readFileSync(channelsFile(), "utf8")) as Channel[];
    return Array.isArray(arr) ? arr.filter((c) => c && typeof c.id === "string") : [];
  } catch {
    return [];
  }
}

export function getChannel(id: string): Channel | null {
  return listChannels().find((c) => c.id === id) ?? null;
}

function writeChannels(list: Channel[]): void {
  fs.writeFileSync(channelsFile(), JSON.stringify(list, null, 2), "utf8");
}

/** Create (no id) or update (existing id) a channel. */
export function saveChannel(input: { id?: string; name: string; voiceId: string; language: string }): Channel {
  const list = listChannels();
  const clean = {
    name: (input.name || "").trim(),
    voiceId: (input.voiceId || "").trim(),
    language: (input.language || "").trim(),
  };
  if (input.id) {
    const idx = list.findIndex((c) => c.id === input.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...clean };
      writeChannels(list);
      return list[idx];
    }
  }
  const ch: Channel = { id: crypto.randomUUID(), ...clean };
  list.push(ch);
  writeChannels(list);
  return ch;
}

export function deleteChannel(id: string): void {
  writeChannels(listChannels().filter((c) => c.id !== id));
}
