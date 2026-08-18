import type { WASocket } from "@whiskeysockets/baileys";
import type { Command, CommandContext, WAMessage } from "../types";
import { fetchMeta, download } from "../ytdlp";
import { fetchJson, fetchText, fetchBuffer } from "../http-utils";
import { isPublicHttpUrl, hostMatches } from "../url-utils";
import { tryAcquire } from "../limiter";
import { logger } from "../../logger";
import {
  setPendingDownload,
  getPendingDownload,
  clearPendingDownload,
} from "../pending-downloads";

const AUDIO_FORMAT = "18/bestaudio[ext=m4a]/best";
const VIDEO_FORMAT =
  "best[ext=mp4][height<=720]/best[height<=720]/best[ext=mp4]/best";
const MAX_AUDIO_MB = 50;
const MAX_VIDEO_MB = 64;
const MAX_DURATION_S = 1800; // 30 minutes

/**
 * The subset of CommandContext needed to download media and reply. Shared by the
 * normal command handlers and the interactive `.play` menu reply handler (which
 * runs outside the command dispatcher and builds this object by hand).
 */
type Sendable = Pick<CommandContext, "sock" | "from" | "msg" | "react" | "reply">;

/**
 * Domains whose links may be handed to yt-dlp directly. Restricting URL inputs
 * to sites with a dedicated yt-dlp extractor (rather than allowing any public
 * URL through generic extraction) prevents SSRF via attacker-controlled HTTP
 * redirects to internal/link-local targets. Non-URL input is treated as a
 * YouTube search instead, so this never blocks normal "search by name" use.
 */
const MEDIA_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "music.youtube.com",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "fb.com",
  "twitter.com",
  "x.com",
  "pinterest.com",
  "pin.it",
  "dailymotion.com",
  "dai.ly",
  "vimeo.com",
  "soundcloud.com",
];

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function fmtDuration(sec: number | null): string {
  if (!sec) return "";
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Map a downloaded audio file's extension to a WhatsApp-playable mimetype. The
 * file is normally an mp3 (yt-dlp `-x --audio-format mp3`, which needs ffmpeg),
 * but if ffmpeg is unavailable yt-dlp keeps the original container (m4a/opus/
 * webm). The mimetype MUST follow the actual bytes — a hardcoded `audio/mpeg`
 * on a real m4a is exactly what makes WhatsApp show "this audio is not
 * available because something is wrong with the audio file".
 */
function audioMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "m4a":
    case "mp4":
    case "aac":
      return "audio/mp4";
    case "ogg":
    case "opus":
      return "audio/ogg; codecs=opus";
    case "webm":
      return "audio/webm";
    case "wav":
      return "audio/wav";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}

function arg(ctx: CommandContext): string {
  return (ctx.text.trim() || ctx.quotedText?.trim() || "").trim();
}

async function sendAudio(
  s: Sendable,
  target: string,
  pre?: { title: string; duration: number | null },
): Promise<void> {
  await s.react("⏳");
  // The interactive `.play` flow already resolved the track (title + duration,
  // and rejected anything over the length cap) when it showed the card, so a
  // caller that passes `pre` skips a SECOND SoundCloud metadata round-trip here.
  // That redundant lookup was a needless point of failure — under throttling it
  // can itself time out and sink the download after the user already picked a
  // format. Direct callers (.ytmp3 / .spotify) pass no `pre` and resolve here.
  const meta = pre ?? (await fetchMeta(target));
  if (meta.duration && meta.duration > MAX_DURATION_S) {
    await s.reply(
      `❌ That's too long (${fmtDuration(meta.duration)}). The limit is 30 minutes.`,
    );
    return;
  }
  const { buffer, ext } = await download(target, {
    format: AUDIO_FORMAT,
    audio: true,
    maxSizeMb: MAX_AUDIO_MB,
  });
  await s.sock.sendMessage(
    s.from,
    { audio: buffer, mimetype: audioMime(ext), fileName: `${meta.title}.${ext}` },
    { quoted: s.msg },
  );
  await s.react("✅");
}

