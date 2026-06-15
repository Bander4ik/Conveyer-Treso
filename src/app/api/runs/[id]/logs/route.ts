import { NextResponse } from "next/server";
import { getRunDir, readRun } from "@/lib/runs-store";
import { readLogFile, subscribe, type LogEntry } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dir = getRunDir(id);

  // Plain JSON history — the run page loads this first so logs are visible
  // even if the SSE stream is unavailable (proxy, hot-reload, reconnects).
  if (new URL(req.url).searchParams.get("format") === "json") {
    return NextResponse.json({ entries: readLogFile(dir) });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (e: LogEntry) => safeEnqueue(`data: ${JSON.stringify(e)}\n\n`);

      // replay history, then tail live
      for (const e of readLogFile(dir)) send(e);
      const unsub = subscribe(id, send);

      const interval = setInterval(() => {
        safeEnqueue(`: ping\n\n`);
        const meta = readRun(id);
        if (meta) {
          safeEnqueue(`event: status\ndata: ${JSON.stringify({ status: meta.status })}\n\n`);
        }
      }, 4000);

      const cleanup = () => {
        closed = true;
        unsub();
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
