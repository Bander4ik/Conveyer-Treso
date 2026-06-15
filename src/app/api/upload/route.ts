import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { uploadsDir } from "@/lib/paths";

const ALLOWED = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg"]);

/** Stores the manually generated voiceover (e.g. from GenAIPro) for a new run. */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file in form data" }, { status: 400 });
  }
  const ext = path.extname(file.name || "").toLowerCase() || ".mp3";
  if (!ALLOWED.has(ext)) {
    return NextResponse.json(
      { error: `Unsupported audio format ${ext} (use mp3/wav/m4a/aac/ogg)` },
      { status: 400 }
    );
  }
  const dest = path.join(uploadsDir(), `${crypto.randomUUID()}${ext}`);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length < 1000) {
    return NextResponse.json({ error: "Audio file looks empty" }, { status: 400 });
  }
  fs.writeFileSync(dest, buf);
  return NextResponse.json({ path: dest, size: buf.length, name: file.name });
}
