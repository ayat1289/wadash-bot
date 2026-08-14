import type { Command } from "../types";
import { setConfig, getConfig } from "../../config";
import { getGroupMetadataCached } from "../../group-meta";

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

      const statusMap = new Map<string, string | null>();
      const batches = await chunk(jids, 40);
      for (const batch of batches) {
        try {
          const res = (await ctx.sock.fetchStatus(...batch)) as StatusEntry[] | undefined;
          for (const entry of res ?? []) {
            statusMap.set(entry.id, entry.status?.status ?? null);
          }
        } catch {
          /* one batch may fail; keep the rest */
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
        const num = (p.id ?? "").split(":")[0].split("@")[0];
        const status = statusMap.get(p.id);
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
