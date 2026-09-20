import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger";
import { runProcess } from "./proc";
import { getFfmpegPath } from "./ffmpeg";

export interface YtMeta {
  title: string;
  duration: number | null;
  uploader: string | null;
  ext: string | null;
  /** Canonical page URL of the resolved track (used to show/relink the exact item). */
  webpageUrl: string | null;
}

export interface YtDownload {
  buffer: Buffer;
  ext: string;
  /** Optional display title (e.g. supplied by the Instagram download API). */
  title?: string | null;
}

// ---------------------------------------------------------------------------
// Instagram download API fallback.
//
// The bot's server IP is blanket-blocked by Instagram (HTTP 429 on EVERY
// surface — www, oembed, __a=1 JSON and the mobile i.instagram.com API), so the
// local yt-dlp extractor cannot resolve Instagram media at all. We bypass that
// by asking the hosted SenatorAPI web service (api.fast-creat.ir/instagram) to
// resolve the link from clean infrastructure, then download the resulting
// media CDN URL (instagram.*.fbcdn.net) — which is NOT blocked from our IP.
//
// Auth: the apikey is the full "<bot_id>:<secret>@Api_ManagerRoBot" token.
// The URL MUST be passed clean (no ?igsh=... query params) or the service
// replies "لینک وارد شده صحیح نمی باشد" (link not correct). The service is
// anti-spam rate-limited, so transient failures are retried.
// ---------------------------------------------------------------------------

const IG_API_KEY = process.env.INSTAGRAM_API_KEY ?? "";

