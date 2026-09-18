import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, CommandContext } from "../types";
import { fetchMeta, download, downloadTikTok, downloadVideoSmart, IS_TIKTOK_URL } from "../ytdlp";
import { fetchBuffer } from "../http-utils";
import { hostMatches } from "../url-utils";
import { tryAcquire } from "../limiter";
import { runProcess } from "../proc";
import { getFfmpegPath } from "../ffmpeg";
import { logger } from "../../logger";

const AUDIO_FORMAT = "18/bestaudio[ext=m4a]/best";
const MAX_AUDIO_MB = 50;
const MAX_VIDEO_MB = 64;
const MAX_DURATION_S = 1800;

const SEARCH = "ytsearch1";

const ALLOWED = [
  "youtube.com", "youtu.be", "music.youtube.com", "youtube-nocookie.com",
  "soundcloud.com", "on.soundcloud.com", "tiktok.com", "vm.tiktok.com",
  "instagram.com", "instagr.am", "facebook.com", "fb.watch", "fb.com",
  "twitter.com", "x.com", "pinterest.com", "pin.it", "dailymotion.com", "dai.ly",
  "vimeo.com", "reddit.com", "rumble.com", "vk.com", "vkvideo.ru", "bilibili.com",
  "douyin.com", "threads.net", "bandcamp.com", "mixcloud.com", "audiomack.com",
  "streamable.com", "youtube.com/shorts", "music.apple.com", "apple.com",
  "deezer.com", "spotify.com", "open.spotify.com", "mega.nz", "pixeldrain.com",
  "mediafire.com", "onedrive.live.com", "drive.google.com",
];

// Audio name searches use SoundCloud by default (YouTube blocks this host's
// IP). When the operator sets YOUTUBE_COOKIES(/_FILE), YouTube is unblocked and
// name searches switch to YouTube's catalog (bigger hit rate, plus the audio
// and name-video commands all work).
const AUDIO_SEARCH: "ytsearch1" | "scsearch1" = process.env.YOUTUBE_COOKIES ||
  process.env.YOUTUBE_COOKIES_FILE
  ? "ytsearch1"
  : "scsearch1";

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function arg(ctx: CommandContext): string {
  return (ctx.text.trim() || ctx.quotedText?.trim() || "").trim();
}

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

async function sendAudio(ctx: CommandContext, target: string): Promise<void> {
  await ctx.react("⏳");
  const meta = await fetchMeta(target);
  if (meta.duration && meta.duration > MAX_DURATION_S) {
    await ctx.reply(`❌ That's too long (${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, "0")}). Limit is 30 minutes.`);
    return;
  }
  const { buffer, ext } = await download(target, { format: AUDIO_FORMAT, audio: true, maxSizeMb: MAX_AUDIO_MB });
  await ctx.sock.sendMessage(ctx.from, { audio: buffer, mimetype: audioMime(ext), fileName: `${meta.title}.${ext}` }, { quoted: ctx.msg });
  await ctx.react("✅");
}

async function sendVideo(ctx: CommandContext, target: string): Promise<void> {
  await ctx.react("⏳");
  // TikTok/Instagram links route through their working API paths; everything
  // else (plus search queries) goes through yt-dlp.
  const dl = await downloadVideoSmart(target, { maxSizeMb: MAX_VIDEO_MB });
  await ctx.sock.sendMessage(ctx.from, { video: dl.buffer, mimetype: "video/mp4", caption: `🎬 ${dl.title ?? "video"}` }, { quoted: ctx.msg });
  await ctx.react("✅");
}

/** TikTok audio/video via the public tikwm API (yt-dlp's extractor is IP-blocked). */
async function tiktokApiDownload(ctx: CommandContext, wantAudio = false): Promise<void> {
  const input = arg(ctx);
  if (!input || !IS_TIKTOK_URL.test(input)) {
    await ctx.reply(`Send a TikTok link.\nExample: *${ctx.prefix}${ctx.command} https://vt.tiktok.com/...*`);
    return;
  }
  await ctx.react("⏳");
  try {
    if (wantAudio) {
      const dl = await downloadTikTok(input, { audio: true, maxSizeMb: MAX_AUDIO_MB });
      await ctx.sock.sendMessage(
        ctx.from,
        { audio: dl.buffer, mimetype: dl.mime, fileName: `${(dl.title ?? "tt").replace(/[^\w-]+/g, "_").slice(0, 40)}.${dl.ext}` },
        { quoted: ctx.msg },
      );
    } else {
      await sendVideo(ctx, input);
    }
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err, cmd: ctx.command }, "tiktok download failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't download that TikTok (TikTok may be blocking this server right now). Try again later.");
  }
}

