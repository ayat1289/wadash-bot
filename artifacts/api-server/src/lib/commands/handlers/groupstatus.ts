import type { Command } from "../types";
import { setConfig, getConfig } from "../../config";

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

export const groupStatusCommands: Command[] = [
  {
    name: "gst",
    aliases: ["groupstatus"],
    category: "GROUPSTATUS",
    desc: "Set/show the group's custom status text",
    groupOnly: true,
    handler: async (ctx) => {
      const key = `gst:${ctx.from}`;
      const current = await getConfig(key, ctx.tenantId);
      const val = ctx.text.trim();

      if (!val) {
        const lines = [
          `╭─〔 *📊 Group Status* 〕`,
          `│`,
          current
            ? `│ *Current status*:\n│ ${current}`
            : `│ No status set for this group yet.`,
          `│`,
          `│ *Usage:*`,
          `│ ${ctx.prefix}gst <text>` + " — set this group's status",
          `│ ${ctx.prefix}gst off` + " — clear the status",
          `╰──────────────`,
        ];
        return ctx.reply(lines.join("\n"));
      }

      if (val.toLowerCase() === "off" || val.toLowerCase() === "del" || val.toLowerCase() === "clear") {
        if (!current) return ctx.reply("ℹ️ No status was set for this group.");
        await setConfig(key, "", ctx.tenantId);
        return ctx.reply("🗑️ Group status cleared.");
      }

      if (val.length > 500) return ctx.reply("❌ Status too long (max 500 characters).");
      await setConfig(key, val, ctx.tenantId);
      await ctx.reply(`✅ Group status set:\n\n> ${val}`);
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