export async function downloadInstagramViaApi(
  url: string,
  opts: { maxSizeMb: number },
): Promise<YtDownload> {
  if (!IG_API_KEY) {
    throw new Error("Instagram download API key not configured (INSTAGRAM_API_KEY)");
  }
  // Strip any query params / tracking suffix — the service rejects them.
  const clean = url.split("?")[0].split("#")[0];
  const endpoint = new URL("https://api.fast-creat.ir/instagram");
  endpoint.searchParams.set("apikey", IG_API_KEY);
  endpoint.searchParams.set("type", "post2");
  endpoint.searchParams.set("url", clean);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(endpoint.toString(), {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      let j: any;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`Instagram API returned non-JSON: ${text.slice(0, 200)}`);
      }
      if (!j?.ok || !j?.result?.ok) {
        const status = j?.result?.status ?? "unknown error";
        throw new Error(`Instagram API failed: ${status}`);
      }
      const files: any[] = Array.isArray(j.result.files) ? j.result.files : [];
      const video = files.find((f) => f?.type === "video" && f?.url);
      if (!video?.url) {
        throw new Error("Instagram API returned no video download URL");
      }
      const title = typeof j.result.title === "string" ? j.result.title : null;

      // Stream the CDN mp4 into a buffer, enforcing a ceiling.
      const vr = await fetch(video.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10)", Accept: "*/*" },
        signal: AbortSignal.timeout(90_000),
      });
      if (!vr.ok) throw new Error(`Media download failed (${vr.status})`);
      const contentLength = Number(vr.headers.get("content-length") ?? 0);
      const capBytes = opts.maxSizeMb * 1024 * 1024 * 1.2;
      if (contentLength && contentLength > capBytes) {
        throw new Error("file exceeds size limit");
      }
      const buffer = Buffer.from(await vr.arrayBuffer());
      if (buffer.length > capBytes) throw new Error("file exceeds size limit");
      const ext = video.ext === "mp4" ? "mp4" : "mp4";
      return { buffer, ext, title };
    } catch (err) {
      lastErr = err;
      logger.warn({ err, url, attempt }, "Instagram API download failed, retrying");
      await new Promise((r) => setTimeout(r, 2500 + attempt * 2000));
    }
  }
  throw lastErr;
}

/** True when the hosted Instagram download API is configured (INSTAGRAM_API_KEY). */
export function isInstagramApiConfigured(): boolean {
  return Boolean(IG_API_KEY);
}

export const IS_TIKTOK_URL =
  /^https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i;
export const IS_INSTAGRAM_URL =
  /^https?:\/\/(www\.)?(instagram\.com|instagr\.am|ig\.me)\//i;
export const IS_YOUTUBE_URL =
  /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/.*/i;

const VIDEO_FORMAT =
  "best[ext=mp4][height<=720]/best[height<=720]/best[ext=mp4]/best";

/** URL of the self-hosted open-source Cobalt API instance (see docker-compose). */
const COBALT_URL = (process.env.COBALT_URL || "").replace(/\/+$/, "");

/**
 * Download via the free, open-source Cobalt media downloader API
 * (imputnet/cobalt). Resolves the post and mirrors media back through the
 * instance's /tunnel endpoint. Handles both relative and absolute tunnel URLs.
 */
export async function downloadCobalt(
  url: string,
  opts: { audio?: boolean; maxSizeMb: number },
): Promise<{
  buffer: Buffer;
  ext: string;
  title: string | null;
  filename: string | null;
  mime: string;
}> {
  if (!COBALT_URL) throw new Error("COBALT_URL is not configured");
  const res = await fetch(`${COBALT_URL}/`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      downloadMode: opts.audio ? "audio" : "auto",
      audioFormat: "mp3",
      videoQuality: "720",
      filenameStyle: "basic",
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Cobalt API HTTP ${res.status}`);
  const j = (await res.json()) as {
    status?: string;
    filename?: string;
    mimeType?: string;
    url?: string;
    picker?: { url?: string; type?: string }[];
    error?: { code?: string; reason?: string };
  };
  if (j.status === "error" || !j.url) {
    const code = j.error?.code ?? "unknown";
    throw new Error(code); // callers map known codes to friendly messages
  }
  if (j.status === "picker") {
    const first = j.picker?.find((p) => p.url) ?? j.picker?.[0];
    if (!first?.url) throw new Error("error.api.picker.empty");
    j.url = first.url;
  }
  const tunnel = /^https?:\/\//i.test(j.url) ? j.url : `${COBALT_URL}${j.url}`;
  const capBytes = opts.maxSizeMb * 1024 * 1024 * 1.2;
  const media = await fetch(tunnel, {
    headers: { Accept: "*/*", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!media.ok) throw new Error(`Cobalt tunnel HTTP ${media.status}`);
  const length = Number(media.headers.get("content-length") ?? 0);
  if (length && length > capBytes) throw new Error("file exceeds size limit");
  const buffer = Buffer.from(await media.arrayBuffer());
  if (buffer.length > capBytes) throw new Error("file exceeds size limit");

  const name = j.filename ?? "";
  const ext = (/\.[a-z0-9]+\b/i.exec(name)?.[0] ?? ".mp4").replace(".", "").toLowerCase() || "mp4";
  return {
    buffer,
    ext,
    title: (name.split(".")[0] ?? null)?.slice(0, 90) || null,
    filename: name || null,
    mime: opts.audio ? (ext === "mp3" ? "audio/mpeg" : "audio/mp4") : (j.mimeType ?? "video/mp4"),
  };
}

/**
 * TikTok video/audio download. yt-dlp's TikTok extractor is IP-blocked from this
 * host ("Your IP address is blocked from accessing this post"), but the public
 * tikwm API resolves posts from clean infrastructure and the returned
 * `*.tiktokcdn*.com` media files ARE fetchable from this host. Resolve via
 * tikwm, then stream the CDN URL.
 */
export async function downloadTikTok(
  url: string,
  opts: { audio?: boolean; maxSizeMb: number },
): Promise<{
  buffer: Buffer;
  ext: string;
  title: string | null;
  nickname: string | null;
  mime: string;
}> {
  const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TikTok API HTTP ${res.status}`);
  const j = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: { title?: string; nickname?: string; play?: string; wmplay?: string; music?: string };
  };
  const src = opts.audio ? j.data?.music : j.data?.play || j.data?.wmplay;
  if (j.code !== 0 || !src) {
    throw new Error(`TikTok API returned no media: ${j.msg ?? `code ${j.code}`}`);
  }
  const capBytes = opts.maxSizeMb * 1024 * 1024 * 1.2;
  const media = await fetch(src, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Referer: "https://www.tiktok.com/",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!media.ok) throw new Error(`TikTok CDN HTTP ${media.status}`);
  const length = Number(media.headers.get("content-length") ?? 0);
  if (length && length > capBytes) throw new Error("file exceeds size limit");
  const buffer = Buffer.from(await media.arrayBuffer());
  if (buffer.length > capBytes) throw new Error("file exceeds size limit");

  const srcExt = (/\.[a-z0-9]+\b/i.exec(src.split("?")[0] ?? "")?.[0] ?? "").replace(".", "").toLowerCase();
  const ext = opts.audio ? srcExt || "mp3" : "mp4";
  return {
    buffer,
    ext,
    title: j.data?.title?.slice(0, 90) || null,
    nickname: j.data?.nickname ?? null,
    mime: opts.audio
      ? ext === "mp3"
        ? "audio/mpeg"
        : "audio/mp4"
      : "video/mp4",
  };
}

