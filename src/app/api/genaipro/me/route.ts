import { NextResponse } from "next/server";
import { getMe, getVeoCredits } from "@/lib/services/genaipro";

/** Connection check: voice balance + Veo (image/video) credit pool. */
export async function GET() {
  try {
    const me = await getMe();
    let veoRemaining: number | null = null;
    try {
      veoRemaining = (await getVeoCredits()).remaining;
    } catch {
      // Veo pool endpoint failing shouldn't mask a working voice connection
    }
    return NextResponse.json({
      ok: true,
      username: me.username,
      balance: me.balance,
      veoRemaining,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
