import os from "os";
import path from "path";
import fs from "fs";

/**
 * All user data lives OUTSIDE the project tree so code updates never touch it.
 * Layout:
 *   ~/.conveyer-treso/
 *     settings.json          app settings
 *     assets/                user-provided files: music.mp3, intro.mp4
 *     assets/base/           generated FX assets (dot.png, ember.png, darkbg.png)
 *     uploads/               voiceover MP3s uploaded before a run is created
 *     runs/<id>/             per-run working dir + final.mp4
 */
export const DATA_DIR =
  process.env.CONVEYER_TRESO_DATA_DIR || path.join(os.homedir(), ".conveyer-treso");

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetsDir(): string {
  return ensureDir(path.join(DATA_DIR, "assets"));
}

export function baseAssetsDir(): string {
  return ensureDir(path.join(DATA_DIR, "assets", "base"));
}

export function uploadsDir(): string {
  return ensureDir(path.join(DATA_DIR, "uploads"));
}

export function runsRoot(customRoot?: string): string {
  const root = customRoot && customRoot.trim() ? customRoot.trim() : path.join(DATA_DIR, "runs");
  return ensureDir(root);
}

export function runDir(runId: string, customRoot?: string): string {
  return ensureDir(path.join(runsRoot(customRoot), runId));
}

/** Find a user asset by base name (music.mp3 / music.wav / intro.mp4 ...). */
export function findUserAsset(baseName: string, extensions: string[]): string | null {
  const dir = assetsDir();
  for (const ext of extensions) {
    const p = path.join(dir, `${baseName}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const MUSIC_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

/** assets/music/ — users drop one or more tracks here; they loop as a playlist. */
export function musicDir(): string {
  return ensureDir(path.join(DATA_DIR, "assets", "music"));
}

/**
 * All music tracks, alphabetical: legacy single assets/music.<ext> first,
 * then everything inside assets/music/.
 */
export function listMusicTracks(): string[] {
  const out: string[] = [];
  const single = findUserAsset("music", MUSIC_EXTS.map((e) => e.slice(1)));
  if (single) out.push(single);
  const dir = musicDir();
  try {
    for (const f of fs.readdirSync(dir).sort()) {
      if (MUSIC_EXTS.includes(path.extname(f).toLowerCase())) {
        out.push(path.join(dir, f));
      }
    }
  } catch {
    // unreadable music dir — treat as empty
  }
  return out;
}