/**
 * Download a VIDEO for any supported link, choosing the working path per host:
 *   - TikTok    → Cobalt (free/OSS, watermark-free) with the tikwm API as
 *     fallback (yt-dlp's TikTok extractor is IP-blocked).
 *   - Instagram → SenatorAPI when INSTAGRAM_API_KEY is set, else Cobalt, else
 *     plain yt-dlp.
 *   - YouTube   → handled by the audio-ready free API in `youtube-mp3.ts`;
 *     this function keeps plain yt-dlp as the generic path for everything else
 *     (Facebook/X/Pinterest/...).
 */
export async function downloadVideoSmart(
  url: string,
  opts: { maxSizeMb: number },
): Promise<{ buffer: Buffer; ext: string; title: string | null; mime: string; source: string }> {
  if (IS_TIKTOK_URL.test(url)) {
    if (COBALT_URL) {
      try {
        const d = await downloadCobalt(url, { maxSizeMb: opts.maxSizeMb });
        return { ...d, title: d.title ?? null, source: "cobalt" };
      } catch (err) {
        logger.warn({ err, url }, "Cobalt TikTok download failed, falling back to tikwm");
      }
    }
    const d = await downloadTikTok(url, { maxSizeMb: opts.maxSizeMb });
    return { buffer: d.buffer, ext: d.ext, title: d.title, mime: d.mime, source: "tikwm" };
  }
  if (IS_INSTAGRAM_URL.test(url)) {
    for (const via of ["senator", "cobalt"] as const) {
      try {
        if (via === "senator" && IG_API_KEY) {
          const d = await downloadInstagramViaApi(url, { maxSizeMb: opts.maxSizeMb });
          return { buffer: d.buffer, ext: d.ext, title: d.title ?? null, mime: "video/mp4", source: "senator" };
        }
        if (via === "cobalt" && COBALT_URL) {
          const d = await downloadCobalt(url, { maxSizeMb: opts.maxSizeMb });
          return { buffer: d.buffer, ext: d.ext, title: d.title, mime: "video/mp4", source: "cobalt" };
        }
      } catch (err) {
        logger.warn({ err, url, via }, `Instagram download via ${via} failed, trying next`);
      }
    }
  }
  const meta = await fetchMeta(url);
  const { buffer, ext } = await download(url, {
    format: VIDEO_FORMAT,
    maxSizeMb: opts.maxSizeMb,
  });
  return { buffer, ext, title: meta.title, mime: "video/mp4", source: "yt-dlp" };
}

