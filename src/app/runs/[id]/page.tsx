"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

interface RunMeta {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  voiceMode: string;
  error?: string;
  outputPath?: string;
  stats?: { segments?: number; uniqueImages?: number; durationSec?: number };
}

interface LogEntry {
  ts: string;
  level: string;
  stage?: string;
  message: string;
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [run, setRun] = useState<RunMeta | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // run meta polling
  useEffect(() => {
    if (!id) return;
    let active = true;
    const load = () =>
      fetch(`/api/runs/${id}`)
        .then((r) => r.json())
        .then((d) => {
          if (active && d.run) setRun(d.run);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [id]);

  // logs: history via plain fetch (robust), live tail via SSE (best-effort).
  // Entries are deduped by ts+message so the two sources can overlap safely.
  useEffect(() => {
    if (!id) return;
    const keyOf = (e: LogEntry) => `${e.ts}|${e.stage ?? ""}|${e.message}`;
    // Dedup against the CURRENT log state (not a per-effect Set): under React
    // Strict Mode the effect mounts twice, so two EventSources + two history
    // pollers can each deliver the same entry. Filtering inside setLogs against
    // what's already shown collapses those duplicates no matter how many
    // sources append.
    const append = (entries: LogEntry[]) => {
      if (entries.length === 0) return;
      setLogs((prev) => {
        const have = new Set(prev.map(keyOf));
        const fresh = entries.filter((e) => !have.has(keyOf(e)));
        if (fresh.length === 0) return prev;
        const next = [...prev, ...fresh];
        return next.length > 2000 ? next.slice(-1500) : next;
      });
    };

    const loadHistory = () =>
      fetch(`/api/runs/${id}/logs?format=json`)
        .then((r) => r.json())
        .then((d) => append(d.entries ?? []))
        .catch(() => {});

    loadHistory();
    // safety net: re-sync history every 5s while the page is open — even if
    // SSE delivers nothing, logs still appear
    const t = setInterval(loadHistory, 5000);

    const es = new EventSource(`/api/runs/${id}/logs`);
    es.onmessage = (ev) => {
      try {
        append([JSON.parse(ev.data) as LogEntry]);
      } catch {
        // ignore malformed
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; history polling covers the gap
    };
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    if (autoScroll && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const [retrying, setRetrying] = useState(false);

  async function cancel() {
    await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
  }

  async function retry() {
    setRetrying(true);
    try {
      const resp = await fetch(`/api/runs/${id}/retry`, { method: "POST" });
      if (resp.ok) {
        setLogs([]);
        setRun((r) => (r ? { ...r, status: "running", error: undefined } : r));
      }
    } finally {
      setRetrying(false);
    }
  }

  const isActive = run && (run.status === "running" || run.status === "pending");
  const isDone = run?.status === "done";
  const canRetry = run && (run.status === "error" || run.status === "cancelled") && run.voiceMode !== undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold flex-1 truncate">{run?.title ?? "Run"}</h1>
        {run && (
          <span
            className={
              isActive
                ? "badge badge-running"
                : isDone
                  ? "badge badge-done"
                  : run.status === "error"
                    ? "badge badge-error"
                    : "badge"
            }
          >
            {run.status}
          </span>
        )}
        {isActive && (
          <button className="btn btn-danger" onClick={cancel}>
            Cancel
          </button>
        )}
        {canRetry && (
          <button className="btn btn-primary" onClick={retry} disabled={retrying}>
            {retrying ? "Restarting…" : "↻ Retry"}
          </button>
        )}
      </div>

      {run?.error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="card-title" style={{ color: "var(--danger)" }}>
            Error
          </div>
          <div className="text-sm whitespace-pre-wrap">{run.error}</div>
          <div className="text-sm mt-3" style={{ color: "var(--text-dim)" }}>
            Press <b>↻ Retry</b> — it continues from here and reuses every image and voiceover
            already generated (no re-paying for finished work).
          </div>
        </div>
      )}

      {isDone && (
        <div className="card space-y-4">
          <div className="card-title">Result</div>
          <video
            controls
            preload="metadata"
            className="w-full rounded-lg"
            style={{ maxHeight: 420, background: "#000" }}
            src={`/api/runs/${id}/file?path=final.mp4`}
          />
          <div className="flex items-center gap-4">
            <a className="btn btn-primary" href={`/api/runs/${id}/file?path=final.mp4`} download>
              ⬇ Download final.mp4
            </a>
            {run?.stats && (
              <span className="text-sm" style={{ color: "var(--text-dim)" }}>
                {run.stats.segments} segments · {run.stats.uniqueImages} unique images ·{" "}
                {run.stats.durationSec ? `${Math.floor(run.stats.durationSec / 60)}:${String(Math.round(run.stats.durationSec % 60)).padStart(2, "0")}` : ""}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex items-center mb-3">
          <div className="card-title mb-0 flex-1">Logs</div>
          <label className="text-xs flex items-center gap-2" style={{ color: "var(--text-dim)" }}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            auto-scroll
          </label>
        </div>
        <div className="log-box" ref={logBoxRef}>
          {logs.length === 0 && <span className="log-info">Waiting for logs…</span>}
          {logs.map((l, i) => (
            <div key={i} className={`log-${l.level}`}>
              <span style={{ opacity: 0.5 }}>{l.ts.slice(11, 19)}</span>{" "}
              {l.stage ? `[${l.stage}] ` : ""}
              {l.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