async function sendVideo(s: Sendable, target: string): Promise<void> {
  await s.react("⏳");
  const meta = await fetchMeta(target);
  const { buffer } = await download(target, {
    format: VIDEO_FORMAT,
    maxSizeMb: MAX_VIDEO_MB,
  });
  await s.sock.sendMessage(
    s.from,
    { video: buffer, mimetype: "video/mp4", caption: `🎬 ${meta.title}` },
    { quoted: s.msg },
  );
  await s.react("✅");
}

/**
 * Resolve a user argument to a yt-dlp target: a vetted public URL or a search.
 * Non-URL input resolves through a YouTube search (`ytsearch1`), which works
 * from this server for both metadata and m4a audio. The `android_vr` client
 * gets formats, and audio prefers m4a because opus/webm streams 403.
 */
async function fromUrlOrSearch(
  ctx: CommandContext,
  input: string,
  send: (s: Sendable, target: string) => Promise<void>,
  searchPrefix: "ytsearch1" | "scsearch1" = "ytsearch1",
): Promise<void> {
  if (isUrl(input)) {
    if (!hostMatches(input, MEDIA_DOMAINS)) {
      await ctx.reply(
        "❌ That link isn't supported. Send a YouTube link (or one from TikTok, Instagram, Facebook, X, Pinterest, Dailymotion, Vimeo, SoundCloud) — or just type the name to search.",
      );
      return;
    }
    await send(ctx, input);
  } else {
    await send(ctx, `${searchPrefix}:${input}`);
  }
}

/**
 * Interactive `.play` / `.song`: resolve the track, show it, and ask the user to
 * reply `1` (audio/mp3) or `2` (video/mp4). The download itself happens when they
 * answer — see `handleDownloadSelection`, wired into the message loop. Search by
 * name uses YouTube (`ytsearch1`), so both audio and video work.
 */
async function startPlay(ctx: CommandContext, input: string): Promise<void> {
  const url = isUrl(input);
  if (url && !hostMatches(input, MEDIA_DOMAINS)) {
    await ctx.reply(
      "❌ That link isn't supported. Send a link from YouTube, TikTok, Instagram, Facebook, X, Pinterest, Dailymotion, Vimeo, or SoundCloud — or just type the song name.",
    );
    return;
  }
  await ctx.react("🔎");
  const target = url ? input : `ytsearch1:${input}`;
  try {
    const meta = await fetchMeta(target);
    if (meta.duration && meta.duration > MAX_DURATION_S) {
      await ctx.reply(
        `❌ That's too long (${fmtDuration(meta.duration)}). The limit is 30 minutes.`,
      );
      return;
    }
    const audioTarget =
      meta.webpageUrl && hostMatches(meta.webpageUrl, MEDIA_DOMAINS)
        ? meta.webpageUrl
        : target;
    const videoTarget = url ? input : `ytsearch1:${input}`;
    setPendingDownload(ctx.tenantId, ctx.from, ctx.sender, {
      audioTarget,
      videoTarget,
      fromUrl: url,
      title: meta.title,
    });

    const link = meta.webpageUrl ?? (url ? input : "");
    const lines = [`🎵 *${meta.title}*`];
    if (meta.uploader) lines.push(`👤 ${meta.uploader}`);
    if (meta.duration) lines.push(`⏱️ ${fmtDuration(meta.duration)}`);
    if (link) lines.push(`🔗 ${link}`);
    lines.push("", "_Reply to download:_", "*1* — 🎵 Audio (mp3)", "*2* — 🎬 Video (mp4)");
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    logger.warn({ err, cmd: "play", input }, "play search failed");
    await ctx.reply(
      "❌ Couldn't find that song on YouTube. Check the spelling, or send a direct YouTube link and pick *1* for audio.",
    );
  }
}

