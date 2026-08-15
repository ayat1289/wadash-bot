import type { Command } from "../types";
import { setConfig, getConfig } from "../../config";
import { getGroupMetadataCached } from "../../group-meta";
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

export const groupStatusCommands: Command[] = [
  {
    name: "gst",
    aliases: ["groupstatus"],
    category: "GROUPSTATUS",
    desc: "Post a WhatsApp group invite to your status",
    handler: async (ctx) => {
      const link = ctx.args[0];

      if (!link || !link.includes("chat.whatsapp.com/")) {
        return ctx.reply(`❌ Usage:\n${ctx.prefix}gst https://chat.whatsapp.com/XXXXXXXX`);
      }

      try {
        const code = link.split("chat.whatsapp.com/")[1].split(/[?\s]/)[0];

        // Resolve the real group from the invite code so `jid`/`subject` match
        // the group the code belongs to. Baileys 7 maps `text` -> caption,
        // `jid` -> groupJid and `subject` -> groupName on the wire; it also
        // fetches the profile picture from `jid` internally, so the resolved
        // JID keeps the send from throwing and matches what WhatsApp expects.
        let meta = ctx.groupMetadata ?? null;
        try {
          meta = await ctx.sock.groupGetInviteInfo(code);
        } catch (err) {
          logger.warn({ err }, "gst: invite info lookup failed, falling back to current group");
          if (!meta && ctx.from.endsWith("@g.us")) {
            meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
          }
        }

        const jid = meta?.id ?? (ctx.from.endsWith("@g.us") ? ctx.from : "");

        logger.info(
          {
            code,
            groupJid: jid,
            groupSubject: meta?.subject ?? "Join Our Group",
            from: ctx.from,
          },
          "gst: posting group invite to status",
        );

        await ctx.sock.sendMessage("status@broadcast", {
          groupInvite: {
            inviteCode: code,
            inviteExpiration: Math.floor(Date.now() / 1000) + 86400,
            text: "💗 JOIN ACTIVE PEEPS 💀\n\n• PRO CHATTING ZONE •\n\n💀 SHARE GROUP LINK 💗",
            jid,
            subject: meta?.subject ?? "Join Our Group",
          },
        });

        await ctx.reply("✅ Group invite added to WhatsApp Status.");
      } catch (error) {
        logger.error({ err: error }, "gst: failed to post group status");
        await ctx.reply("❌ Failed to add group status.");
      }
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