/**
 * YouTube player clients. `mweb` is the primary client — it provides direct
 * HTTPS stream URLs that work reliably from datacenter IPs (unlike `web` which
 * forces SABR-only, or `android_vr` which intermittently 403s). `android_vr`
 * is the fallback for metadata/search on other extractors. With deno + mweb,
 * format 18 (combined mp4) works for all tested YouTube videos.
 */
const YT_EXTRACTOR_ARGS = [
  "--extractor-args",
  "youtube:player_client=mweb,android_vr",
];

/**
 * Tell yt-dlp to use deno for YouTube's JS challenges (n-parameter, signature).
 * deno is installed at /.deno/bin/deno; the self-contained yt-dlp binary has no
 * built-in JS runtime, so without this flag the `web` client falls back to
 * android_vr-only mode and loses DASH formats.
 */
const DENO_PATH = "/.deno/bin/deno";
const DENO_ARGS = existsSync(DENO_PATH)
  ? ["--js-runtimes", "deno"]
  : [];

/**
 * Network-resilience flags applied to every yt-dlp invocation. SoundCloud (the
 * audio backend) intermittently throttles this host's IP; without a per-socket
 * timeout a single stalled read hangs the whole process until the hard SIGKILL
 * timeout and the command fails outright (observed in production as
 * "`.../bin/yt-dlp timed out after 45000ms` cmd=play"). `--socket-timeout`
 * bounds each network read so a stalled connection errors fast and is retried
 * instead of hanging; the retry flags absorb transient extractor / HTTP /
 * HLS-fragment failures so a flaky resolve recovers within the window.
 */
const NET_ARGS = [
  "--socket-timeout",
  "30",
  "--retries",
  "5",
  "--extractor-retries",
  "3",
  "--fragment-retries",
  "10",
];

// ---------------------------------------------------------------------------
// YouTube cookies.
//
// This host's IP is blanket-blocked by YouTube ("Sign in to confirm you're not
// a bot") for EVERY player client — android, tv, web_music, android_music,
// ios_music, web_creator, tv_simply, android_vr, web_embedded, you name it. The
// block is applied at the player-API level BEFORE tokens/clients matter, so no
// extractor-args or PO-token config fixes it from this IP. The only reliable
// bypass is a real browser session: yt-dlp's `--cookies` accepts a Netscape-
// format cookies.txt export, and with a fresh YouTube session community reports
// confirm datacenter-IP downloads work again.
//
// To enable it, set either:
//   YOUTUBE_COOKIES      — the raw cookies.txt CONTENT (as a secret/env var)
//   YOUTUBE_COOKIES_FILE — a path to a cookies.txt mounted into the container
//
// The content is written once to a temp file (reused by every invocation;
// removed on exit). While it is set, the audio handlers flip their name-search
// prefix to `ytsearch1` so the full YouTube catalog becomes searchable, and
// name-based video downloads also work. Without cookies, name search stays on
// SoundCloud (which is not blocked from this host).
// ---------------------------------------------------------------------------

let cookiesPath: string | null | undefined;

