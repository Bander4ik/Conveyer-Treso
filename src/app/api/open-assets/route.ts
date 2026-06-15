import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { assetsDir, musicDir } from "@/lib/paths";

/** Opens the user's assets folder in the OS file manager. */
export async function POST() {
  const dir = assetsDir();
  musicDir(); // make sure assets/music exists so the user sees where tracks go
  try {
    if (process.platform === "win32") {
      // `cmd /c start` is the reliable way — bare explorer spawn from a dev
      // server process often exits silently without opening a window
      spawn("cmd", ["/c", "start", "", dir], { detached: true, windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [dir], { detached: true }).unref();
    } else {
      spawn("xdg-open", [dir], { detached: true }).unref();
    }
    return NextResponse.json({ ok: true, dir });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
