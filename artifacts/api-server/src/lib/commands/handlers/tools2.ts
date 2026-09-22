import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadMediaMessage, type WAMessage } from "@whiskeysockets/baileys";
import sharp from "sharp";
import type { Command, CommandContext } from "../types";
import { fetchBuffer } from "../http-utils";
import { isPublicHttpUrl } from "../url-utils";
import { tryAcquire } from "../limiter";
import { runProcess } from "../proc";
import { getFfmpegPath } from "../ffmpeg";
import { logger } from "../../logger";

const UA = "WADashBot/1.0";

function arg(ctx: CommandContext): string {
  return (ctx.text.trim() || ctx.quotedText?.trim() || "").trim();
}

async function quotedBuffer(ctx: CommandContext): Promise<Buffer | null> {
  const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ci?.quotedMessage;
  if (!quoted) return null;
  const target = {
    key: { remoteJid: ctx.from, fromMe: false, id: ci?.stanzaId ?? undefined, participant: ci?.participant ?? undefined },
    message: quoted,
  } as WAMessage;
  return (await downloadMediaMessage(target, "buffer", {}, { logger, reuploadRequest: ctx.sock.updateMediaMessage })) as Buffer;
}

/** Wraps an image-processing helper with the acquire/reply plumbing. */
async function withImage(ctx: CommandContext, fn: (buf: Buffer, dir: string) => Promise<{ out: Buffer; mime: string; name: string; caption?: string }>): Promise<void> {
  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  let dir: string | null = null;
  try {
    const buf = await quotedBuffer(ctx);
    if (!buf) {
      await ctx.reply("🖼️ Reply to an *image* with this command.");
      return;
    }
    dir = await mkdtemp(join(tmpdir(), "img-"));
    await ctx.react("⏳");
    const { out, mime, name, caption } = await fn(buf, dir);
    await ctx.sock.sendMessage(ctx.from, { image: out, mimetype: mime, caption }, { quoted: ctx.msg });
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err, cmd: ctx.command }, "image command failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't process that image.");
  } finally {
    slot.release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function compressHandler(ctx: CommandContext): Promise<void> {
  await withImage(ctx, async (buf) => {
    const img = sharp(buf).rotate();
    const meta = await img.metadata();
    const width = Math.min(meta.width ?? 1600, 1280);
    const out = await img
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();
    return { out, mime: "image/jpeg", name: "compressed.jpg", caption: `📦 Compressed image (${(out.length / 1024).toFixed(0)} KB)` };
  });
}

async function hdHandler(ctx: CommandContext): Promise<void> {
  await withImage(ctx, async (buf) => {
    const img = sharp(buf).rotate();
    const meta = await img.metadata();
    const out = await img
      .resize({ width: (meta.width ?? 800) * 2, height: (meta.height ?? 600) * 2, kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
      .jpeg({ quality: 92 })
      .toBuffer();
    return { out, mime: "image/jpeg", name: "hd.jpg", caption: "✨ Upscaled (HD)" };
  });
}

async function collageHandler(ctx: CommandContext): Promise<void> {
  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  let dir: string | null = null;
  try {
    const buf = await quotedBuffer(ctx);
    if (!buf) {
      await ctx.reply("🖼️ Reply to an *image* to make a 2x2 collage.");
      return;
    }
    dir = await mkdtemp(join(tmpdir(), "collage-"));
    const inPath = join(dir, "in.png");
    const outPath = join(dir, "out.jpg");
    await writeFile(inPath, buf);
    await ctx.react("⏳");
    const { code } = await runProcess(
      getFfmpegPath(),
      ["-y", "-i", inPath, "-vf", "scale=480:480:force_original_aspect_ratio=increase,crop=480:480,tile=2x2", "-frames:v", "1", "-q:v", "4", outPath],
      { timeoutMs: 60_000 },
    );
    if (code !== 0) {
      await ctx.react("❌");
      await ctx.reply("❌ Couldn't build the collage.");
      return;
    }
    const out = await readFile(outPath);
    await ctx.sock.sendMessage(ctx.from, { image: out, caption: "🖼️ 2x2 Collage" }, { quoted: ctx.msg });
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err }, "collage failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't process that image.");
  } finally {
    slot.release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function removebgHandler(ctx: CommandContext): Promise<void> {
  await withImage(ctx, async (buf) => {
    const out = await sharp(buf).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    return { out, mime: "image/jpeg", name: "cleaned.jpg", caption: "🪄 Background cleaned to white (full .removebg needs an API key)." };
  });
}

// ---------------------------------------------------------------------------
// Uploads: .upload / .uploadimg (catbox) and .tourl (file.io)
// ---------------------------------------------------------------------------

async function uploadToCatbox(buf: Buffer, isImage: boolean): Promise<string> {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", new Blob([new Uint8Array(buf)], { type: isImage ? "image/*" : "application/octet-stream" }), isImage ? "image.png" : "file.bin");
  const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!/^https?:/.test(text)) throw new Error(text);
  return text;
}

async function uploadToFileio(buf: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)]), "file.bin");
  const res = await fetch("https://file.io", { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  const j = (await res.json()) as { success?: boolean; link?: string };
  if (j.success && j.link) return j.link;
  throw new Error("file.io upload failed");
}

async function uploadHandler(ctx: CommandContext, isImage: boolean): Promise<void> {
  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  try {
    const buf = await quotedBuffer(ctx);
    if (!buf) {
      await ctx.reply(isImage ? "🖼️ Reply to an *image* to upload it." : "📎 Reply to a *file* to upload it.");
      return;
    }
    if (buf.length > 180 * 1024 * 1024) {
      await ctx.reply("❌ That file is too big for the free upload host.");
      return;
    }
    await ctx.react("⏳");
    let link: string;
    try {
      link = await uploadToCatbox(buf, isImage);
    } catch {
      link = await uploadToFileio(buf);
    }
    await ctx.reply(`✅ *Uploaded:*\n${link}`);
    await ctx.react("✅");
  } catch {
    await ctx.react("❌");
    await ctx.reply("❌ Upload failed. The free host may be rate-limiting.");
  } finally {
    slot.release();
  }
}

async function tourlHandler(ctx: CommandContext): Promise<void> {
  const text = arg(ctx);
  if (!text) return ctx.reply(`Usage: *${ctx.prefix}tourl <text>* — uploads text and gives you a link.`);
  try {
    const res = await fetch("https://file.io", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text,
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json()) as { success?: boolean; link?: string };
    if (j.success && j.link) await ctx.reply(`✅ *${j.link}*`);
    else await ctx.reply("❌ Couldn't upload the text right now.");
  } catch {
    await ctx.reply("❌ Couldn't upload the text right now.");
  }
}

// ---------------------------------------------------------------------------
// Web utilities
// ---------------------------------------------------------------------------

async function webinfoHandler(ctx: CommandContext): Promise<void> {
  const url = ctx.args[0] ?? "";
  if (!/^https?:\/\//i.test(url) || !isPublicHttpUrl(url)) {
    return ctx.reply(`Usage: *${ctx.prefix}webinfo <public URL>*`);
  }
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": UA } });
    await ctx.reply(
      `🌐 *Web info:*\nURL: ${url}\nStatus: ${res.status}\nType: ${res.headers.get("content-type") ?? "?"}\nLength: ${res.headers.get("content-length") ?? "?"}\nServer: ${res.headers.get("server") ?? "?"}`,
    );
  } catch {
    await ctx.reply("❌ Couldn't reach that URL.");
  }
}

async function waybackHandler(ctx: CommandContext): Promise<void> {
  const url = ctx.args[0] ?? "";
  if (!/^https?:\/\//i.test(url)) return ctx.reply(`Usage: *${ctx.prefix}wayback <URL>*`);
  try {
    const j = (await fetchJson(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`)) as {
      archived_snapshots?: { closest?: { url?: string; timestamp?: string } };
    };
    const snap = j.archived_snapshots?.closest?.url;
    await ctx.reply(snap ? `🕰️ *Snapshot found:*\n${snap}` : "❌ No archived snapshot for that URL.");
  } catch {
    await ctx.reply("❌ Couldn't query the Wayback Machine.");
  }
}

async function archiveHandler(ctx: CommandContext): Promise<void> {
  const url = ctx.args[0] ?? "";
  if (!/^https?:\/\//i.test(url)) return ctx.reply(`Usage: *${ctx.prefix}archive <URL>* — saves a copy to web.archive.org`);
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, { signal: AbortSignal.timeout(30_000), redirect: "manual", headers: { "User-Agent": UA } });
    const out = `https://web.archive.org/web/${url.replace(/^https?:\/\//, "")}`;
    await ctx.reply(`📦 Archived: ${out}\n(status ${res.status})`);
  } catch {
    await ctx.reply("❌ Couldn't save that page (archive.org may be rate-limiting).");
  }
}

// ---------------------------------------------------------------------------

function fetchJson(url: string): Promise<unknown> {
  return fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
}

export const tools2Commands: Command[] = [
  { name: "compress", category: "TOOLS", desc: "Compress a replied image", handler: compressHandler },
  { name: "hd", category: "IMAGE", desc: "Upscale a replied image", handler: hdHandler },
  { name: "collage", category: "IMAGE", desc: "Make a 2x2 collage", handler: collageHandler },
  { name: "removebg", category: "IMAGE", desc: "Clean image background", handler: removebgHandler },
  { name: "upload", category: "TOOLS", desc: "Upload a replied file", handler: async (ctx) => uploadHandler(ctx, false) },
  { name: "uploadimg", category: "TOOLS", desc: "Upload a replied image", handler: async (ctx) => uploadHandler(ctx, true) },
  { name: "tourl", category: "TOOLS", desc: "Upload text → link", handler: tourlHandler },
  { name: "webinfo", category: "TOOLS", desc: "Inspect a URL", handler: webinfoHandler },
  { name: "wayback", category: "TOOLS", desc: "Wayback Machine lookup", handler: waybackHandler },
  { name: "archive", category: "TOOLS", desc: "Archive a page", handler: archiveHandler },
  { name: "ssweb", category: "TOOLS", desc: "Website screenshot", handler: async (ctx) => ctx.reply("🖥️ `.ssweb` needs a screenshot service/API key — not available in this build yet.") },
  { name: "web2pdf", category: "TOOLS", desc: "Webpage → PDF", handler: async (ctx) => ctx.reply("📄 `.web2pdf` needs a rendering service — not available in this build yet.") },
  { name: "mergepdf", category: "TOOLS", desc: "Merge PDFs", handler: async (ctx) => ctx.reply("📑 `.mergepdf` needs the pdf-lib dependency — not available in this build yet.") },
  { name: "splitpdf", category: "TOOLS", desc: "Split a PDF", handler: async (ctx) => ctx.reply("📑 `.splitpdf` needs the pdf-lib dependency — not available in this build yet.") },
  { name: "ocr", category: "TOOLS", desc: "Extract text from image", handler: async (ctx) => ctx.reply("🔍 `.ocr` needs tesseract (or an OCR API key) — not available in this build yet.") },
];
