import QRCode from "qrcode";
import jsQR from "jsqr";
import sharp from "sharp";
import type { Command } from "../types";
import { downloadMedia, hasMedia } from "../media-utils";
import { fancyAll, flipText, toMorse, toBinary, genPassword } from "../text-utils";

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}

/** Build a 512x512 SVG with the text wrapped and centered, for sticker output. */
function textStickerSvg(raw: string): string {
  const text = raw.slice(0, 120);
  const words = text.split(/\s+/).filter(Boolean);
  const maxPerLine = 12;
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length > maxPerLine && current) {
      lines.push(current.trim());
      current = w;
    } else {
      current = (current + " " + w).trim();
    }
  }
  if (current) lines.push(current.trim());
  const safeLines = lines.slice(0, 6);
  const fontSize = Math.max(40, Math.min(120, 360 / Math.max(...safeLines.map((l) => l.length), 1)));
  const lineHeight = fontSize * 1.2;
  const totalHeight = lineHeight * safeLines.length;
  const startY = 256 - totalHeight / 2 + fontSize;
  const tspans = safeLines
    .map((l, i) => `<text x="256" y="${startY + i * lineHeight}" text-anchor="middle">${escapeXml(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <style>text{font-family:'DejaVu Sans',sans-serif;font-weight:bold;font-size:${fontSize}px;fill:#fff;stroke:#000;stroke-width:${Math.max(2, fontSize / 12)}px;paint-order:stroke;}</style>
    ${tspans}
  </svg>`;
}

