"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface RunListItem {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  stats?: { segments?: number; durationSec?: number };
}

function badgeClass(status: string): string {
  if (status === "running" || status === "pending") return "badge badge-running";
  if (status === "done") return "badge badge-done";
  if (status === "error") return "badge badge-error";
  return "badge";
}

function fmtDur(sec?: number): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/runs")
        .then((r) => r.json())
        .then((d) => {
          if (active) {
            setRuns(d.runs ?? []);
            setLoaded(true);
          }
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Runs</h1>
      {loaded && runs.length === 0 && (
        <div className="card" style={{ color: "var(--text-dim)" }}>
          No runs yet — create your first video on the New Video page.
        </div>
      )}
      <div className="space-y-3">
        {runs.map((r) => (
          <Link key={r.id} href={`/runs/${r.id}`} className="card flex items-center gap-4 hover:border-[var(--accent)] transition-colors">
            <span className={badgeClass(r.status)}>{r.status}</span>
            <span className="font-medium flex-1 truncate">{r.title}</span>
            <span className="text-xs" style={{ color: "var(--text-dim)" }}>
              {r.stats?.segments ? `${r.stats.segments} seg` : ""}
              {r.stats?.durationSec ? ` · ${fmtDur(r.stats.durationSec)}` : ""}
            </span>
            <span className="text-xs" style={{ color: "var(--text-dim)" }}>
              {new Date(r.createdAt).toLocaleString()}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