function getCookiesPath(): string | null {
  if (cookiesPath !== undefined) return cookiesPath;
  cookiesPath = null;
  try {
    const filePath = process.env.YOUTUBE_COOKIES_FILE?.trim();
    const raw = (
      filePath ? readFileSync(filePath, "utf8") : (process.env.YOUTUBE_COOKIES ?? "")
    ).trim();
    if (!raw) return null;
    const p = join(tmpdir(), `yt-cookies-${process.pid}.txt`);
    writeFileSync(p, `${raw}\n`, { mode: 0o600 });
    process.once("exit", () => {
      try {
        rmSync(p, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    });
    cookiesPath = p;
  } catch (err) {
    logger.warn(
      { err },
      "YouTube cookies could not be loaded (YOUTUBE_COOKIES/YOUTUBE_COOKIES_FILE) — YouTube stays blocked",
    );
  }
  return cookiesPath;
}

function cookieArgs(): string[] {
  const p = getCookiesPath();
  return p ? ["--cookies", p] : [];
}

/**
 * Resolve which yt-dlp to run. We vendor the official **self-contained**
 * PyInstaller build (`yt-dlp_linux`) at `artifacts/api-server/bin/yt-dlp` and
 * run it DIRECTLY (not through `python3`). Two reasons:
 *  1. The Nix-provided `yt-dlp` is pinned to a release whose SoundCloud-search
 *     extractor is broken (it builds an
 *     `api.soundcloud.com/tracks/soundcloud%3Atracks%3A...` URL no extractor
 *     matches).
 *  2. The previous approach — a yt-dlp *zipapp* run via the Nix `python3` —
 *     loaded the Nix store's `libssl.so.3` for HTTPS, and that file was
 *     corrupted (EIO: "cannot read file data") in the published image, so
 *     EVERY audio command died at `fetchMeta` with an SSL ImportError that a
 *     republish kept reusing. The self-contained binary bundles its own CPython
 *     + OpenSSL (extracted to /tmp at runtime), so it never touches the
 *     (corruptible) Nix openssl.
 * The binary is committed, so it survives any deploy regardless of how the
 * image is built. Falls back to the bare `yt-dlp` binary only if the vendored
 * file is somehow missing.
 */
interface YtRunner {
  cmd: string;
  baseArgs: string[];
}

let runner: YtRunner | null = null;

function getRunner(): YtRunner {
  if (runner) return runner;
  // The app always runs as the bundled `dist/index.mjs`, so `import.meta.url`
  // anchors us to `.../artifacts/api-server/dist` regardless of cwd (dev runs
  // from the package dir, production from the repo root).
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const vendored = join(moduleDir, "..", "bin", "yt-dlp");
  if (existsSync(vendored)) {
    // Run the self-contained binary directly so it uses its OWN bundled OpenSSL,
    // never the Nix store's (which can be corrupted in the published image).
    runner = { cmd: vendored, baseArgs: [] };
  } else {
    // Last-resort fallback: the Nix-provided yt-dlp has a broken SoundCloud
    // search extractor, so audio downloads will fail. Surface it loudly.
    logger.warn(
      { vendored },
      "vendored yt-dlp missing — falling back to system yt-dlp (SoundCloud search likely broken)",
    );
    runner = { cmd: "yt-dlp", baseArgs: [] };
  }
  return runner;
}

/**
 * Fetch metadata for a yt-dlp target (URL or `scsearch1:`/`ytsearch1:` query)
 * without downloading the media. Throws if the target can't be resolved.
 */
export async function fetchMeta(target: string): Promise<YtMeta> {
  const j = await fetchInfo(target);
  return {
    title: typeof j.title === "string" ? j.title : "media",
    duration: typeof j.duration === "number" ? j.duration : null,
    uploader: typeof j.uploader === "string" ? j.uploader : null,
    ext: typeof j.ext === "string" ? j.ext : null,
    webpageUrl: typeof j.webpage_url === "string" ? j.webpage_url : null,
  };
}

/**
 * Fetch the FULL parsed yt-dlp info JSON for a target (all fields — formats,
 * thumbnails, id, etc.) without downloading the media. Used by handlers that
 * need to inspect what a page actually contains (e.g. Pinterest, which may be
 * a video pin with formats or an image-only pin with just a thumbnail).
 * Throws if the target can't be resolved.
 */
export async function fetchInfo(
  target: string,
): Promise<Record<string, any>> {
  const r = getRunner();
  const args = [
    ...r.baseArgs,
    ...DENO_ARGS,
    ...cookieArgs(),
    "-J",
    "--no-warnings",
    "--no-playlist",
    ...NET_ARGS,
    ...YT_EXTRACTOR_ARGS,
    "--",
    target,
  ];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { code, stdout, stderr } = await runProcess(r.cmd, args, {
        timeoutMs: 90_000,
      });
      if (code !== 0 || !stdout.trim()) {
        throw new Error(
          `yt-dlp metadata failed (${code}): ${stderr.slice(-200)}`,
        );
      }
      const firstLine = stdout.trim().split("\n")[0] ?? "{}";
      const j = JSON.parse(firstLine) as Record<string, unknown>;
      return j as Record<string, any>;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        logger.warn(
          { err, target, attempt },
          "yt-dlp metadata failed, retrying",
        );
        await new Promise((r) => setTimeout(r, 2500 + attempt * 1500));
      }
    }
  }
  throw lastErr;
}

