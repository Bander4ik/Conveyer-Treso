import fs from "fs";
import { getNumber, getSetting } from "../settings";
import { CancelledError, isCancelled } from "../cancellation";
import { runFfmpeg } from "./ffmpeg";

function checkAbort(runId?: string): void {
  if (runId && isCancelled(runId)) throw new CancelledError();
}

/**
 * GenAIPro client (genaipro.io — Aleix's credit-based provider).
 * Spec: https://docs.genaipro.io/openapi.yaml (copy in _reference/).
 *  - Labs TTS: POST /v1/labs/task {input, voice_id, model_id, ...} → {task_id};
 *    poll GET /v1/labs/task/{id} → {status: processing|completed, result: mp3 url}
 *  - Images:  POST /v2/veo/create-image (multipart) → 202 {id};
 *    poll GET /v2/veo/tasks/{id} → {status: processing|completed|failed, file_urls}
 *  - Auth: Authorization: Bearer <token>; image endpoints rate-limited 30 req/min.
 */
const BASE = "https://genaipro.io/api";

function apiKey(): string {
  const key = getSetting("GENAIPRO_API_KEY");
  if (!key) throw new Error("GENAIPRO_API_KEY is not set (open Settings → GenAIPro)");
  return key;
}

async function gapFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function errText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── account ── */

export async function getMe(): Promise<{ id: string; username: string; balance: number }> {
  const resp = await gapFetch("/v2/me");
  if (!resp.ok) throw new Error(`GenAIPro /v2/me ${resp.status}: ${await errText(resp)}`);
  return (await resp.json()) as { id: string; username: string; balance: number };
}

/** Veo credit pool (images/video) — separate from the Labs voice balance. */
export async function getVeoCredits(): Promise<{ quota: number; used: number; remaining: number }> {
  const resp = await gapFetch("/v2/veo/credits");
  if (!resp.ok) throw new Error(`GenAIPro /v2/veo/credits ${resp.status}: ${await errText(resp)}`);
  const packages = (await resp.json()) as { quota?: number; used?: number }[];
  let quota = 0;
  let used = 0;
  for (const p of Array.isArray(packages) ? packages : []) {
    quota += p.quota ?? 0;
    used += p.used ?? 0;
  }
  return { quota, used, remaining: Math.max(0, quota - used) };
}

/* ── voices ── */

export interface GenaiproVoice {
  voice_id: string;
  name: string;
  language?: string;
  accent?: string;
  gender?: string;
  category?: string;
  preview_url?: string;
  description?: string;
}

export async function listVoices(opts: {
  search?: string;
  language?: string;
  pageSize?: number;
}): Promise<GenaiproVoice[]> {
  const q = new URLSearchParams();
  q.set("page_size", String(opts.pageSize ?? 50));
  if (opts.search) q.set("search", opts.search);
  if (opts.language) q.set("language", opts.language);
  const resp = await gapFetch(`/v1/labs/voices?${q.toString()}`);
  if (!resp.ok) throw new Error(`GenAIPro voices ${resp.status}: ${await errText(resp)}`);
  const data = (await resp.json()) as GenaiproVoice[];
  return Array.isArray(data) ? data : [];
}

/* ── TTS ── */

interface LabsTask {
  id?: string;
  status?: string; // processing | completed
  result?: string; // mp3 url when completed
}

