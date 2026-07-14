import fs from "fs";
import path from "path";
import crypto from "crypto";
import { runDir, runsRoot } from "./paths";
import { getSetting } from "./settings";

export type RunStatus = "pending" | "running" | "done" | "error" | "cancelled";

export type VoiceMode = "manual" | "elevenlabs" | "genaipro";

export interface RunMeta {
  id: string;
  title: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  voiceMode: VoiceMode;
  /** absolute path of the uploaded voiceover (manual mode) */
  voiceoverFile?: string;
  script: string;
  error?: string;
  outputPath?: string;
  /** multi-language: the channels this run produces a video for */
  channelIds?: string[];
  /** multi-language: one finished video per channel */
  outputs?: RunOutput[];
  stats?: {
    segments?: number;
    uniqueImages?: number;
    durationSec?: number;
  };
}

export interface RunOutput {
  channelId: string;
  channelName: string;
  language: string;
  path: string;
  durationSec?: number;
}

function metaFile(dir: string): string {
  return path.join(dir, "run.json");
}

export function customRunsRoot(): string | undefined {
  const v = getSetting("RUNS_OUTPUT_DIR").trim();
  return v || undefined;
}

export function getRunDir(runId: string): string {
  return runDir(runId, customRunsRoot());
}

export function createRun(input: {
  title?: string;
  script: string;
  voiceMode: VoiceMode;
  voiceoverFile?: string;
  channelIds?: string[];
}): RunMeta {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta: RunMeta = {
    id,
    title: input.title?.trim() || `Video ${now.slice(0, 16).replace("T", " ")}`,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    voiceMode: input.voiceMode,
    voiceoverFile: input.voiceoverFile,
    script: input.script,
    channelIds: input.channelIds && input.channelIds.length > 0 ? input.channelIds : undefined,
  };
  const dir = getRunDir(id);
  fs.writeFileSync(metaFile(dir), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export function readRun(runId: string): RunMeta | null {
  try {
    const raw = fs.readFileSync(metaFile(getRunDir(runId)), "utf8");
    return JSON.parse(raw) as RunMeta;
  } catch {
    return null;
  }
}

export function updateRun(runId: string, patch: Partial<RunMeta>): RunMeta | null {
  const meta = readRun(runId);
  if (!meta) return null;
  const next: RunMeta = { ...meta, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(metaFile(getRunDir(runId)), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function listRuns(limit = 50): RunMeta[] {
  const root = runsRoot(customRunsRoot());
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const metas: RunMeta[] = [];
  for (const name of entries) {
    const file = metaFile(path.join(root, name));
    try {
      const raw = fs.readFileSync(file, "utf8");
      metas.push(JSON.parse(raw) as RunMeta);
    } catch {
      // not a run dir — skip
    }
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // Keep payload light for list views.
  return metas.slice(0, limit).map((m) => ({ ...m, script: "" }));
}
