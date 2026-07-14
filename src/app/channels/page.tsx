"use client";

import { useEffect, useState } from "react";

interface Channel {
  id: string;
  name: string;
  voiceId: string;
  language: string;
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/channels")
      .then((r) => r.json())
      .then((d) => setChannels(d.channels ?? []))
      .catch(() => {});
  }, []);

  function resetForm() {
    setEditingId(null);
    setName("");
    setLanguage("");
    setVoiceId("");
  }

  function startEdit(c: Channel) {
    setEditingId(c.id);
    setName(c.name);
    setLanguage(c.language);
    setVoiceId(c.voiceId);
  }

  async function save() {
    if (!name.trim()) {
      setError("Channel name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId ?? undefined,
          name: name.trim(),
          language: language.trim(),
          voiceId: voiceId.trim(),
        }),
      });
      const d = await resp.json();
      if (!resp.ok) throw new Error(d.error || "Failed to save channel");
      setChannels(d.channels ?? []);
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const resp = await fetch(`/api/channels?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const d = await resp.json();
    if (resp.ok) {
      setChannels(d.channels ?? []);
      if (editingId === id) resetForm();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Channels</h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-dim)" }}>
          Each channel is one language edition. In a multi-language run the visuals are generated
          once and reused; each channel gets its own voice, translated script and subtitles.
        </p>
      </div>

      <div className="card space-y-4">
        <div className="card-title">{editingId ? "Edit channel" : "Add a channel"}</div>
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Riqueza ES"
          />
        </div>
        <div>
          <label className="label">Language</label>
          <input
            className="input"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="Spanish, German…"
          />
        </div>
        <div>
          <label className="label">Voice ID</label>
          <input
            className="input"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            autoComplete="off"
          />
          <p className="hint">
            GenAIPro voice id — find one in Settings → GenAIPro → Find a voice, then paste its id
            here.
          </p>
        </div>
        {error && (
          <p className="hint" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : editingId ? "Save changes" : "Add channel"}
          </button>
          {editingId && (
            <button className="btn" type="button" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="card space-y-3">
        <div className="card-title">Your channels</div>
        {channels.length === 0 ? (
          <p className="hint">No channels yet — add one above.</p>
        ) : (
          channels.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 text-sm rounded-lg px-3 py-2"
              style={{ background: "var(--bg-soft)", border: "1px solid var(--border)" }}
            >
              <span className="font-medium">{c.name}</span>
              <span style={{ color: "var(--text-dim)" }}>{c.language}</span>
              <span
                className="text-xs truncate max-w-[12rem]"
                style={{ color: "var(--text-dim)" }}
                title={c.voiceId}
              >
                {c.voiceId}
              </span>
              <span className="flex-1" />
              <button className="btn text-xs px-2 py-1" onClick={() => startEdit(c)}>
                Edit
              </button>
              <button className="btn btn-danger text-xs px-2 py-1" onClick={() => remove(c.id)}>
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
