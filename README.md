# Conveyer Treso

Local app that turns a narration **script** into a finished **mystical "animated stills" video** — the style of long manifestation / spirituality YouTube videos: AI-generated grimoire imagery with a slow cinematic zoom, floating dust and embers, candle-light flicker, dark meditative passages between scenes, one ambient music drone under everything.

Everything runs on your computer: Next.js web UI + your FFmpeg + your API keys. Nothing is uploaded anywhere.

---

## What you need

1. **Node.js 20+** — https://nodejs.org
2. **FFmpeg** — https://www.gyan.dev/ffmpeg/builds/ (download "full" build, unzip, add the `bin` folder to PATH — or set the full path to `ffmpeg.exe` in Settings → System)
3. **Google API key** (free) — https://aistudio.google.com → *Get API key*. Needed for script segmentation (and optionally for images).
4. **GenAIPro API key** — sign in at genaipro.io → click your **avatar → Manage Account → API Key → Create API Key**. Paste it in Settings and press **Check connection** (it shows your username and credit balance). This powers:
   - **Voiceover (default mode):** the app voices each segment automatically through Labs / Voice AI (ElevenLabs voices, billed in your cheap GenAIPro credits). Pick a voice with the built-in voice search in Settings.
   - **Images (optional):** switch *Image provider* to `genaipro` to generate the visuals with `nano_banana_pro` / `imagen_4` through your Veo credits (1 credit per image, failed tasks auto-refunded) instead of the Google free tier.

   Alternatives for voiceover: **Upload MP3** (make it in any TTS tool and upload — timing is distributed automatically) or **ElevenLabs** (direct API key).

## Install & run

**Easiest way — double-click the launcher:**

- **Windows:** `START-WINDOWS.bat`
- **Mac:** `START-MAC.command`
  *(first time only: if macOS says the file can't be run, open Terminal in this folder and run `chmod +x START-MAC.command`, then double-click it again)*

The launcher installs dependencies on first run, starts the server and opens http://localhost:3777 in your browser. Keep its window open while you work; close it (or press Ctrl+C) to stop the app.

**Or manually:**

```bash
npm install
npm run dev
```

Open http://localhost:3777.

**First run checklist:**
1. Settings → paste your **Google API Key** and **GenAIPro API Key** → Save → press **Check connection** (should show your balance).
2. Settings → GenAIPro → **Find a voice** (e.g. search "spanish narration") → **Use** → Save.
3. Settings → **Run smoke test** — builds a short test video with synthetic images/sound. If it finishes and plays, FFmpeg and the render engine are OK (no API keys needed for this).
4. *(optional)* Drop `music.mp3` (quiet ambient drone) and `intro.mp4` (your channel splash) into the assets folder shown in Settings — they're picked up automatically on every video.

## Making a video

1. **New Video** → paste the script (any language — Spanish narration works out of the box).
2. Pick the voiceover mode:
   - **GenAIPro (auto, default)** — each segment is voiced through your GenAIPro credits; exact per-segment timing.
   - **Upload MP3** — upload a full ready-made voiceover. The app spreads the images across the audio proportionally to the text.
   - **ElevenLabs** — automatic via direct ElevenLabs API.
3. **Generate Video** → watch the logs. When it's done, preview and **Download final.mp4**.

## How it works

```
script
  → the WHOLE script is voiced in ONE continuous take (single-shot) — natural
    narration with no per-scene pauses (long scripts are voiced in a few large
    continuous chunks, split only at sentence ends)
  → that voiceover is cut into scenes of 12–20 seconds each, by the real
    speech timecodes (Settings → Scenes & narration)
  → Gemini writes one image prompt per scene; a pool of unique images is
    generated (16:9), all locked to ONE color palette (Settings → Look & Motion
    → Color palette; default warm orange/gold/red, with violet/blue/emerald
    alternatives for variety between videos)
  → FFmpeg renders each scene with three animations, all continuous across cuts:
      1. the image itself sways — slow Ken Burns zoom (in/out alternating),
         fading in from darkness and dissolving back into it
      2. a big translucent "magic smoke" glow travels along the screen edges
      3. dust and embers drift up through the frame
    plus a subtle candle-light flicker
  → clips are concatenated, intro.mp4 prepended, voiceover laid as one track,
    music.mp3 looped quietly underneath, faded out at the end
  → final.mp4 (1080p30 by default)
```

**Music is never generated** — the app only loops the tracks YOU put in the assets `music\` folder (use the *Open assets folder* button). Multiple tracks play in order and repeat as a playlist. No files = no music.

**Subtitles** are burned in automatically (GenAIPro voice mode): timings come from the GenAIPro/ElevenLabs subtitle export and follow the actual speech, so the text disappears whenever the narrator pauses. Style matches the reference channel (white italic serif, black outline, bottom-centered); tune it in Settings → Subtitles, or turn it off. Not available with uploaded-MP3 / ElevenLabs voice modes.

**Long videos are cheap:** `Max unique images` (default 60) caps image generation; a 3-4-hour script reuses the pool in a cycle — exactly how the reference channels do it.

Subtitles are intentionally **not** burned in (per-segment timing is saved in `timings.json` inside the run folder, so they can be added later).

## Where files live

| What | Where |
|---|---|
| Settings | `~/.conveyer-treso/settings.json` |
| Assets (music/intro) | `~/.conveyer-treso/assets/` |
| Runs (per-video working files + final.mp4) | `~/.conveyer-treso/runs/<id>/` |

## Troubleshooting

- **"Failed to start ffmpeg"** — FFmpeg is not on PATH. Set the full path to `ffmpeg.exe` in Settings → System.
- **GenAIPro images: "Insufficient quota"** — GenAIPro keeps voice and images in **separate credit pools**. Press *Check connection* in Settings: it shows both. If *Veo (image) credits* is 0, buy a Veo package at genaipro.io — or switch *Image provider* back to `gemini` (needs Google billing, see below).
- **Gemini images 429 "limit: 0"** — the Google **free tier does not include image generation**; enable billing on the key's project at aistudio.google.com, or use *Image provider* = `genaipro` instead.
- **Gemini 429 / quota** — lower `Parallel image requests` to 1, or lower `Max unique images`. The app retries automatically with backoff.
- **An image failed** — the run continues; that segment plays as a dark ambient passage (this looks natural in this style).
- **Voiceover upload is large (hours-long MP3)** — that's fine; it's stored locally and never re-encoded until final mux.
