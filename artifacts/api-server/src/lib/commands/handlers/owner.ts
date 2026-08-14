import type { Command, CommandContext } from "../types";
import {
  setConfig,
  getSudoNumbers,
  addSudoNumber,
  removeSudoNumber,
} from "../../config";
import { jidBase, findParticipant } from "../../group-meta";
import { restartConnection, blockOnAllSessions } from "../../whatsapp";
import { LEGACY_TENANT_ID } from "@workspace/db";

function targetJid(ctx: CommandContext): string | null {
  const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  if (mentioned.length) return mentioned[0];
  const quoted = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (quoted) return quoted;
  const num = ctx.text.replace(/[^0-9]/g, "");
  if (num) return `${num}@s.whatsapp.net`;
  return null;
}

/**
 * Resolve a target phone number (digits only, matching `jidBase(sender)`) for
 * the sudo command. Prefers an @mention, then a replied-to user, then digits
 * typed in `rest` (the text after the `add`/`del` subcommand).
 */
function resolveSudoNumber(ctx: CommandContext, rest: string): string | null {
  const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  if (mentioned.length) return jidBase(mentioned[0]);
  const quoted = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (quoted) return jidBase(quoted);
  const digits = rest.replace(/[^0-9]/g, "");
  return digits || null;
}

/**
 * Fleet-wide actions (`.report`/`.unreport` block a number on EVERY linked
 * WhatsApp) must NOT be available to every tenant owner — `ownerOnly` is a
 * PER-TENANT gate, so that would let one tenant mutate other tenants'
 * blocklists. They are limited to the bot's GLOBAL operator: the owner of the
 * primary (legacy) tenant, plus any number listed in the optional
 * `GLOBAL_OWNER_NUMBERS` env (comma-separated digits).
 */
function isGlobalOwner(ctx: CommandContext): boolean {
  if (ctx.tenantId === LEGACY_TENANT_ID) return true;
  const allow = (process.env.GLOBAL_OWNER_NUMBERS ?? "")
    .split(",")
    .map((s) => s.replace(/[^0-9]/g, ""))
    .filter(Boolean);
  return allow.length > 0 && allow.includes(jidBase(ctx.senderNumber));
}

/**
 * Resolve a report target to a phone-number JID when possible. A phone JID
 * (`<digits>@s.whatsapp.net`) is portable across every linked session; an
 * `@lid` (common from a group reply) is per-account and usually won't block on
 * other sessions, so we first try to map it to a phone via group metadata.
 */
function resolveReportTarget(ctx: CommandContext): { jid: string; portable: boolean } | null {
  const raw = targetJid(ctx);
  if (!raw) return null;
  if (raw.endsWith("@s.whatsapp.net")) return { jid: raw, portable: true };
  if (raw.endsWith("@lid")) {
    const p = ctx.groupMetadata ? findParticipant(ctx.groupMetadata.participants, raw) : undefined;
    if (p) {
      const alt = p as unknown as Record<string, unknown>;
      for (const field of ["jid", "phoneNumber", "pn"]) {
        const v = alt[field];
        if (typeof v === "string") {
          const digits = jidBase(v);
          if (/^[0-9]{5,}$/.test(digits)) return { jid: `${digits}@s.whatsapp.net`, portable: true };
        }
      }
    }
    return { jid: raw, portable: false };
  }
  return { jid: raw, portable: false };
}

