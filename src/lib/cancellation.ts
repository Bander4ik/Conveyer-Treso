/**
 * Cooperative run cancellation. The set is pinned to globalThis so the cancel
 * API route and the running pipeline always share it, even across Next dev
 * hot reloads / per-route module instances.
 */
function cancelledSet(): Set<string> {
  const g = globalThis as typeof globalThis & { __tresoCancelled?: Set<string> };
  if (!g.__tresoCancelled) g.__tresoCancelled = new Set();
  return g.__tresoCancelled;
}

export class CancelledError extends Error {
  constructor() {
    super("Run cancelled by user");
    this.name = "CancelledError";
  }
}

export function requestCancel(runId: string): void {
  cancelledSet().add(runId);
}

export function clearCancel(runId: string): void {
  cancelledSet().delete(runId);
}

export function isCancelled(runId: string): boolean {
  return cancelledSet().has(runId);
}

export function checkCancelled(runId: string): void {
  if (cancelledSet().has(runId)) throw new CancelledError();
}
