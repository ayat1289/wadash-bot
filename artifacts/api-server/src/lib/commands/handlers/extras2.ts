import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type { Command, CommandContext } from "../types";
import { db, activityLogTable, tenantsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { download, fetchMeta } from "../ytdlp";
import { runProcess } from "../proc";
import { getFfmpegPath } from "../ffmpeg";
import { logger } from "../../logger";

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);

const VIDEO_FORMAT =
  "best[ext=mp4][height<=720]/best[height<=720]/best[ext=mp4]/best";
const MAX_VIDEO_MB = 64;

// ---------------------------------------------------------------------------
// In-memory stores (bounded, lost on restart — same policy as extras.ts).
// ---------------------------------------------------------------------------

const MAX = 2000;
function boundedInsert<K, V>(map: Map<K, V>, k: K, v: V): void {
  map.delete(k);
  map.set(k, v);
  if (map.size > MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

const birthdays = new Map<string, string>(); // `${tenant}:${num}` -> "MM-DD"
const nicknames = new Map<string, string>(); // `${tenant}:${num}` -> nick
const confessions = new Map<string, { from: string; text: string }>();
const confessionMode = new Set<string>(); // `${tenant}:${group}`
const songQuiz = new Map<string, { answer: string; tries: number }>();
const attendance = new Map<string, Set<string>>(); // `${tenant}:${group}:${date}`
const votes = new Map<string, { topic: string; yes: Set<string>; no: Set<string> }>();

export const blacklist = new Set<string>(); // `${tenant}:${number}`
export const lockedCommands = new Map<string, Set<string>>(); // `${tenant}:${group}` -> cmds

const SONGS = [
  { t: "Shape of You", l: "The club isn't the best place to find a lover" },
  { t: "Blinding Lights", l: "I've been tryna call" },
  { t: "Bohemian Rhapsody", l: "Is this the real life?" },
  { t: "Billie Jean", l: "She was more like a beauty queen" },
  { t: "Hotel California", l: "On a dark desert highway" },
  { t: "Smells Like Teen Spirit", l: "Load up on guns, bring your friends" },
  { t: "Rolling in the Deep", l: "There's a fire starting in my heart" },
  { t: "Uptown Funk", l: "This hit, that ice cold" },
  { t: "Despacito", l: "Ay, sí, yo tengo un don" },
  { t: "Take On Me", l: "We're talking away" },
];

function key(ctx: CommandContext, extra = ""): string {
  return `${ctx.tenantId}:${extra}${ctx.senderNumber}`;
}
function today(ctx: CommandContext): string {
  return new Date().toISOString().slice(0, 10);
}

async function sendMedia(ctx: CommandContext, url: string, asVideo: boolean): Promise<void> {
  await ctx.react("⏳");
  try {
    const meta = await fetchMeta(url);
    const { buffer, ext } = await download(url, {
      format: VIDEO_FORMAT,
      maxSizeMb: MAX_VIDEO_MB,
    });
    if (asVideo) {
      await ctx.sock.sendMessage(ctx.from, { video: buffer, mimetype: "video/mp4", caption: `🎬 ${meta.title ?? url}` }, { quoted: ctx.msg });
    } else {
      await ctx.sock.sendMessage(ctx.from, { audio: buffer, mimetype: "audio/mp3", fileName: `${meta.title ?? "media"}.${ext}` }, { quoted: ctx.msg });
    }
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err, url }, "extras2 download failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't download that. Link may be private or unsupported.");
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const extras2Commands: Command[] = [
  // --- Owner utilities ------------------------------------------------------
  {
    name: "eval",
    category: "OWNER",
    desc: "Run JavaScript on the bot server",
    ownerOnly: true,
    handler: async (ctx) => {
      const code = ctx.text.slice(ctx.prefix.length + ctx.command.length).trim();
      if (!code) return ctx.reply("❌ Usage: `.eval <js code>` — async allowed.");
      try {
        const fn = new Function("require", "ctx", `return (async () => { ${code} })()`);
        const result = await fn(require, ctx);
        const out = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        await ctx.reply(`✅ ${String(out).slice(0, 3000) || "undefined"}`);
      } catch (e) {
        await ctx.reply(`❌ ${String(e).slice(0, 1500)}`);
      }
    },
  },
  {
    name: "dashboard",
    category: "OWNER",
    desc: "Bot status overview",
    ownerOnly: true,
    handler: async (ctx) => {
      const tenants = await db.select().from(tenantsTable);
      const uptime = Math.floor(process.uptime());
      const d = Math.floor(uptime / 86400);
      const h = Math.floor((uptime % 86400) / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
      await ctx.reply(
        `📊 *Bot Dashboard*\n\n` +
          `• Status: 🟢 online\n` +
          `• Uptime: ${d}d ${h}h ${m}m\n` +
          `• Memory: ${mem} MB\n` +
          `• Tenants: ${tenants.length}\n` +
          `• Registered commands: ${ctx.command.length ? "via registry" : "n/a"}`,
      );
    },
  },
  {
    name: "auditlog",
    category: "OWNER",
    desc: "Recent bot activity",
    ownerOnly: true,
    handler: async (ctx) => {
      const rows = await db.select().from(activityLogTable)
        .where(eq(activityLogTable.tenantId, ctx.tenantId))
        .orderBy(desc(activityLogTable.timestamp)).limit(12);
      if (!rows.length) return ctx.reply("📭 No activity logged yet.");
      const lines = rows.map((r: { timestamp: Date; type: string; description: string }) => `• [${r.timestamp.toISOString().slice(5, 16)}] ${r.type}: ${r.description.slice(0, 80)}`);
      await ctx.reply(`🗒 *Recent activity*\n\n${lines.join("\n")}`);
    },
  },
  {
    name: "backupdb",
    category: "OWNER",
    desc: "Download a Postgres dump",
    ownerOnly: true,
    aliases: ["backup"],
    handler: async (ctx) => {
      const url = process.env.DATABASE_URL;
      if (!url) return ctx.reply("❌ DATABASE_URL not set.");
      await ctx.react("⏳");
      try {
        const { stdout } = await execFileP("pg_dump", ["--no-owner", "--clean", url], {
          maxBuffer: 512 * 1024 * 1024,
          timeout: 120_000,
        });
        const name = `wadash-db-${new Date().toISOString().slice(0, 10)}.sql`;
        await ctx.sock.sendMessage(ctx.from, { document: Buffer.from(stdout), fileName: name, mimetype: "application/sql" }, { quoted: ctx.msg });
        await ctx.react("✅");
      } catch (e) {
        await ctx.react("❌");
        await ctx.reply(`❌ Dump failed: ${String(e).slice(0, 300)}`);
      }
    },
  },

  // --- Birthday reminders (in-memory) ---------------------------------------
  {
    name: "addbirthday",
    category: "FUN",
    desc: "Save your birthday (MM-DD)",
    groupOnly: true,
    handler: async (ctx) => {
      const d = ctx.text.trim().split(/\s+/)[0];
      if (!/^\d{1,2}-\d{1,2}$/.test(d ?? "")) return ctx.reply("❌ Usage: `.addbirthday 12-25`");
      const [, mm, dd] = d!.split("-").map((n) => parseInt(n, 10));
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return ctx.reply("❌ Invalid date.");
      boundedInsert(birthdays, key(ctx), `${mm}-${dd}`);
      await ctx.reply(`🎂 Saved! Your birthday: ${mm}-${dd}.`);
    },
  },
  {
    name: "delbirthday",
    category: "FUN",
    desc: "Remove your saved birthday",
    groupOnly: true,
    handler: async (ctx) => {
      const k = key(ctx);
      if (!birthdays.has(k)) return ctx.reply("❌ No birthday saved for you.");
      birthdays.delete(k);
      await ctx.reply("🗑 Removed your birthday.");
    },
  },
  {
    name: "birthdays",
    category: "FUN",
    desc: "List birthdays in this group",
    groupOnly: true,
    handler: async (ctx) => {
      if (!birthdays.size) return ctx.reply("📭 No birthdays saved yet.");
      const rows = [...birthdays.entries()].map(([k, d]) => `• ${d} → ${k.split(":")[1]}`);
      await ctx.reply(`🎂 *Saved birthdays*\n\n${rows.join("\n")}`);
    },
  },

  // --- Confession / anonymous notes -----------------------------------------
  {
    name: "confess",
    category: "FUN",
    desc: "Send an anonymous message in this group",
    groupOnly: true,
    handler: async (ctx) => {
      const text = (ctx.text.trim() || ctx.quotedText?.trim() || "").trim();
      if (!text) return ctx.reply("❌ Type something to confess: `.confess <text>`");
      if (confessionMode.has(`${ctx.tenantId}:${ctx.from}`)) {
        boundedInsert(confessions, `${ctx.tenantId}:${ctx.from}:${Date.now()}`, { from: ctx.senderNumber, text });
        await ctx.reply("🙈 Confession stored for the admins.");
      } else {
        await ctx.sock.sendMessage(ctx.from, { text: `🤫 *Anonymous confession:*\n\n${text}` });
        await ctx.reply("🙈 Sent anonymously.");
      }
    },
  },
  {
    name: "confessionmode",
    category: "ADMIN",
    desc: "Toggle anonymous confession collection",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const g = `${ctx.tenantId}:${ctx.from}`;
      if (confessionMode.has(g)) { confessionMode.delete(g); await ctx.reply("ℹ️ Confessions now post directly to the group."); }
      else { confessionMode.add(g); await ctx.reply("🙈 Confessions are now collected privately for admins. Admins can read them with `.confessions`."); }
    },
  },
  {
    name: "confessions",
    category: "ADMIN",
    desc: "Read collected confessions",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const g = `${ctx.tenantId}:${ctx.from}:`;
      const mine = [...confessions.entries()].filter(([k]) => k.startsWith(g));
      if (!mine.length) return ctx.reply("📭 No confessions collected.");
      await ctx.reply(mine.map(([, v]) => `• ${v.text.slice(0, 120)}`).join("\n"));
    },
  },

  // --- Guess the song --------------------------------------------------------
  {
    name: "guessthesong",
    category: "FUN",
    desc: "Guess the song from its first line",
    groupOnly: true,
    handler: async (ctx) => {
      const song = SONGS[randomInt(SONGS.length)];
      boundedInsert(songQuiz, ctx.from, { answer: song.t.toLowerCase(), tries: 3 });
      const masked = song.t.replace(/[a-zA-Z0-9]/g, "_");
      await ctx.reply(`🎤 *Guess the Song!*\n\n"${song.l}…"\n\n🎵 ${masked}\n\nReply with *${ctx.prefix}answer <title>*`);
    },
  },
  {
    name: "answer",
    category: "FUN",
    desc: "Answer the current song quiz",
    groupOnly: true,
    handler: async (ctx) => {
      const quiz = songQuiz.get(ctx.from);
      if (!quiz) return ctx.reply("❌ No active quiz in this group. Start one with `.guessthesong`.");
      const guess = ctx.text.trim().toLowerCase();
      if (guess === quiz.answer) {
        songQuiz.delete(ctx.from);
        await ctx.reply(`🎉 Correct! It was *${SONGS.find((s) => s.t.toLowerCase() === quiz.answer)?.t}*!`);
      } else {
        quiz.tries -= 1;
        if (quiz.tries <= 0) {
          songQuiz.delete(ctx.from);
          await ctx.reply(`😅 Out of tries! The song was *${SONGS.find((s) => s.t.toLowerCase() === quiz.answer)?.t}*.`);
        } else {
          await ctx.reply(`❌ Nope. ${quiz.tries} ${quiz.tries === 1 ? "try" : "tries"} left.`);
        }
      }
    },
  },

  // --- Downloads --------------------------------------------------------------
  {
    name: "telegram",
    category: "DOWNLOAD",
    desc: "Download a Telegram channel post (video)",
    handler: async (ctx) => {
      const url = ctx.text.trim();
      if (!/^https:\/\/t\.me\//i.test(url)) return ctx.reply("❌ Send a `https://t.me/...` link.");
      await sendMedia(ctx, url, true);
    },
  },
  {
    name: "reels",
    category: "DOWNLOAD",
    desc: "Download an Instagram reel",
    aliases: ["story", "ig", "instagram"],
    handler: async (ctx) => {
      const url = ctx.text.trim();
      if (!/^https?:\/\/(www\.)?(instagram\.com|instagr\.am|ig\.me)\//i.test(url)) return ctx.reply("❌ Send an Instagram link.");
      await sendMedia(ctx, url, true);
    },
  },

  // --- Voice / sticker --------------------------------------------------------
  {
    name: "voicechanger",
    category: "MEDIA",
    desc: "Pitch-shift a voice note / audio",
    groupOnly: true,
    handler: async (ctx) => {
      const m = ctx.msg.message;
      const media = m?.audioMessage ?? m?.documentMessage ?? m?.videoMessage;
      if (!media) return ctx.reply("❌ Reply to a voice note or audio with `.voicechanger`.");
      await ctx.react("⏳");
      try {
        const buf = await downloadMediaMessage(ctx.msg, "buffer", {}, { logger, reuploadRequest: ctx.sock.updateMediaMessage });
        const { writeFile, readFile } = await import("node:fs/promises");
        const dir = await mkdtemp(join(tmpdir(), "vc-"));
        const input = join(dir, "in.m4a");
        const out = join(dir, "out.mp3");
        try {
          await writeFile(input, buf);
          const { code } = await runProcess(getFfmpegPath(), ["-y", "-i", input, "-af", "asetrate=44100*0.85,aresample=44100,atempo=1.176", out], { timeoutMs: 60_000 });
          if (code !== 0) throw new Error(`ffmpeg exit ${code}`);
          const audio = await readFile(out);
          await ctx.sock.sendMessage(ctx.from, { audio, mimetype: "audio/mpeg", ptt: true }, { quoted: ctx.msg });
          await ctx.react("✅");
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      } catch (e) {
        await ctx.react("❌");
        await ctx.reply(`❌ Voice change failed: ${String(e).slice(0, 200)}`);
      }
    },
  },

  // --- Attendance ---------------------------------------------------------------
  {
    name: "attendance",
    category: "GROUP",
    desc: "Mark yourself present",
    groupOnly: true,
    handler: async (ctx) => {
      const g = `${ctx.tenantId}:${ctx.from}:${today(ctx)}`;
      const set = attendance.get(g) ?? new Set<string>();
      set.add(ctx.senderNumber);
      boundedInsert(attendance, g, set);
      await ctx.reply(`✅ Marked present. Use *.attendancelist* to see who's here.`);
    },
  },
  {
    name: "attendancelist",
    category: "GROUP",
    desc: "Who is present today",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const g = `${ctx.tenantId}:${ctx.from}:${today(ctx)}`;
      const set = attendance.get(g);
      if (!set?.size) return ctx.reply("📭 No one marked attendance yet.");
      await ctx.reply(`📋 *Attendance (${today(ctx)})* — ${set.size}\n\n${[...set].join("\n")}`);
    },
  },

  // --- Nickname -----------------------------------------------------------------
  {
    name: "setnick",
    category: "GROUP",
    desc: "Set your nickname",
    groupOnly: true,
    handler: async (ctx) => {
      const nick = ctx.text.trim().slice(0, 25);
      if (!nick) return ctx.reply("❌ Usage: `.setnick <name>`");
      boundedInsert(nicknames, key(ctx), nick);
      await ctx.reply(`✅ Nickname set to *${nick}*.`);
    },
  },

  // --- Voting ---------------------------------------------------------------------
  {
    name: "adminvote",
    category: "GROUP",
    desc: "Start a yes/no vote",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const topic = ctx.text.trim().slice(0, 100);
      if (!topic) return ctx.reply("❌ Usage: `.adminvote <question>`");
      boundedInsert(votes, ctx.from, { topic, yes: new Set(), no: new Set() });
      await ctx.reply(`🗳 *Vote started:* ${topic}\n\nReply *${ctx.prefix}vote yes* or *${ctx.prefix}vote no*`);
    },
  },
  {
    name: "vote",
    category: "GROUP",
    desc: "Cast your vote",
    groupOnly: true,
    handler: async (ctx) => {
      const v = votes.get(ctx.from);
      if (!v) return ctx.reply("❌ No active vote. Start one with `.adminvote`.");
      const choice = ctx.text.trim().toLowerCase();
      if (choice !== "yes" && choice !== "no") return ctx.reply("❌ Say `.vote yes` or `.vote no`.");
      v.yes.delete(ctx.senderNumber);
      v.no.delete(ctx.senderNumber);
      (choice === "yes" ? v.yes : v.no).add(ctx.senderNumber);
      await ctx.reply(`✅ Voted ${choice.toUpperCase()}. Tally: ✅${v.yes.size} ❌${v.no.size}`);
    },
  },

  // --- Lock / blacklist (enforced in command-handler) ------------------------------
  {
    name: "lockcmd",
    category: "ADMIN",
    desc: "Lock a command in this group",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const c = ctx.text.trim().toLowerCase();
      if (!c) return ctx.reply("❌ Usage: `.lockcmd <command>`");
      const set = lockedCommands.get(`${ctx.tenantId}:${ctx.from}`) ?? new Set<string>();
      set.add(c);
      boundedInsert(lockedCommands, `${ctx.tenantId}:${ctx.from}`, set);
      await ctx.reply(`🔒 Locked *${c}* in this group.`);
    },
  },
  {
    name: "unlockcmd",
    category: "ADMIN",
    desc: "Unlock a locked command",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const c = ctx.text.trim().toLowerCase();
      const set = lockedCommands.get(`${ctx.tenantId}:${ctx.from}`);
      if (!c || !set?.delete(c)) return ctx.reply("❌ That command isn't locked.");
      await ctx.reply(`🔓 Unlocked *${c}*.`);
    },
  },
  {
    name: "lockedcmds",
    category: "ADMIN",
    desc: "List locked commands",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const set = lockedCommands.get(`${ctx.tenantId}:${ctx.from}`);
      if (!set?.size) return ctx.reply("🔓 No commands are locked in this group.");
      await ctx.reply(`🔒 *Locked:* ${[...set].join(", ")}`);
    },
  },
  {
    name: "blacklist",
    category: "ADMIN",
    desc: "Blacklist a user from the bot",
    adminOnly: true,
    handler: async (ctx) => {
      const num = ctx.text.trim().replace(/\D/g, "");
      if (!num) return ctx.reply("❌ Usage: `.blacklist <number>`");
      blacklist.add(`${ctx.tenantId}:${num}`);
      await ctx.reply(`🚫 Blacklisted ${num}.`);
    },
  },
  {
    name: "unblacklist",
    category: "ADMIN",
    desc: "Remove a user from the blacklist",
    adminOnly: true,
    handler: async (ctx) => {
      const num = ctx.text.trim().replace(/\D/g, "");
      if (!num || !blacklist.delete(`${ctx.tenantId}:${num}`)) return ctx.reply("❌ Not blacklisted.");
      await ctx.reply(`✅ Removed ${num} from the blacklist.`);
    },
  },
  {
    name: "blacklistlist",
    category: "ADMIN",
    desc: "List blacklisted users",
    adminOnly: true,
    handler: async (ctx) => {
      const mine = [...blacklist].filter((k) => k.startsWith(`${ctx.tenantId}:`));
      if (!mine.length) return ctx.reply("🚫 Blacklist is empty.");
      await ctx.reply(`🚫 *Blacklisted:*\n\n${mine.map((k) => k.split(":")[1]).join("\n")}`);
    },
  },

  // --- Join queue / verify -------------------------------------------------------
  //
  // These operate on WhatsApp's REAL join-approval queue (group join-approval
  // mode). `groupRequestParticipantsList` lists the pending requests, and
  // `groupRequestParticipantsUpdate` approves/rejects them. The bot must be a
  // group admin for these to work.
  {
    name: "joinqueue",
    category: "ADMIN",
    desc: "See pending join requests",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      let reqs: { [key: string]: string }[] = [];
      try {
        reqs = (await ctx.sock.groupRequestParticipantsList(ctx.from)) ?? [];
      } catch (err) {
        return ctx.reply(`❌ Couldn't fetch join requests: ${(err as Error)?.message ?? err}`);
      }
      if (!reqs.length) return ctx.reply("📭 No pending join requests.");
      const lines = reqs.map((r, i) => {
        const jid = r.jid ?? r.lid ?? "";
        return `${i + 1}. ${jid.split(":")[0].split("@")[0]}`;
      });
      await ctx.reply(
        `⏳ *Pending joins:*\n\n${lines.join("\n")}\n\nApprove: *${ctx.prefix}approve <num>*  Reject: *${ctx.prefix}reject <num>*`,
      );
    },
  },
  {
    name: "approve",
    category: "ADMIN",
    desc: "Approve a pending join request",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const num = ctx.text.trim().replace(/\D/g, "");
      if (!num) return ctx.reply(`Usage: *${ctx.prefix}approve <number>`);
      let reqs: { [key: string]: string }[] = [];
      try {
        reqs = (await ctx.sock.groupRequestParticipantsList(ctx.from)) ?? [];
      } catch (err) {
        return ctx.reply(`❌ Couldn't fetch join requests: ${(err as Error)?.message ?? err}`);
      }
      const base = num.includes("@") ? num : `${num}@s.whatsapp.net`;
      const match = reqs.find((r) => {
        const jid = r.jid ?? r.lid ?? "";
        const rBase = jid.split(":")[0].split("@")[0];
        return jid === base || rBase === num;
      });
      if (!match) return ctx.reply("❌ No pending request for that number.");
      const jid = match.jid ?? match.lid ?? "";
      try {
        await ctx.sock.groupRequestParticipantsUpdate(ctx.from, [jid], "approve");
      } catch (err) {
        return ctx.reply(`❌ Approve failed: ${(err as Error)?.message ?? err}`);
      }
      await ctx.reply(`✅ Approved *${num}*.`);
    },
  },
  {
    name: "reject",
    category: "ADMIN",
    desc: "Reject a pending join request",
    adminOnly: true,
    groupOnly: true,
    handler: async (ctx) => {
      const num = ctx.text.trim().replace(/\D/g, "");
      if (!num) return ctx.reply(`Usage: *${ctx.prefix}reject <number>`);
      let reqs: { [key: string]: string }[] = [];
      try {
        reqs = (await ctx.sock.groupRequestParticipantsList(ctx.from)) ?? [];
      } catch (err) {
        return ctx.reply(`❌ Couldn't fetch join requests: ${(err as Error)?.message ?? err}`);
      }
      const base = num.includes("@") ? num : `${num}@s.whatsapp.net`;
      const match = reqs.find((r) => {
        const jid = r.jid ?? r.lid ?? "";
        const rBase = jid.split(":")[0].split("@")[0];
        return jid === base || rBase === num;
      });
      if (!match) return ctx.reply("❌ No pending request for that number.");
      const jid = match.jid ?? match.lid ?? "";
      try {
        await ctx.sock.groupRequestParticipantsUpdate(ctx.from, [jid], "reject");
      } catch (err) {
        return ctx.reply(`❌ Reject failed: ${(err as Error)?.message ?? err}`);
      }
      await ctx.reply(`❌ Rejected *${num}*.`);
    },
  },
];
