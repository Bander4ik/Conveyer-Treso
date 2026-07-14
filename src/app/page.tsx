"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface AssetsInfo {
  dir: string;
  musicDir: string;
  musicTracks: string[];
  intro: string | null;
}

interface Channel {
  id: string;
  name: string;
  voiceId: string;
  language: string;
}

// Draft is kept in localStorage so the typed script survives navigating away
// to another tab and back (the page unmounts on client-side navigation).
const DRAFT_KEY = "treso:newVideoDraft:v1";

function hasSavedDraft(): boolean {
  try {
    return !!localStorage.getItem(DRAFT_KEY);
  } catch {
    return false;
  }
}

export default function NewVideoPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [voiceMode, setVoiceMode] = useState<"genaipro" | "manual" | "elevenlabs">("genaipro");
  const [uploading, setUploading] = useState(false);
  const [voiceoverFile, setVoiceoverFile] = useState<string | null>(null);
  const [voiceoverName, setVoiceoverName] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetsInfo | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // `loaded` is STATE (not a ref) on purpose: under React Strict Mode the mount
  // effects run twice, and a ref-based guard let the persist effect overwrite
  // the draft with empty values between the two runs. Gating persist on a state
  // value means it simply doesn't run until the restore has committed.
  const [loaded, setLoaded] = useState(false);

  // restore the draft on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<{
          title: string;
          script: string;
          voiceMode: "genaipro" | "manual" | "elevenlabs";
          voiceoverFile: string | null;
          voiceoverName: string | null;
        }>;
        if (typeof d.title === "string") setTitle(d.title);
        if (typeof d.script === "string") setScript(d.script);
        if (d.voiceMode) setVoiceMode(d.voiceMode);
        if (d.voiceoverFile) setVoiceoverFile(d.voiceoverFile);
        if (d.voiceoverName) setVoiceoverName(d.voiceoverName);
      }
    } catch {
      // ignore malformed draft
    }
    setLoaded(true);
  }, []);

  // persist the draft on every change — but only after the restore committed
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ title, script, voiceMode, voiceoverFile, voiceoverName })
      );
    } catch {
      // storage full / unavailable — non-fatal
    }
  }, [loaded, title, script, voiceMode, voiceoverFile, voiceoverName]);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setAssets(d.assets ?? null);
        // only apply the default voice mode when the user has no saved draft,
        // so a restored choice isn't overwritten
        const m = d.settings?.VOICE_MODE;
        if (!hasSavedDraft() && (m === "elevenlabs" || m === "manual" || m === "genaipro")) {
          setVoiceMode(m);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/channels")
      .then((r) => r.json())
      .then((d) => setChannels(d.channels ?? []))
      .catch(() => {});
  }, []);

  const words = script.trim().split(/\s+/).filter(Boolean).length;

  function toggleChannel(id: string) {
    setSelectedChannelIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    );
  }

  async function uploadVoiceover(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch("/api/upload", { method: "POST", body: form });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Upload failed");
      setVoiceoverFile(data.path);
      setVoiceoverName(data.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVoiceoverFile(null);
      setVoiceoverName(null);
    } finally {
      setUploading(false);
    }
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      // Channels use their own GenAIPro voices, so a multi-language run is
      // always genaipro voice mode regardless of the single-video selection.
      const useChannels = selectedChannelIds.length > 0;
      const resp = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          script,
          voiceMode: useChannels ? "genaipro" : voiceMode,
          voiceoverFile: voiceoverFile ?? undefined,
          channelIds: useChannels ? selectedChannelIds : undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to start");
      try {
        localStorage.removeItem(DRAFT_KEY); // run started — draft no longer needed
      } catch {
        // ignore
      }
      router.push(`/runs/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New Video</h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-dim)" }}>
          Paste the narration script — get a finished mystical video.
        </p>
      </div>

      <div className="card space-y-4">
        <div>
          <label className="label">Title (optional)</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="La Energía Es La Lengua De Dios…"
          />
        </div>
        <div>
          <label className="label">
            Script — narration text, any language ({words} words ≈{" "}
            {Math.round((words / 2.4 / 60) * 10) / 10} min)
          </label>
          <textarea
            className="textarea"
            rows={14}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Paste the full narration script here…"
          />
        </div>
      </div>

      <div className="card space-y-4">
        <div className="card-title">Voiceover</div>
        <div className="flex gap-3 flex-wrap">
          <button
            className={`btn ${voiceMode === "genaipro" ? "btn-primary" : ""}`}
            onClick={() => setVoiceMode("genaipro")}
            type="button"
          >
            GenAIPro (auto)
          </button>
          <button
            className={`btn ${voiceMode === "manual" ? "btn-primary" : ""}`}
            onClick={() => setVoiceMode("manual")}
            type="button"
          >
            Upload MP3
          </button>
          <button
            className={`btn ${voiceMode === "elevenlabs" ? "btn-primary" : ""}`}
            onClick={() => setVoiceMode("elevenlabs")}
            type="button"
          >
            ElevenLabs (auto)
          </button>
        </div>
        {voiceMode === "genaipro" && (
          <p className="hint">
            The script is voiced segment by segment through your GenAIPro account (Labs / Voice AI
            credits). Set the API key and pick a voice in Settings → GenAIPro first.
          </p>
        )}
        {voiceMode === "manual" ? (
          <div>
            <p className="hint mb-2">
              Generate the full voiceover in GenAIPro (or any TTS tool), download the MP3 and
              upload it here. Image timing is distributed across the audio automatically.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".mp3,.wav,.m4a,.aac,.ogg"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadVoiceover(f);
              }}
            />
            <div className="flex items-center gap-3">
              <button className="btn" type="button" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? "Uploading…" : "Choose audio file"}
              </button>
              {voiceoverName && (
                <span className="text-sm" style={{ color: "var(--ok)" }}>
                  ✓ {voiceoverName}
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="hint">
            The script is voiced segment by segment with your ElevenLabs voice. Set the API key and
            Voice ID in Settings first.
          </p>
        )}
      </div>

      <div className="card space-y-3">
        <div className="card-title">Make in these channels (multi-language)</div>
        {channels.length === 0 ? (
          <p className="hint">
            No channels yet.{" "}
            <a href="/channels" style={{ color: "var(--accent)" }}>
              Add a channel
            </a>{" "}
            to produce this video in multiple languages.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {channels.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedChannelIds.includes(c.id)}
                    onChange={() => toggleChannel(c.id)}
                  />
                  <span className="font-medium">{c.name}</span>
                  <span style={{ color: "var(--text-dim)" }}>{c.language}</span>
                </label>
              ))}
            </div>
            <p className="hint">
              Leave empty for a single video. Select channels to produce the same video in each
              language (visuals generated once, reused).
            </p>
          </>
        )}
      </div>

      {assets && (
        <div className="card">
          <div className="flex items-center mb-2">
            <div className="card-title mb-0 flex-1">Extras (optional)</div>
            <button
              className="btn text-xs"
              type="button"
              onClick={() => fetch("/api/open-assets", { method: "POST" })}
            >
              📂 Open assets folder
            </button>
          </div>
          <p className="hint">
            Your personal assets folder: <span style={{ color: "var(--accent)" }}>{assets.dir}</span>
            <br />• <b>Music</b> — drop one or more tracks into the <b>music</b> subfolder; they
            play in order and repeat as a playlist under the whole video —{" "}
            {assets.musicTracks.length > 0 ? (
              <span style={{ color: "var(--ok)" }}>
                {assets.musicTracks.length} track(s): {assets.musicTracks.join(", ")} ✓
              </span>
            ) : (
              "no tracks yet"
            )}
            <br />• <b>intro.mp4</b> — your channel splash, prepended before the video —{" "}
            {assets.intro ? <span style={{ color: "var(--ok)" }}>found ✓</span> : "not found"}
          </p>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <span style={{ color: "var(--danger)" }}>{error}</span>
        </div>
      )}

      <button className="btn btn-primary text-base px-6 py-3" disabled={starting} onClick={start}>
        {starting ? "Starting…" : "⚡ Generate Video"}
      </button>
    </div>
  );
}
