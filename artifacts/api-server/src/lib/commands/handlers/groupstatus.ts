import type { Command } from "../types";
import { setConfig, getConfig } from "../../config";
import { getGroupMetadataCached, jidBase } from "../../group-meta";
import { logger } from "../../logger";

function toggle(name: string, aliases: string[] | undefined, label: string, keyPrefix: string): Command {
  return {
    name,
    aliases,
    category: "GROUPSTATUS",
    desc: `Toggle ${label}`,
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}${name} on/off*`);
      await setConfig(`${keyPrefix}:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(`${val === "on" ? "✅" : "🚫"} ${label} is now *${val.toUpperCase()}* for this group.`);
    },
  };
}

type StatusEntry = { id: string; status?: { status?: string | null; setAt?: Date } };

async function chunk<T>(arr: T[], size: number): Promise<T[][]> {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("USync query timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const groupStatusCommands: Command[] = [
  {
    name: "gst",
    aliases: ["groupstatus"],
    category: "GROUPSTATUS",
    desc: "Show every member's WhatsApp status in this group",
    groupOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata ?? (await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from));
      if (!meta) return ctx.reply("❌ Could not fetch group metadata. Try again in a moment.");

      const jids = meta.participants.map((p) => p.id).filter(Boolean);
      if (!jids.length) return ctx.reply("❌ No participants found in this group.");

      // Status entries are keyed by the bare number because Baileys 7 may echo
      // the result under the phone JID even when we queried with a LID (and vice
      // versa). Normalizing both sides makes the lookup LID/phone agnostic.
      const statusMap = new Map<string, string | null>();
      const batches = await chunk(jids, 40);
      for (const batch of batches) {
        try {
          const res = (await withTimeout(ctx.sock.fetchStatus(...batch), 8000)) as
            | StatusEntry[]
            | undefined;
          for (const entry of res ?? []) {
            const key = jidBase(entry.id);
            if (key) statusMap.set(key, entry.status?.status ?? null);
          }
        } catch (err) {
          logger.warn({ err, batch: batch.length }, "Group status batch failed");
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      const botNum = (ctx.sock.user?.id ?? "").split(":")[0].split("@")[0];
      const lines = [
        `╭─〔 *👥 Group Status* 〕`,
        `│ *${meta.subject || "Unknown"}*`,
        `│`,
      ];
      for (const p of meta.participants) {
        const num = jidBase(p.id);
        const status = statusMap.get(num);
        const name =
          p.notify ??
          (num === botNum ? ctx.config.botName : undefined) ??
          num;
        const badge = p.admin || p.isAdmin ? " 👑" : "";
        const line = status
          ? `│ • ${name}${badge}\n│   └ ${status}`
          : `│ • ${name}${badge}`;
        lines.push(line);
      }
      lines.push(`╰──────────────`);

      await ctx.sock.sendMessage(ctx.from, { text: lines.join("\n") }, { quoted: ctx.msg });
    },
  },
  toggle("welcome", undefined, "Welcome messages", "welcome"),
  toggle("goodbye", ["exit", "left"], "Goodbye messages", "goodbye"),
  toggle("antispam", undefined, "Anti-spam protection", "antispam"),
  {
    name: "setwelcome",
    category: "GROUPSTATUS",
    desc: "Set the welcome message",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) {
        return ctx.reply(
          `Usage: *${ctx.prefix}setwelcome <message>*\n\nPlaceholders:\n• *@user* — the new member\n• *@group* — the group name`,
        );
      }
      await setConfig(`welcometext:${ctx.from}`, ctx.text, ctx.tenantId);
      await setConfig(`welcome:${ctx.from}`, "true", ctx.tenantId);
      await ctx.reply(`✅ Welcome message saved and enabled.`);
    },
  },
  {
    name: "setgoodbye",
    aliases: ["setleft", "setexit"],
    category: "GROUPSTATUS",
    desc: "Set the goodbye message",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) {
        return ctx.reply(
          `Usage: *${ctx.prefix}setgoodbye <message>*\n\nPlaceholders:\n• *@user* — the leaving member\n• *@group* — the group name`,
        );
      }
      await setConfig(`goodbyetext:${ctx.from}`, ctx.text, ctx.tenantId);
      await setConfig(`goodbye:${ctx.from}`, "true", ctx.tenantId);
      await ctx.reply(`✅ Goodbye message saved and enabled.`);
    },
  },
];