export async function ttsToFile(
  text: string,
  outFile: string,
  opts: { runId?: string; taskIdFile?: string; voiceId?: string } = {}
): Promise<{ taskId: string }> {
  const { runId, taskIdFile } = opts;
  // per-channel override (multi-language) falls back to the global setting
  const voiceId = opts.voiceId?.trim() || getSetting("GENAIPRO_VOICE_ID");
  if (!voiceId) throw new Error("GENAIPRO_VOICE_ID is not set (Settings → GenAIPro, or set a voice on the channel)");
  const model = getSetting("GENAIPRO_TTS_MODEL") || "eleven_multilingual_v2";

  const body = JSON.stringify({
    input: text,
    voice_id: voiceId,
    model_id: model,
    stability: clamp(parseFloat(getSetting("TTS_STABILITY")) || 0.5, 0, 1),
    similarity: clamp(parseFloat(getSetting("TTS_SIMILARITY")) || 0.75, 0, 1),
    speed: clamp(parseFloat(getSetting("TTS_SPEED")) || 1.0, 0.7, 1.2),
    use_speaker_boost: true,
  });

  checkAbort(runId);

  // RESUME a task that was already submitted for this segment in an earlier
  // run: GenAIPro keeps the result server-side, so we re-poll the SAME task
  // instead of creating (and paying for) a new one. This is what makes a
  // slow/stuck task non-fatal — the next Retry just picks it up finished.
  let taskId = "";
  if (taskIdFile) {
    const prior = readTaskId(taskIdFile);
    if (prior && (await taskIsLive(prior))) taskId = prior;
  }
  if (!taskId) {
    taskId = await createTtsTask(body);
    if (taskIdFile) {
      try {
        fs.writeFileSync(taskIdFile, taskId, "utf8");
      } catch {
        // persistence is best-effort; the task still works this run
      }
    }
  }

  const url = await pollLabsTask(taskId, runId);
  await downloadToFile(url, outFile);
  return { taskId };
}

