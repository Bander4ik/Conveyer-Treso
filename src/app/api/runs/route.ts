import { NextResponse } from "next/server";
import path from "path";
import { createRun, listRuns } from "@/lib/runs-store";
import { startPipeline } from "@/lib/pipeline";
import { uploadsDir } from "@/lib/paths";

export async function GET() {
  return NextResponse.json({ runs: listRuns(50) });
}

export async function POST(req: Request) {
  let body: {
    title?: string;
    script?: string;
    voiceMode?: string;
    voiceoverFile?: string;
    smoke?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const smoke = body.smoke === true;
  const script = (body.script ?? "").trim();
  const voiceMode =
    body.voiceMode === "elevenlabs" || body.voiceMode === "genaipro" || body.voiceMode === "manual"
      ? body.voiceMode
      : "manual";

  if (!smoke && script.split(/\s+/).filter(Boolean).length < 10) {
    return NextResponse.json({ error: "Script is empty or too short" }, { status: 400 });
  }

  let voiceoverFile: string | undefined;
  if (!smoke && voiceMode === "manual") {
    const f = (body.voiceoverFile ?? "").trim();
    if (!f) {
      return NextResponse.json(
        { error: "Manual voice mode: upload the voiceover MP3 first" },
        { status: 400 }
      );
    }
    // only accept files we stored ourselves
    const resolved = path.resolve(f);
    if (!resolved.startsWith(path.resolve(uploadsDir()))) {
      return NextResponse.json({ error: "Invalid voiceover file path" }, { status: 400 });
    }
    voiceoverFile = resolved;
  }

  const meta = createRun({
    title: smoke ? "Smoke test (no APIs)" : body.title,
    script: smoke ? "smoke" : script,
    voiceMode,
    voiceoverFile,
  });
  startPipeline(meta.id, { smoke });
  return NextResponse.json({ id: meta.id });
}
