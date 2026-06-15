"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type FieldType = "text" | "password" | "textarea" | "select";

interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  hint?: string;
  rows?: number;
}

interface Group {
  title: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    title: "API Keys",
    fields: [
      {
        key: "GOOGLE_API_KEY",
        label: "Google API Key (Gemini — script segmentation, optionally images)",
        type: "password",
        hint: "Get it at aistudio.google.com → Get API key. Needed for script segmentation in every mode.",
      },
      {
        key: "GENAIPRO_API_KEY",
        label: "GenAIPro API Key (voiceover + optionally images)",
        type: "password",
        hint: "genaipro.io → your avatar → Manage Account → API Key → Create API Key. Use the 'Check connection' button below after saving.",
      },
      {
        key: "ELEVENLABS_API_KEY",
        label: "ElevenLabs API Key (alternative voiceover)",
        type: "password",
      },
    ],
  },
  {
    title: "Voice",
    fields: [
      {
        key: "VOICE_MODE",
        label: "Default voice mode",
        type: "select",
        options: ["genaipro", "manual", "elevenlabs"],
        hint: "genaipro = automatic per-segment voiceover via your GenAIPro credits. manual = you upload a ready MP3. elevenlabs = automatic via ElevenLabs API.",
      },
      {
        key: "GENAIPRO_VOICE_ID",
        label: "GenAIPro Voice ID",
        type: "text",
        hint: "Use the voice search below, or copy the voice id from the GenAIPro dashboard.",
      },
      {
        key: "GENAIPRO_TTS_MODEL",
        label: "GenAIPro TTS model",
        type: "select",
        options: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_v3"],
        hint: "multilingual_v2 — best quality for Spanish narration.",
      },
      { key: "ELEVENLABS_VOICE_ID", label: "ElevenLabs Voice ID", type: "text" },
      {
        key: "ELEVENLABS_MODEL",
        label: "ElevenLabs model",
        type: "select",
        options: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5"],
        hint: "multilingual_v2 gives the best quality for Spanish narration.",
      },
      { key: "TTS_SPEED", label: "Speed (0.7–1.2)", type: "text" },
      { key: "TTS_STABILITY", label: "Stability (0–1)", type: "text" },
      { key: "TTS_SIMILARITY", label: "Similarity boost (0–1)", type: "text" },
      { key: "TAIL_SILENCE", label: "Pause between segments, sec", type: "text" },
      { key: "TTS_CONCURRENCY", label: "Parallel TTS requests", type: "text" },
      {
        key: "TTS_TASK_TIMEOUT_MIN",
        label: "Max wait per voice clip, min",
        type: "text",
        hint: "How long to wait for one GenAIPro voice clip before giving up. GenAIPro can be slow under load; if you see 'still processing' errors, raise this. A timed-out clip is never lost — Retry picks up the finished audio.",
      },
    ],
  },
  {
    title: "Images",
    fields: [
      {
        key: "IMAGE_PROVIDER",
        label: "Image provider",
        type: "select",
        options: ["gemini", "genaipro"],
        hint: "gemini = direct Google API (free tier has daily limits). genaipro = nano-banana / imagen via GenAIPro Veo credits (1 credit per image, failed tasks auto-refunded).",
      },
      {
        key: "GENAIPRO_IMAGE_MODEL",
        label: "GenAIPro image model",
        type: "select",
        options: ["nano_banana_pro", "nano_banana_2", "imagen_4"],
      },
      {
        key: "IMAGE_MODEL",
        label: "Gemini image model",
        type: "text",
        hint: "gemini-2.5-flash-image (nano-banana). Used only when provider = gemini.",
      },
      {
        key: "MAX_UNIQUE_IMAGES",
        label: "Max unique images per video",
        type: "text",
        hint: "Long scripts reuse images in a cycle (like the reference channel does). Keeps cost flat on 3-4 hour videos.",
      },
      { key: "IMAGE_CONCURRENCY", label: "Parallel image requests", type: "text" },
      {
        key: "IMAGE_STYLE_SUFFIX",
        label: "Style suffix appended to every image prompt",
        type: "textarea",
        rows: 3,
      },
    ],
  },
  {
    title: "Scenes & narration",
    fields: [
      { key: "TEXT_MODEL", label: "Gemini text model (writes image prompts)", type: "text" },
      {
        key: "SCENE_MIN_SEC",
        label: "Min scene duration, sec",
        type: "text",
        hint: "Each image (scene) is shown for a window between min and max seconds, cut by the real speech timecodes.",
      },
      { key: "SCENE_MAX_SEC", label: "Max scene duration, sec", type: "text" },
      {
        key: "MAX_TTS_CHARS",
        label: "Max characters per voice take",
        type: "text",
        hint: "The whole script is voiced in one continuous take. Scripts longer than this are voiced in a few large continuous chunks (split only at sentence ends). ~9000 is safe for ElevenLabs voices.",
      },
      {
        key: "SCENE_DESCRIBE_PROMPT",
        label: "Image-prompt instructions (per scene)",
        type: "textarea",
        rows: 12,
      },
    ],
  },
  {
    title: "Look & Motion",
    fields: [
      {
        key: "VIDEO_PALETTE",
        label: "Color palette (one gamma for the whole video)",
        type: "select",
        options: ["golden-fire", "violet-storm", "mystic-blue", "emerald-ritual"],
        hint: "golden-fire = warm orange/gold/red like the reference channel. The palette locks the image prompts, the dark background and the edge-glow color. Switch it per video for variety.",
      },
      { key: "VIDEO_RESOLUTION", label: "Resolution", type: "select", options: ["1920x1080", "1280x720"] },
      { key: "VIDEO_FPS", label: "FPS", type: "text" },
      { key: "ZOOM_AMOUNT", label: "Ken Burns zoom amount (0.05–0.3)", type: "text" },
      {
        key: "IMAGE_HOLD_SECONDS",
        label: "Image hold, sec",
        type: "text",
        hint: "Only matters for very long scenes — with 12–20s scenes the image stays visible the whole time and just dips at the cut.",
      },
      { key: "FADE_IN_SECONDS", label: "Image fade-in, sec", type: "text" },
      { key: "FADE_OUT_SECONDS", label: "Dissolve-to-dark, sec", type: "text" },
      { key: "EDGE_FADE_SECONDS", label: "Dip at segment cut, sec", type: "text" },
      { key: "PARTICLES_ENABLED", label: "Floating dust / embers", type: "select", options: ["true", "false"] },
      { key: "PARTICLE_COUNT", label: "Particle count (max 16)", type: "text" },
      {
        key: "EDGE_GLOW_ENABLED",
        label: "Edge glow — magic smoke travelling along the screen border",
        type: "select",
        options: ["true", "false"],
      },
      { key: "EDGE_GLOW_STRENGTH", label: "Edge glow strength (0–1)", type: "text" },
      { key: "EDGE_GLOW_SIZE", label: "Edge glow size (fraction of width, 0.3–1)", type: "text" },
      { key: "EDGE_GLOW_PERIOD", label: "Edge glow lap time, sec", type: "text" },
      { key: "FLICKER_ENABLED", label: "Candle-light flicker", type: "select", options: ["true", "false"] },
      { key: "FLICKER_STRENGTH", label: "Flicker strength (0.01–0.05)", type: "text" },
    ],
  },
  {
    title: "Subtitles",
    fields: [
      {
        key: "SUBTITLES_ENABLED",
        label: "Burn subtitles into the video",
        type: "select",
        options: ["true", "false"],
        hint: "Timings come from the GenAIPro subtitle export and follow the actual speech — text disappears while the narrator pauses. Works with the GenAIPro voice mode (not with uploaded MP3 / ElevenLabs).",
      },
      { key: "SUBTITLE_FONT", label: "Font", type: "select", options: ["Georgia", "Times New Roman", "Palatino Linotype", "Arial"] },
      { key: "SUBTITLE_FONT_SIZE", label: "Font size (at 1080p)", type: "text" },
      { key: "SUBTITLE_MAX_CHARS", label: "Max characters per line", type: "text" },
      { key: "SUBTITLE_MARGIN_V", label: "Bottom margin, px", type: "text" },
    ],
  },
  {
    title: "Music bed",
    fields: [
      {
        key: "MUSIC_VOLUME",
        label: "Music volume (0–1)",
        type: "text",
        hint: "Drop music.mp3 into the assets folder (path shown below). 0.10 ≈ quiet ambient drone under the voice.",
      },
      { key: "MUSIC_FADE_OUT", label: "Music fade-out at the end, sec", type: "text" },
    ],
  },
  {
    title: "System",
    fields: [
      {
        key: "FFMPEG_PATH",
        label: "FFmpeg path (empty = use PATH)",
        type: "text",
        hint: "Example: C:\\ffmpeg\\bin\\ffmpeg.exe",
      },
      { key: "RUNS_OUTPUT_DIR", label: "Runs output folder (empty = default)", type: "text" },
      { key: "RENDER_CONCURRENCY", label: "Parallel ffmpeg renders", type: "text" },
    ],
  },
];

