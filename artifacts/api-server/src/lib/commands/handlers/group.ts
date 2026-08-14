import type { Command, CommandContext } from "../types";
import { getBool, getConfig, setConfig } from "../../config";
import { findParticipant, participantHasNumber, sameUser } from "../../group-meta";
import { addWarn, getWarnCount, resetWarns } from "../../warns";
import { createScheduledTask } from "../../scheduled-tasks-store";
import { parseDuration, formatDuration } from "../duration-utils";

const WARN_LIMIT = 3;

function targetJids(ctx: CommandContext): string[] {
  const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  if (mentioned.length) return mentioned;
  const quotedParticipant = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (quotedParticipant) return [quotedParticipant];
  return [];
}

// A warn target is exempt when they are a group admin/owner (admins can't be
// warned — same spirit as the other group controls).
function isGroupAdminJid(ctx: CommandContext, jid: string): boolean {
  const p = ctx.groupMetadata ? findParticipant(ctx.groupMetadata.participants, jid) : undefined;
  return Boolean(p && (p.admin === "admin" || p.admin === "superadmin"));
}

// Members who can never be warned/kicked: the bot itself, any group admin, and
// the configured bot owner. Owner match is LID-safe — resolve the participant
// from group metadata and compare via participantHasNumber (handles @lid).
async function isExemptFromWarn(ctx: CommandContext, target: string): Promise<boolean> {
  const botId = ctx.sock.user?.id;
  if (botId && sameUser(botId, target)) return true;
  if (isGroupAdminJid(ctx, target)) return true;
  const ownerNumber = await getConfig("ownerNumber", ctx.tenantId);
  if (ownerNumber) {
    const p = ctx.groupMetadata ? findParticipant(ctx.groupMetadata.participants, target) : undefined;
    if (participantHasNumber(p ?? { id: target }, ownerNumber)) return true;
  }
  return false;
}

