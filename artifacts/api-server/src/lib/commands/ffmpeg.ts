import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger";

let ffmpegPath: string | null = null;

/**
 * Resolve which ffmpeg to run. We vendor a self-contained **static** ffmpeg at
 * `artifacts/api-server/bin/ffmpeg` and run it DIRECTLY — never the Nix-store
 * ffmpeg declared in `replit.nix`. Reason: in the published GCE image the
 * Nix-store binary is corrupted and every spawn fails with `spawn EIO`
 * (errno -5) — the same content-addressed image corruption that previously
 * broke the Nix yt-dlp/OpenSSL (see `.agents/memory/nix-store-image-corruption.md`).
 * ffmpeg works fine in dev but silently dies in production, so audio commands
 * (`.play`/`.song`/`.ytmp3` mp3 conversion, `.tts`/`.say` voice notes, audio
 * effects, `.tomp3`) shipped a raw/undecodable file and WhatsApp showed
 * "this audio is not available because something is wrong with the audio file".
 *
 * The static binary bundles its own codecs (libmp3lame/libopus/aac/libwebp) and
 * is committed under `bin/`, so it survives deploys (esbuild-only prod build;
 * `data/` is gitignored, `bin/` is committed) and never touches the Nix store.
 * The path is anchored via `import.meta.url`, which resolves to the bundled
 * `dist/` dir in both dev and prod. If the vendored file is somehow missing it
 * falls back to the bare `ffmpeg` on PATH in dev, but THROWS in production
 * (where that PATH binary is the corrupt Nix one this vendoring exists to avoid).
 */
export function getFfmpegPath(): string {
  if (ffmpegPath) return ffmpegPath;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const vendored = join(moduleDir, "..", "bin", "ffmpeg");
  if (existsSync(vendored)) {
    ffmpegPath = vendored;
    return ffmpegPath;
  }
  // In production the system ffmpeg is the corrupted Nix-store binary that this
  // whole vendoring exists to avoid — falling back to it would silently
  // reintroduce the `spawn EIO` audio bug. So fail loudly in prod and only fall
  // back to a PATH ffmpeg in dev (where the runtime-path ffmpeg works fine).
  const isProd =
    process.env.NODE_ENV === "production" || Boolean(process.env.REPLIT_DEPLOYMENT);
  if (isProd) {
    logger.error(
      { vendored },
      "vendored ffmpeg missing in production — refusing to fall back to the (corruptible) Nix-store ffmpeg",
    );
    throw new Error("vendored ffmpeg binary is missing");
  }
  logger.warn({ vendored }, "vendored ffmpeg missing — falling back to system ffmpeg (dev only)");
  ffmpegPath = "ffmpeg";
  return ffmpegPath;
}
