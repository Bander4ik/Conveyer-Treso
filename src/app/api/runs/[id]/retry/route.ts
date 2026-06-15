import { NextResponse } from "next/server";
import { readRun } from "@/lib/runs-store";
import { clearCancel } from "@/lib/cancellation";
import { startPipeline } from "@/lib/pipeline";

/**
 * Re-runs the same run, reusing everything already generated (segments,
 * images, per-segment voiceover + subtitles). Only the missing pieces are
 * regenerated — so a run that died mid-way never re-pays for finished work.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = readRun(id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (meta.status === "running" || meta.status === "pending") {
    return NextResponse.json({ error: "Run is already in progress" }, { status: 409 });
  }
  if (meta.script === "smoke") {
    return NextResponse.json({ error: "Smoke tests can't be retried — start a new one" }, { status: 400 });
  }
  clearCancel(id);
  startPipeline(id, {});
  return NextResponse.json({ ok: true });
}
