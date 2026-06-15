# Conveyer Treso — Full Setup Guide

This guide is written for **non-technical users**. Follow it step by step and you'll have the app running on your own computer. It takes about **15–20 minutes** the first time.

Conveyer Treso turns a written **script** into a finished **mystical "animated stills" video** — AI images with a slow cinematic zoom, floating embers, a glowing edge, burned-in subtitles, and your background music. Everything runs **on your own computer** — your script and keys never leave your machine.

---

## Part 1 — Install the two free programs you need

You only do this once.

### 1A. Node.js (the engine the app runs on)

1. Go to **https://nodejs.org**
2. Click the big green button that says **"LTS"** (recommended version).
3. Open the downloaded file and click **Next → Next → Install** (accept all defaults).
4. Done. You won't see an icon anywhere — that's normal, it works in the background.

### 1B. FFmpeg (the program that builds the video)

**On Windows:**
1. Go to **https://www.gyan.dev/ffmpeg/builds/**
2. Under "release builds", download the file named **`ffmpeg-release-full.7z`** (or the `.zip` if you don't have 7-Zip).
3. Unzip it. You'll get a folder like `ffmpeg-7.x-full_build`.
4. Move that folder to an easy place, e.g. `C:\ffmpeg`.
5. Inside it there's a `bin` folder containing `ffmpeg.exe`. Remember this path, e.g. `C:\ffmpeg\bin\ffmpeg.exe` — you may need it later (Step 4D).

*(Advanced/optional: adding the `bin` folder to your system PATH lets the app find FFmpeg automatically. If you don't know how, skip it — you'll just paste the path in Settings later.)*

**On Mac:**
1. Open the **Terminal** app (press Cmd+Space, type "Terminal", Enter).
2. If you don't have Homebrew, paste this and press Enter (follow its prompts):
   `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
3. Then paste: `brew install ffmpeg` and press Enter. Wait for it to finish.

---

## Part 2 — Get the app files

You received the app as a **folder called `Conveyer Treso`** (either as a ZIP file, or a download link).

- **If it's a ZIP file:** right-click it → **Extract All** (Windows) or double-click it (Mac). You now have the `Conveyer Treso` folder. Put it somewhere easy, like your Desktop.
- **If it's a link to a download page:** click the **Download** / **Download ZIP** button, then extract it as above.

⚠️ Keep the whole folder together — don't move individual files out of it.

---

## Part 3 — Start the app

1. Open the `Conveyer Treso` folder.
2. Double-click:
   - **Windows:** `START-WINDOWS.bat`
   - **Mac:** `START-MAC.command`
     *(First time on Mac: if it says it can't be opened, right-click the file → **Open** → **Open**. Or open Terminal in the folder and run `chmod +x START-MAC.command` once.)*
3. A black window opens and shows some text. **The first time it will take 1–2 minutes** (it's downloading the parts it needs). Leave the window open.
4. Your web browser opens automatically at **http://localhost:3777** with the app. If it doesn't, open your browser and type that address.

**To use the app, the black window must stay open.** To stop the app, close that window.

✅ Tip: every time you want to use the app in the future, just double-click the same START file again.

---

## Part 4 — Connect your accounts (one time)

In the app, click **Settings** in the left menu. Fill these in, then click **Save settings** at the bottom.

### 4A. Google API key (for the script logic — free)
1. Go to **https://aistudio.google.com**, sign in with a Google account.
2. Click **"Get API key"** → **Create API key**.
3. Copy the key and paste it into **Settings → API Keys → Google API Key**.

### 4B. GenAIPro key (for the voice — and optionally the images)
1. Go to **https://genaipro.io** and sign in.
2. Click your **avatar (top-right) → Manage Account → API Key → Create API Key**.
3. Copy it into **Settings → API Keys → GenAIPro API Key**.
4. Scroll to the **GenAIPro** section and click **Check connection** — it should show your username and your two balances (Voice credits and Veo/image credits).

### 4C. Pick a voice
1. In **Settings → GenAIPro**, type what you want in the voice search (e.g. `spanish narration`, or a voice name) and click **Search**.
2. Click **▶ preview** to hear a voice, then **Use** on the one you like.
3. Click **Save settings**.

### 4D. Tell the app where FFmpeg is (only if needed)
- If when you make a video you see an error like *"Failed to start ffmpeg"*, go to **Settings → System → FFmpeg path** and paste the full path you noted in Step 1B (e.g. `C:\ffmpeg\bin\ffmpeg.exe`). Save.

### 4E. Check the engine works (no keys needed)
- In **Settings**, click **▶ Run smoke test**. It builds a short test video in ~1–2 minutes. If it plays at the end, FFmpeg and the app are working correctly.

---

## Part 5 — (Optional) Add your music and intro

Click **Open assets folder** (button on the New Video or Settings page). A folder opens. Inside:

- **Music:** put one or more audio files (mp3/wav) into the **`music`** sub-folder. They play one after another and loop quietly under the whole video. (No files = no music.)
- **Intro:** put your channel's intro clip as **`intro.mp4`** directly in the assets folder. It will be added to the start of every video. (No file = no intro.)

---

## Part 6 — Make your first video

1. Click **New Video** in the left menu.
2. Paste your **script** (the narration text — any language; Spanish works great).
3. Under **Voiceover**, leave **GenAIPro (auto)** selected.
4. Click **⚡ Generate Video**.
5. You'll see a live log. The app will:
   - voice the whole script in one natural take,
   - cut it into 12–20-second scenes,
   - generate an image for each scene,
   - build the video with motion, effects, subtitles and music.
6. When it's done, the video appears with a **⬇ Download final.mp4** button.

💡 Your typed script is saved automatically — if you switch tabs or close the browser, it's still there when you come back.

---

## Part 7 — Good to know

- **Where your videos are saved:** `Documents`-level hidden folder `.conveyer-treso/runs/…` — but you don't need to find it manually; just use the Download button.
- **If something fails partway (e.g. images), press ↻ Retry.** It continues from where it stopped and **reuses everything already made** — you never pay twice for the voice or images that already worked.
- **Subtitles** are added automatically and follow the speech (they disappear when the narrator pauses). You can change their size/font or turn them off in **Settings → Subtitles**.
- **Scene length** (how long each image stays) is **Settings → Scenes & narration** (default 12–20 seconds).
- **Color style:** **Settings → Look & Motion → Color palette** (warm gold by default; also violet / blue / emerald).

---

## Part 8 — Troubleshooting

| Problem | What it means / fix |
|---|---|
| **"Failed to start ffmpeg"** | FFmpeg isn't found. Do Step 4D (paste the full path to `ffmpeg.exe`). |
| **Images fail: "Insufficient quota"** | Your GenAIPro **image (Veo) credits** are empty **or your package expired**. Open genaipro.io, check the Veo/image balance, and buy/renew an image package. Voice credits are separate and don't help with images. Then press **↻ Retry**. |
| **Gemini images error "limit: 0"** | Google's free plan doesn't include image generation. Either use GenAIPro for images (Settings → Images → provider `genaipro`), or enable billing on your Google account. |
| **Voice clip "still processing" / slow** | GenAIPro is busy. The app waits patiently and a timed-out clip is never lost — just press **↻ Retry**, it picks up the finished audio. |
| **The app won't open / "port in use"** | Close any old black command window from a previous launch, then double-click the START file again. |
| **Rendering a long video is slow** | Normal for 4K-length content on a laptop. For a quick preview, set **Settings → Look & Motion → Resolution = 1280x720** (about 2× faster), then switch back to 1920×1080 for the final. |

---

## Quick recap (after first-time setup)

1. Double-click **START-WINDOWS.bat** / **START-MAC.command**.
2. Browser opens → **New Video** → paste script → **Generate Video**.
3. Wait → **Download final.mp4**.

That's it. Enjoy! 🔮
