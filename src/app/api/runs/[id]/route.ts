import { NextResponse } from "next/server";
import { readRun } from "@/lib/runs-store";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = readRun(id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run: meta });
}
