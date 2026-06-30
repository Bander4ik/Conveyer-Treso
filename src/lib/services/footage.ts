import fs from "fs";
import { getNumber, getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { runBin, ffprobeBin } from "./ffmpeg";

/**
 * Real stock footage + photos with Gemini-Vision relevance scoring.
 *
 * Ported from Conveyer Reign's visual-source.ts (multi-provider router + vision
 * scorer) and stock-footage.ts (Pexels multi-key pool), adapted to Treso:
 *  - Treso's string-stage logger + settings keys + cancellation.
 *  - JSON/no-native-deps: NO sqlite vision cache (Reign/Guilherme used one) —
 *    scoring is per-run only.
 *  - Pre-applied pitfalls: AbortController timeout on EVERY network call;
 *    relevance threshold cascades and stays modest (default 55, NOT Patrice's
 *    85 that starved footage to 1/23); mpdecimate freeze-guard on stock clips.
 *
 * Providers: pexels (video+photo, multi-key) · pixabay (video+photo, needs key)
 *  · openverse (photo, keyless) · wikimedia (photo, keyless) · archive (video,
 *  keyless). Most are keyless, so footage works even before Aleix adds a Pexels
 *  key — Pexels just widens the pool and adds video.
 */

const UA = "ConveyerTreso/1.0 (local video tool)";
const SOURCE_POOL_PER_PROVIDER = 5;
const SOURCE_POOL_MAX = 14;

export type FootageKind = "video" | "image";

export interface FootageResult {
  path: string;
  kind: FootageKind;
  provider: string;
  matchScore: number;
  author?: string | null;
  sourceUrl?: string;
  license?: string | null;
}

interface ProviderHit {
  kind: FootageKind;
  url: string; // direct download URL
  dedupeId: string; // e.g. "pexels:123"
  thumbUrl?: string; // preview the vision scorer looks at
  author?: string | null;
  sourceUrl?: string;
  license?: string | null;
  provider?: string;
}

type Orientation = "landscape" | "portrait" | "square";

function orientation(): Orientation {
  const o = (getSetting("STOCK_ORIENTATION") || "landscape").toLowerCase();
  return o === "portrait" || o === "square" ? (o as Orientation) : "landscape";
}

function maxHeight(): number {
  return Math.max(360, Math.round(getNumber("STOCK_MAX_HEIGHT", 1080)));
}

/* ── fetch with a hard timeout (Node fetch has no default → infinite hang) ── */

async function fetchT(url: URL | string, init: RequestInit = {}, ms = 30_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadToFile(url: string, outPath: string, ms = 90_000): Promise<void> {
  const resp = await fetchT(url, { headers: { "User-Agent": UA } }, ms);
  if (!resp.ok) throw new Error(`download ${resp.status}: ${url.slice(0, 120)}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) throw new Error(`empty download: ${url.slice(0, 120)}`);
  fs.writeFileSync(outPath, buf);
}

async function safe<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch {
    return [];
  }
}

/* ── Pexels multi-key pool (200 req/hr/key) — rotate + wait-and-resume ── */

interface KeyState {
  key: string;
  resetAt: number | null;
  exhaustedUntilMs: number | null;
}

const pexelsPool: { keys: KeyState[]; cursor: number } = { keys: [], cursor: 0 };

function refreshPexelsPool(): KeyState[] {
  const raw = getSetting("PEXELS_API_KEY") || "";
  const parsed = raw.split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean);
  if (parsed.length === 0) return [];
  const existing = new Map(pexelsPool.keys.map((k) => [k.key, k]));
  pexelsPool.keys = parsed.map((k) => existing.get(k) ?? { key: k, resetAt: null, exhaustedUntilMs: null });
  if (pexelsPool.cursor >= pexelsPool.keys.length) pexelsPool.cursor = 0;
  return pexelsPool.keys;
}

async function sleepCancel(ms: number, runId: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    checkCancelled(runId);
    await new Promise<void>((r) => setTimeout(r, Math.min(5000, ms - (Date.now() - start))));
  }
}

/** Pexels fetch through the key pool. Returns null if no key is configured. */
async function pexelsFetch(url: URL, runId: string): Promise<Response | null> {
  const keys = refreshPexelsPool();
  if (keys.length === 0) return null;
  const MAX_429 = keys.length * 3;
  let hits = 0;
  while (hits < MAX_429) {
    const now = Date.now();
    // pick an available key, else wait for the soonest to recover
    let chosen: KeyState | null = null;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[(pexelsPool.cursor + i) % keys.length];
      if (k.exhaustedUntilMs === null || k.exhaustedUntilMs <= now) {
        k.exhaustedUntilMs = null;
        chosen = k;
        pexelsPool.cursor = keys.indexOf(k);
        break;
      }
    }
    if (!chosen) {
      const soonest = keys.reduce((a, b) => ((a.exhaustedUntilMs ?? Infinity) < (b.exhaustedUntilMs ?? Infinity) ? a : b));
      const wait = Math.min(75 * 60_000, Math.max(0, (soonest.exhaustedUntilMs ?? now) - now) + 5000);
      log(runId, "warn", `All Pexels keys rate-limited — pausing ~${Math.ceil(wait / 60000)} min, then auto-resume`, "footage");
      await sleepCancel(wait, runId);
      continue;
    }
    const resp = await fetchT(url, { headers: { Authorization: chosen.key } });
    if (resp.status === 429) {
      hits++;
      try { await resp.text(); } catch { /* ignore */ }
      chosen.exhaustedUntilMs = (chosen.resetAt ? chosen.resetAt * 1000 : now + 60 * 60_000) + 5000;
      pexelsPool.cursor = (keys.indexOf(chosen) + 1) % keys.length;
      continue;
    }
    if (resp.ok) {
      const reset = parseInt(resp.headers.get("x-ratelimit-reset") || "", 10);
      if (Number.isFinite(reset)) chosen.resetAt = reset;
      const rem = parseInt(resp.headers.get("x-ratelimit-remaining") || "", 10);
      if (Number.isFinite(rem) && rem < 3) chosen.exhaustedUntilMs = (chosen.resetAt ? chosen.resetAt * 1000 : now + 60 * 60_000) + 5000;
    }
    return resp;
  }
  return null;
}

/* ── providers ── */

interface PexelsVideoFile { quality: string; file_type: string; width: number; height: number; link: string }
interface PexelsVideo { id: number; duration: number; url: string; image: string; video_files: PexelsVideoFile[]; user?: { name?: string } }
interface PexelsPhoto { id: number; url: string; photographer?: string; src: { original: string; large2x: string; large: string; medium: string } }

function pickPexelsVideoFile(v: PexelsVideo): PexelsVideoFile | null {
  const maxH = maxHeight();
  const mp4s = v.video_files.filter((f) => /mp4/i.test(f.file_type));
  if (mp4s.length === 0) return null;
  const below = mp4s.filter((f) => f.height <= maxH).sort((a, b) => b.height - a.height);
  return below[0] ?? [...mp4s].sort((a, b) => a.height - b.height)[0] ?? null;
}

async function pexelsHits(query: string, runId: string, want: FootageKind, minDur: number): Promise<ProviderHit[]> {
  const orient = orientation();
  if (want === "video") {
    const u = new URL("https://api.pexels.com/videos/search");
    u.searchParams.set("query", query);
    u.searchParams.set("per_page", "15");
    u.searchParams.set("orientation", orient);
    if (minDur > 0) u.searchParams.set("min_duration", String(Math.ceil(minDur)));
    const resp = await pexelsFetch(u, runId);
    if (!resp || !resp.ok) return [];
    const data = (await resp.json()) as { videos?: PexelsVideo[] };
    const hits: ProviderHit[] = [];
    for (const v of data.videos ?? []) {
      const file = pickPexelsVideoFile(v);
      if (!file) continue;
      hits.push({ kind: "video", url: file.link, dedupeId: `pexels:${v.id}`, thumbUrl: v.image, author: v.user?.name ?? null, sourceUrl: v.url, license: "Pexels License" });
    }
    return hits;
  }
  const u = new URL("https://api.pexels.com/v1/search");
  u.searchParams.set("query", query);
  u.searchParams.set("per_page", "15");
  u.searchParams.set("orientation", orient);
  const resp = await pexelsFetch(u, runId);
  if (!resp || !resp.ok) return [];
  const data = (await resp.json()) as { photos?: PexelsPhoto[] };
  const maxH = maxHeight();
  return (data.photos ?? []).map((p) => ({
    kind: "image" as const,
    url: maxH >= 900 ? p.src.large2x : p.src.large,
    dedupeId: `pexels-photo:${p.id}`,
    thumbUrl: p.src.medium,
    author: p.photographer ?? null,
    sourceUrl: p.url,
    license: "Pexels License",
  }));
}

async function pixabayHits(query: string, want: FootageKind): Promise<ProviderHit[]> {
  const key = getSetting("PIXABAY_API_KEY");
  if (!key) return [];
  const orient = orientation();
  if (want === "video") {
    const u = new URL("https://pixabay.com/api/videos/");
    u.searchParams.set("key", key);
    u.searchParams.set("q", query.slice(0, 100));
    u.searchParams.set("safesearch", "true");
    u.searchParams.set("per_page", "20");
    if (orient !== "square") u.searchParams.set("orientation", orient === "portrait" ? "vertical" : "horizontal");
    const resp = await fetchT(u, { headers: { "User-Agent": UA } });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { hits?: { id: number; pageURL?: string; user?: string; videos?: Record<string, { url: string }> }[] };
    return (data.hits ?? [])
      .map((h): ProviderHit | null => {
        const v = h.videos?.large?.url ? h.videos.large : h.videos?.medium;
        if (!v?.url) return null;
        return { kind: "video", url: v.url, dedupeId: `pixabay:${h.id}`, author: h.user ?? null, sourceUrl: h.pageURL, license: "Pixabay License" };
      })
      .filter((x): x is ProviderHit => x !== null);
  }
  const u = new URL("https://pixabay.com/api/");
  u.searchParams.set("key", key);
  u.searchParams.set("q", query.slice(0, 100));
  u.searchParams.set("image_type", "photo");
  u.searchParams.set("safesearch", "true");
  u.searchParams.set("per_page", "30");
  u.searchParams.set("min_width", "1280");
  u.searchParams.set("orientation", orient === "portrait" ? "vertical" : "horizontal");
  const resp = await fetchT(u, { headers: { "User-Agent": UA } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { hits?: { id: number; pageURL?: string; user?: string; largeImageURL?: string; fullHDURL?: string; webformatURL?: string }[] };
  return (data.hits ?? [])
    .map((h): ProviderHit | null => {
      const url = h.fullHDURL || h.largeImageURL;
      if (!url) return null;
      return { kind: "image", url, dedupeId: `pixabay-img:${h.id}`, thumbUrl: h.webformatURL || url, author: h.user ?? null, sourceUrl: h.pageURL, license: "Pixabay License" };
    })
    .filter((x): x is ProviderHit => x !== null);
}

async function openverseHits(query: string): Promise<ProviderHit[]> {
  const u = new URL("https://api.openverse.org/v1/images/");
  u.searchParams.set("q", query);
  u.searchParams.set("license", "pdm,cc0,by,by-sa");
  u.searchParams.set("license_type", "commercial,modification");
  u.searchParams.set("page_size", "20");
  const resp = await fetchT(u, { headers: { "User-Agent": UA } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { results?: { id: string; url?: string; thumbnail?: string; creator?: string; foreign_landing_url?: string; license?: string }[] };
  return (data.results ?? [])
    .filter((r) => r.url && !/\.svg(\?|$)/i.test(r.url)) // ffmpeg can't ken-burns an SVG
    .map((r): ProviderHit => ({ kind: "image", url: r.url as string, dedupeId: `openverse:${r.id}`, thumbUrl: r.thumbnail || r.url, author: r.creator ?? null, sourceUrl: r.foreign_landing_url, license: r.license ?? null }));
}

async function wikimediaHits(query: string): Promise<ProviderHit[]> {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  u.searchParams.set("action", "query");
  u.searchParams.set("format", "json");
  u.searchParams.set("generator", "search");
  u.searchParams.set("gsrsearch", query);
  u.searchParams.set("gsrnamespace", "6");
  u.searchParams.set("gsrlimit", "20");
  u.searchParams.set("prop", "imageinfo");
  u.searchParams.set("iiprop", "url|mime|extmetadata");
  u.searchParams.set("iiurlwidth", "1920");
  const resp = await fetchT(u, { headers: { "User-Agent": UA } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { query?: { pages?: Record<string, { title?: string; imageinfo?: { url?: string; thumburl?: string; mime?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }[] }> } };
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  const hits: ProviderHit[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info || !/^image\//.test(info.mime ?? "")) continue;
    const url = info.thumburl; // raster even when the source is SVG/TIFF
    if (!url) continue;
    hits.push({ kind: "image", url, dedupeId: `wikimedia:${p.title}`, thumbUrl: url, author: info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, "").slice(0, 120) ?? null, sourceUrl: info.descriptionurl, license: info.extmetadata?.LicenseShortName?.value ?? null });
  }
  return hits;
}

async function archiveHits(query: string): Promise<ProviderHit[]> {
  const search = new URL("https://archive.org/advancedsearch.php");
  search.searchParams.set("q", `(${query.slice(0, 120)}) AND mediatype:(movies)`);
  search.searchParams.append("fl[]", "identifier");
  search.searchParams.append("sort[]", "downloads desc");
  search.searchParams.set("rows", "6");
  search.searchParams.set("output", "json");
  const resp = await fetchT(search, { headers: { "User-Agent": UA } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { response?: { docs?: { identifier?: string }[] } };
  const docs = (data.response?.docs ?? []).filter((d) => d.identifier).slice(0, 3);
  const hits: ProviderHit[] = [];
  for (const d of docs) {
    try {
      const metaResp = await fetchT(`https://archive.org/metadata/${encodeURIComponent(d.identifier!)}`, { headers: { "User-Agent": UA } });
      if (!metaResp.ok) continue;
      const meta = (await metaResp.json()) as { files?: { name?: string; size?: string }[]; metadata?: { licenseurl?: string; creator?: string } };
      const mp4s = (meta.files ?? [])
        .filter((f) => f.name?.toLowerCase().endsWith(".mp4") && Number(f.size || 0) > 0 && Number(f.size) < 80 * 1024 * 1024)
        .sort((a, b) => Number(a.size) - Number(b.size));
      const file = mp4s[0];
      if (!file?.name) continue;
      hits.push({ kind: "video", url: `https://archive.org/download/${encodeURIComponent(d.identifier!)}/${encodeURIComponent(file.name)}`, dedupeId: `archive:${d.identifier}`, thumbUrl: `https://archive.org/services/img/${encodeURIComponent(d.identifier!)}`, author: meta.metadata?.creator ?? null, sourceUrl: `https://archive.org/details/${encodeURIComponent(d.identifier!)}`, license: meta.metadata?.licenseurl ?? "archive.org item license" });
    } catch {
      // skip this item
    }
  }
  return hits;
}

const VIDEO_PROVIDERS = new Set(["pexels", "pixabay", "archive"]);
const IMAGE_PROVIDERS = new Set(["pexels", "pixabay", "openverse", "wikimedia"]);

function configuredProviders(want: FootageKind): string[] {
  const valid = want === "video" ? VIDEO_PROVIDERS : IMAGE_PROVIDERS;
  const raw = getSetting("FOOTAGE_SOURCES") || "pexels,openverse,wikimedia,archive";
  const list = raw.split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => valid.has(s));
  return [...new Set(list.length > 0 ? list : [...valid])];
}

