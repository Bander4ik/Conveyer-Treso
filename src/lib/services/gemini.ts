import { getSetting } from "../settings";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Models worth falling back to when the configured one is overloaded (503)
 *  or missing (404). The family-proven ladder. */
const TEXT_FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

class GeminiHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GeminiHttpError";
    this.status = status;
  }
}

interface GeminiTextOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** force application/json response */
  json?: boolean;
  timeoutMs?: number;
}

/**
 * Text generation via Google Generative Language REST API (family pattern).
 * Tries the configured model with patient backoff, then walks the fallback
 * ladder — "high demand" 503 spikes usually affect one model alias only.
 */
export async function geminiText(
  systemPrompt: string,
  userText: string,
  opts: GeminiTextOptions = {}
): Promise<string> {
  const configured = opts.model || getSetting("TEXT_MODEL") || "gemini-flash-latest";
  const ladder = [...new Set([configured, ...TEXT_FALLBACK_MODELS])];

  let lastErr: Error | null = null;
  for (const model of ladder) {
    try {
      return await geminiTextOnce(model, systemPrompt, userText, opts);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      // auth/key problems fail for every model — no point walking the ladder.
      // A 400 is NOT one of those: it is usually per-model (an unsupported
      // generationConfig field), so keep walking.
      if (e instanceof GeminiHttpError && [401, 403].includes(e.status)) throw e;
    }
  }
  throw lastErr ?? new Error("Gemini: all models failed");
}

/** Models that rejected `thinkingConfig` once — never send it to them again.
 *  Gemini 3.x cannot have thinking disabled: `thinkingBudget: 0` comes back as
 *  a bare 400 INVALID_ARGUMENT ("Request contains an invalid argument"), which
 *  reads like a wrong model name but is really this one field. */
const noThinkingConfig = new Set<string>();

async function geminiTextOnce(
  model: string,
  systemPrompt: string,
  userText: string,
  opts: GeminiTextOptions
): Promise<string> {
  try {
    return await geminiCall(model, systemPrompt, userText, opts, !noThinkingConfig.has(model));
  } catch (e) {
    if (e instanceof GeminiHttpError && e.status === 400 && !noThinkingConfig.has(model)) {
      // retry once without thinkingConfig — that's the usual culprit
      noThinkingConfig.add(model);
      return await geminiCall(model, systemPrompt, userText, opts, false);
    }
    throw e;
  }
}

async function geminiCall(
  model: string,
  systemPrompt: string,
  userText: string,
  opts: GeminiTextOptions,
  withThinkingConfig: boolean
): Promise<string> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (open Settings)");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      ...(opts.json !== false ? { responseMimeType: "application/json" } : {}),
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxOutputTokens ?? 65535,
      ...(withThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });

  const maxRetries = 4;
  let lastErr: Error = new Error("Gemini: no attempts made");
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = new Error(`Gemini network error: ${e instanceof Error ? e.message : String(e)}`);
      if (attempt === maxRetries) throw lastErr;
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    clearTimeout(timer);

    if (resp.ok) {
      const json = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      };
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const reason = cand?.finishReason;
      if (reason && reason !== "STOP") {
        throw new Error(`Gemini finished with ${reason} (output likely cut off — script chunk too large)`);
      }
      if (!text) throw new Error("Gemini returned empty output");
      return text;
    }
    const errText = (await resp.text()).slice(0, 400);
    lastErr = new GeminiHttpError(resp.status, `Gemini ${model} ${resp.status}: ${errText}`);
    if (!RETRYABLE.has(resp.status) || attempt === maxRetries) throw lastErr;
    // 503 "high demand" / 429 quota need real patience, capped at 45s
    const base = resp.status === 429 ? 5000 : 2500;
    await sleep(Math.min(45_000, base * 2 ** attempt));
  }
  throw lastErr;
}

/**
 * Image generation via Gemini image model ("nano-banana").
 * Returns raw image bytes (PNG/JPEG per mimeType).
 */
export async function geminiImage(prompt: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (open Settings)");
  const model = getSetting("IMAGE_MODEL") || "gemini-2.5-flash-image";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "16:9" },
    },
  });

  const maxRetries = 5;
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = `Gemini image network error: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt === maxRetries) throw new Error(lastErr);
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    clearTimeout(timer);

    if (resp.ok) {
      const json = (await resp.json()) as {
        candidates?: {
          content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
        }[];
      };
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          return {
            bytes: Buffer.from(part.inlineData.data, "base64"),
            mimeType: part.inlineData.mimeType || "image/png",
          };
        }
      }
      lastErr = "Gemini image: response contained no image data (prompt may have been blocked)";
      if (attempt === maxRetries) throw new Error(lastErr);
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    const errText = (await resp.text()).slice(0, 400);
    lastErr = `Gemini image ${resp.status}: ${errText}`;
    if (!RETRYABLE.has(resp.status) || attempt === maxRetries) throw new Error(lastErr);
    // 429 on the image model is common on free tier — back off harder.
    await sleep((resp.status === 429 ? 5000 : 1500) * 2 ** attempt);
  }
  throw new Error(lastErr);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
