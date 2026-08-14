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

async function isOn(ctx: { from: string; tenantId: number }, keyPrefix: string): Promise<boolean> {
  const v = await getConfig(`${keyPrefix}:${ctx.from}`, ctx.tenantId);
  return v === "true" || v === "on" || v === "1";
}

function statusLine(label: string, on: boolean): string {
  return `${on ? "✅" : "⬜"} ${label}`;
}

export const groupStatusCommands: Command[] = [
  {
    name: "gst",
    aliases: ["groupstatus"],
    category: "GROUPSTATUS",
    desc: "Show this group's status (info + toggles)",
    groupOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata ?? (await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from));
      if (!meta) return ctx.reply("❌ Could not fetch group metadata. Try again in a moment.");

      const ownerNum = (meta.owner ?? "").split(":")[0].split("@")[0];
      const admins = meta.participants.filter((p) => p.admin || p.isAdmin);
      const botP = meta.participants.find((p) => {
        const base = (p.id ?? "").split(":")[0].split("@")[0];
        return base === ctx.sock.user?.id?.split(":")[0].split("@")[0];
      });

      const [welcome, goodbye, antispam, slowmode, lockdown, readonly, verify, antiflood] =
        await Promise.all([
          isOn(ctx, "welcome"),
          isOn(ctx, "goodbye"),
          isOn(ctx, "antispam"),
          isOn(ctx, "slowmode"),
          isOn(ctx, "lockdown"),
          isOn(ctx, "readonly"),
          isOn(ctx, "verify"),
          isOn(ctx, "antiflood"),
        ]);

      const lines = [
        `╭─〔 *📊 Group Status* 〕`,
        `│`,
        `│ ✦ *Name*: ${meta.subject || "—"}`,
        `│ ✦ *ID*: ${meta.id}`,
        `│ ✦ *Owner*: ${ownerNum ? `@${ownerNum}` : "—"}`,
        `│ ✦ *Members*: ${meta.participants.length}${meta.size ? ` (${meta.size})` : ""}`,
        `│ ✦ *Admins*: ${admins.length}`,
        `│ ✦ *Bot role*: ${botP?.admin || botP?.isAdmin ? "Admin" : "Member"}`,
        `│ ✦ *Description*: ${meta.desc ? meta.desc.slice(0, 100) : "—"}`,
        `│`,
        `│ *— Protection —*`,
        statusLine("Welcome messages", welcome),
        statusLine("Goodbye messages", goodbye),
        statusLine("Anti-spam", antispam),
        statusLine("Slow mode", slowmode),
        statusLine("Lockdown", lockdown),
        statusLine("Read-only", readonly),
        statusLine("Verification", verify),
        statusLine("Anti-flood", antiflood),
        `╰──────────────`,
      ];

      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: lines.join("\n"),
          mentions: ownerNum ? [`${ownerNum}@s.whatsapp.net`] : undefined,
        },
        { quoted: ctx.msg },
      );
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
