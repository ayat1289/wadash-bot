import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadMediaMessage,
  type proto,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { Command, CommandContext } from "../types";
import { tryAcquire } from "../limiter";
import { runProcess } from "../proc";
import { getFfmpegPath } from "../ffmpeg";
import { logger } from "../../logger";

// ---------------------------------------------------------------------------
// .vv — reveal a replied-to view-once photo / video / voice note
// ---------------------------------------------------------------------------

type ViewOnceKind = "image" | "video" | "audio";

const VV_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Unwrap the various view-once envelopes WhatsApp uses and identify the inner
 * media kind. Handles the three wrapper variants as well as a media message
 * that simply carries the `viewOnce` flag with no wrapper. Returns null for
 * ordinary (non-view-once) media so `.vv` only ever reposts view-once content.
 */
export function unwrapViewOnce(
  q: proto.IMessage,
): { inner: proto.IMessage; kind: ViewOnceKind } | null {
  const wrapped =
    q.viewOnceMessage?.message ??
    q.viewOnceMessageV2?.message ??
    q.viewOnceMessageV2Extension?.message ??
    null;
  const inner = wrapped ?? q;
  const wasViewOnce = wrapped !== null;
  if (inner.imageMessage && (wasViewOnce || inner.imageMessage.viewOnce)) {
    return { inner, kind: "image" };
  }
  if (inner.videoMessage && (wasViewOnce || inner.videoMessage.viewOnce)) {
    return { inner, kind: "video" };
  }
  if (inner.audioMessage && (wasViewOnce || inner.audioMessage.viewOnce)) {
    return { inner, kind: "audio" };
  }
  return null;
}

async function vvHandler(ctx: CommandContext): Promise<void> {
  const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ci?.quotedMessage;
  if (!quoted) {
    await ctx.reply(
      "🔁 Reply to a *view-once* photo, video, or voice note with this command.",
    );
    return;
  }
  const found = unwrapViewOnce(quoted);
  if (!found) {
    await ctx.reply(
      "❌ That message isn't a view-once photo, video, or voice note.",
    );
    return;
  }

  // Rebuild the quoted message's own key so expired media can be re-uploaded.
  const target = {
    key: {
      remoteJid: ctx.from,
      fromMe: false,
      id: ci?.stanzaId ?? undefined,
      participant: ci?.participant ?? undefined,
    },
    message: found.inner,
  } as WAMessage;

  // Downloading + re-uploading media is bandwidth/memory heavy, so gate it.
  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  try {
    const buffer = (await downloadMediaMessage(
      target,
      "buffer",
      {},
      { logger, reuploadRequest: ctx.sock.updateMediaMessage },
    )) as Buffer;

    if (buffer.length > VV_MAX_BYTES) {
      await ctx.reply("❌ That media is too large to resend.");
      return;
    }

    const caption = "🔓 *Revealed view-once*";
    if (found.kind === "image") {
      await ctx.sock.sendMessage(
        ctx.from,
        { image: buffer, caption },
        { quoted: ctx.msg },
      );
    } else if (found.kind === "video") {
      await ctx.sock.sendMessage(
        ctx.from,
        { video: buffer, caption },
        { quoted: ctx.msg },
      );
    } else {
      await ctx.sock.sendMessage(
        ctx.from,
        {
          audio: buffer,
          mimetype:
            found.inner.audioMessage?.mimetype ?? "audio/ogg; codecs=opus",
          ptt: found.inner.audioMessage?.ptt ?? true,
        },
        { quoted: ctx.msg },
      );
    }
  } catch (err) {
    logger.warn({ err }, "vv reveal failed");
    await ctx.reply("❌ Couldn't reveal that — the media may have expired.");
  } finally {
    slot.release();
  }
}

// ---------------------------------------------------------------------------
// .say — text-to-speech voice note (key-free Google Translate TTS + ffmpeg)
// ---------------------------------------------------------------------------

const TTS_MAX_CHARS = 500;
const TTS_CHUNK_CHARS = 190; // Google's translate_tts endpoint caps `q` length.

