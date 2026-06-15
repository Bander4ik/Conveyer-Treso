import { NextResponse } from "next/server";
import { requestCancel } from "@/lib/cancellation";
import { readRun, updateRun } from "@/lib/runs-store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = readRun(id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  requestCancel(id);
  if (meta.status === "pending" || meta.status === "running") {
    updateRun(id, { status: "cancelled" });
  }
  return NextResponse.json({ ok: true });
}
