import fs from "fs";
import { getNumber, getSetting } from "../settings";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Synthesize one block of text to an mp3 via the ElevenLabs API. */
export async function elevenLabsToFile(text: string, outFile: string): Promise<void> {
  const apiKey = getSetting("ELEVENLABS_API_KEY");
  const voiceId = getSetting("ELEVENLABS_VOICE_ID");
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set (open Settings)");
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID is not set (open Settings)");
  const model = getSetting("ELEVENLABS_MODEL") || "eleven_multilingual_v2";

  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: {
      stability: clamp(getNumber("TTS_STABILITY", 0.5), 0, 1),
      similarity_boost: clamp(getNumber("TTS_SIMILARITY", 0.75), 0, 1),
      speed: clamp(getNumber("TTS_SPEED", 1.0), 0.7, 1.2),
    },
  });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const maxRetries = 4;
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body,
    });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 200) throw new Error("ElevenLabs returned an empty audio file");
      fs.writeFileSync(outFile, buf);
      return;
    }
    const errText = (await resp.text()).slice(0, 300);
    lastErr = `ElevenLabs ${resp.status}: ${errText}`;
    if (!RETRYABLE.has(resp.status) || attempt === maxRetries) throw new Error(lastErr);
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  throw new Error(lastErr);
}