export const groupCommands: Command[] = [
  {
    name: "vcf",
    aliases: ["savecontacts", "getcontacts"],
    category: "GROUP",
    desc: "Export group members as a contacts (.vcf) file",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const parts = ctx.groupMetadata?.participants ?? [];
      const phones = parts.map((p) => p.id).filter((id) => id.endsWith("@s.whatsapp.net"));
      if (phones.length === 0) {
        return ctx.reply("❌ No exportable phone contacts found in this group.");
      }
      const cards = phones.map((id) => {
        const num = id.split("@")[0];
        return `BEGIN:VCARD\nVERSION:3.0\nFN:+${num}\nTEL;type=CELL;type=VOICE;waid=${num}:+${num}\nEND:VCARD`;
      });
      const buf = Buffer.from(cards.join("\n"), "utf-8");
      const subject = ctx.groupMetadata?.subject ?? "group";
      const fileName = `${subject.replace(/[^\w-]+/g, "_").slice(0, 40) || "contacts"}.vcf`;
      await ctx.sock.sendMessage(
        ctx.from,
        {
          document: buf,
          fileName,
          mimetype: "text/x-vcard",
          caption: `📇 ${phones.length} contacts from *${subject}*`,
        },
        { quoted: ctx.msg },
      );
    },
  },
  {
    name: "tagall",
    aliases: ["everyone", "all"],
    category: "GROUP",
    desc: "Mention all members",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      const jids = meta.participants.map((p) => p.id);
      const text =
        `📢 *Attention everyone!*\n${ctx.text ? `\n${ctx.text}\n` : ""}\n` +
        meta.participants.map((p) => `◦ @${p.id.split("@")[0]}`).join("\n");
      await ctx.sock.sendMessage(ctx.from, { text, mentions: jids });
    },
  },
  {
    name: "hidetag",
    aliases: ["htag"],
    category: "GROUP",
    desc: "Tag all silently",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      const jids = meta.participants.map((p) => p.id);
      await ctx.sock.sendMessage(ctx.from, { text: ctx.text || "📢", mentions: jids });
    },
  },
  {
    name: "tag",
    category: "GROUP",
    desc: "Tag members with a message",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      const jids = meta.participants.map((p) => p.id);
      await ctx.sock.sendMessage(ctx.from, { text: ctx.text || "📢 Tag", mentions: jids });
    },
  },
  {
    name: "kick",
    aliases: ["remove"],
    category: "GROUP",
    desc: "Remove a member",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const targets = targetJids(ctx);
      if (!targets.length) return ctx.reply(`Tag or reply to the member to kick.\nUsage: *${ctx.prefix}kick @user*`);
      await ctx.sock.groupParticipantsUpdate(ctx.from, targets, "remove");
      await ctx.reply(`✅ Removed ${targets.length} member(s).`);
    },
  },
  {
    name: "promote",
    category: "GROUP",
    desc: "Promote a member to admin",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const targets = targetJids(ctx);
      if (!targets.length) return ctx.reply(`Tag the member to promote.\nUsage: *${ctx.prefix}promote @user*`);

      // When anti-promote is on, only the bot owner or the group creator may
      // appoint admins — even through the bot — so admins can't bypass it.
      const antipromote = await getBool(`antipromote:${ctx.from}`, ctx.tenantId);
      if (antipromote && !ctx.isOwner) {
        const senderP = ctx.groupMetadata ? findParticipant(ctx.groupMetadata.participants, ctx.sender) : undefined;
        const creatorP = ctx.groupMetadata
          ? findParticipant(ctx.groupMetadata.participants, ctx.groupMetadata.owner)
          : undefined;
        const isCreator = Boolean(senderP && creatorP && senderP.id === creatorP.id);
        if (!isCreator) {
          return ctx.reply("🛡️ Anti-promote is on. Only the bot owner can appoint admins here.");
        }
      }

      await ctx.sock.groupParticipantsUpdate(ctx.from, targets, "promote");
      await ctx.reply(`✅ Promoted to admin.`);
    },
  },
  {
    name: "demote",
    category: "GROUP",
    desc: "Demote an admin",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const targets = targetJids(ctx);
      if (!targets.length) return ctx.reply(`Tag the admin to demote.\nUsage: *${ctx.prefix}demote @user*`);

      // When anti-demote is on, only the bot owner or the group creator may
      // strip admin — even through the bot — so admins can't bypass it.
      const antidemote = await getBool(`antidemote:${ctx.from}`, ctx.tenantId);
      if (antidemote && !ctx.isOwner) {
        const senderP = ctx.groupMetadata ? findParticipant(ctx.groupMetadata.participants, ctx.sender) : undefined;
        const creatorP = ctx.groupMetadata
          ? findParticipant(ctx.groupMetadata.participants, ctx.groupMetadata.owner)
          : undefined;
        const isCreator = Boolean(senderP && creatorP && senderP.id === creatorP.id);
        if (!isCreator) {
          return ctx.reply("🛡️ Anti-demote is on. Only the bot owner can change admins here.");
        }
      }

      await ctx.sock.groupParticipantsUpdate(ctx.from, targets, "demote");
      await ctx.reply(`✅ Demoted to member.`);
    },
  },
  {
    name: "add",
    category: "GROUP",
    desc: "Add a member by number",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const num = ctx.text.replace(/[^0-9]/g, "");
      if (!num) return ctx.reply(`Usage: *${ctx.prefix}add 234XXXXXXXXXX*`);
      const jid = `${num}@s.whatsapp.net`;
      let status = "";
      try {
        const res = await ctx.sock.groupParticipantsUpdate(ctx.from, [jid], "add");
        status = String(res?.[0]?.status ?? "");
      } catch {
        return ctx.reply(`❌ Couldn't add +${num}.`);
      }
      if (status === "200") return ctx.reply(`✅ Added +${num} to the group.`);
      // Common failure: the user's privacy settings block being added directly
      // (403). Fall back to DMing them the group invite link so they can join.
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
    name: "open",
    aliases: ["unmute", "unlock"],
    category: "GROUP",
    desc: "Allow everyone to send",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      await ctx.sock.groupSettingUpdate(ctx.from, "not_announcement");
      await ctx.reply("🔓 Group opened — everyone can send messages.");
    },
  },
  {
    name: "close",
    aliases: ["mute", "lock"],
    category: "GROUP",
    desc: "Only admins can send",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      await ctx.sock.groupSettingUpdate(ctx.from, "announcement");
      await ctx.reply("🔒 Group closed — only admins can send messages.");
    },
  },
  {
    name: "closein",
    aliases: ["scheduleclose", "autoclose"],
    category: "GROUP",
    desc: "Close the group after a delay (e.g. closein 30m)",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const ms = parseDuration(ctx.text);
      if (!ms) return ctx.reply(`Usage: *${ctx.prefix}closein 30m* — units s/m/h/d`);
      await createScheduledTask({ tenantId: ctx.tenantId, kind: "group_close", targetJid: ctx.from, dueAt: new Date(Date.now() + ms) });
      await ctx.reply(`🔒 Group will close in *${formatDuration(ms)}*.`);
    },
  },
  {
    name: "openin",
    aliases: ["scheduleopen", "autoopen"],
    category: "GROUP",
    desc: "Open the group after a delay (e.g. openin 2h)",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const ms = parseDuration(ctx.text);
      if (!ms) return ctx.reply(`Usage: *${ctx.prefix}openin 2h* — units s/m/h/d`);
      await createScheduledTask({ tenantId: ctx.tenantId, kind: "group_open", targetJid: ctx.from, dueAt: new Date(Date.now() + ms) });
      await ctx.reply(`🔓 Group will open in *${formatDuration(ms)}*.`);
    },
  },
  {
    name: "warn",
    category: "GROUP",
    desc: "Warn a member (3 warnings = auto-kick)",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const target = targetJids(ctx)[0];
      if (!target) return ctx.reply(`Tag or reply to the member to warn.\nUsage: *${ctx.prefix}warn @user [reason]*`);
      if (await isExemptFromWarn(ctx, target)) return ctx.reply("⚠️ That member can't be warned (admin or owner).");
      const reason = ctx.text.replace(/@\d+/g, "").trim() || undefined;
      const count = await addWarn(ctx.tenantId, ctx.from, target, reason);
      if (count >= WARN_LIMIT) {
        await ctx.sock.sendMessage(ctx.from, {
          text: `⛔ @${target.split("@")[0]} reached ${count}/${WARN_LIMIT} warnings — removing.`,
          mentions: [target],
        });
        try {
          await ctx.sock.groupParticipantsUpdate(ctx.from, [target], "remove");
        } catch {
          await ctx.reply("Couldn't remove the member — I need to be a group admin.");
        }
        await resetWarns(ctx.tenantId, ctx.from, target);
        return;
      }
      await ctx.sock.sendMessage(ctx.from, {
        text: `⚠️ @${target.split("@")[0]} warned (${count}/${WARN_LIMIT})${reason ? `\nReason: ${reason}` : ""}`,
        mentions: [target],
      });
    },
  },
  {
    name: "warns",
    aliases: ["warnings", "checkwarn"],
    category: "GROUP",
    desc: "Check a member's warnings",
    groupOnly: true,
    handler: async (ctx) => {
      const target = targetJids(ctx)[0] ?? ctx.sender;
      const count = await getWarnCount(ctx.tenantId, ctx.from, target);
      await ctx.sock.sendMessage(ctx.from, {
        text: `⚠️ @${target.split("@")[0]} has *${count}/${WARN_LIMIT}* warning(s).`,
        mentions: [target],
      });
    },
  },
  {
    name: "resetwarn",
    aliases: ["unwarn", "delwarn"],
    category: "GROUP",
    desc: "Clear a member's warnings",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const target = targetJids(ctx)[0];
      if (!target) return ctx.reply(`Tag or reply to the member.\nUsage: *${ctx.prefix}resetwarn @user*`);
      await resetWarns(ctx.tenantId, ctx.from, target);
      await ctx.sock.sendMessage(ctx.from, {
        text: `✅ Cleared warnings for @${target.split("@")[0]}.`,
        mentions: [target],
      });
    },
  },
  {
    name: "link",
    aliases: ["grouplink", "invite"],
    category: "GROUP",
    desc: "Get the group invite link",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const code = await ctx.sock.groupInviteCode(ctx.from);
      await ctx.reply(`🔗 *Group Link*\nhttps://chat.whatsapp.com/${code}`);
    },
  },
  {
    name: "revoke",
    aliases: ["resetlink"],
    category: "GROUP",
    desc: "Reset the group invite link",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      await ctx.sock.groupRevokeInvite(ctx.from);
      await ctx.reply("✅ Group link has been reset.");
    },
  },
  {
    name: "setdesc",
    category: "GROUP",
    desc: "Set group description",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}setdesc <new description>*`);
      await ctx.sock.groupUpdateDescription(ctx.from, ctx.text);
      await ctx.reply("✅ Group description updated.");
    },
  },
  {
    name: "setname",
    aliases: ["setsubject", "setgroupname"],
    category: "GROUP",
    desc: "Set group name",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}setname <new name>*`);
      await ctx.sock.groupUpdateSubject(ctx.from, ctx.text);
      await ctx.reply("✅ Group name updated.");
    },
  },
  {
    name: "totalmembers",
    aliases: ["members", "membercount"],
    category: "GROUP",
    desc: "Show member count",
    groupOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      await ctx.reply(`👥 *${meta.subject}*\nTotal members: *${meta.participants.length}*`);
    },
  },
  {
    name: "groupinfo",
    aliases: ["ginfo", "infogc"],
    category: "GROUP",
    desc: "Show group info",
    groupOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      const admins = meta.participants.filter((p) => p.admin).length;
      await ctx.reply(
        `📋 *Group Info*\n\n` +
          `📛 Name: ${meta.subject}\n` +
          `🆔 ID: ${meta.id}\n` +
          `👥 Members: ${meta.participants.length}\n` +
          `👮 Admins: ${admins}\n` +
          `📝 Description: ${meta.desc || "—"}`,
      );
    },
  },
  {
    name: "listadmin",
    aliases: ["admins"],
    category: "GROUP",
    desc: "List group admins",
    groupOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      const admins = meta.participants.filter((p) => p.admin);
      const text = `👮 *Group Admins (${admins.length})*\n\n` + admins.map((a) => `◦ @${a.id.split("@")[0]}`).join("\n");
      await ctx.sock.sendMessage(ctx.from, { text, mentions: admins.map((a) => a.id) });
    },
  },
  {
    name: "leave",
    aliases: ["leavegc"],
    category: "GROUP",
    desc: "Bot leaves the group",
    groupOnly: true,
    ownerOnly: true,
    handler: async (ctx) => {
      await ctx.reply("👋 Goodbye!");
      await ctx.sock.groupLeave(ctx.from);
    },
  },
  {
    name: "antilink",
    category: "GROUPSTATUS",
    desc: "Toggle anti-link protection",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}antilink on/off*`);
      await setConfig(`antilink:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(`🛡️ Anti-link is now *${val.toUpperCase()}* for this group.`);
    },
  },
  {
    name: "antibadword",
    aliases: ["antibadwords"],
    category: "GROUPSTATUS",
    desc: "Auto-kick members who use bad words",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}antibadword on/off*`);
      await setConfig(`antibadword:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(
        val === "on"
          ? "🚫 Anti-badword is now *ON*. Any member who uses a bad word will be removed immediately — no warning. Admins are exempt, and I must be a group admin to remove members."
          : "🚫 Anti-badword is now *OFF* for this group.",
      );
    },
  },
  {
    name: "antistatus",
    category: "GROUPSTATUS",
    desc: "Auto-delete statuses members share into the group",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}antistatus on/off*`);
      await setConfig(`antistatus:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(
        val === "on"
          ? "🗑️ Anti-status is now *ON*. Any status a member shares into this group will be deleted immediately — no warning. Admins are exempt, and I must be a group admin to delete it."
          : "🗑️ Anti-status is now *OFF* for this group.",
      );
    },
  },
  {
    name: "antipromote",
    category: "GROUPSTATUS",
    desc: "Kick the promoter + the promoted member",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}antipromote on/off*`);
      await setConfig(`antipromote:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(
        val === "on"
          ? "🛡️ Anti-promote is now *ON*. Only the bot owner can appoint admins — if any other admin promotes someone, the bot shows the reason then kicks BOTH that admin and the promoted member from the group."
          : "🛡️ Anti-promote is now *OFF* for this group.",
      );
    },
  },
  {
    name: "adminevents",
    aliases: ["promotedemote", "adminnotify"],
    category: "GROUPSTATUS",
    desc: "Announce when a member is promoted/demoted",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}adminevents on/off*`);
      await setConfig(`adminevents:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(
        val === "on"
          ? "📢 Admin-event alerts are now *ON*. The bot will announce in this group whenever a member is promoted to admin or an admin is demoted."
          : "📢 Admin-event alerts are now *OFF* for this group.",
      );
    },
  },
  {
    name: "del",
    aliases: ["delete", "delmsg"],
    category: "GROUP",
    desc: "Delete the replied-to message",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
      const stanzaId = ci?.stanzaId;
      const participant = ci?.participant ?? undefined;
      if (!stanzaId) {
        return ctx.reply(`Reply to the message you want to delete with *${ctx.prefix}del*.`);
      }
      // LID-safe own-message check: resolve both the quoted sender and the bot
      // to group participants before comparing (group senders can be @lid).
      const botP = ctx.groupMetadata
        ? findParticipant(ctx.groupMetadata.participants, ctx.sock.user?.id)
        : undefined;
      const senderP =
        participant && ctx.groupMetadata
          ? findParticipant(ctx.groupMetadata.participants, participant)
          : undefined;
      const fromMe = Boolean(botP && senderP && botP.id === senderP.id);
      const key = fromMe
        ? { remoteJid: ctx.from, fromMe: true, id: stanzaId }
        : { remoteJid: ctx.from, fromMe: false, id: stanzaId, participant };
      await ctx.sock.sendMessage(ctx.from, { delete: key });
    },
  },
  {
    name: "antidemote",
    aliases: ["antidemoteadmin"],
    category: "GROUPSTATUS",
    desc: "Kick any admin who demotes another admin",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}antidemote on/off*`);
      await setConfig(`antidemote:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(
        val === "on"
          ? "🛡️ Anti-demote is now *ON*. If any admin (other than the group creator or bot owner) demotes an admin, the bot shows the reason then removes that admin from the group."
          : "🛡️ Anti-demote is now *OFF* for this group.",
      );
    },
  },
  {
    name: "kickall",
    aliases: ["removeall"],
    category: "GROUP",
    desc: "Remove ALL members from the group (owner only)",
    groupOnly: true,
    ownerOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      const ownerNumber = await getConfig("ownerNumber", ctx.tenantId);
      // Resolve the bot/creator to real participants so exemptions are LID-safe.
      const botP = findParticipant(meta.participants, ctx.sock.user?.id);
      const creatorP = meta.owner ? findParticipant(meta.participants, meta.owner) : undefined;
      const targets = meta.participants
        .filter((p) => {
          if (botP && p.id === botP.id) return false;
          if (creatorP && p.id === creatorP.id) return false;
          if (ownerNumber && participantHasNumber(p, ownerNumber)) return false;
          return true;
        })
        .map((p) => p.id);
      if (!targets.length) return ctx.reply("No removable members found.");
      await ctx.reply(`⚠️ Removing ${targets.length} member(s) from the group...`);
      let removed = 0;
      for (let i = 0; i < targets.length; i += 20) {
        const batch = targets.slice(i, i + 20);
        try {
          await ctx.sock.groupParticipantsUpdate(ctx.from, batch, "remove");
          removed += batch.length;
        } catch {
          /* keep going on the next batch */
        }
        if (i + 20 < targets.length) await new Promise((r) => setTimeout(r, 1500));
      }
      await ctx.reply(`✅ Done. Removed ${removed} member(s).`);
    },
  },
  {
    name: "alldemote",
    aliases: ["demoteall"],
    category: "GROUP",
    desc: "Demote ALL admins (owner only)",
    groupOnly: true,
    ownerOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const meta = ctx.groupMetadata;
      if (!meta) return;
      const ownerNumber = await getConfig("ownerNumber", ctx.tenantId);
      // Resolve the bot/creator to real participants so exemptions are LID-safe.
      const botP = findParticipant(meta.participants, ctx.sock.user?.id);
      const creatorP = meta.owner ? findParticipant(meta.participants, meta.owner) : undefined;
      const targets = meta.participants
        .filter((p) => {
          if (!p.admin) return false; // members are already non-admins
          if (p.admin === "superadmin") return false; // creator can't be demoted
          if (botP && p.id === botP.id) return false;
          if (creatorP && p.id === creatorP.id) return false;
          if (ownerNumber && participantHasNumber(p, ownerNumber)) return false;
          return true;
        })
        .map((p) => p.id);
      if (!targets.length) return ctx.reply("No demotable admins found.");
      let done = 0;
      for (let i = 0; i < targets.length; i += 20) {
        const batch = targets.slice(i, i + 20);
        try {
          await ctx.sock.groupParticipantsUpdate(ctx.from, batch, "demote");
          done += batch.length;
        } catch {
          /* keep going on the next batch */
        }
        if (i + 20 < targets.length) await new Promise((r) => setTimeout(r, 1500));
      }
      await ctx.reply(`✅ Demoted ${done} admin(s) to member.`);
    },
  },
];
