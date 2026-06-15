# CLAUDE.md — project context for Claude Code

## What Conveyer Treso is

A **local web app** (Next.js dev server + FFmpeg + JSON files, no DB, no hosted backend) that turns a narration script into a finished "animated stills" mystical video. Built for Aleix (Treso), a mentee of Andrew's, whose channel posts long Spanish manifestation/spirituality videos (reference: youtube.com/watch?v=WorHAPmb2Bc — "Colección De Riqueza", 4-hour videos).

**The visual formula** (extracted from frame analysis of the reference, see `_reference/frames/` if present; refined by Vlad's feedback after the first smoke test):
- AI image (ornate grimoires, glowing sigils, candles — fire/energy is *baked into the image by the prompt*, not an overlay)
- ONE color palette per video (`VIDEO_PALETTE` + `src/lib/palettes.ts`): default warm golden-fire (reference channel), alternatives violet/blue/emerald. The palette is appended LAST to every image prompt and tints the dark backdrop + edge glow. Vlad explicitly rejected mixed colors within one video.
- slow Ken Burns zoom alternating in/out per segment ("картинка колишеться")
- a big translucent palette-colored glow blob travelling along the frame PERIMETER (`EDGE_GLOW_*`, piecewise if/lt expressions in render.ts) — Vlad: "оранжевий волшебний димок по краях екрану бігає"
- image fades in from black, holds ~30 s, then dissolves into a dark ember-dust ambient background while narration continues (long segments)
- floating dust/ember particles (RGBA sprites with gaussian alpha — they composite over the glow without black-square halos) + subtle candle flicker, all continuous across cuts via (t+offset)
- BURNED SUBTITLES (added on Aleix's request, overriding the original "no subtitles" instruction): genaipro voice mode requests `POST /v1/labs/task/subtitle/{task_id}` per segment after TTS, polls the task until `subtitle` URL appears, parses VTT/SRT (`services/subtitles.ts`), stores cues on `SegmentTiming.cues` (relative to segment start — no offset math needed), and render.ts writes a styled `.ass` next to each clip and appends a `subtitles=` filter. Cues are speech-aligned ⇒ no text during narrator pauses (Vlad's hard requirement). Style: white bold-italic Georgia, black outline, bottom-center (SUBTITLE_* settings). Manual/ElevenLabs modes have no cues ⇒ no subs.
- subtitles exist on the reference but are deliberately NOT implemented (Vlad's explicit instruction); per-segment timings are saved in `timings.json` for later
- one ambient drone music file looped quietly under the whole video
- intro splash (заставка) prepended from a user file

## Stack & deliberate decisions

- **Next.js 16 / React 19 / Tailwind 4 / TS** — matches the conveyer family (Conveyer Hum etc.).
- **NO native deps** (no better-sqlite3, no fluent-ffmpeg): the family needs a postinstall hack against Windows Defender truncating `.node` files. Treso stores runs/settings as **JSON files** under `~/.conveyer-treso/` and spawns ffmpeg directly (`src/lib/services/ffmpeg.ts`).
- **Clips are rendered VIDEO-ONLY; audio is muxed once at assembly.** Per-clip AAC audio + `concat -c copy` accumulates ~23 ms/clip A/V drift over hundreds of segments. Instead: ElevenLabs MP3s are padded to each clip's exact duration as WAV (sample-exact) and concatenated into one continuous track; manual mode uses the uploaded MP3 as-is with proportional per-segment durations (snapped to the frame grid, last segment absorbs the residue).
- **Particle/flicker continuity:** every segment's FX expressions use `(t + startOffset)` where startOffset = sum of previous segment durations, and the particle table is a fixed seeded PRNG (`particleTable()` in render.ts) — so dust drifts seamlessly across hard cuts and the cuts are invisible (segment edges are dark by design: image alpha-fades at both ends).
- **`blend=all_mode=screen` MUST run in RGB (`format=gbrp`)** — in YUV it screen-blends the neutral chroma planes (128→~192) and the whole frame turns magenta. This was hit and fixed during development; don't "simplify" it away.
- **Image pool with round-robin reuse** (`MAX_UNIQUE_IMAGES`, default 60): the reference 4-hour video demonstrably cycles a few dozen visuals. Pool prompts are taken from evenly-spaced segments so reused imagery follows the script's arc. A failed image generation degrades that segment to the dark-ambient background (non-fatal).
- **Voice providers:** `genaipro` (DEFAULT — Aleix's credit provider; client in `src/lib/services/genaipro.ts`, spec copy in `_reference/genaipro-openapi.yaml`, live spec https://docs.genaipro.io/openapi.yaml; base `https://genaipro.io/api`, `Authorization: Bearer`; TTS = POST `/v1/labs/task` → poll `/v1/labs/task/{id}` → download `result` mp3), `manual` (upload MP3) and `elevenlabs` (direct REST, family pattern). GenAIPro also serves as optional IMAGE_PROVIDER (`/v2/veo/create-image`, models nano_banana_pro/nano_banana_2/imagen_4, 16:9 via IMAGE_ASPECT_RATIO_LANDSCAPE, poll `/v2/veo/tasks/{id}`, **30 req/min shared rate limit** — poll gently, back off hard on 429). Settings page has Check-connection (`/v2/me`) and voice search (`/v1/labs/voices`) helpers.
- **Gemini direct REST** (`generativelanguage.googleapis.com`), no SDK: text via `TEXT_MODEL` (gemini-flash-latest), images via `IMAGE_MODEL` (gemini-2.5-flash-image / nano-banana, `responseModalities:["IMAGE"]`, aspectRatio 16:9). One GOOGLE_API_KEY covers both — that's what Aleix already uses.

## Pipeline (src/lib/pipeline.ts) — SINGLE-SHOT (rebuilt 2026-06-14)

Vlad rejected the old per-scene voicing (each scene = its own TTS task): intonation reset every ~15s, pause artifacts at joins, and 11+ slow tasks per run. The pipeline now voices the WHOLE script in one continuous take and cuts scenes by the speech timecodes.

`POST /api/runs` → `createRun()` → `startPipeline()` fire-and-forget:
1. **VOICE** `generateVoiceTimeline()` (services/voice.ts) — voices the whole script in ONE take (large sentence-aligned chunks if it exceeds `MAX_TTS_CHARS`≈9000, since ElevenLabs/GenAIPro cap a single request). Chunks are voiced in PARALLEL (TTS_CONCURRENCY) then stitched in order — serial chunk voicing was a big time sink on long scripts. Per genaipro chunk: `ttsToFile` → mp3 → wav, `exportSubtitlesRaw` → SRT. Concatenates chunk wavs → one continuous `voiceover.wav`; offsets each chunk's cues → global `cues[]`; builds a per-word `words[]` timeline. Manual mode = uploaded file, no timecodes. Returns `VoiceTimeline {voiceoverFile, totalSec, cues, words}`, cached to `voice.json`.
2. **SCENES** `cutScenes()` (services/scenes.ts) — cuts the narration into N scenes STRICTLY 12–20s each (`SCENE_MIN_SEC`/`SCENE_MAX_SEC`, Vlad's hard rule): N=clamp(round(T/16), ceil(T/max), floor(T/min)); even boundaries nudged to the nearest word only within a slack that keeps every scene in range. Scene text from the word timeline (or even split for manual). `describeScenes()` — ONE Gemini call writes a `visual_prompt` per scene (Gemini no longer splits/times anything). → `scenes.json`.
3. `generateImages()` (services/image-gen.ts) — pool → round-robin assignment (unchanged; takes `{index,visual_prompt}[]`).
4. `renderAllScenes()` (services/render.ts) — per scene: duration = `endSec-startSec`; subtitle cues = `sliceCues(globalCues, startSec, endSec)` offset to clip-local. **FX are PRE-RENDERED once** (`prerenderFxLoop`): particles + edge-glow + blur are rendered to a short looping `fx/fxloop.mp4` (loop length = glow lap time so the glow is seamless), then each clip just `-stream_loop -1 -ss (sceneStart % loopSec)`-seeks into it and screen-blends it (continuous motion across cuts). This is the big render speedup — measured: per-frame FX cost was ~41s for a 16s clip (12× the ~3.4s encode cost); recomputing it for every clip was the bottleneck. Doing it once + light per-clip blend roughly halves per-clip filter time; for long videos the one-time loop cost is negligible. Image Ken-Burns upscale reduced 2×→1.35× (zoom max ≈1.12). RENDER_CONCURRENCY default 3 (tune to cores).
5. `assembleVideo()` (services/assemble.ts) — concat clips (`-c copy`), intro prepend, then mux the SINGLE `voiceover.wav` over the whole video + music playlist. (No more per-segment audio concat — the voiceover is already one continuous track.)

Order is voice→images now (was images-first). Voice is cheap (1 task) so the old "don't waste voice credits if images fail" concern is moot; images still need scene texts which come from the voice timeline. `services/elevenlabs.ts` holds the ElevenLabs TTS call. Old `services/tts.ts` + `services/segment.ts` were DELETED.

Logs: JSONL file per run + in-process EventEmitter → SSE (`/api/runs/[id]/logs`), plus a `?format=json` history endpoint the run page re-syncs every 5s. The run page dedups entries by `ts|stage|message` INSIDE the `setLogs` updater (against current state) — NOT a per-effect Set: React Strict Mode double-mounts the effect in dev, so two EventSources + two pollers each deliver every entry; state-level dedup collapses them (the file itself is never duplicated — verified). Status: `run.json` per run, polled by the UI. Cancellation: cooperative in-memory set.

**Smoke test** (`POST /api/runs {smoke:true}`, button in Settings): synthetic gradient images + sine-wave voiceover through the REAL render+assemble path — verifies FFmpeg end-to-end with zero API keys.

## Resume / Retry (added 2026-06-13)

A run is fully **resumable** — `POST /api/runs/[id]/retry` (↻ Retry button on the run page for error/cancelled runs) calls `startPipeline(id, {})` again on the SAME run dir. Stages reuse on-disk artifacts so finished work is never re-paid:
- **segments** — `loadSegmentsIfPresent(dir)` reads `segments.json`.
- **images** (the expensive Veo part) — `findExistingPoolImage()` reuses any `images/img_NNN.{png,jpg}` >500B; zero API calls for already-generated images.
- **voice** — `perSegmentVoice` reuses a segment when `audio/seg_NNNN.mp3` + `audio/seg_NNNN.json` sidecar both exist. The sidecar stores `{rawDurationSec, cues}` (tail silence re-applied at load, so the TAIL_SILENCE setting can change). Segments voiced BEFORE this feature lack sidecars → they re-synth (cheap), but images are still saved.
- **render + assemble** — always re-run (local/cheap, reflects current visual/subtitle settings).

Zombie-task fix: on any pipeline error the catch calls `requestCancel(runId)`; the cancel flag is cleared at pipeline START (not in `finally`), so sibling in-flight parallel TTS/image polls (which check `isCancelled` via `checkAbort`) stop instead of logging after the run failed, and a retry still starts clean.

GenAIPro TTS tasks run async and complete server-side even when slow, so per-task poll patience is generous (15 min, setting `TTS_TASK_TIMEOUT_MIN`) — do NOT cut this short and resubmit (that sends the task to the back of the queue, making it worse; a 2026-06-13 attempt to do so was reverted). The task id is persisted to `audio/seg_NNNN.task` the moment it's created; `ttsToFile(text, out, {runId, taskIdFile})` re-polls that same task on a Retry (`taskIsLive` check) and downloads the finished audio rather than paying for a new task — so a timed-out clip is never lost.

Verified end-to-end with a fully pre-seeded synthetic run: retry reused segments + 3 images + 3 voiced segments with ZERO API calls, burned subtitles from the cached cues, and assembled final.mp4.

## Verify a change

1. `npx tsc --noEmit` — 0 errors.
2. `npm run dev` → Settings → Run smoke test → watch logs → final.mp4 plays.
3. For filtergraph changes: extract frames from the smoke output (`ffmpeg -ss N -i final.mp4 -frames:v 1 out.jpg`) and LOOK at them (particles visible? colors correct, not magenta? fades smooth?).

## Out of scope / future

- Subtitle burning (timings are saved; add drawtext/ass in render.ts when asked).
- GenAIPro API adapter (waiting for reachable docs).
- Auto-script generation (Claude) — Vlad plans it as a later phase.
- Folding into Conveyer Hub as a mode — Hub's `ModeDefinition` could express this pipeline (renderer "ffmpeg-stills-fx"); keep that mapping in mind but don't merge prematurely.
