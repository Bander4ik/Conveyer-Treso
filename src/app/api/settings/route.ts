import { NextResponse } from "next/server";
import path from "path";
import { getMaskedSettings, setSettings, DEFAULTS, type SettingKey } from "@/lib/settings";
import { assetsDir, musicDir, listMusicTracks, findUserAsset } from "@/lib/paths";

export async function GET() {
  musicDir(); // ensure assets/music exists so users see where to drop tracks
  return NextResponse.json({
    settings: getMaskedSettings(),
    defaults: DEFAULTS,
    assets: {
      dir: assetsDir(),
      musicDir: musicDir(),
      musicTracks: listMusicTracks().map((t) => path.basename(t)),
      intro: findUserAsset("intro", ["mp4", "mov", "webm"]),
    },
  });
}

export async function POST(req: Request) {
  let body: Partial<Record<SettingKey, string>>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  setSettings(body);
  return NextResponse.json({ ok: true, settings: getMaskedSettings() });
}
