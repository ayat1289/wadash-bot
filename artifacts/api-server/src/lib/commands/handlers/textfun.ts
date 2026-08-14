import type { Command } from "../types";

// sPoNgEbOb mocking case — alternate upper/lower across letters only.
function mockCase(s: string): string {
  let i = 0;
  return [...s]
    .map((ch) => {
      if (!/[a-z]/i.test(ch)) return ch;
      const out = i % 2 === 0 ? ch.toLowerCase() : ch.toUpperCase();
      i++;
      return out;
    })
    .join("");
}

export const textFunCommands: Command[] = [
  {
    name: "mock",
    aliases: ["spongebob"],
    category: "TOOLS",
    desc: "sPoNgEbOb-style mocking text",
    handler: async (ctx) => {
      const t = ctx.text.trim() || ctx.quotedText || "";
      if (!t) return ctx.reply(`Usage: *${ctx.prefix}mock <text>* (or reply to a message)`);
      await ctx.reply(mockCase(t));
    },
  },
  {
    name: "reversetext",
    aliases: ["rev", "reverseword"],
    category: "TOOLS",
    desc: "Reverse your text",
    handler: async (ctx) => {
      const t = ctx.text.trim() || ctx.quotedText || "";
      if (!t) return ctx.reply(`Usage: *${ctx.prefix}reversetext <text>* (or reply to a message)`);
      await ctx.reply([...t].reverse().join(""));
    },
  },
];