export const ownerCommands: Command[] = [
  {
    name: "block",
    category: "OWNER",
    desc: "Block a user",
    ownerOnly: true,
    handler: async (ctx) => {
      const jid = targetJid(ctx);
      if (!jid) return ctx.reply(`Usage: *${ctx.prefix}block @user* or reply`);
      await ctx.sock.updateBlockStatus(jid, "block");
      await ctx.reply("🚫 User blocked.");
    },
  },
  {
    name: "unblock",
    category: "OWNER",
    desc: "Unblock a user",
    ownerOnly: true,
    handler: async (ctx) => {
      const jid = targetJid(ctx);
      if (!jid) return ctx.reply(`Usage: *${ctx.prefix}unblock @user* or number`);
      await ctx.sock.updateBlockStatus(jid, "unblock");
      await ctx.reply("✅ User unblocked.");
    },
  },
  {
    name: "report",
    aliases: ["reportscam", "reportscammer", "scammer", "blockscammer"],
    category: "OWNER",
    desc: "Report a scammer — block them on EVERY number linked to the bot",
    ownerOnly: true,
    handler: async (ctx) => {
      const target = resolveReportTarget(ctx);
      if (!target) {
        return ctx.reply(
          `🚨 Reply to the scammer's message (or @tag them / type their number) with *${ctx.prefix}report*.`,
        );
      }
      // Only ever report a real person, never a group / broadcast / status jid.
      if (!target.jid.endsWith("@s.whatsapp.net") && !target.jid.endsWith("@lid")) {
        return ctx.reply("❌ I can only report a person, not a group.");
      }
      const num = jidBase(target.jid);

      // Fleet-wide blocking is reserved for the global operator (see
      // isGlobalOwner). Other tenant owners may only block on their own number.
      if (!isGlobalOwner(ctx)) {
        await ctx.sock.updateBlockStatus(target.jid, "block");
        return ctx.reply(`🚫 Reported & blocked *+${num}* on your number.`);
      }

      // Fleet-wide blocking needs a portable phone JID — an unresolved `@lid`
      // can't be blocked on other sessions, so don't claim a fleet-wide success
      // for it. Block on this session and ask for the phone number instead.
      if (!target.portable) {
        await ctx.sock.updateBlockStatus(target.jid, "block");
        return ctx.reply(
          `🚫 Blocked on your number only — I couldn't work out that user's phone number.\n` +
            `To block them on *every* linked number, reply to their DM or run *${ctx.prefix}report <number>*.`,
        );
      }

      await ctx.reply(`🚨 Reporting *+${num}* as a scammer and blocking on every linked number...`);
      const { total, ok } = await blockOnAllSessions(target.jid, "block");
      await ctx.reply(
        `✅ Reported & blocked *+${num}* on *${ok}/${total}* linked number(s).\n\n` +
          `_WhatsApp doesn't let bots file an official spam report, so the bot blocks the scammer everywhere instead._\n` +
          `Undo with *${ctx.prefix}unreport* (reply / @tag / number).`,
      );
    },
  },
  {
    name: "unreport",
    aliases: ["unblockall", "unreportscam"],
    category: "OWNER",
    desc: "Reverse a scammer report — unblock them on every linked number",
    ownerOnly: true,
    handler: async (ctx) => {
      const target = resolveReportTarget(ctx);
      if (!target) {
        return ctx.reply(
          `Reply to the message (or @tag them / type their number) with *${ctx.prefix}unreport*.`,
        );
      }
      if (!target.jid.endsWith("@s.whatsapp.net") && !target.jid.endsWith("@lid")) {
        return ctx.reply("❌ I can only unblock a person, not a group.");
      }
      const num = jidBase(target.jid);

      if (!isGlobalOwner(ctx)) {
        await ctx.sock.updateBlockStatus(target.jid, "unblock");
        return ctx.reply(`✅ Unblocked *+${num}* on your number.`);
      }

      if (!target.portable) {
        await ctx.sock.updateBlockStatus(target.jid, "unblock");
        return ctx.reply(
          `✅ Unblocked *+${num}* on your number only — I couldn't work out their phone number.\n` +
            `To unblock on *every* linked number, reply to their DM or run *${ctx.prefix}unreport <number>*.`,
        );
      }

      const { total, ok } = await blockOnAllSessions(target.jid, "unblock");
      await ctx.reply(`✅ Unblocked *+${num}* on *${ok}/${total}* linked number(s).`);
    },
  },
  {
    name: "join",
    category: "OWNER",
    desc: "Join a group via invite link",
    ownerOnly: true,
    handler: async (ctx) => {
      const match = ctx.text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]+)/);
      const code = match?.[1] ?? ctx.text.trim();
      if (!code) return ctx.reply(`Usage: *${ctx.prefix}join <invite link>*`);
      try {
        await ctx.sock.groupAcceptInvite(code);
        await ctx.reply("✅ Joined the group.");
      } catch {
        await ctx.reply("❌ Could not join. The link may be invalid or expired.");
      }
    },
  },
  {
    name: "setbio",
    category: "OWNER",
    desc: "Set bot's about/status",
    ownerOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}setbio <text>*`);
      await ctx.sock.updateProfileStatus(ctx.text);
      await ctx.reply("✅ Bio updated.");
    },
  },
  {
    name: "setname2",
    aliases: ["setbotprofile"],
    category: "OWNER",
    desc: "Set bot's profile name",
    ownerOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}setname2 <name>*`);
      await ctx.sock.updateProfileName(ctx.text);
      await ctx.reply("✅ Profile name updated.");
    },
  },
  {
    name: "getpp",
    aliases: ["profilepic"],
    category: "OWNER",
    desc: "Get a user's profile picture",
    handler: async (ctx) => {
      const jid = targetJid(ctx) ?? ctx.sender;
      try {
        const url = await ctx.sock.profilePictureUrl(jid, "image");
        if (!url) return ctx.reply("❌ No profile picture available.");
        await ctx.sock.sendMessage(ctx.from, { image: { url }, caption: "🖼️ Profile picture" }, { quoted: ctx.msg });
      } catch {
        await ctx.reply("❌ No profile picture available.");
      }
    },
  },
  {
    name: "public",
    category: "OWNER",
    desc: "Set bot to public mode",
    ownerOnly: true,
    handler: async (ctx) => {
      await setConfig("mode", "public", ctx.tenantId);
      await ctx.reply("🌐 Bot is now *public* — everyone can use commands.");
    },
  },
  {
    name: "self",
    aliases: ["private"],
    category: "OWNER",
    desc: "Set bot to private mode",
    ownerOnly: true,
    handler: async (ctx) => {
      await setConfig("mode", "private", ctx.tenantId);
      await ctx.reply(
        "🔒 Bot is now *private* — only the owner and sudo users can use commands.\n\n" +
          `Add someone with *${ctx.prefix}sudo add <number>*.`,
      );
    },
  },
  {
    name: "sudo",
    aliases: ["allow"],
    category: "OWNER",
    desc: "Manage sudo users (can use the bot while it's private)",
    ownerOnly: true,
    handler: async (ctx) => {
      const trimmed = ctx.text.trim();
      const [subRaw, ...restParts] = trimmed.split(/\s+/);
      const sub = (subRaw ?? "").toLowerCase();
      const rest = restParts.join(" ");
      const usage =
        `👮 *Sudo users* can use the bot even when it's *private*.\n\n` +
        `• *${ctx.prefix}sudo add <number>* — also works by replying or @tagging\n` +
        `• *${ctx.prefix}sudo del <number>* — remove a sudo user\n` +
        `• *${ctx.prefix}sudo list* — show all sudo users`;

      if (sub === "list") {
        const list = await getSudoNumbers(ctx.tenantId);
        if (!list.length) return ctx.reply(`👮 No sudo users yet.\n\n${usage}`);
        const lines = list.map((n, i) => `${i + 1}. +${n}`).join("\n");
        return ctx.reply(`👮 *Sudo users* (${list.length}):\n${lines}`);
      }

      if (sub === "add") {
        const num = resolveSudoNumber(ctx, rest);
        if (!num) return ctx.reply(`Usage: *${ctx.prefix}sudo add <number>* (or reply / @tag a user).`);
        const added = await addSudoNumber(num, ctx.tenantId);
        return ctx.reply(
          added ? `✅ Added *+${num}* to sudo users.` : `ℹ️ *+${num}* is already a sudo user.`,
        );
      }

      if (sub === "del" || sub === "delete" || sub === "remove" || sub === "rm") {
        const num = resolveSudoNumber(ctx, rest);
        if (!num) return ctx.reply(`Usage: *${ctx.prefix}sudo del <number>* (or reply / @tag a user).`);
        const removed = await removeSudoNumber(num, ctx.tenantId);
        return ctx.reply(
          removed ? `✅ Removed *+${num}* from sudo users.` : `ℹ️ *+${num}* was not a sudo user.`,
        );
      }

      return ctx.reply(usage);
    },
  },
  {
    name: "broadcast",
    aliases: ["bc"],
    category: "OWNER",
    desc: "Broadcast a message to all groups",
    ownerOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}broadcast <message>*`);
      const groups = await ctx.sock.groupFetchAllParticipating();
      const ids = Object.keys(groups);
      let sent = 0;
      for (const id of ids) {
        try {
          await ctx.sock.sendMessage(id, { text: `📢 *Broadcast*\n\n${ctx.text}` });
          sent++;
          await new Promise((r) => setTimeout(r, 800));
        } catch {
          /* skip failed group */
        }
      }
      await ctx.reply(`✅ Broadcast sent to ${sent}/${ids.length} groups.`);
    },
  },
  {
    name: "leaveall",
    category: "OWNER",
    desc: "Leave all groups",
    ownerOnly: true,
    handler: async (ctx) => {
      const groups = await ctx.sock.groupFetchAllParticipating();
      const ids = Object.keys(groups);
      if (!ids.length) return ctx.reply("ℹ️ The bot is not in any groups.");
      await ctx.reply(`👋 Leaving ${ids.length} group(s)...`);
      let left = 0;
      for (const id of ids) {
        try {
          await ctx.sock.groupLeave(id);
          left++;
          await new Promise((r) => setTimeout(r, 700));
        } catch {
          /* skip failed group */
        }
      }
      await ctx.reply(`✅ Left ${left}/${ids.length} groups.`);
    },
  },
  {
    name: "restart",
    category: "OWNER",
    desc: "Reconnect the bot to WhatsApp",
    ownerOnly: true,
    handler: async (ctx) => {
      await ctx.reply("♻️ Reconnecting to WhatsApp... give me a few seconds.");
      await restartConnection(ctx.tenantId);
    },
  },
];
