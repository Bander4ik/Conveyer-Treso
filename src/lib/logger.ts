import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

export type LogLevel = "info" | "warn" | "error" | "success" | "debug";

export interface LogEntry {
  ts: string;
  runId: string;
  level: LogLevel;
  stage?: string;
  message: string;
}

/**
 * Logs are appended to <runDir>/run.log.jsonl and broadcast on an in-process
 * bus for the SSE endpoint. The bus and file map are pinned to globalThis —
 * in Next dev, hot reloads and per-route module graphs would otherwise create
 * separate instances and live tailing would silently break.
 */
interface LoggerState {
  bus: EventEmitter;
  logFiles: Map<string, string>;
}

function state(): LoggerState {
  const g = globalThis as typeof globalThis & { __tresoLogger?: LoggerState };
  if (!g.__tresoLogger) {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    g.__tresoLogger = { bus, logFiles: new Map() };
  }
  return g.__tresoLogger;
}

export function bindLogFile(runId: string, runDirPath: string): void {
  state().logFiles.set(runId, path.join(runDirPath, "run.log.jsonl"));
}

export function log(
  runId: string,
  level: LogLevel,
  message: string,
  stage?: string
): void {
  const entry: LogEntry = { ts: new Date().toISOString(), runId, level, stage, message };
  const file = state().logFiles.get(runId);
  if (file) {
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // never let logging kill the pipeline
    }
  }
  state().bus.emit(`log:${runId}`, entry);
}

export function subscribe(runId: string, handler: (e: LogEntry) => void): () => void {
  const { bus } = state();
  bus.on(`log:${runId}`, handler);
  return () => bus.off(`log:${runId}`, handler);
}

export function readLogFile(runDirPath: string): LogEntry[] {
  try {
    const raw = fs.readFileSync(path.join(runDirPath, "run.log.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is LogEntry => e !== null);
  } catch {
    return [];
  }
}