async function providerSearch(name: string, query: string, runId: string, want: FootageKind, minDur: number): Promise<ProviderHit[]> {
  switch (name) {
    case "pexels": return pexelsHits(query, runId, want, minDur);
    case "pixabay": return pixabayHits(query, want);
    case "openverse": return want === "image" ? openverseHits(query) : [];
    case "wikimedia": return want === "image" ? wikimediaHits(query) : [];
    case "archive": return want === "video" ? archiveHits(query) : [];
    default: return [];
  }
}

async function gatherCandidates(runId: string, query: string, want: FootageKind, minDur: number, usedIds: Set<string>): Promise<ProviderHit[]> {
  const names = configuredProviders(want);
  const lists = await Promise.all(
    names.map(async (name) => (await safe(providerSearch(name, query, runId, want, minDur))).slice(0, SOURCE_POOL_PER_PROVIDER).map((h) => ({ ...h, provider: name })))
  );
  // source-diverse round-robin: take the i-th from each provider in turn
  const seen = new Set<string>();
  const pool: ProviderHit[] = [];
  for (let i = 0; i < SOURCE_POOL_PER_PROVIDER; i++) {
    for (const list of lists) {
      const h = list[i];
      if (!h || usedIds.has(h.dedupeId) || seen.has(h.dedupeId)) continue;
      seen.add(h.dedupeId);
      pool.push(h);
      if (pool.length >= SOURCE_POOL_MAX) return pool;
    }
  }
  return pool;
}