interface AssetsInfo {
  dir: string;
  musicDir: string;
  musicTracks: string[];
  intro: string | null;
}

interface GapVoice {
  voice_id: string;
  name: string;
  language: string;
  accent: string;
  gender: string;
  category: string;
  preview_url: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [assets, setAssets] = useState<AssetsInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [smokeStarting, setSmokeStarting] = useState(false);
  const [gapStatus, setGapStatus] = useState<string | null>(null);
  const [gapChecking, setGapChecking] = useState(false);
  const [voiceQuery, setVoiceQuery] = useState("");
  const [voices, setVoices] = useState<GapVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setValues(d.settings ?? {});
        setAssets(d.assets ?? null);
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      const resp = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const d = await resp.json();
      if (d.settings) setValues(d.settings);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  async function smokeTest() {
    setSmokeStarting(true);
    try {
      const resp = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smoke: true }),
      });
      const d = await resp.json();
      if (resp.ok) router.push(`/runs/${d.id}`);
    } finally {
      setSmokeStarting(false);
    }
  }

  async function checkGenaipro() {
    setGapChecking(true);
    setGapStatus(null);
    try {
      const resp = await fetch("/api/genaipro/me");
      const d = await resp.json();
      setGapStatus(
        d.ok
          ? `✓ Connected as ${d.username} — voice credits: ${d.balance}` +
              (d.veoRemaining !== null && d.veoRemaining !== undefined
                ? ` · Veo (image) credits: ${d.veoRemaining}`
                : "")
          : `✗ ${d.error || "Connection failed"}`
      );
    } catch (e) {
      setGapStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGapChecking(false);
    }
  }

  async function searchVoices() {
    setVoicesLoading(true);
    setVoicesError(null);
    setVoices([]);
    try {
      const q = new URLSearchParams();
      if (voiceQuery.trim()) q.set("search", voiceQuery.trim());
      const resp = await fetch(`/api/genaipro/voices?${q.toString()}`);
      const d = await resp.json();
      if (!resp.ok) throw new Error(d.error || "Voice search failed");
      setVoices(d.voices ?? []);
      if ((d.voices ?? []).length === 0) setVoicesError("Nothing found — try another search term.");
    } catch (e) {
      setVoicesError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoicesLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold flex-1">Settings</h1>
        {savedAt && Date.now() - savedAt < 4000 && (
          <span className="text-sm" style={{ color: "var(--ok)" }}>
            ✓ Saved
          </span>
        )}
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>

      {assets && (
        <div className="card">
          <div className="flex items-center mb-2">
            <div className="card-title mb-0 flex-1">Assets folder</div>
            <button
              className="btn text-xs"
              type="button"
              onClick={() => fetch("/api/open-assets", { method: "POST" })}
            >
              📂 Open assets folder
            </button>
          </div>
          <p className="hint">
            <span style={{ color: "var(--accent)" }}>{assets.dir}</span>
            <br />• <b>music\</b> — drop one or more audio tracks (mp3/wav/m4a…) into this
            subfolder. They play in order and repeat as a playlist, quietly under the voice.
            Current:{" "}
            {assets.musicTracks.length > 0 ? (
              <span style={{ color: "var(--ok)" }}>
                {assets.musicTracks.length} track(s): {assets.musicTracks.join(", ")} ✓
              </span>
            ) : (
              "no tracks yet"
            )}
            <br />• <b>intro.mp4</b> — channel splash, prepended before every video:{" "}
            {assets.intro ? <span style={{ color: "var(--ok)" }}>found ✓</span> : "not found"}
            <br />• <b>base\</b> — auto-generated effect sprites, don&apos;t touch.
          </p>
        </div>
      )}

      <div className="card">
        <div className="card-title">Check the render engine</div>
        <p className="hint mb-3">
          Builds a short 3-segment test video with synthetic images and sound — verifies FFmpeg and
          the whole assembly without any API keys.
        </p>
        <button className="btn" onClick={smokeTest} disabled={smokeStarting}>
          {smokeStarting ? "Starting…" : "▶ Run smoke test"}
        </button>
      </div>

      <div className="card space-y-4">
        <div className="card-title">GenAIPro</div>
        <div className="flex items-center gap-3 flex-wrap">
          <button className="btn" onClick={checkGenaipro} disabled={gapChecking}>
            {gapChecking ? "Checking…" : "Check connection"}
          </button>
          {gapStatus && (
            <span
              className="text-sm"
              style={{ color: gapStatus.startsWith("✓") ? "var(--ok)" : "var(--danger)" }}
            >
              {gapStatus}
            </span>
          )}
        </div>
        <div>
          <label className="label">Find a voice (saves the ID into the Voice section below)</label>
          <div className="flex gap-2">
            <input
              className="input"
              value={voiceQuery}
              onChange={(e) => setVoiceQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") searchVoices();
              }}
              placeholder="e.g. spanish narration, Antoni, deep male…"
            />
            <button className="btn" onClick={searchVoices} disabled={voicesLoading}>
              {voicesLoading ? "Searching…" : "Search"}
            </button>
          </div>
          {voicesError && (
            <p className="hint" style={{ color: "var(--danger)" }}>
              {voicesError}
            </p>
          )}
          {voices.length > 0 && (
            <div className="mt-3 space-y-2 max-h-72 overflow-y-auto pr-1">
              {voices.map((v) => (
                <div
                  key={v.voice_id}
                  className="flex items-center gap-3 text-sm rounded-lg px-3 py-2"
                  style={{ background: "var(--bg-soft)", border: "1px solid var(--border)" }}
                >
                  <span className="font-medium">{v.name}</span>
                  <span style={{ color: "var(--text-dim)" }}>
                    {[v.language, v.accent, v.gender].filter(Boolean).join(" · ")}
                  </span>
                  <span className="flex-1" />
                  {v.preview_url && (
                    <a
                      href={v.preview_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs"
                      style={{ color: "var(--accent)" }}
                    >
                      ▶ preview
                    </a>
                  )}
                  <button
                    className="btn text-xs px-2 py-1"
                    onClick={() => {
                      setValues((vals) => ({ ...vals, GENAIPRO_VOICE_ID: v.voice_id }));
                      setGapStatus(`Voice "${v.name}" selected — press Save settings`);
                    }}
                  >
                    Use
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {GROUPS.map((g) => (
        <div key={g.title} className="card space-y-4">
          <div className="card-title">{g.title}</div>
          {g.fields.map((f) => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {f.type === "textarea" ? (
                <textarea
                  className="textarea"
                  rows={f.rows ?? 4}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              ) : f.type === "select" ? (
                <select
                  className="select"
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  type={f.type}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  autoComplete="off"
                />
              )}
              {f.hint && <p className="hint">{f.hint}</p>}
            </div>
          ))}
        </div>
      ))}

      <button className="btn btn-primary" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
