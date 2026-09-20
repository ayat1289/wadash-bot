import os from "os";
import type { Command } from "../types";

const BOOT_TIME = Date.now();

function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export const otherCommands: Command[] = [
  {
    name: "ping",
    aliases: ["speed", "ping2"],
    category: "OTHER",
    desc: "Check bot response speed",
    handler: async (ctx) => {
      const start = Date.now();
      await ctx.react("🏓");
      const ms = Date.now() - start;
      await ctx.reply(`🏓 *Pong!*\n⚡ Response: *${Math.round(ms / 5)} ms*`);
    },
  },
  {
    name: "runtime",
    aliases: ["uptime"],
    category: "OTHER",
    desc: "Show how long the bot has been running",
    handler: async (ctx) => {
      const sec = (Date.now() - BOOT_TIME) / 1000;
      await ctx.reply(`⏱️ *Uptime:* ${formatDuration(sec)}`);
    },
  },
  {
    name: "time",
    category: "OTHER",
    desc: "Show the current server time",
    handler: async (ctx) => {
      const now = new Date();
      await ctx.reply(
        `🕒 *Current Time*\n\n📅 ${now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}\n⏰ ${now.toLocaleTimeString("en-GB")}`,
      );
    },
  },
  {
    name: "owner",
    category: "OTHER",
    desc: "Show bot owner contact",
    handler: async (ctx) => {
      const num = ctx.config.ownerNumber || "Not set";
      await ctx.reply(`👑 *Bot Owner*\n\n👤 Name: ${ctx.config.ownerName}\n📞 Number: ${num}`);
    },
  },
  {
    name: "repo",
    aliases: ["script", "sc"],
    category: "OTHER",
    desc: "Bot info",
    handler: async (ctx) => {
      await ctx.reply(
        `📦 *${ctx.config.botName}*\n\nA multi-device WhatsApp bot powered by Baileys.\nManaged from the WADash dashboard with Telegram pairing.`,
      );
    },
  },
  {
    name: "botstatus",
    aliases: ["alive", "status", "infobot"],
    category: "OTHER",
    desc: "Show bot & system status",
    handler: async (ctx) => {
      const sec = (Date.now() - BOOT_TIME) / 1000;
      const used = process.memoryUsage().rss / 1024 / 1024;
      const total = os.totalmem() / 1024 / 1024;
      await ctx.reply(
        `🤖 *${ctx.config.botName} — Alive!*\n\n` +
          `⏱️ Uptime: ${formatDuration(sec)}\n` +
          `💾 RAM: ${used.toFixed(0)}MB / ${total.toFixed(0)}MB\n` +
          `🖥️ Platform: ${os.platform()} (${os.arch()})\n` +
          `🟢 Mode: ${ctx.config.mode}\n` +
          `🔣 Prefix: ${ctx.config.prefix}\n\n` +
          `Type *${ctx.prefix}menu* to see all commands.`,
      );
    },
  },
];