function parseChoice(body: string): "audio" | "video" | null {
  const t = body.trim().toLowerCase();
  if (t === "1" || t === "mp3" || t === "audio" || t === "🎵") return "audio";
  if (t === "2" || t === "mp4" || t === "video" || t === "🎬") return "video";
  return null;
}

/**
 * Handle a reply to the interactive `.play` menu (a bare `1`/`2`/`mp3`/`mp4`).
 * Returns true if it consumed the message. Called from the message loop BEFORE
 * command dispatch; it's a cheap no-op when the text isn't a choice or there's no
 * live pending menu for this exact sender. The download runs under the global +
 * per-tenant concurrency caps but skips the per-user cooldown (already paid when
 * the menu was issued; the pending choice is single-use so it can't be spammed).
 */
export async function handleDownloadSelection(opts: {
  sock: WASocket;
  msg: WAMessage;
  tenantId: number;
  from: string;
  sender: string;
  body: string;
}): Promise<boolean> {
  const { sock, msg, tenantId, from, sender, body } = opts;
  const choice = parseChoice(body);
  if (!choice) return false;
  const pending = getPendingDownload(tenantId, from, sender);
  if (!pending) return false;

  const reply = async (t: string): Promise<void> => {
    await sock.sendMessage(from, { text: t }, { quoted: msg });
  };
  const react = async (emoji: string): Promise<void> => {
    try {
      await sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
    } catch {
      /* reactions are best-effort */
    }
  };
  const s: Sendable = { sock, from, msg, react, reply };

  // Video by song name can't be delivered (YouTube blocks this host). Keep the
  // pending entry so the user can still choose audio instead.
  if (choice === "video" && !pending.fromUrl) {
    await reply(
      "🎬 Video isn't available for a song name. Send a *link* (YouTube / TikTok / Instagram / Facebook) and pick *2* — or reply *1* for the audio 🎵.",
    );
    return true;
  }

  const slot = tryAcquire(`${tenantId}:${sender}`, {
    concurrency: true,
    skipCooldown: true,
  });
  if (!slot.ok) {
    // Keep the pending entry so they can retry once capacity frees up.
    await reply(slot.reason);
    return true;
  }
  clearPendingDownload(tenantId, from, sender);
  try {
    if (choice === "audio") {
      // `.play` already resolved + length-checked this track; reuse its title and
      // skip re-fetching metadata (one fewer SoundCloud round-trip that can hang).
      await sendAudio(s, pending.audioTarget, {
        title: pending.title,
        duration: null,
      });
    } else {
      await sendVideo(s, pending.videoTarget);
    }
  } catch (err) {
    logger.warn({ err, choice }, "interactive download failed");
    await react("❌");
    if (choice === "video") {
      await reply(
        "❌ Couldn't get that video. It may be private, region-locked, or too large. Try a direct link.",
      );
    } else {
      await reply(
        "❌ Couldn't download that audio. It may be unavailable or too large — try again.",
      );
    }
  } finally {
    slot.release();
  }
  return true;
}

/**
 * Build a command with shared empty-arg usage, abuse guards (cooldown +
 * optional global concurrency), and error handling. `heavy` controls whether
 * the global concurrency slot is taken (false for trivial commands like apk).
 */
function dl(opts: {
  name: string;
  aliases?: string[];
  category: string;
  desc: string;
  usage: string;
  heavy?: boolean;
  run: (ctx: CommandContext, input: string) => Promise<void>;
}): Command {
  const { name, aliases, category, desc, usage, run, heavy = true } = opts;
  return {
    name,
    aliases,
    category,
    desc,
    handler: async (ctx) => {
      const input = arg(ctx);
      if (!input) {
        await ctx.reply(usage.replace(/%p/g, ctx.prefix));
        return;
      }
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: heavy });
      if (!slot.ok) {
        await ctx.reply(slot.reason);
        return;
      }
      try {
        await run(ctx, input);
      } catch (err) {
        logger.warn({ err, cmd: name }, "download command failed");
        await ctx.reply(
          "❌ Couldn't download that. The link may be private, unavailable, region-locked, or too large.",
        );
      } finally {
        slot.release();
      }
    },
  };
}