/** Generic link-or-search → audio (SoundCloud search when no URL). */
async function audioCmd(ctx: CommandContext): Promise<void> {
  const input = arg(ctx);
  if (!input) {
    await ctx.reply(`Send a link or a song name to search.\nExample: *${ctx.prefix}${ctx.command} faded*`);
    return;
  }
  await ctx.react("⏳");
  try {
    if (isUrl(input)) {
      if (!hostMatches(input, ALLOWED)) {
        await ctx.reply("❌ That link isn't supported by this command.");
        return;
      }
      await sendAudio(ctx, input);
    } else {
      await sendAudio(ctx, `${AUDIO_SEARCH}:${input}`);
    }
  } catch (err) {
    logger.warn({ err, cmd: ctx.command }, "audio download failed");
    await ctx.react("❌");
    if (isUrl(input)) {
      await ctx.reply("❌ Couldn't download that link. It may be private, region-locked, or unavailable.");
    } else {
      await ctx.reply(
        "❌ Couldn't find that track. Check the spelling, or send a direct link.",
      );
    }
  }
}

/** Generic link → video download. */
async function videoCmd(ctx: CommandContext): Promise<void> {
  const input = arg(ctx);
  if (!input) {
    await ctx.reply(`Send a *direct link* to download the video.\nExample: *${ctx.prefix}${ctx.command} https://www.youtube.com/watch?v=...*`);
    return;
  }
  if (!isUrl(input)) {
    await ctx.react("⏳");
    try {
      await sendVideo(ctx, `${SEARCH}:${input}`);
    } catch {
      await ctx.react("❌");
      const blocked = !(process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIES_FILE);
      await ctx.reply(
        blocked
          ? "❌ YouTube blocks downloads from this server (it's the hosting IP, not the video). For audio, try *%pplay <song name>* — or send a *direct link*."
          : "❌ Couldn't find or download that video. Try a *direct link* or a different search.",
      );
    }
    return;
  }
  if (!hostMatches(input, ALLOWED)) {
    await ctx.reply("❌ That link isn't supported by this command.");
    return;
  }
  await ctx.react("⏳");
  try {
    await sendVideo(ctx, input);
  } catch (err) {
    logger.warn({ err, cmd: ctx.command }, "video download failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't download that video. The platform may have blocked this server.");
  }
}

/** YouTube-link-only audio (search blocked from this host). */
async function ytAudio(ctx: CommandContext): Promise<void> {
  const input = arg(ctx);
  if (!input) {
    await ctx.reply(`Send a *YouTube link*.\nExample: *${ctx.prefix}${ctx.command} https://youtu.be/...*`);
    return;
  }
  if (!isUrl(input) || !hostMatches(input, ALLOWED)) {
    await ctx.reply("❌ Send a direct YouTube link.");
    return;
  }
  await ctx.react("⏳");
  try {
    await sendAudio(ctx, input);
  } catch (err) {
    logger.warn({ err, cmd: ctx.command }, "yt audio failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't get that audio. YouTube may be blocking this server right now.");
  }
}

/** yt-dlp flat-playlist JSON for a playlist/channel → list of titles. */
async function listItems(target: string, limit: number): Promise<{ title: string; url: string }[]> {
  const { runProcess } = await import("../proc");
  const { existsSync } = await import("node:fs");
  const { dirname, join: j } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const ytdlp = join(moduleDir, "..", "bin", "yt-dlp");
  const cmd = existsSync(ytdlp) ? ytdlp : "yt-dlp";
  const { code, stdout } = await runProcess(
    cmd,
    ["--flat-playlist", "-J", "--no-warnings", "--socket-timeout", "30", "--retries", "3", "--", target],
    { timeoutMs: 60_000 },
  );
  if (code !== 0 || !stdout.trim()) return [];
  const j0 = JSON.parse(stdout.trim().split("\n")[0] ?? "{}") as {
    title?: string;
    entries?: { title?: string; url?: string }[];
  };
  return (j0.entries ?? []).slice(0, limit).map((e) => ({ title: e.title ?? "unknown", url: e.url ?? "" }));
}

function ytId(url: string): string | null {
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{6,})/.exec(url);
  return m ? m[1] : null;
}

