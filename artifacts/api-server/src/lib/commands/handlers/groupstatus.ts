import type { Command } from "../types";
import { setConfig } from "../../config";
import { logger } from "../../logger";
import {
  generateWAMessageFromContent,
  type proto,
} from "@whiskeysockets/baileys";

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
    desc: "Update group status",
    handler: async (ctx) => {
      const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
      const quoted = ci?.quotedMessage;
      if (!quoted) {
        await ctx.reply("Reply to a message with *" + ctx.prefix + "gst*");
        return;
      }

      // Identify what was replied to: image, video, or text.
      let kind: "image" | "video" | "text" | null = null;
      if (quoted.imageMessage) kind = "image";
      else if (quoted.videoMessage) kind = "video";
      else if (quoted.conversation || quoted.extendedTextMessage?.text) kind = "text";

      if (!kind) {
        await ctx.reply("Reply to a message with *" + ctx.prefix + "gst*");
        return;
      }

      const caption =
        kind === "image"
          ? quoted.imageMessage?.caption ?? ""
          : kind === "video"
            ? quoted.videoMessage?.caption ?? ""
            : undefined;
      const quotedText = quoted.conversation || quoted.extendedTextMessage?.text || "";

      // Build the story/status content.
      //
      // Text: a simple conversation text.
      //
      // Image / video: FORWARD the original media as-is instead of
      // downloading + re-encrypting it. Re-uploading via
      // `generateWAMessageContent` produces a fresh encryption that WhatsApp's
      // media server silently rejects for a *group status*, so the whole update
      // shows "Updated N" but never appears. Reusing the original message's
      // valid `directPath`/`mediaKey`/hashes/thumbnail guarantees the media is
      // real and decryptable by the recipients.
      const baseMedia =
        kind === "image"
          ? (quoted.imageMessage ?? {})
          : kind === "video"
            ? (quoted.videoMessage ?? {})
            : null;

      const inner: proto.Message =
        kind === "text"
          ? ({ conversation: quotedText } as proto.Message)
          : ({
              [kind === "image" ? "imageMessage" : "videoMessage"]: {
                ...baseMedia,
                caption,
                gifPlayback: false,
                contextInfo: { isGroupStatus: true },
              },
            } as unknown as proto.Message);

      if (kind === "video") {
        const vm = inner["videoMessage"] as Record<string, unknown>;
        logger.info(
          {
            seconds: vm.seconds,
            width: vm.width,
            height: vm.height,
            mimetype: vm.mimetype,
            hasThumbnail: Boolean(vm.jpegThumbnail),
            directPath: Boolean(vm.directPath),
            hasMediaKey: Boolean(vm.mediaKey),
          },
          "gst: video status prepared (forwarded)",
        );
      }

      const groups = Object.values(await ctx.sock.groupFetchAllParticipating());
      let updated = 0;

      for (const g of groups) {
        try {
          const gid = g.id;
          if (!gid) continue;

          // Route every kind through the SAME group-jid mechanism that already
          // works for text: `groupStatusMessageV2` relayed straight to the
          // group. This renders a status card visible to all participants in
          // the group chat (no reliance on story/Status-tab delivery rules).
          const wrapped = { groupStatusMessageV2: { message: inner } };
          const fullMsg = generateWAMessageFromContent(gid, wrapped, {
            timestamp: new Date(),
            userJid: ctx.sock.user?.id,
          });
          await ctx.sock.relayMessage(gid, fullMsg.message, { messageId: fullMsg.key.id });
          logger.info(
            { group: gid, kind, messageId: fullMsg.key.id },
            "gst: relayed status",
          );
          updated++;
        } catch (error) {
          logger.warn({ err: error, group: g.id }, "gst: group status send failed");
        }
      }

      await ctx.reply(`Updated *${updated}*`);
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
