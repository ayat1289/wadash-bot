import { existsSync } from "node:fs";
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
      "-o",
      join(dir, "media.%(ext)s"),
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      ...NET_ARGS,
      ...YT_EXTRACTOR_ARGS,
      "--max-filesize",
      `${opts.maxSizeMb}M`,
      "-f",
      opts.format,
    ];
    if (opts.audio) {
      // Point yt-dlp's audio-extraction postprocessor at the vendored static
      // ffmpeg. Without this it resolves ffmpeg from PATH (the Nix-store binary),
      // which is corrupted in the published image and dies with `spawn EIO` —
      // yt-dlp then ships the raw SoundCloud container and WhatsApp rejects it as
      // "something is wrong with the audio file". `--ffmpeg-location` accepts the
      // binary path directly.
      args.push("--ffmpeg-location", getFfmpegPath());
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
