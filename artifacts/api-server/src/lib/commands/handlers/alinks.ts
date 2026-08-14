import type { WAMessage } from "@whiskeysockets/baileys";
import type { Command, CommandContext } from "../types";
import { getConfig, setConfig } from "../../config";
import { logger } from "../../logger";

// ---------------------------------------------------------------------------
// Alinks — WhatsApp group-link forwarder (adapted from the "Alinks" plugin).
//
// The owner configures one or more target JIDs (a group, private chat, or
// status) plus an optional custom message. When the feature is ON and any
// incoming message contains a chat.whatsapp.com invite link, the bot resolves
// the group name + profile picture and forwards the link (with a nice preview
// card) to every configured target. Duplicate links are only sent once.
//
// Settings live in the per-tenant bot_config table (keys under `alinks:`).
// ---------------------------------------------------------------------------

const PREFIX = "alinks:";
const LINK_REGEX = /https?:\/\/chat\.whatsapp\.com\/[0-9A-Za-z]+/gi;

/** In-memory set of already-forwarded invite links (bounded to 500). */
const sentLinks = new Set<string>();

type AlinksSettings = {
  enabled: boolean;
  targetJids: string[];
  customMsg: string;
};

async function loadSettings(tenantId: number): Promise<AlinksSettings> {
  const [enabled, jids, msg] = await Promise.all([
    getConfig(`${PREFIX}enabled`, tenantId),
    getConfig(`${PREFIX}targets`, tenantId),
    getConfig(`${PREFIX}message`, tenantId),
  ]);
  return {
    enabled: enabled === "true",
    targetJids: jids ? jids.split(",").map((j) => j.trim()).filter(Boolean) : [],
    customMsg: msg,
  };
}

