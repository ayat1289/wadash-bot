import type { Command, CommandContext } from "../types";

async function translateText(text: string, target: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`translate failed: ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("bad response");
  return (data[0] as unknown[])
    .map((seg) => (Array.isArray(seg) ? String(seg[0] ?? "") : ""))
    .join("");
}

function getSourceText(ctx: CommandContext, stripFirst: boolean): string {
  const quoted = ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedText =
    quoted?.conversation || quoted?.extendedTextMessage?.text || quoted?.imageMessage?.caption || "";
  if (quotedText) return quotedText;
  if (stripFirst) return ctx.args.slice(1).join(" ");
  return ctx.text;
}

function shortcut(name: string, lang: string, label: string): Command {
  return {
    name,
    category: "TRANSLATE",
    desc: `Translate to ${label}`,
    handler: async (ctx) => {
      const src = getSourceText(ctx, false);
      if (!src) return ctx.reply(`Usage: *${ctx.prefix}${name} <text>* or reply to a message`);
      try {
        await ctx.reply(`🌐 *${label}*\n${await translateText(src, lang)}`);
      } catch {
        await ctx.reply("❌ Translation failed. Try again later.");
      }
    },
  };
}

export const translateCommands: Command[] = [
  {
    name: "translate",
    aliases: ["tr", "trt"],
    category: "TRANSLATE",
    desc: "Translate text to a language",
    handler: async (ctx) => {
      const lang = (ctx.args[0] || "en").toLowerCase();
      const src = getSourceText(ctx, true);
      if (!src) {
        return ctx.reply(`Usage: *${ctx.prefix}translate <lang> <text>*\nExample: *${ctx.prefix}translate es hello*\nOr reply to a message with *${ctx.prefix}translate <lang>*`);
      }
      try {
        await ctx.reply(`🌐 *Translation (${lang})*\n${await translateText(src, lang)}`);
      } catch {
        await ctx.reply("❌ Translation failed. Check the language code and try again.");
      }
    },
  },
  shortcut("toen", "en", "English"),
  shortcut("toes", "es", "Spanish"),
  shortcut("tofr", "fr", "French"),
  shortcut("toar", "ar", "Arabic"),
  shortcut("tohi", "hi", "Hindi"),
];