/** Split text into <=size word-boundary chunks (hard-splitting any long word). */
function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (candidate.length > size) {
      if (cur) chunks.push(cur);
      if (word.length > size) {
        for (let i = 0; i < word.length; i += size) {
          chunks.push(word.slice(i, i + size));
        }
        cur = "";
      } else {
        cur = word;
      }
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function fetchTtsMp3(text: string): Promise<Buffer> {
  const url =
    "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en" +
    `&q=${encodeURIComponent(text)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function sayHandler(ctx: CommandContext): Promise<void> {
  const text = (ctx.text.trim() || ctx.quotedText?.trim() || "").trim();
  if (!text) {
    await ctx.reply(`Usage: *${ctx.prefix}say <text>* (or reply to a message)`);
    return;
  }
  if (text.length > TTS_MAX_CHARS) {
    await ctx.reply(`❌ Too long. Keep it under ${TTS_MAX_CHARS} characters.`);
    return;
  }

  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "say-"));
    await ctx.react("🗣️");
    const mp3Parts: Buffer[] = [];
    for (const part of chunkText(text, TTS_CHUNK_CHARS)) {
      mp3Parts.push(await fetchTtsMp3(part));
    }
    const mp3 = Buffer.concat(mp3Parts);

    // Transcode to Ogg/Opus so WhatsApp renders it as a real voice note.
    const inPath = join(dir, "in.mp3");
    const outPath = join(dir, "out.ogg");
    await writeFile(inPath, mp3);
    // Transcode best-effort: `runProcess` REJECTS on a spawn error or timeout
    // (it only returns a non-zero `code` on a clean failure), so wrap it so an
    // ffmpeg throw falls back to the raw mp3 instead of failing the command.
    let ogg: Buffer | null = null;
    try {
      const { code } = await runProcess(
        getFfmpegPath(),
        [
          "-y",
          "-i",
          inPath,
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          "-ar",
          "48000",
          "-ac",
          "1",
          outPath,
        ],
        { timeoutMs: 30_000 },
      );
      if (code === 0) ogg = await readFile(outPath).catch(() => null);
    } catch (err) {
      logger.warn({ err }, "say (tts) ffmpeg transcode failed; falling back to mp3");
    }

    if (ogg && ogg.length > 0) {
      await ctx.sock.sendMessage(
        ctx.from,
        { audio: ogg, mimetype: "audio/ogg; codecs=opus", ptt: true },
        { quoted: ctx.msg },
      );
    } else {
      // Opus transcoding failed — send the raw mp3 as a normal audio attachment
      // (ptt:false) so it still PLAYS. An mp3 sent as a voice note (ptt:true)
      // won't play on most WhatsApp builds, which is the "audio not playing" bug.
      await ctx.sock.sendMessage(
        ctx.from,
        { audio: mp3, mimetype: "audio/mpeg", ptt: false },
        { quoted: ctx.msg },
      );
    }
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err }, "say (tts) failed");
    await ctx.reply("❌ Couldn't generate that voice clip right now.");
  } finally {
    slot.release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// .togif — convert a replied-to video (or image) into a GIF
// ---------------------------------------------------------------------------

const GIF_MAX_DURATION_S = 300; // 5 minutes
const GIF_MAX_BYTES = 24 * 1024 * 1024;

/** Parse the "Duration: HH:MM:SS.xx" line ffmpeg prints to stderr for `-i`. */
function parseDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function togifHandler(ctx: CommandContext): Promise<void> {
  const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ci?.quotedMessage;
  const inner = quoted?.videoMessage || quoted?.imageMessage;
  if (!quoted || !inner) {
    await ctx.reply("🎞️ Reply to a *video* (or image) with this command to get a GIF.");
    return;
  }
  const target = {
    key: {
      remoteJid: ctx.from,
      fromMe: false,
      id: ci?.stanzaId ?? undefined,
      participant: ci?.participant ?? undefined,
    },
    message: quoted,
  } as WAMessage;

  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "gif-"));
    await ctx.react("⏳");
    const buffer = (await downloadMediaMessage(
      target,
      "buffer",
      {},
      { logger, reuploadRequest: ctx.sock.updateMediaMessage },
    )) as Buffer;
    const inPath = join(dir, "in.bin");
    const outPath = join(dir, "out.gif");
    await writeFile(inPath, buffer);

    if (quoted.videoMessage) {
      const { stderr } = await runProcess(getFfmpegPath(), ["-i", inPath], {
        timeoutMs: 15_000,
      }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
      const dur = parseDuration(stderr);
      if (dur !== null && dur > GIF_MAX_DURATION_S) {
        await ctx.reply("❌ That video is too long to turn into a GIF (limit 5 minutes).");
        return;
      }
    }

    // Palette-based GIF keeps colors accurate without bloating the file; scale
    // down to 480px wide and cap at 15fps so WhatsApp-friendly file sizes stay
    // sane. `-fs` is a hard output-size cap, and the timeout bounds the encode.
    const { code } = await runProcess(
      getFfmpegPath(),
      [
        "-y",
        "-i",
        inPath,
        "-vf",
        "fps=15,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer",
        "-fs",
        String(GIF_MAX_BYTES),
        outPath,
      ],
      { timeoutMs: 120_000 },
    );
    if (code !== 0) {
      await ctx.react("❌");
      await ctx.reply("❌ Couldn't convert that to a GIF right now. Try a shorter/smaller video.");
      return;
    }
    const gif = await readFile(outPath).catch(() => null);
    if (!gif || gif.length === 0 || gif.length > GIF_MAX_BYTES) {
      await ctx.react("❌");
      await ctx.reply("❌ That media is too large to turn into a GIF.");
      return;
    }
    await ctx.sock.sendMessage(
      ctx.from,
      { document: gif, mimetype: "image/gif", fileName: "animation.gif", caption: "🎞️ Converted GIF" },
      { quoted: ctx.msg },
    );
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err }, "togif failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't convert that to a GIF right now.");
  } finally {
    slot.release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const mediaCommands: Command[] = [
  {
    name: "vv",
    aliases: ["viewonce", "rvo", "readviewonce"],
    category: "TOOLS",
    desc: "Reveal a replied-to view-once photo/video/voice",
    handler: vvHandler,
  },
  {
    name: "say",
    aliases: ["tts"],
    category: "FUN",
    desc: "Convert text to a voice note",
    handler: sayHandler,
  },
  {
    name: "togif",
    aliases: ["gif"],
    category: "VIDEO",
    desc: "Convert a replied video/image to a GIF",
    handler: togifHandler,
  },
];
