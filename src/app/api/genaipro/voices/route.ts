import { NextResponse } from "next/server";
import { listVoices } from "@/lib/services/genaipro";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  try {
    const voices = await listVoices({
      search: searchParams.get("search") ?? undefined,
      language: searchParams.get("language") ?? undefined,
      pageSize: 50,
    });
    return NextResponse.json({
      voices: voices.map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        language: v.language ?? "",
        accent: v.accent ?? "",
        gender: v.gender ?? "",
        category: v.category ?? "",
        preview_url: v.preview_url ?? "",
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