/** A platform command that requires a URL on an allowlisted set of domains. */
function platformVideo(
  name: string,
  aliases: string[] | undefined,
  desc: string,
  label: string,
  domains: string[],
): Command {
  return dl({
    name,
    aliases,
    category: "DOWNLOAD",
    desc,
    usage: `Usage: *%p${name} <${label} link>*`,
    run: async (ctx, input) => {
      if (!hostMatches(input, domains)) {
        await ctx.reply(`❌ Please provide a valid ${label} link.`);
        return;
      }
      await sendVideo(ctx, input);
    },
  });
}

async function spotifyHandler(ctx: CommandContext, input: string): Promise<void> {
  if (!hostMatches(input, ["spotify.com"])) {
    await ctx.reply("❌ Please provide a valid Spotify track link.");
    return;
  }
  await ctx.react("⏳");
  const oembed = await fetchJson<{ title?: string }>(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(input)}`,
  );
  const title = oembed.title?.trim();
  if (!title) {
    await ctx.reply("❌ Couldn't read that Spotify track.");
    return;
  }
  const searchTarget = `ytsearch1:${title}`;
  const meta = await fetchMeta(searchTarget);
  if (meta.duration && meta.duration > MAX_DURATION_S) {
    await ctx.reply(`❌ That track is too long (${fmtDuration(meta.duration)}).`);
    return;
  }
  const { buffer, ext } = await download(searchTarget, {
    format: AUDIO_FORMAT,
    audio: true,
    maxSizeMb: MAX_AUDIO_MB,
  });
  await ctx.sock.sendMessage(
    ctx.from,
    { audio: buffer, mimetype: audioMime(ext), fileName: `${title}.${ext}` },
    { quoted: ctx.msg },
  );
  await ctx.react("✅");
}

async function gitcloneHandler(ctx: CommandContext, input: string): Promise<void> {
  const m = input.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  const slug = m
    ? `${m[1]}/${m[2].replace(/\.git$/i, "")}`
    : /^[\w.-]+\/[\w.-]+$/.test(input)
      ? input.replace(/\.git$/i, "")
      : null;
  if (!slug) {
    await ctx.reply(
      `❌ Provide a GitHub repo, e.g. *${ctx.prefix}gitclone https://github.com/owner/repo*`,
    );
    return;
  }
  await ctx.react("⏳");
  const info = await fetchJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${slug}`,
  );
  const branch = info.default_branch ?? "main";
  const zipUrl = `https://codeload.github.com/${slug}/zip/refs/heads/${branch}`;
  const { buffer } = await fetchBuffer(zipUrl, {
    maxBytes: MAX_VIDEO_MB * 1024 * 1024,
  });
  const fileName = `${slug.split("/")[1] ?? "repo"}-${branch}.zip`;
  await ctx.sock.sendMessage(
    ctx.from,
    {
      document: buffer,
      mimetype: "application/zip",
      fileName,
      caption: `📦 ${slug} (${branch})`,
    },
    { quoted: ctx.msg },
  );
  await ctx.react("✅");
}

async function mediafireHandler(ctx: CommandContext, input: string): Promise<void> {
  if (!hostMatches(input, ["mediafire.com"])) {
    await ctx.reply("❌ Please provide a valid MediaFire link.");
    return;
  }
  await ctx.react("⏳");
  const html = await fetchText(input);
  const m =
    html.match(/href="(https?:\/\/download[^"]+)"/i) ||
    html.match(/id="downloadButton"[^>]*href="([^"]+)"/i);
  const direct = m?.[1];
  if (!direct || !isPublicHttpUrl(direct)) {
    await ctx.reply("❌ Couldn't find a direct download link for that MediaFire page.");
    return;
  }
  const nameMatch = direct.match(/\/([^/?]+\.[a-z0-9]{2,5})(?:\?|$)/i);
  const fileName = nameMatch?.[1] ?? "mediafire-file";
  const { buffer, contentType } = await fetchBuffer(direct, {
    maxBytes: MAX_VIDEO_MB * 1024 * 1024,
  });
  await ctx.sock.sendMessage(
    ctx.from,
    {
      document: buffer,
      mimetype: contentType ?? "application/octet-stream",
      fileName,
    },
    { quoted: ctx.msg },
  );
  await ctx.react("✅");
}