/* ── Gemini-Vision relevance scoring (raw REST; no helper in gemini.ts) ── */

function threshold(): number {
  return Math.max(0, Math.min(100, Math.round(getNumber("REAL_MATCH_THRESHOLD", 55))));
}

async function fetchThumb(url: string): Promise<{ mime: string; data: string } | null> {
  try {
    const r = await fetchT(url, { headers: { "User-Agent": UA } }, 12_000);
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!/^image\//.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 4 * 1024 * 1024) return null;
    return { mime, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

function hitLabel(h: ProviderHit): string {
  try {
    const slug = new URL(h.sourceUrl || "").pathname.split("/").filter(Boolean).pop() || "";
    const words = decodeURIComponent(slug).replace(/\.[a-z0-9]+$/i, "").replace(/\d+/g, " ").replace(/[-_]+/g, " ").trim();
    if (words.length > 3) return words;
  } catch { /* ignore */ }
  return h.dedupeId.replace(/^[a-z-]+:/, "").replace(/[-_]+/g, " ");
}

/**
 * ONE Gemini-vision call scores every candidate 0-100 by LOOKING at its preview
 * against the scene + overall topic. Wrong real-world domain ⇒ ≤20. Fail-open
 * with no key (returns first candidate, score 0 so the caller broadens), but a
 * transient error does NOT bypass the bar.
 */
async function scoreAndPick(runId: string, sceneIdx: number, query: string, sceneText: string, videoContext: string | undefined, pool: ProviderHit[]): Promise<{ hit: ProviderHit; score: number } | null> {
  if (pool.length === 0) return null;
  if (threshold() <= 0) return { hit: pool[0], score: 100 };
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) return { hit: pool[0], score: 0 };

  const thumbs = await Promise.all(pool.map((h) => (h.thumbUrl ? fetchThumb(h.thumbUrl) : Promise.resolve(null))));
  const parts: ({ text: string } | { inline_data: { mime_type: string; data: string } })[] = [
    {
      text:
        `You are choosing the single best stock clip/photo for ONE scene of a mystical/spiritual narrated video.\n` +
        `OVERALL VIDEO TOPIC: "${(videoContext || sceneText).slice(0, 400)}"\n` +
        `THIS SCENE (narration): "${sceneText.slice(0, 240)}"\n` +
        `WANTED VISUAL: "${query}"\n\n` +
        `Below are numbered candidates: a title line then its preview image. For EACH, score 0-100 how well the IMAGE itself fits this scene AND the overall mood ` +
        `(100 = exactly the wanted subject, fitting the dark mystical tone; a DIFFERENT real-world domain or off-topic ⇒ score ≤20). Judge what you SEE, not the title. ` +
        `Return STRICTLY JSON: [{"i":<int>,"score":<int>}]. No markdown.`,
    },
  ];
  pool.forEach((h, i) => {
    parts.push({ text: `[${i}] ${h.kind} from ${h.provider}: ${hitLabel(h)}` });
    const t = thumbs[i];
    if (t) parts.push({ inline_data: { mime_type: t.mime, data: t.data } });
  });

  try {
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("TEXT_MODEL") || "gemini-2.5-flash";
    const r = await fetchT(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } } }) },
      60_000
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as { i: number; score: number }[];
    const scored = arr.map((x) => ({ hit: pool[Number(x.i)], score: Number(x.score) })).filter((x) => x.hit && Number.isFinite(x.score)).sort((a, b) => b.score - a.score);
    return scored[0] ?? { hit: pool[0], score: 0 };
  } catch (e) {
    log(runId, "debug", `Scene #${sceneIdx}: relevance scoring failed (${(e as Error).message.slice(0, 80)}) — broadening`, "footage");
    return { hit: pool[0], score: 0 };
  }
}