async function thumbHandler(ctx: CommandContext): Promise<void> {
  const input = arg(ctx);
  if (!input || !isUrl(input) || !hostMatches(input, ALLOWED)) {
    await ctx.reply(`Send a *YouTube link* to get its thumbnail.\nExample: *${ctx.prefix}ytthumb https://youtu.be/...*`);
    return;
  }
  const id = ytId(input);
  if (!id) {
    await ctx.reply("❌ Couldn't find a video id in that link.");
    return;
  }
  try {
    const { buffer } = await fetchBuffer(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, { maxBytes: 8 * 1024 * 1024, timeoutMs: 20000 });
    await ctx.sock.sendMessage(ctx.from, { image: buffer, caption: `🖼️ Thumbnail\n${input}` }, { quoted: ctx.msg });
  } catch {
    await ctx.reply("❌ Couldn't fetch that thumbnail.");
  }
}

async function infoHandler(ctx: CommandContext): Promise<void> {
  const input = arg(ctx);
  if (!input || !isUrl(input) || !hostMatches(input, ALLOWED)) {
    await ctx.reply(`Send a *link* to inspect.\nExample: *${ctx.prefix}ytinfo https://youtu.be/...*`);
    return;
  }
  try {
    const meta = await fetchMeta(input);
    const dur = meta.duration ? `${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, "0")}` : "unknown";
    await ctx.reply(`📽️ *${meta.title}*\n\n⏱️ Duration: ${dur}\n👤 Uploader: ${meta.uploader ?? "unknown"}\n🔗 ${meta.webpageUrl ?? input}`);
  } catch {
    await ctx.reply("❌ Couldn't read that link.");
  }
}

/** Search YouTube and play the top result (like a music search). */
async function searchHandler(ctx: CommandContext): Promise<void> {
  const q = arg(ctx);
  if (!q) {
    await ctx.reply(`Usage: *${ctx.prefix}${ctx.command} <song name>*`);
    return;
  }
  await ctx.react("🔍");
  try {
    const items = await listItems(`${AUDIO_SEARCH}:${q}`, 5);
    if (items.length === 0) {
      await ctx.reply("❌ No results found.");
      return;
    }
    const lines = items.map((e, i) => `${i + 1}. ${e.title}`).join("\n");
    await ctx.reply(`🔍 *Top results for "${q}":*\n${lines}\n\n▶️ Playing the top result…`);
    await sendAudio(ctx, `${AUDIO_SEARCH}:${q}`);
  } catch {
    await ctx.reply("❌ Search failed right now. Try again later.");
  }
}