async function apkHandler(ctx: CommandContext, input: string): Promise<void> {
  const query = encodeURIComponent(input);
  await ctx.reply(
    `🔎 For your safety I link to the official Google Play store instead of serving APK files directly.\n\n` +
      `Search results for *${input}*:\nhttps://play.google.com/store/search?q=${query}&c=apps`,
  );
}

export const downloadCommands: Command[] = [
  // --- Audio ---
  dl({
    name: "play",
    aliases: ["song"],
    category: "DOWNLOAD",
    desc: "Search a song, then pick audio (mp3) or video (mp4)",
    usage: "Usage: *%pplay <song name or link>*",
    run: startPlay,
  }),
  dl({
    name: "ytmp3",
    category: "DOWNLOAD",
    desc: "Download audio (MP3) from a search or link",
    usage: "Usage: *%pytmp3 <song name or link>*",
    run: (ctx, input) => fromUrlOrSearch(ctx, input, sendAudio, "ytsearch1"),
  }),
  // --- Video (also listed under the VIDEO menu) ---
  dl({
    name: "ytmp4",
    category: "DOWNLOAD",
    desc: "Download YouTube video (MP4)",
    usage: "Usage: *%pytmp4 <YouTube link or search>*",
    run: (ctx, input) => fromUrlOrSearch(ctx, input, sendVideo),
  }),
  dl({
    name: "video",
    category: "DOWNLOAD",
    desc: "Download a video from a link or YouTube search",
    usage: "Usage: *%pvideo <link or search>*",
    run: (ctx, input) => fromUrlOrSearch(ctx, input, sendVideo),
  }),
  // --- Platform-specific video (host-allowlisted) ---
  platformVideo("tiktok", ["tt", "tiktokvideo"], "Download a TikTok video", "TikTok", ["tiktok.com"]),
  platformVideo("instagram", ["ig", "igvideo"], "Download an Instagram video", "Instagram", ["instagram.com"]),
  platformVideo("facebook", ["fb", "fbvideo"], "Download a Facebook video", "Facebook", ["facebook.com", "fb.watch", "fb.com"]),
  platformVideo("twitter", ["x", "xvideo"], "Download a Twitter/X video", "Twitter/X", ["twitter.com", "x.com"]),
  platformVideo("pinterest", undefined, "Download a Pinterest video", "Pinterest", ["pinterest.com", "pin.it"]),
  // --- Special sources ---
  dl({
    name: "spotify",
    category: "DOWNLOAD",
    desc: "Download a Spotify track (via YouTube audio)",
    usage: "Usage: *%pspotify <Spotify track link>*",
    run: spotifyHandler,
  }),
  dl({
    name: "gitclone",
    category: "DOWNLOAD",
    desc: "Download a GitHub repo as a zip",
    usage: "Usage: *%pgitclone <github repo link>*",
    run: gitcloneHandler,
  }),
  dl({
    name: "mediafire",
    category: "DOWNLOAD",
    desc: "Download a file from MediaFire",
    usage: "Usage: *%pmediafire <mediafire link>*",
    run: mediafireHandler,
  }),
  dl({
    name: "apk",
    category: "DOWNLOAD",
    desc: "Find an app on the Play Store",
    usage: "Usage: *%papk <app name>*",
    heavy: false,
    run: apkHandler,
  }),
];
