import { NextResponse } from "next/server";
import { listChannels, saveChannel, deleteChannel } from "@/lib/channels";

export async function GET() {
  return NextResponse.json({ channels: listChannels() });
}

export async function POST(req: Request) {
  let body: { id?: string; name?: string; voiceId?: string; language?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Channel name is required" }, { status: 400 });
  const channel = saveChannel({
    id: body.id,
    name,
    voiceId: (body.voiceId ?? "").trim(),
    language: (body.language ?? "").trim(),
  });
  return NextResponse.json({ channel, channels: listChannels() });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  deleteChannel(id);
  return NextResponse.json({ ok: true, channels: listChannels() });
}