/** Download an audio track, then run an ffmpeg post-process step. */
async function audioWithFfmpeg(
  ctx: CommandContext,
  ffmpegArgs: string[],
  outName: string,
  mime: string,
): Promise<void> {
  const input = arg(ctx);
  if (!input) {
    await ctx.reply(`Send a *link* or *song name*.\nExample: *${ctx.prefix}${ctx.command} faded*`);
    return;
  }
  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "proc-"));
    await ctx.react("⏳");
    const target = isUrl(input) && hostMatches(input, ALLOWED) ? input : `${AUDIO_SEARCH}:${input}`;
    const { buffer } = await download(target, { format: AUDIO_FORMAT, audio: true, maxSizeMb: MAX_AUDIO_MB });
    const inPath = join(dir, "in.mp3");
    const outPath = join(dir, outName);
    await writeFile(inPath, buffer);
    const { code } = await runProcess(getFfmpegPath(), ["-y", "-i", inPath, ...ffmpegArgs, outPath], { timeoutMs: 120_000 });
    if (code !== 0) {
      await ctx.react("❌");
      await ctx.reply("❌ Couldn't process that audio.");
      return;
    }
    const out = await readFile(outPath).catch(() => null);
    if (!out || out.length === 0) {
      await ctx.react("❌");
      await ctx.reply("❌ Processing produced no output.");
      return;
    }
    await ctx.sock.sendMessage(ctx.from, { audio: out, mimetype: mime, fileName: outName }, { quoted: ctx.msg });
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err, cmd: ctx.command }, "audio post-process failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't download that audio. Try a direct link.");
  } finally {
    slot.release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ringtoneHandler(ctx: CommandContext): Promise<void> {
  await audioWithFfmpeg(ctx, ["-t", "30", "-c:a", "libmp3lame", "-b:a", "160k"], "ringtone.mp3", "audio/mpeg");
}

async function karaokeHandler(ctx: CommandContext): Promise<void> {
  await audioWithFfmpeg(
    ctx,
    ["-af", "pan=stereo|c0=c0-c1|c1=c1-c0", "-c:a", "libmp3lame", "-b:a", "128k"],
    "karaoke.mp3",
    "audio/mpeg",
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const downloads2Commands: Command[] = [
  // Music search / play
  { name: "music", aliases: ["music"], category: "DOWNLOAD", desc: "Play music (search or link)", handler: audioCmd },
  { name: "play2", category: "DOWNLOAD", desc: "Play music", handler: audioCmd },
  { name: "play3", category: "DOWNLOAD", desc: "Play music", handler: audioCmd },
  { name: "play4", category: "DOWNLOAD", desc: "Play music", handler: audioCmd },
  { name: "play5", category: "DOWNLOAD", desc: "Play music", handler: audioCmd },
  { name: "musicsearch", category: "DOWNLOAD", desc: "Search tracks (SoundCloud)", handler: searchHandler },
  { name: "charts", category: "DOWNLOAD", desc: "Top tracks search", handler: async (ctx) => {
      const input = arg(ctx);
      if (!input) {
        await ctx.reply("Usage: *" + ctx.prefix + "charts <genre/vibe>* — e.g. .charts pop");
        return;
      }
      const items = await listItems(`${AUDIO_SEARCH}:${input}`, 8);
      await ctx.reply(items.length ? `📈 *Results:*\n${items.map((e, i) => `${i + 1}. ${e.title}`).join("\n")}` : "❌ No results.");
    } },
  { name: "trendingmusic", category: "DOWNLOAD", desc: "Trending music search", handler: async (ctx) => {
      const items = await listItems(`${AUDIO_SEARCH}:trending`, 8);
      await ctx.reply(items.length ? `🔥 *Trending now:*\n${items.map((e, i) => `${i + 1}. ${e.title}`).join("\n")}` : "❌ No results.");
    } },

  // Platform audio (link or SoundCloud search fallback)
  { name: "soundcloud", aliases: ["sc"], category: "DOWNLOAD", desc: "SoundCloud track", handler: audioCmd },
  { name: "audiomack", category: "DOWNLOAD", desc: "Audiomack track", handler: audioCmd },
  { name: "bandcamp", category: "DOWNLOAD", desc: "Bandcamp track", handler: audioCmd },
  { name: "mixcloud", category: "DOWNLOAD", desc: "Mixcloud mix", handler: audioCmd },
  { name: "deezer", category: "DOWNLOAD", desc: "Deezer track (search fallback)", handler: audioCmd },
  { name: "tidal", category: "DOWNLOAD", desc: "Tidal track (search fallback)", handler: audioCmd },
  { name: "jiosaavn", category: "DOWNLOAD", desc: "JioSaavn track", handler: audioCmd },
  { name: "hungama", category: "DOWNLOAD", desc: "Hungama track", handler: audioCmd },
  { name: "boomplay", category: "DOWNLOAD", desc: "Boomplay track", handler: audioCmd },
  { name: "spotifysearch", category: "DOWNLOAD", desc: "Search a track (Spotify-style)", handler: searchHandler },
  { name: "spotifydl", category: "DOWNLOAD", desc: "Download a track (search fallback)", handler: audioCmd },
  { name: "spotifyplaylist", category: "DOWNLOAD", desc: "Playlist (search fallback)", handler: audioCmd },
  { name: "spotifyalbum", category: "DOWNLOAD", desc: "Album (search fallback)", handler: audioCmd },
  { name: "applemusic", category: "DOWNLOAD", desc: "Apple Music track", handler: audioCmd },
  { name: "podcast", category: "DOWNLOAD", desc: "Podcast episode (link)", handler: audioCmd },
  { name: "audiobook", category: "DOWNLOAD", desc: "LibriVox audiobook", handler: audioCmd },

  // YouTube
  { name: "yta", aliases: ["ytaudio"], category: "DOWNLOAD", desc: "YouTube audio (link)", handler: ytAudio },
  { name: "ytv", aliases: ["ytvideo"], category: "DOWNLOAD", desc: "YouTube video (link)", handler: videoCmd },
  { name: "ytshorts", category: "DOWNLOAD", desc: "YouTube Shorts (link)", handler: videoCmd },
  { name: "ytlive", category: "DOWNLOAD", desc: "YouTube live (link)", handler: videoCmd },
  { name: "ytsearch", category: "DOWNLOAD", desc: "Search YouTube and play a result", handler: searchHandler },
  { name: "ytplaylist", category: "DOWNLOAD", desc: "List a YouTube playlist", handler: async (ctx) => {
      const input = arg(ctx);
      if (!input || !isUrl(input)) return ctx.reply(`Send a *YouTube playlist link*.\nExample: *${ctx.prefix}ytplaylist https://youtube.com/playlist?list=...*`);
      const items = await listItems(input, 15);
      await ctx.reply(items.length ? `📋 *Playlist (${items.length}+):*\n${items.map((e, i) => `${i + 1}. ${e.title}`).join("\n")}` : "❌ Couldn't read that playlist (YouTube may be blocking this server).");
    } },
  { name: "ytchannel", category: "DOWNLOAD", desc: "List a channel's uploads", handler: async (ctx) => {
      const input = arg(ctx);
      if (!input || !isUrl(input)) return ctx.reply(`Send a *channel link*.\nExample: *${ctx.prefix}ytchannel https://youtube.com/@channel*`);
      const items = await listItems(input, 15);
      await ctx.reply(items.length ? `📺 *Latest uploads:*\n${items.map((e, i) => `${i + 1}. ${e.title}`).join("\n")}` : "❌ Couldn't read that channel.");
    } },
  { name: "ytthumb", category: "DOWNLOAD", desc: "YouTube thumbnail", handler: thumbHandler },
  { name: "ytinfo", category: "DOWNLOAD", desc: "Video info", handler: infoHandler },
  { name: "ytcomment", category: "DOWNLOAD", desc: "Video comments (link)", handler: async (ctx) => {
      const input = arg(ctx);
      if (!input || !isUrl(input)) return ctx.reply(`Send a *YouTube link*.\nExample: *${ctx.prefix}ytcomment https://youtu.be/...*`);
      await ctx.reply("💬 Comments aren't available on this build (YouTube blocks the API from this server). Try *" + ctx.prefix + "ytinfo* for video details.");
    } },

  // TikTok
  { name: "tiktokhd", category: "DOWNLOAD", desc: "TikTok HD video", aliases: ["tt", "tiktok", "tik", "tiktokvideo"], handler: tiktokApiDownload },
  { name: "ttmp3", category: "DOWNLOAD", desc: "TikTok audio", handler: async (ctx) => tiktokApiDownload(ctx, true) },
  { name: "ttslide", category: "DOWNLOAD", desc: "TikTok slideshow", handler: videoCmd },
  { name: "xdl", category: "DOWNLOAD", desc: "X (Twitter) video", handler: videoCmd },
  { name: "threads", category: "DOWNLOAD", desc: "Threads video", handler: videoCmd },
  { name: "reddit", category: "DOWNLOAD", desc: "Reddit video", handler: videoCmd },
  { name: "vk", category: "DOWNLOAD", desc: "VK video", handler: videoCmd },
  { name: "bilibili", category: "DOWNLOAD", desc: "Bilibili video", handler: videoCmd },
  { name: "douyin", category: "DOWNLOAD", desc: "Douyin video", handler: videoCmd },
  { name: "dailymotion", category: "DOWNLOAD", desc: "Dailymotion video", handler: videoCmd },
  { name: "vimeo", category: "DOWNLOAD", desc: "Vimeo video", handler: videoCmd },
  { name: "rumble", category: "DOWNLOAD", desc: "Rumble video", handler: videoCmd },
  { name: "sharechat", category: "DOWNLOAD", desc: "ShareChat video", handler: videoCmd },
  { name: "snapchat", category: "DOWNLOAD", desc: "Snapchat content", handler: videoCmd },
  { name: "linkedin", category: "DOWNLOAD", desc: "LinkedIn video", handler: videoCmd },
  { name: "likee", category: "DOWNLOAD", desc: "Likee video", handler: videoCmd },
  { name: "kwai", category: "DOWNLOAD", desc: "Kwai video", handler: videoCmd },
  { name: "capcut", category: "DOWNLOAD", desc: "CapCut template", handler: videoCmd },
  { name: "ifunny", category: "DOWNLOAD", desc: "iFunny content", handler: videoCmd },
  { name: "weibo", category: "DOWNLOAD", desc: "Weibo video", handler: videoCmd },
  { name: "album", category: "DOWNLOAD", desc: "Album cover", handler: thumbHandler },
  { name: "ringtone", category: "AUDIO", desc: "Make a 30s ringtone", handler: ringtoneHandler },
  { name: "karaoke", category: "AUDIO", desc: "Remove vocals (karaoke)", handler: karaokeHandler },
];