/* ── freeze-guard: reject a frozen/degenerate stock clip (mpdecimate) ── */

/** Best-effort moving-frame check. Fail-OPEN: any probe error ⇒ accept. */
async function clipHasMotion(file: string): Promise<boolean> {
  try {
    const out = await runBin(
      ffprobeBin(),
      ["-v", "error", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-read_intervals", "%+3", "-count_frames", "-of", "csv=p=0", file],
      30_000
    );
    const frames = parseInt(out.trim(), 10);
    if (!Number.isFinite(frames)) return true; // can't tell → accept
    return frames >= 2; // <2 distinct frames in the first 3s ⇒ frozen
  } catch {
    return true;
  }
}

/* ── query helpers ── */

function cleanQuery(q: string, maxWords = 12): string {
  return q.split(/\s+/).slice(0, maxWords).join(" ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function broaden(query: string, level: number): string {
  if (level <= 0) return query;
  const words = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2);
  const keep = level === 1 ? 4 : 2;
  return (words.length ? words : query.split(/\s+/)).slice(0, keep).join(" ") || query;
}

export interface AcquireFootageOptions {
  runId: string;
  want: FootageKind;
  /** short literal search phrase (real_query); falls back to fallbackQuery. */
  query: string;
  fallbackQuery?: string;
  sceneText?: string;
  videoContext?: string;
  outPath: string;
  /** mutable set of dedupeIds claimed this run (shared across scenes). */
  usedIds: Set<string>;
  minDurSec?: number;
}

/**
 * Search every enabled provider for a scene, vision-score the candidates, and
 * download the best match (≥ threshold, cascading via query broadening over 3
 * attempts). Returns the downloaded file + metadata, or `null` when nothing
 * clears the bar (the caller then falls back to an AI image).
 */
export async function acquireFootage(opts: AcquireFootageOptions): Promise<FootageResult | null> {
  const { runId, want, outPath, usedIds, videoContext } = opts;
  const baseQuery = cleanQuery(opts.query || opts.fallbackQuery || "");
  if (!baseQuery) {
    log(runId, "warn", `Empty footage query (no real_query/visual_prompt) — falling back to AI`, "footage");
    return null;
  }
  const minDur = Math.max(0, opts.minDurSec ?? getNumber("STOCK_MIN_DURATION", 4));
  const bar = threshold();

  for (let attempt = 0; attempt < 3; attempt++) {
    checkCancelled(runId);
    const query = broaden(baseQuery, attempt);
    const pool = await gatherCandidates(runId, query, want, minDur, usedIds);
    if (pool.length === 0) continue;
    const best = await scoreAndPick(runId, 0, query, opts.sceneText ?? "", videoContext, pool);
    if (!best || best.score < bar) continue;
    usedIds.add(best.hit.dedupeId);
    try {
      await downloadToFile(best.hit.url, outPath);
      // freeze-guard for video only (a frozen stock clip looks like a still bug)
      if (want === "video" && !(await clipHasMotion(outPath))) {
        log(runId, "debug", `Rejected frozen stock clip from ${best.hit.provider} — broadening`, "footage");
        try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
        continue;
      }
      log(runId, "info", `Real ${best.hit.kind} via ${best.hit.provider} — relevance ${best.score}% ["${query}"]`, "footage");
      return { path: outPath, kind: best.hit.kind, provider: best.hit.provider ?? "stock", matchScore: best.score, author: best.hit.author, sourceUrl: best.hit.sourceUrl, license: best.hit.license };
    } catch (e) {
      usedIds.delete(best.hit.dedupeId);
      log(runId, "debug", `Footage pick failed to download (${(e as Error).message.slice(0, 100)}) — broadening`, "footage");
    }
  }
  log(runId, "info", `No ${want} cleared ${bar}% after 3 attempts — using AI image instead`, "footage");
  return null;
}