function readTaskId(file: string): string | null {
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

/** True if the task still exists on GenAIPro and is processing or completed. */
async function taskIsLive(taskId: string): Promise<boolean> {
  try {
    const resp = await gapFetch(`/v1/labs/task/${encodeURIComponent(taskId)}`);
    if (!resp.ok) return false;
    const task = (await resp.json()) as LabsTask;
    return task.status === "processing" || task.status === "completed";
  } catch {
    return false;
  }
}

async function createTtsTask(body: string): Promise<string> {
  let lastErr = "";
  for (let attempt = 0; attempt <= 4; attempt++) {
    const resp = await gapFetch("/v1/labs/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (resp.ok) {
      const json = (await resp.json()) as { task_id?: string };
      if (!json.task_id) throw new Error("GenAIPro TTS: response without task_id");
      return json.task_id;
    }
    lastErr = `GenAIPro TTS ${resp.status}: ${await errText(resp)}`;
    if (![429, 500, 502, 503, 504].includes(resp.status) || attempt === 4) throw new Error(lastErr);
    await sleep((resp.status === 429 ? 10_000 : 2000) * (attempt + 1));
  }
  throw new Error(lastErr);
}

/**
 * Requests subtitle export for a finished TTS task and returns the raw
 * VTT/SRT text. Timings are real speech alignments, so cues end whenever the
 * narrator pauses. Returns null if the export never materializes.
 */
export async function exportSubtitlesRaw(taskId: string, runId?: string): Promise<string | null> {
  const maxChars = Math.max(16, Math.round(getNumber("SUBTITLE_MAX_CHARS", 34)));
  const resp = await gapFetch(`/v1/labs/task/subtitle/${encodeURIComponent(taskId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_characters_per_line: maxChars,
      max_lines_per_cue: 2,
      max_seconds_per_cue: 5,
    }),
  });
  if (!resp.ok) {
    throw new Error(`GenAIPro subtitle export ${resp.status}: ${await errText(resp)}`);
  }
  // the subtitle URL appears on the task once the export job finishes
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    checkAbort(runId);
    await sleep(2500);
    const taskResp = await gapFetch(`/v1/labs/task/${encodeURIComponent(taskId)}`);
    if (taskResp.status === 429) {
      await sleep(10_000);
      continue;
    }
    if (!taskResp.ok) {
      throw new Error(`GenAIPro subtitle poll ${taskResp.status}: ${await errText(taskResp)}`);
    }
    const task = (await taskResp.json()) as LabsTask & { subtitle?: string };
    if (task.subtitle) {
      const subResp = await fetch(task.subtitle);
      if (!subResp.ok) throw new Error(`GenAIPro subtitle download ${subResp.status}`);
      return await subResp.text();
    }
  }
  return null;
}

async function pollLabsTask(taskId: string, runId?: string): Promise<string> {
  // GenAIPro processes TTS asynchronously and the result persists server-side,
  // so we wait patiently — a slow queue is normal. If we ever do time out, the
  // task id is saved (see ttsToFile) and the next Retry re-polls the SAME task,
  // which will have finished by then. Tunable via TTS_TASK_TIMEOUT_MIN.
  const timeoutMin = Math.max(2, getNumber("TTS_TASK_TIMEOUT_MIN", 15));
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    checkAbort(runId);
    await sleep(4000);
    const resp = await gapFetch(`/v1/labs/task/${encodeURIComponent(taskId)}`);
    if (resp.status === 429) {
      await sleep(15_000);
      continue;
    }
    if (!resp.ok) throw new Error(`GenAIPro task poll ${resp.status}: ${await errText(resp)}`);
    const task = (await resp.json()) as LabsTask;
    if (task.status === "completed") {
      if (!task.result) throw new Error("GenAIPro TTS: task completed but no audio URL");
      return task.result;
    }
    // status "processing" → keep polling
  }
  throw new Error(
    `GenAIPro TTS: task ${taskId} still processing after ${timeoutMin} min — press Retry, it will pick up the finished audio`
  );
}

/* ── images (Veo create-image: nano_banana_pro / nano_banana_2 / imagen_4) ── */

interface VeoTask {
  id?: string;
  status?: string; // processing | completed | failed
  file_urls?: string[];
  error?: string;
}

export async function imageToFile(
  prompt: string,
  outFile: string,
  opts: { runId?: string; taskIdFile?: string } = {}
): Promise<void> {
  const { runId, taskIdFile } = opts;
  const model = getSetting("GENAIPRO_IMAGE_MODEL") || "nano_banana_pro";
  checkAbort(runId);

  // RESUME a create-image task from a previous run: genaipro's Veo image backend
  // can be slow/overloaded (minutes per image), but it completes server-side, so
  // re-poll the SAME task instead of creating (and paying for) a new one. This is
  // what makes a timed-out image non-fatal — the next Retry picks it up finished.
  let taskId = "";
  if (taskIdFile) {
    const prior = readTaskId(taskIdFile);
    if (prior && (await veoTaskIsLive(prior))) taskId = prior;
  }

  if (!taskId) {
    let lastErr = "";
    for (let attempt = 0; attempt <= 4; attempt++) {
      checkAbort(runId);
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("aspect_ratio", "IMAGE_ASPECT_RATIO_LANDSCAPE"); // 16:9
      form.append("number_of_images", "1");
      form.append("model", model);
      const resp = await gapFetch("/v2/veo/create-image", { method: "POST", body: form });
      if (resp.ok) {
        const json = (await resp.json()) as VeoTask;
        if (!json.id) throw new Error("GenAIPro image: response without task id");
        taskId = json.id;
        break;
      }
      lastErr = `GenAIPro image ${resp.status}: ${await errText(resp)}`;
      // 30 req/min shared limit — back off generously on 429
      if (![429, 500, 502, 503, 504].includes(resp.status) || attempt === 4) throw new Error(lastErr);
      await sleep((resp.status === 429 ? 20_000 : 3000) * (attempt + 1));
    }
    if (taskIdFile) {
      try {
        fs.writeFileSync(taskIdFile, taskId, "utf8");
      } catch {
        // persistence is best-effort; the task still works this run
      }
    }
  }

  // Patient polling — genaipro's image backend can be slow under load. A task
  // that outlasts the window is NOT lost: its id is persisted, so a Retry
  // re-polls it (see the resume block above) and downloads the finished image.
  const timeoutMin = Math.max(2, getNumber("IMAGE_TASK_TIMEOUT_MIN", 15));
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    checkAbort(runId);
    await sleep(6000); // gentle polling — image endpoints share the 30 req/min budget
    const resp = await gapFetch(`/v2/veo/tasks/${encodeURIComponent(taskId)}`);
    if (resp.status === 429) {
      await sleep(20_000);
      continue;
    }
    if (!resp.ok) throw new Error(`GenAIPro image poll ${resp.status}: ${await errText(resp)}`);
    const task = (await resp.json()) as VeoTask;
    if (task.status === "completed") {
      const url = task.file_urls?.[0];
      if (!url) throw new Error("GenAIPro image: completed but no file URL");
      await downloadToFile(url, outFile);
      return;
    }
    if (task.status === "failed") {
      throw new Error(`GenAIPro image failed: ${task.error || "unknown error"} (credits auto-refunded)`);
    }
  }
  throw new Error(
    `GenAIPro image: task ${taskId} still processing after ${timeoutMin} min — press Retry, it will pick up the finished image`
  );
}

/* ── video (Veo frames-to-video: animate a still image into a short clip) ── */

/** True if a Veo task still exists and is processing/completed (for Resume). */
async function veoTaskIsLive(taskId: string): Promise<boolean> {
  try {
    const resp = await gapFetch(`/v2/veo/tasks/${encodeURIComponent(taskId)}`);
    if (!resp.ok) return false;
    const t = (await resp.json()) as VeoTask;
    return t.status === "processing" || t.status === "completed";
  } catch {
    return false;
  }
}

async function pollVeoVideo(taskId: string, outFile: string, runId?: string): Promise<void> {
  // Successful i2v gens finish in ~1-2 min when genaipro is healthy, but under
  // load their queue runs far longer — a 5-min cap made the run give up on jobs
  // that genaipro then completed anyway (the client sees finished clips in his
  // genaipro dashboard while the video has none). Tunable, like the TTS/image
  // waits; the task is never lost either way (the id is persisted → Retry
  // picks up the finished clip without re-paying).
  const timeoutMin = Math.max(2, getNumber("VIDEO_TASK_TIMEOUT_MIN", 15));
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    checkAbort(runId);
    await sleep(6000); // gentle — Veo endpoints share the 30 req/min budget
    const resp = await gapFetch(`/v2/veo/tasks/${encodeURIComponent(taskId)}`);
    if (resp.status === 429) {
      await sleep(20_000);
      continue;
    }
    if (!resp.ok) throw new Error(`GenAIPro video poll ${resp.status}: ${await errText(resp)}`);
    const task = (await resp.json()) as VeoTask;
    if (task.status === "completed") {
      const url = task.file_urls?.[0];
      if (!url) throw new Error("GenAIPro video: completed but no file URL");
      await downloadToFile(url, outFile);
      return;
    }
    if (task.status === "failed") {
      throw new Error(`GenAIPro video failed: ${task.error || "unknown error"} (credits auto-refunded)`);
    }
    // "processing" → keep polling
  }
  throw new Error(`GenAIPro video: task ${taskId} timed out after ${timeoutMin} min — press Retry to pick up the finished clip`);
}

/**
 * Animate a START IMAGE into a short video clip via genaipro Veo frames-to-video.
 * The API exposes NO duration parameter — the clip returns at the model's own
 * fixed length (~8s for Veo). The CALLER measures the real length (ffprobe) and
 * cuts the scene to match it; we never stretch/freeze to fill a longer scene.
 *
 * Resumable: the task id is persisted to taskIdFile the moment it is created, so
 * a Retry re-polls the SAME task instead of paying for a new one.
 */
export async function framesToVideoFile(
  startImage: string,
  prompt: string,
  outFile: string,
  opts: { runId?: string; taskIdFile?: string } = {}
): Promise<void> {
  const { runId, taskIdFile } = opts;
  const aspect =
    (getSetting("STOCK_ORIENTATION") || "landscape").toLowerCase() === "portrait"
      ? "VIDEO_ASPECT_RATIO_PORTRAIT"
      : "VIDEO_ASPECT_RATIO_LANDSCAPE";

  checkAbort(runId);

  // Veo i2v reliably FAILS the generation job on some raw provider images — e.g.
  // nano_banana returns JPEG bytes that get saved as `.png`, full-range/odd-size
  // quirks. Re-encoding the start frame to a clean, standard JPEG first makes it
  // succeed (verified: same image + same prompt fails raw, passes re-encoded).
  const startJpeg = `${outFile}.startframe.jpg`;
  await runFfmpeg([
    "-i", startImage,
    "-vf", "scale='min(1920,iw)':-2:flags=lanczos,format=yuvj420p",
    "-q:v", "3", "-y", startJpeg,
  ]);
  const buf = fs.readFileSync(startJpeg);

  const submit = async (): Promise<string> => {
    let lastErr = "";
    for (let attempt = 0; attempt <= 4; attempt++) {
      checkAbort(runId);
      const form = new FormData();
      form.append("start_image", new Blob([new Uint8Array(buf)], { type: "image/jpeg" }), "start.jpg");
      form.append("prompt", prompt);
      form.append("aspect_ratio", aspect);
      form.append("number_of_videos", "1"); // sent as string in form data per spec
      const resp = await gapFetch("/v2/veo/frames-to-video", { method: "POST", body: form }, 120_000);
      if (resp.ok) {
        const json = (await resp.json()) as { histories?: VeoTask[]; id?: string };
        const id = json.histories?.[0]?.id ?? json.id;
        if (!id) throw new Error("GenAIPro video: response without task id");
        return id;
      }
      lastErr = `GenAIPro frames-to-video ${resp.status}: ${await errText(resp)}`;
      if (![429, 500, 502, 503, 504].includes(resp.status) || attempt === 4) throw new Error(lastErr);
      await sleep((resp.status === 429 ? 20_000 : 3000) * (attempt + 1));
    }
    throw new Error(lastErr);
  };

  try {
    // A FAILED Veo job auto-refunds the credit, and i2v is inherently flaky, so
    // retry a fresh generation once before giving up (the caller then falls back
    // to an AI-image still).
    const GEN_ATTEMPTS = 2;
    let lastErr: Error | null = null;
    for (let gen = 1; gen <= GEN_ATTEMPTS; gen++) {
      let taskId = "";
      // RESUME an in-flight task from a previous run (no re-charge) — only on the
      // first attempt, and only if it's still alive (a FAILED task is skipped).
      if (gen === 1 && taskIdFile) {
        const prior = readTaskId(taskIdFile);
        if (prior && (await veoTaskIsLive(prior))) taskId = prior;
      }
      if (!taskId) {
        taskId = await submit();
        if (taskIdFile) {
          try {
            fs.writeFileSync(taskIdFile, taskId, "utf8");
          } catch {
            // persistence is best-effort; the task still works this run
          }
        }
      }
      try {
        await pollVeoVideo(taskId, outFile, runId);
        return; // success
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        // retry only a genuine generation FAILURE (not cancel/timeout)
        if (gen < GEN_ATTEMPTS && /failed/i.test(lastErr.message)) {
          if (taskIdFile) {
            try {
              fs.rmSync(taskIdFile, { force: true });
            } catch {
              // best-effort
            }
          }
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr ?? new Error("GenAIPro video: generation failed");
  } finally {
    try {
      fs.rmSync(startJpeg, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/* ── helpers ── */

async function downloadToFile(url: string, outFile: string): Promise<void> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const resp = await fetch(url);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 500) throw new Error(`GenAIPro download from ${url} is suspiciously small`);
      fs.writeFileSync(outFile, buf);
      return;
    }
    if (attempt === 3) throw new Error(`GenAIPro download ${resp.status} for ${url}`);
    await sleep(2000 * (attempt + 1));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
