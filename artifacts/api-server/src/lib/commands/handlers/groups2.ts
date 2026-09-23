import sharp from "sharp";
import type { Command, CommandContext } from "../types";
import { setConfig, getConfig } from "../../config";
import { getGroupMetadataCached, jidBase } from "../../group-meta";
import { hasMedia, downloadMedia } from "../media-utils";
import { clearPendingVerify } from "../verification";
import { logger } from "../../logger";

// ---------------------------------------------------------------------------
// Generic toggle factory (mirrors groupstatus.ts but covers the rest of the
// anti-* family and misc group toggles).
// ---------------------------------------------------------------------------

function toggle(name: string, aliases: string[] | undefined, label: string, keyPrefix: string): Command {
  return {
    name,
    aliases,
    category: "SETTINGS",
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

// ---------------------------------------------------------------------------
// Number parsing helpers
// ---------------------------------------------------------------------------

function parseNumbers(ctx: CommandContext): string[] {
  const raw = ctx.text.trim().replace(/^all\s*/i, "");
  const nums = raw
    .split(/[\s,;]+/)
    .map((x) => x.replace(/[^\d]/g, ""))
    .filter((x) => x.length >= 6);
  return [...new Set(nums.map((n) => `${n}@s.whatsapp.net`))];
}

async function allParticipantJids(ctx: CommandContext): Promise<string[]> {
  const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
  return meta?.participants.map((p) => p.id) ?? [];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const groups2Commands: Command[] = [
  // --- Anti-* toggles -------------------------------------------------------
  toggle("antibots", undefined, "Anti-bots (kick verified/bot accounts)", "antibots"),
  toggle("antifake", undefined, "Anti-fake-accounts", "antifake"),
  toggle("antiforwarded", undefined, "Anti-forwarded-messages", "antiforwarded"),
  toggle("antiimage", undefined, "Anti-image-spam", "antiimage"),
  toggle("antikickinactive", undefined, "Anti-inactive-members (auto-kick)", "antikickinactive"),
  toggle("antimassmention", undefined, "Anti-mass-mention", "antimassmention"),
  toggle("antiraid", undefined, "Anti-raid (auto-remove burst of new members)", "antiraid"),
  toggle("antisticker", undefined, "Anti-sticker-spam", "antisticker"),
  toggle("antivideo", undefined, "Anti-video-spam", "antivideo"),
  toggle("welcomedm", undefined, "Send welcome message in private chat", "welcomedm"),
  toggle("autocreate", undefined, "Auto-setup new groups", "autocreate"),
  toggle("autopromote", undefined, "Auto-promote new members", "autopromote"),
  toggle("autodemote", undefined, "Auto-demote members who leave", "autodemote"),
  toggle("ghostadmin", undefined, "Ghost admin (silent moderation)", "ghostadmin"),
  toggle("adminlog", undefined, "Log admin actions", "adminlog"),

  // --- Parameterized toggles ------------------------------------------------
  {
    name: "lockdown",
    category: "SETTINGS",
    desc: "Lock the group (non-admins can't send)",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      await setConfig(`lockdown:${ctx.from}`, "true", ctx.tenantId);
      await ctx.reply(`🔒 Group is now in *lockdown*. Only admins can send. Use *${ctx.prefix}unlockdown* to open it.`);
    },
  },
  {
    name: "unlockdown",
    category: "SETTINGS",
    desc: "Unlock the group",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      await setConfig(`lockdown:${ctx.from}`, "false", ctx.tenantId);
      await ctx.reply("🔓 Lockdown lifted — members can send again.");
    },
  },
  {
    name: "setinactive",
    category: "SETTINGS",
    desc: "Kick members inactive for N days (0 to disable)",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const days = Math.floor(Number(ctx.text.trim()));
      if (!Number.isFinite(days) || days < 0 || days > 365) {
        return ctx.reply(`Usage: *${ctx.prefix}setinactive <days>* (0 to disable)`);
      }
      await setConfig(`inactive-days:${ctx.from}`, String(days), ctx.tenantId);
      await setConfig(`antikickinactive:${ctx.from}`, days > 0 ? "true" : "false", ctx.tenantId);
      await ctx.reply(days === 0 ? "🕐 Inactive-member kicking is *OFF*." : `🕐 Members inactive for *${days}d+* will be kicked.`);
    },
  },
  {
    name: "setgroupprefix",
    category: "SETTINGS",
    desc: "Set a custom command prefix for this group",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const p = ctx.text.trim().slice(0, 2);
      if (!p) return ctx.reply(`Usage: *${ctx.prefix}setgroupprefix <char>*`);
      await setConfig(`gprefix:${ctx.from}`, p, ctx.tenantId);
      await ctx.reply(`🔧 Command prefix for this group is now *${p}* (type *${p}menu*).`);
    },
  },
  {
    name: "setautocreate",
    category: "SETTINGS",
    desc: "Auto-create a new group with the same settings",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const name = ctx.text.trim() || "New group";
      const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
      const participants = [ctx.sender, ...(meta?.participants.map((p) => p.id).slice(0, 8) ?? [])];
      try {
        const { groupMetadata } = (await ctx.sock.groupCreate(name, participants)) as { groupMetadata?: { id?: string } };
        if (groupMetadata?.id) {
          await ctx.sock.groupSettingUpdate(groupMetadata.id, meta?.announce ? "announcement" : "not_announcement").catch(() => {});
        }
        await ctx.reply(`✅ Created *${name}*.`);
      } catch (e) {
        logger.warn({ err: e }, "groupCreate failed");
        await ctx.reply("❌ Couldn't create the group (I may have hit a rate limit). Try again later.");
      }
    },
  },
  {
    name: "featureperm",
    category: "SETTINGS",
    desc: "Restrict a feature to admins only",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const [feature, level] = ctx.text.trim().split(/\s+/);
      if (!feature || (level !== "admin" && level !== "all")) {
        return ctx.reply(`Usage: *${ctx.prefix}featureperm <feature> admin|all*\nExample: *${ctx.prefix}featureperm play admin*`);
      }
      await setConfig(`featureperm:${feature.toLowerCase()}`, level, ctx.tenantId);
      await ctx.reply(`🔐 *${feature}* is now restricted to *${level.toUpperCase()}*.`);
    },
  },
  {
    name: "tempmute",
    category: "ADMIN",
    desc: "Temporarily mute a member (minutes)",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const [numRaw, minRaw] = ctx.text.trim().split(/\s+/);
      const num = numRaw?.replace(/\D/g, "");
      const mins = Math.floor(Number(minRaw ?? "5"));
      if (!num || num.length < 6 || !Number.isFinite(mins) || mins < 1 || mins > 1440) {
        return ctx.reply(`Usage: *${ctx.prefix}tempmute <number> <minutes>*`);
      }
      const jid = `${num}@s.whatsapp.net`;
      await setConfig(`tempmute:${ctx.from}:${jid}`, String(Date.now() + mins * 60_000), ctx.tenantId);
      await ctx.reply(`🔇 ${num} muted for *${mins} minute(s)*.`);
    },
  },
  // --- Group utilities -------------------------------------------------------
  {
    name: "bulkpromote",
    category: "ADMIN",
    desc: "Promote everyone or listed members",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const targets = /^all/i.test(ctx.text.trim()) ? (await allParticipantJids(ctx)).filter((j) => j !== ctx.sender) : parseNumbers(ctx);
      if (!targets.length) return ctx.reply(`Usage: *${ctx.prefix}bulkpromote all* or *${ctx.prefix}bulkpromote <num1> <num2>*`);
      for (let i = 0; i < targets.length; i += 20) {
        await ctx.sock.groupParticipantsUpdate(ctx.from, targets.slice(i, i + 20), "promote").catch(() => {});
      }
      await ctx.reply(`👑 Promoted *${targets.length}* member(s).`);
    },
  },
  {
    name: "bulkdemote",
    category: "ADMIN",
    desc: "Demote everyone or listed members",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const targets = /^all/i.test(ctx.text.trim()) ? (await allParticipantJids(ctx)).filter((j) => j !== ctx.sender) : parseNumbers(ctx);
      if (!targets.length) return ctx.reply(`Usage: *${ctx.prefix}bulkdemote all* or *${ctx.prefix}bulkdemote <num1> <num2>*`);
      for (let i = 0; i < targets.length; i += 20) {
        await ctx.sock.groupParticipantsUpdate(ctx.from, targets.slice(i, i + 20), "demote").catch(() => {});
      }
      await ctx.reply(`🔻 Demoted *${targets.length}* member(s).`);
    },
  },
  {
    name: "bulkremove",
    category: "ADMIN",
    desc: "Remove many members at once",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const targets = parseNumbers(ctx);
      if (!targets.length) return ctx.reply(`Usage: *${ctx.prefix}bulkremove <num1> <num2> ...*`);
      for (let i = 0; i < targets.length; i += 20) {
        await ctx.sock.groupParticipantsUpdate(ctx.from, targets.slice(i, i + 20), "remove").catch(() => {});
      }
      await ctx.reply(`🗑 Removed *${targets.length}* member(s).`);
    },
  },
  {
    name: "exportmembers",
    aliases: ["exportgroup"],
    category: "GROUP",
    desc: "Export all group members as a contact file",
    groupOnly: true,
    handler: async (ctx) => {
      const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
      if (!meta) return ctx.reply("❌ Couldn't read group metadata.");
      const vcards = meta.participants.map((p) => {
        const num = jidBase(p.id);
        return `BEGIN:VCARD\nVERSION:3.0\nFN:${num}\nTEL;TYPE=CELL:+${num}\nEND:VCARD`;
      });
      await ctx.sock.sendMessage(ctx.from, { document: Buffer.from(vcards.join("\n")), mimetype: "text/x-vcard", fileName: `${meta.subject.replace(/[^\w-]+/g, "_").slice(0, 40) || "members"}.vcf` }, { quoted: ctx.msg });
    },
  },
  {
    name: "importmembers",
    category: "ADMIN",
    desc: "Add members by number",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const targets = parseNumbers(ctx);
      if (!targets.length) return ctx.reply(`Usage: *${ctx.prefix}importmembers <num1> <num2> ...*`);
      for (let i = 0; i < targets.length; i += 5) {
        await ctx.sock.groupParticipantsUpdate(ctx.from, targets.slice(i, i + 5), "add").catch(() => {});
      }
      await ctx.reply(`➕ Adding *${targets.length}* member(s)…`);
    },
  },
  {
    name: "clonegroup",
    category: "GROUP",
    desc: "Clone this group (name, desc, members)",
    groupOnly: true,
    adminOnly: true,
    botAdminOnly: true,
    handler: async (ctx) => {
      const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
      if (!meta) return ctx.reply("❌ Couldn't read group metadata.");
      try {
        const { groupMetadata } = (await ctx.sock.groupCreate(`${meta.subject} (copy)`, [ctx.sender])) as { groupMetadata?: { id?: string } };
        if (groupMetadata?.id) {
          await ctx.sock.groupSettingUpdate(groupMetadata.id, meta.announce ? "announcement" : "not_announcement").catch(() => {});
          if (meta.desc) await ctx.sock.groupUpdateDescription(groupMetadata.id, meta.desc).catch(() => {});
          await ctx.reply(`✅ Group cloned. Add members with *${ctx.prefix}importmembers <num>* in the new group.`);
        } else {
          await ctx.reply("✅ Group created.");
        }
      } catch {
        await ctx.reply("❌ Couldn't create the group right now.");
      }
    },
  },
  {
    name: "event",
    aliases: ["addevent", "scheduleevent"],
    category: "GROUP",
    desc: "Schedule an event (title | DD-MM-YYYY HH:MM)",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const parts = ctx.text.split("|").map((s) => s.trim());
      const title = parts[0];
      if (!title) return ctx.reply(`Usage: *${ctx.prefix}event <title> | <DD-MM-YYYY HH:MM>*`);
      let when = 0;
      if (parts[1]) {
        const d = new Date(parts[1].replace(/-/g, "/"));
        if (Number.isNaN(d.getTime())) return ctx.reply("❌ Invalid date. Use DD-MM-YYYY HH:MM.");
        when = d.getTime();
      }
      const id = Date.now();
      await setConfig(`event:${ctx.from}:${id}`, `${title}|||${when}`, ctx.tenantId);
      await ctx.reply(`🗓 Event saved: *${title}*${when ? ` (${new Date(when).toLocaleString()})` : ""}`);
    },
  },
  {
    name: "eventlist",
    category: "GROUP",
    desc: "List scheduled events",
    groupOnly: true,
    handler: async (ctx) => {
      const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
      if (!meta) return ctx.reply("❌ Couldn't read group metadata.");
      const lines: string[] = [];
      const raw = await getConfig(`events:${ctx.from}`, ctx.tenantId);
      if (raw) lines.push(...raw.split("\n").map((l) => `• ${l}`));
      await ctx.reply(lines.length ? `🗓 *Events:*\n\n${lines.join("\n")}` : "📭 No events scheduled yet.");
    },
  },
  {
    name: "feedback",
    category: "MISC",
    desc: "Send feedback to the owner",
    handler: async (ctx) => {
      const text = ctx.text.trim() || ctx.quotedText?.trim() || "";
      if (!text) return ctx.reply(`Usage: *${ctx.prefix}feedback <message>*`);
      const owner = ctx.config.ownerNumber;
      if (owner) {
        await ctx.sock.sendMessage(`${owner}@s.whatsapp.net`, { text: `📨 *Feedback from ${ctx.pushName} (${ctx.senderNumber})*\n\n${text}` }).catch(() => {});
      }
      await ctx.reply("📨 Feedback sent. Thanks!");
    },
  },
  {
    name: "swm",
    category: "MEDIA",
    desc: "Make a transparent (no-background) sticker",
    groupOnly: true,
    handler: async (ctx) => {
      if (!hasMedia(ctx, "image")) return ctx.reply(`🖼️ Send or reply to an *image* with *${ctx.prefix}swm*`);
      await ctx.react("⏳");
      const buf = await downloadMedia(ctx, "image");
      if (!buf) return ctx.reply("❌ Failed to download the image.");
      const webp = await sharp(buf)
        .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 95 })
        .toBuffer();
      await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
      await ctx.react("✅");
    },
  },
  {
    name: "stickerpack",
    category: "MEDIA",
    desc: "Add an image to a sticker pack",
    groupOnly: true,
    handler: async (ctx) => {
      if (!hasMedia(ctx, "image")) return ctx.reply(`🖼️ Send or reply to an *image* with *${ctx.prefix}stickerpack*`);
      await ctx.react("⏳");
      const buf = await downloadMedia(ctx, "image");
      if (!buf) return ctx.reply("❌ Failed to download the image.");
      const webp = await sharp(buf)
        .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 90 })
        .toBuffer();
      await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
      await ctx.react("✅");
    },
  },
  {
    name: "answer",
    category: "SETTINGS",
    desc: "Answer the join question",
    groupOnly: true,
    handler: async (ctx) => {
      const ans = ctx.text.trim().toLowerCase();
      if (!ans) return ctx.reply("Send your answer after `.answer`, e.g. `.answer yes`.");
      const gk = `joinquestion:${ctx.from}`;
      const question = await getConfig(gk, ctx.tenantId);
      if (!question) return ctx.reply("No join question is active in this group.");
      const expected = question.split("|||")[0]?.toLowerCase().trim() ?? "";
      const jid = `${ctx.senderNumber}@s.whatsapp.net`;
      if (!expected || ans.includes(expected) || expected.includes(ans)) {
        await setConfig(`answered:${ctx.from}:${jid}`, "true", ctx.tenantId);
        clearPendingVerify(`${ctx.tenantId}:${ctx.from}:${ctx.senderNumber}`);
        await ctx.reply("✅ Correct! Welcome to the group.");
      } else {
        await ctx.reply("❌ That's not the right answer.");
      }
    },
  },
];
