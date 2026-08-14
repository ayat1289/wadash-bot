import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Image } from "node-webpmux";
import type { Command, CommandContext } from "../types";
import { downloadMedia, hasMedia } from "../media-utils";
import { fetchImageBuffer } from "../http-utils";
import { runProcess } from "../proc";
import { getFfmpegPath } from "../ffmpeg";
import { tryAcquire } from "../limiter";
import { logger } from "../../logger";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB source video

/** Strip whitespace + variation selectors, return the leading code-point chars. */
function emojiChars(text: string): string[] {
  return Array.from(text).filter((c) => c.trim().length > 0 && c !== "\uFE0F");
}

function emojiHex(e: string): string {
  const cp = e.codePointAt(0);
  return cp ? cp.toString(16) : "";
}

/**
 * Inject WhatsApp sticker EXIF (pack name + publisher) into a webp buffer
 * WITHOUT re-encoding, so animated stickers keep their animation. The EXIF
 * blob is the well-known TIFF header + a JSON payload, with the JSON length
 * patched into the header at offset 14.
 */
async function rebrandSticker(webpBuf: Buffer, pack: string, author: string): Promise<Buffer> {
  const img = new Image();
  await img.load(webpBuf);
  const json = {
    "sticker-pack-id": "wadash",
    "sticker-pack-name": pack,
    "sticker-pack-publisher": author,
    emojis: [] as string[],
  };
  const jb = Buffer.from(JSON.stringify(json), "utf-8");
  const head = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([head, jb]);
  exif.writeUIntLE(jb.length, 14, 4);
  img.exif = exif;
  return (await img.save(null)) as Buffer;
}

async function videoToMp3(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "tomp3-"));
  const inPath = join(dir, "in");
  const outPath = join(dir, "out.mp3");
  try {
    await writeFile(inPath, input);
    const { code, stderr } = await runProcess(
      getFfmpegPath(),
      ["-y", "-i", inPath, "-vn", "-ac", "2", "-b:a", "128k", outPath],
      { timeoutMs: 90_000 },
    );
    if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(-200)}`);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const stickerCommands: Command[] = [
  {
    name: "emojimix",
    aliases: ["emix", "mix"],
    category: "TOOLS",
    desc: "Mix two emojis into a sticker: <emoji1> <emoji2>",
    handler: async (ctx: CommandContext) => {
      const chars = emojiChars(ctx.text);
      if (chars.length < 2) {
        return ctx.reply(`Usage: *${ctx.prefix}emojimix 😍 🔥*`);
      }
      const [a, b] = chars;
      const url = `https://emojik.vercel.app/s/${emojiHex(a)}_${emojiHex(b)}?size=512`;
      try {
        await ctx.react("⏳");
        const png = await fetchImageBuffer(url, { maxBytes: 4 * 1024 * 1024 });
        const webp = await sharp(png)
          .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 80 })
          .toBuffer();
        await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
        await ctx.react("✅");
      } catch (err) {
        logger.warn({ err }, "emojimix failed");
        await ctx.reply("❌ That emoji pair can't be mixed. Try two different common emojis.");
      }
    },
  },
  {
    name: "take",
    aliases: ["steal", "rename"],
    category: "TOOLS",
    desc: "Rebrand a replied sticker: pack | author",
    handler: async (ctx: CommandContext) => {
      if (!hasMedia(ctx, "sticker")) {
        return ctx.reply(`🏷️ Reply to a *sticker* with *${ctx.prefix}take pack | author*`);
      }
      const [packRaw, authorRaw] = ctx.text.split("|");
      const pack = (packRaw ?? "").trim() || "WADash";
      const author = (authorRaw ?? "").trim() || "Heer MD Bot";
      try {
        await ctx.react("⏳");
        const buf = await downloadMedia(ctx, "sticker");
        if (!buf) return ctx.reply("❌ Failed to download the sticker.");
        const out = await rebrandSticker(buf, pack.slice(0, 60), author.slice(0, 60));
        await ctx.sock.sendMessage(ctx.from, { sticker: out }, { quoted: ctx.msg });
        await ctx.react("✅");
      } catch (err) {
        logger.warn({ err }, "take sticker failed");
        await ctx.reply("❌ Couldn't rebrand that sticker.");
      }
    },
  },
  {
    name: "tomp3",
    aliases: ["toaudio", "tovoice"],
    category: "AUDIO",
    desc: "Extract audio from a replied video",
    handler: async (ctx: CommandContext) => {
      if (!hasMedia(ctx, "video")) {
        return ctx.reply(`🎵 Reply to a *video* with *${ctx.prefix}tomp3* to extract its audio.`);
      }
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
      if (!slot.ok) {
        await ctx.reply(slot.reason);
        return;
      }
      try {
        await ctx.react("⏳");
        const input = await downloadMedia(ctx, "video");
        if (!input || !input.length) throw new Error("no video downloaded");
        if (input.length > MAX_VIDEO_BYTES) {
          await ctx.reply("❌ That video is too large (max ~50MB).");
          return;
        }
        const output = await videoToMp3(input);
        await ctx.sock.sendMessage(
          ctx.from,
          { audio: output, mimetype: "audio/mpeg", fileName: "audio.mp3" },
          { quoted: ctx.msg },
        );
        await ctx.react("✅");
      } catch (err) {
        logger.warn({ err }, "tomp3 failed");
        await ctx.reply("❌ Couldn't extract audio from that video.");
      } finally {
        slot.release();
      }
    },
  },
];