function safeEval(expr: string): string {
  if (!/^[0-9+\-*/().%\s]+$/.test(expr)) return "Invalid expression. Only numbers and + - * / % ( ) are allowed.";
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr})`)();
    if (typeof result !== "number" || !Number.isFinite(result)) return "Invalid expression.";
    return String(result);
  } catch {
    return "Invalid expression.";
  }
}

export const toolsCommands: Command[] = [
  {
    name: "sticker",
    aliases: ["s", "stick"],
    category: "TOOLS",
    desc: "Convert image to sticker",
    handler: async (ctx) => {
      if (!hasMedia(ctx, "image")) {
        return ctx.reply(`🖼️ Send or reply to an *image* with *${ctx.prefix}sticker*`);
      }
      await ctx.react("⏳");
      const buf = await downloadMedia(ctx, "image");
      if (!buf) return ctx.reply("❌ Failed to download the image.");
      const webp = await sharp(buf)
        .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();
      await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
      await ctx.react("✅");
    },
  },
  {
    name: "toimg",
    aliases: ["toimage"],
    category: "TOOLS",
    desc: "Convert sticker to image",
    handler: async (ctx) => {
      if (!hasMedia(ctx, "sticker")) {
        return ctx.reply(`🖼️ Reply to a *sticker* with *${ctx.prefix}toimg*`);
      }
      await ctx.react("⏳");
      const buf = await downloadMedia(ctx, "sticker");
      if (!buf) return ctx.reply("❌ Failed to download the sticker.");
      const png = await sharp(buf).png().toBuffer();
      await ctx.sock.sendMessage(ctx.from, { image: png, caption: "✅ Converted to image" }, { quoted: ctx.msg });
      await ctx.react("✅");
    },
  },
  {
    name: "qrcode",
    aliases: ["qr"],
    category: "TOOLS",
    desc: "Generate a QR code",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}qrcode <text or url>*`);
      const png = await QRCode.toBuffer(ctx.text, { width: 512, margin: 2 });
      await ctx.sock.sendMessage(ctx.from, { image: png, caption: "✅ Here is your QR code" }, { quoted: ctx.msg });
    },
  },
  {
    name: "calculate",
    aliases: ["calc", "math2"],
    category: "TOOLS",
    desc: "Calculate an expression",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}calc 5 * (3 + 2)*`);
      await ctx.reply(`🧮 ${ctx.text} = *${safeEval(ctx.text)}*`);
    },
  },
  {
    name: "fancy",
    aliases: ["fancytext", "styletext"],
    category: "TOOLS",
    desc: "Convert text to fancy fonts",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}fancy your name*`);
      await ctx.reply(fancyAll(ctx.text));
    },
  },
  {
    name: "fliptext",
    aliases: ["flip"],
    category: "TOOLS",
    desc: "Flip text upside down",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}fliptext your text*`);
      await ctx.reply(`🙃 ${flipText(ctx.text)}`);
    },
  },
  {
    name: "genpass",
    aliases: ["password", "pass"],
    category: "TOOLS",
    desc: "Generate a strong password",
    handler: async (ctx) => {
      const len = Math.min(Math.max(parseInt(ctx.text, 10) || 12, 6), 64);
      await ctx.reply(`🔐 *Generated Password (${len} chars)*\n\n\`${genPassword(len)}\``);
    },
  },
  {
    name: "tinyurl",
    aliases: ["shorturl", "short"],
    category: "TOOLS",
    desc: "Shorten a URL",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}tinyurl <url>*`);
      try {
        const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ctx.text.trim())}`);
        const short = await res.text();
        if (!short.startsWith("http")) throw new Error("bad");
        await ctx.reply(`🔗 *Shortened URL*\n${short}`);
      } catch {
        await ctx.reply("❌ Could not shorten that URL. Check the link and try again.");
      }
    },
  },
  {
    name: "base64",
    aliases: ["b64", "encode"],
    category: "TOOLS",
    desc: "Encode text to base64",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}base64 your text*`);
      await ctx.reply(`🔡 ${Buffer.from(ctx.text, "utf-8").toString("base64")}`);
    },
  },
  {
    name: "unbase64",
    aliases: ["decode", "atob"],
    category: "TOOLS",
    desc: "Decode base64 text",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}unbase64 <base64>*`);
      try {
        await ctx.reply(`🔡 ${Buffer.from(ctx.text.trim(), "base64").toString("utf-8")}`);
      } catch {
        await ctx.reply("❌ Invalid base64 string.");
      }
    },
  },
  {
    name: "binary",
    category: "TOOLS",
    desc: "Convert text to binary",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}binary your text*`);
      await ctx.reply(`💻 ${toBinary(ctx.text)}`);
    },
  },
  {
    name: "morse",
    category: "TOOLS",
    desc: "Convert text to morse code",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}morse your text*`);
      await ctx.reply(`📡 ${toMorse(ctx.text)}`);
    },
  },
  {
    name: "attp",
    aliases: ["ttp"],
    category: "TOOLS",
    desc: "Turn text into a sticker",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}attp your text*`);
      await ctx.react("⏳");
      const webp = await sharp(Buffer.from(textStickerSvg(ctx.text)))
        .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 90 })
        .toBuffer();
      await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
      await ctx.react("✅");
    },
  },
  {
    name: "readqr",
    aliases: ["scanqr", "qrread"],
    category: "TOOLS",
    desc: "Read a QR code from an image",
    handler: async (ctx) => {
      if (!hasMedia(ctx, "image")) {
        return ctx.reply(`🔍 Reply to an *image* of a QR code with *${ctx.prefix}readqr*`);
      }
      await ctx.react("⏳");
      const buf = await downloadMedia(ctx, "image");
      if (!buf) return ctx.reply("❌ Failed to download the image.");
      const { data, info } = await sharp(buf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const code = jsQR(
        new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
        info.width,
        info.height,
      );
      if (!code?.data) {
        await ctx.react("❌");
        return ctx.reply("❌ No QR code found in that image.");
      }
      await ctx.react("✅");
      await ctx.reply(`🔍 *QR Content*\n\n${code.data}`);
    },
  },
  {
    name: "poll",
    aliases: ["vote"],
    category: "TOOLS",
    desc: "Create a poll: question | option 1 | option 2",
    handler: async (ctx) => {
      const parts = ctx.text
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length < 3) {
        return ctx.reply(
          `Usage: *${ctx.prefix}poll Question | option 1 | option 2*\n(2–12 options, separated by *|*)`,
        );
      }
      const [name, ...values] = parts;
      await ctx.sock.sendMessage(
        ctx.from,
        { poll: { name, values: values.slice(0, 12), selectableCount: 1 } },
        { quoted: ctx.msg },
      );
    },
  },
];