async function saveSettings(s: AlinksSettings, tenantId: number): Promise<void> {
  await Promise.all([
    setConfig(`${PREFIX}enabled`, String(s.enabled), tenantId),
    setConfig(`${PREFIX}targets`, s.targetJids.join(","), tenantId),
    setConfig(`${PREFIX}message`, s.customMsg, tenantId),
  ]);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Called from the message pipeline for every incoming (non-owner) message.
 * When alinks is enabled it extracts chat.whatsapp.com invite links from the
 * message and forwards each one to every configured target JID.
 */
export async function handleAlinksForward(
  sock: NonNullable<import("@whiskeysockets/baileys").WASocket>,
  tenantId: number,
  msg: WAMessage,
  body: string,
): Promise<void> {
  try {
    const settings = await loadSettings(tenantId);
    if (!settings.enabled || !settings.targetJids.length || !body) return;

    const matches = body.match(LINK_REGEX);
    if (!matches) return;

    await delay(1500);

    for (const link of matches) {
      if (sentLinks.has(link)) continue;
      const code = link.split("/").pop() ?? "";

      let meta: { subject: string; id: string } | null = null;
      let thumbBuffer: Buffer | null = null;
      try {
        meta = await sock.groupGetInviteInfo(code);
        try {
          const ppUrl = await sock.profilePictureUrl(meta.id, "image");
          if (ppUrl) {
            const res = await fetch(ppUrl);
            thumbBuffer = Buffer.from(await res.arrayBuffer());
          }
        } catch {
          /* no profile picture */
        }
      } catch {
        meta = null;
      }

      const groupName = meta?.subject ?? "WhatsApp Group";
      const header = settings.customMsg || "";
      for (const jid of settings.targetJids) {
        try {
          await sock.sendMessage(jid, {
            text: header ? `${header}\n${link}` : link,
            contextInfo: meta
              ? {
                  externalAdReply: {
                    title: groupName,
                    body: `Invite to join "${groupName}"`,
                    mediaType: 1,
                    renderLargerThumbnail: true,
                    thumbnail: thumbBuffer ?? undefined,
                    sourceUrl: link,
                  },
                }
              : undefined,
          });
        } catch (err) {
          logger.warn({ err, tenantId }, "Alinks forward failed");
          try {
            await sock.sendMessage(jid, { text: header ? `${header}\n${link}` : link });
          } catch (err2) {
            logger.warn({ err: err2, tenantId }, "Alinks plain fallback failed");
          }
        }
      }

      sentLinks.add(link);
      if (sentLinks.size > 500) sentLinks.clear();
    }
  } catch (err) {
    logger.warn({ err, tenantId }, "Alinks hook error");
  }
}

const USAGE = `*Alinks Control System*
› ${"`alinks on`"} — enable forwarding
› ${"`alinks off`"} — disable forwarding
› ${"`alinks check`"} — show current settings
› ${"`alinks add <jid>`"} — add a target chat/group JID
› ${"`alinks del <jid>`"} — remove a target JID
› ${"`alinks msg <text>`"} — set a custom message
› ${"`alinks clear`"} — clear targets and message`;

export const alinksCommands: Command[] = [
  {
    name: "add",
    category: "GROUP",
    desc: "Add a JID to alinks targets, or add a member to the group by number",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx: CommandContext) => {
      const input = ctx.text.trim();
      // A full JID (contains "@") → add to alinks target list (the plugin's
      // forwarding destinations). Digits-only → the original group add behavior
      // (invite a member into the current group by number).
      if (input.includes("@")) {
        const settings = await loadSettings(ctx.tenantId);
        if (!settings.targetJids.includes(input)) {
          settings.targetJids.push(input);
          await saveSettings(settings, ctx.tenantId);
        }
        return ctx.reply(`✅ *${input}* added to Alinks targets. (Targets: ${settings.targetJids.length})`);
      }
      const num = ctx.text.replace(/[^0-9]/g, "");
      if (!num) return ctx.reply(`Usage: *${ctx.prefix}add 234XXXXXXXXXX* or *${ctx.prefix}add <jid>@g.us*`);
      const jid = `${num}@s.whatsapp.net`;
      let status = "";
      try {
        const res = await ctx.sock.groupParticipantsUpdate(ctx.from, [jid], "add");
        status = String(res?.[0]?.status ?? "");
      } catch {
        return ctx.reply(`❌ Couldn't add +${num}.`);
      }
      if (status === "200") return ctx.reply(`✅ Added +${num} to the group.`);
      try {
        const code = await ctx.sock.groupInviteCode(ctx.from);
        const subject = ctx.groupMetadata?.subject ?? "the group";
        if (code) {
          await ctx.sock.sendMessage(jid, {
            text: `👋 You've been invited to join *${subject}*:\nhttps://chat.whatsapp.com/${code}`,
          });
          return ctx.reply(
            `⚠️ Couldn't add +${num} directly (their privacy settings block it). I sent them the group invite link instead.`,
          );
        }
      } catch {
        /* fall through to the generic failure reply */
      }
      return ctx.reply(
        `❌ Couldn't add +${num} (status ${status || "unknown"}). They may only allow joining via an invite link.`,
      );
    },
  },
  {
    name: "alinks",
    category: "TOOLS",
    desc: "Alinks — forward WhatsApp group invite links to target chats (owner)",
    ownerOnly: true,
    handler: async (ctx: CommandContext) => {
      const settings = await loadSettings(ctx.tenantId);
      const raw = ctx.text.trim();
      const [cmd, ...rest] = raw.split(/\s+/);
      const value = rest.join(" ").trim();
      const c = (cmd ?? "").toLowerCase();

      if (!c || c === "check") {
        const lines = [
          `*Status:* ${settings.enabled ? "ON" : "OFF"}`,
          "",
          `*Targets:*`,
          settings.targetJids.length ? settings.targetJids.map((j) => `› ${j}`).join("\n") : "No JIDs",
          "",
          `*Message:*`,
          settings.customMsg || "No Message",
        ];
        return ctx.reply(lines.join("\n"));
      }

      if (c === "on") {
        settings.enabled = true;
        await saveSettings(settings, ctx.tenantId);
        return ctx.reply("✅ Alinks *enabled*.");
      }

      if (c === "off") {
        settings.enabled = false;
        await saveSettings(settings, ctx.tenantId);
        return ctx.reply("❌ Alinks *disabled*.");
      }

      if (c === "add") {
        if (!value.includes("@")) return ctx.reply("❌ Invalid JID. Example: `alinks add 1234567890@g.us`");
        if (!settings.targetJids.includes(value)) {
          settings.targetJids.push(value);
          await saveSettings(settings, ctx.tenantId);
        }
        return ctx.reply("✅ Target added.");
      }

      if (c === "del" || c === "remove") {
        settings.targetJids = settings.targetJids.filter((j) => j !== value);
        await saveSettings(settings, ctx.tenantId);
        return ctx.reply("❌ Target removed.");
      }

      if (c === "msg") {
        settings.customMsg = value;
        await saveSettings(settings, ctx.tenantId);
        return ctx.reply("✅ Custom message updated.");
      }

      if (c === "clear") {
        settings.targetJids = [];
        settings.customMsg = "";
        await saveSettings(settings, ctx.tenantId);
        return ctx.reply("✅ Cleared.");
      }

      return ctx.reply(USAGE);
    },
  },
];
