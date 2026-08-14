import type { Command } from "../types";
import { parseDuration, formatDuration } from "../duration-utils";
import { createScheduledTask, listPendingReminders, cancelReminder } from "../../scheduled-tasks-store";

export const reminderCommands: Command[] = [
  {
    name: "remind",
    aliases: ["reminder", "remindme"],
    category: "TOOLS",
    desc: "Set a reminder, e.g. remind 10m call mom",
    handler: async (ctx) => {
      const parts = ctx.text.trim().split(/\s+/);
      const durToken = parts.shift() ?? "";
      const ms = parseDuration(durToken);
      const body = parts.join(" ").trim();
      if (!ms || !body) return ctx.reply(`Usage: *${ctx.prefix}remind 10m <message>*\nTime units: s/m/h/d (e.g. 30s, 10m, 2h, 1h30m, 1d)`);
      const dueAt = new Date(Date.now() + ms);
      await createScheduledTask({ tenantId: ctx.tenantId, kind: "reminder", targetJid: ctx.from, body, dueAt });
      await ctx.reply(`⏰ Reminder set for *${formatDuration(ms)}* from now.`);
    },
  },
  {
    name: "reminders",
    aliases: ["listreminders"],
    category: "TOOLS",
    desc: "List your pending reminders here",
    handler: async (ctx) => {
      const rows = await listPendingReminders(ctx.tenantId, ctx.from);
      if (!rows.length) return ctx.reply("You have no pending reminders in this chat.");
      const lines = rows.map((r) => `• #${r.id} — ${new Date(r.dueAt).toLocaleString()}\n  ${r.body ?? ""}`);
      await ctx.reply(`⏰ *Pending reminders*\n\n${lines.join("\n")}\n\nCancel one with *${ctx.prefix}cancelreminder <id>*`);
    },
  },
  {
    name: "cancelreminder",
    aliases: ["delreminder"],
    category: "TOOLS",
    desc: "Cancel a reminder by id",
    handler: async (ctx) => {
      const id = Number(ctx.text.replace(/[^0-9]/g, ""));
      if (!id) return ctx.reply(`Usage: *${ctx.prefix}cancelreminder <id>* (see *${ctx.prefix}reminders*)`);
      const ok = await cancelReminder(ctx.tenantId, ctx.from, id);
      await ctx.reply(ok ? `✅ Reminder #${id} cancelled.` : `Reminder #${id} not found (or already sent).`);
    },
  },
];
