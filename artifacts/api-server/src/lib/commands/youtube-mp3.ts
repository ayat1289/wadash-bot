import { logger } from "../logger";
import { IS_YOUTUBE_URL } from "./ytdlp";

/**
 * Free, ip-block-proof YouTube audio downloader backed by a public converter
 * network (youtubemp4free.com WordPress admin-ajax → ryin.info → ytmp3free.cc
 * storage). No cookies, no API keys, no VPN/proxy egress — the conversion runs
 * on THEIR servers and the finished MP3 is fetched directly.
 */

const AJAX = "https://youtubemp4free.com/wp-admin/admin-ajax.php";
const HOME = "https://youtubemp4free.com/";
const FRONT = "https://ryin.info/";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/** Optional YouTube search fallback via a public Invidious instance's REST API. */
const INVIDIOUS = ["https://invidious.f5.si", "https://yewtu.be"];

let cachedNonce: { nonce: string; at: number } | null = null;

async function getNonce(): Promise<string> {
  if (cachedNonce && Date.now() - cachedNonce.at < 5 * 60_000) {
    return cachedNonce.nonce;
  }
  const res = await fetch(HOME, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  const html = await res.text();
  const m = /nonce["'\s]*[:=]\s*["']([0-9a-f]{10})["']/i.exec(html);
  const nonce = m?.[1] ?? "1495b10e48";
  cachedNonce = { nonce, at: Date.now() };
  return nonce;
}

async function convert(videoUrl: string): Promise<{
  title: string | null;
  size: number | null;
  getUrl: string | null;
}> {
  const nonce = await getNonce();
  let j: any;
  let first: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(AJAX, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Origin: "https://easyconv.com",
        "X-Requested-With": "mark.via.gp",
        Referer: "https://easyconv.com/",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        action: "yt_convert",
        nonce,
        youtube_url: videoUrl,
      }).toString(),
      signal: AbortSignal.timeout(90_000),
    });
    j = await res.json().catch(() => null);
    if (!first) first = { status: res.status, j };
    if (j?.success && j.data?.slug) {
      // The download page sometimes needs a few seconds before it exposes the
      // file link (conversion finishing on their side); poll it briefly.
      for (let i = 0; i < 8; i++) {
        try {
          const page = await fetch(FRONT + j.data.slug, {
            headers: { "User-Agent": UA },
            signal: AbortSignal.timeout(40_000),
          });
          const html = await page.text();
          const hm = /https:\/\/[^"'\s]+get\.php\?[^"'\s]+/.exec(html);
          if (hm) {
            return {
              title: j.data.info?.title ?? null,
              size: typeof j.data.size === "number" ? j.data.size : null,
              getUrl: hm[0],
            };
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (j?.success === false && /nonce|security|cookie/i.test(String(j.data))) {
      cachedNonce = null;
      continue;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`converter: no download URL ready (${JSON.stringify(first)})`);
}

/**
 * Download the audio of a YouTube video as a Buffer via the free converter.
 * Polls the file endpoint until the MP3 exists (conversion can take up to ~20s).
 */
export async function downloadYouTubeAudioUrl(
  videoUrl: string,
  opts: { maxSizeMb?: number },
): Promise<{ buffer: Buffer; ext: string; mime: string; title: string | null }> {
  const capBytes = (opts.maxSizeMb ?? 50) * 1024 * 1024;
  const { title, size, getUrl } = await convert(videoUrl);
  if (size && size > capBytes) throw new Error("file exceeds size limit");

  let buffer: Buffer | null = null;
  let lastErr: unknown = null;
  for (let i = 0; i < 8 && !buffer; i++) {
    try {
      const res = await fetch(getUrl!, {
        headers: { "User-Agent": UA, Referer: FRONT, Accept: "*/*" },
        signal: AbortSignal.timeout(120_000),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") ?? "";
      if (bytes.length > 0 && /audio|octet/.test(ct)) {
        buffer = bytes;
      }
    } catch (err) {
      lastErr = err;
    }
    if (!buffer) await new Promise((r) => setTimeout(r, 3500));
  }
  if (!buffer) throw lastErr ?? new Error("converter produced no audio");
  if (buffer.length > capBytes) throw new Error("file exceeds size limit");
  return { buffer, ext: "mp3", mime: "audio/mpeg", title };
}

/**
 * One-shot "give me accurate YouTube audio": if `input` is a YouTube URL use it
 * directly; otherwise treat it as a song/name and search YouTube first. Returns
 * null when the converter/search can't resolve it, so callers fall back to
 * their existing (SoundCloud) path. Never throws.
 */
export async function tryYouTubeAudio(
  input: string,
  opts: { maxSizeMb?: number } = {},
): Promise<{ buffer: Buffer; ext: string; mime: string; title: string | null } | null> {
  try {
    const trimmed = input.trim();
    if (IS_YOUTUBE_URL.test(trimmed)) {
      return await downloadYouTubeAudioUrl(trimmed, opts);
    }
    const hit = await searchYouTubeVideo(trimmed);
    if (!hit) return null;
    return await downloadYouTubeAudioUrl(
      `https://www.youtube.com/watch?v=${hit.videoId}`,
      opts,
    );
  } catch (err) {
    logger.warn({ err, input }, "free YouTube audio failed");
    return null;
  }
}

/**
 * Best-effort YouTube search for a song/name, returning the top video. Tries
 * public Invidious REST instances (their media endpoints are bot-gated, so we
 * only use the search API to resolve a videoId, then download via the free
 * converter above). Returns null when no instance answers.
 */
export async function searchYouTubeVideo(
  query: string,
): Promise<{ videoId: string; title: string; duration: number | null } | null> {
  const qs = new URLSearchParams({
    q: query,
    type: "video",
    fields: "videoId,title,lengthSeconds",
  });
  for (const base of INVIDIOUS) {
    try {
      const res = await fetch(`${base}/api/v1/search?${qs}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<Record<string, any>>;
      const hit = rows.find((r) => r?.videoId && r?.title);
      if (hit) {
        return {
          videoId: hit.videoId,
          title: String(hit.title),
          duration: typeof hit.lengthSeconds === "number" ? hit.lengthSeconds : null,
        };
      }
    } catch (err) {
      logger.warn({ err, base }, "invidious search failed");
    }
  }
  return null;
}