/**
 * Download a yt-dlp target into a Buffer. Uses a unique temp dir that is always
 * cleaned up. `--max-filesize` aborts oversized downloads before they complete;
 * when that happens (or nothing is produced) this throws.
 */
export async function download(
  target: string,
  opts: { format: string; audio?: boolean; maxSizeMb: number },
): Promise<YtDownload> {
  const r = getRunner();
  const dir = await mkdtemp(join(tmpdir(), "ytdl-"));
  try {
    const args = [
      ...r.baseArgs,
      ...DENO_ARGS,
      ...cookieArgs(),
      "-o",
      join(dir, "media.%(ext)s"),
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      ...NET_ARGS,
      ...YT_EXTRACTOR_ARGS,
      "--max-filesize",
      `${opts.maxSizeMb}M`,
      // Point yt-dlp's postprocessor (audio extraction) AND any format merging
      // (e.g. HLS video+audio) at the vendored static ffmpeg. Without this it
      // resolves ffmpeg from PATH (the Nix-store binary), which is corrupted in
      // the published image and dies with `spawn EIO`; and HLS video sources
      // that need audio+video merged simply fail with "Requested format is not
      // available". `--ffmpeg-location` accepts the binary path directly.
      "--ffmpeg-location",
      getFfmpegPath(),
      "-f",
      opts.format,
    ];
    if (opts.audio) {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "5");
    }
    args.push("--", target);

    // YouTube intermittently 403s datacenter IPs on stream URLs. The block is
    // transient — retrying after a short delay (3–5 s) almost always succeeds.
    // We try up to 4 times with progressive backoff to absorb these bursts.
    const MAX_ATTEMPTS = 4;
    const isRetryable = (err: unknown) =>
      err instanceof Error && /403|Forbidden|timed?\s*out/i.test(err.message);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const { code, stderr } = await runProcess(r.cmd, args, { timeoutMs: 180_000 });
        const files = await readdir(dir);
        const file = files.find((f) => f.startsWith("media."));
        if (!file) {
          if (/max-filesize|larger than/i.test(stderr)) {
            throw new Error("file exceeds size limit");
          }
          throw new Error(`yt-dlp produced no file (${code}): ${stderr.slice(-200)}`);
        }
        const fullPath = join(dir, file);
        // Post-processing (e.g. audio extraction) can produce a file even when
        // --max-filesize couldn't pre-check an unknown remote size; enforce a hard
        // cap before buffering the whole thing into memory.
        const { size } = await stat(fullPath);
        if (size > opts.maxSizeMb * 1024 * 1024 * 1.2) {
          throw new Error("file exceeds size limit");
        }
        const buffer = await readFile(fullPath);
        const ext = file.split(".").pop() ?? "bin";
        return { buffer, ext };
      } catch (err) {
        lastErr = err;
        const retryable = isRetryable(err);
        if (attempt < MAX_ATTEMPTS - 1 && retryable) {
          const delayMs = 3000 + attempt * 1500;
          logger.warn(
            { err, target, attempt, delayMs },
            "yt-dlp download retryable failure, retrying",
          );
          await new Promise((r) => setTimeout(r, delayMs));
        } else if (!retryable) {
          break;
        }
      }
    }
    throw lastErr;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
