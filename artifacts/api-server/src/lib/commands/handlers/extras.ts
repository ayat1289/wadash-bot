import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadMediaMessage, type WAMessage } from "@whiskeysockets/baileys";
import type { Command, CommandContext } from "../types";
import { fetchBuffer, fetchText } from "../http-utils";
import { isPublicHttpUrl } from "../url-utils";
import { runProcess } from "../proc";
import { getFfmpegPath } from "../ffmpeg";
import { tryAcquire } from "../limiter";
import { getGroupMetadataCached, jidBase, participantHasNumber } from "../../group-meta";
import { logger } from "../../logger";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// In-memory stores (mirror afk-store: bounded, lost on restart).
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

const marriages = new Map<string, string>();
const rules = new Map<string, string>();
const pins = new Map<string, string>();
const notes = new Map<string, string[]>();
const todos = new Map<string, string[]>();
const pastes = new Map<string, string>();
export const customCommands = new Map<string, string>();
const timers = new Map<string, number>();

function groupKey(ctx: CommandContext, suffix = ""): string {
  return `${ctx.tenantId}:${jidBase(ctx.from)}${suffix}`;
}
function userKey(ctx: CommandContext): string {
  return `${ctx.tenantId}:${jidBase(ctx.sender)}`;
}

// ---------------------------------------------------------------------------
// .addcmd / .delcmd / .listcmd — per-group custom text commands
// ---------------------------------------------------------------------------

async function addcmdHandler(ctx: CommandContext): Promise<void> {
  const [name, ...rest] = ctx.args;
  if (!name || rest.length === 0) {
    await ctx.reply(
      `Usage: *${ctx.prefix}addcmd <name> <reply text>*\nCreates a custom command for this group.`,
    );
    return;
  }
  const clean = name.toLowerCase();
  if (clean.startsWith("addcmd") || clean.startsWith("delcmd") || clean.startsWith("listcmd")) {
    await ctx.reply("❌ That name is reserved.");
    return;
  }
  boundedInsert(customCommands, `${groupKey(ctx)}:${clean}`, rest.join(" "));
  await ctx.reply(`✅ Custom command *${ctx.prefix}${clean}* created.`);
}

async function delcmdHandler(ctx: CommandContext): Promise<void> {
  const name = ctx.args[0]?.toLowerCase();
  if (!name) {
    await ctx.reply(`Usage: *${ctx.prefix}delcmd <name>*`);
    return;
  }
  const k = `${groupKey(ctx)}:${name}`;
  if (customCommands.delete(k)) await ctx.reply(`🗑️ Removed custom command *${ctx.prefix}${name}*.`);
  else await ctx.reply("❌ No such custom command.");
}

async function listcmdHandler(ctx: CommandContext): Promise<void> {
  const prefix = `${groupKey(ctx)}:`;
  const names: string[] = [];
  for (const [k] of customCommands) {
    if (k.startsWith(prefix)) names.push(k.slice(prefix.length));
  }
  if (names.length === 0) {
    await ctx.reply("📭 No custom commands in this group yet.");
    return;
  }
  await ctx.reply(`📋 *Custom commands:*\n${names.map((n) => `${ctx.prefix}${n}`).join("\n")}`);
}

export async function findCustomCommand(ctx: CommandContext, name: string): Promise<string | null> {
  return customCommands.get(`${groupKey(ctx)}:${name}`) ?? null;
}

// ---------------------------------------------------------------------------
// .rules / .setrules — group rules (admin)
// ---------------------------------------------------------------------------

async function setrulesHandler(ctx: CommandContext): Promise<void> {
  if (!ctx.text) {
    await ctx.reply(`Usage: *${ctx.prefix}setrules <rules text>*`);
    return;
  }
  boundedInsert(rules, groupKey(ctx), ctx.text);
  await ctx.reply("📜 Group rules updated.");
}

async function rulesHandler(ctx: CommandContext): Promise<void> {
  const r = rules.get(groupKey(ctx));
  await ctx.reply(r ? `📜 *Group rules:*\n${r}` : "📭 No rules set yet. Admin: use `.setrules <text>`.");
}

// ---------------------------------------------------------------------------
// .pin / .unpin / .getpin — group pinboard (in-memory)
// ---------------------------------------------------------------------------

async function pinHandler(ctx: CommandContext): Promise<void> {
  const text = ctx.text || ctx.quotedText;
  if (!text) {
    await ctx.reply(`Usage: *${ctx.prefix}pin <text>* — or reply to a message.`);
    return;
  }
  boundedInsert(pins, groupKey(ctx), text);
  await ctx.reply("📌 Pinned!");
}

async function unpinHandler(ctx: CommandContext): Promise<void> {
  pins.delete(groupKey(ctx));
  await ctx.reply("📌 Pin removed.");
}

async function getpinHandler(ctx: CommandContext): Promise<void> {
  const p = pins.get(groupKey(ctx));
  await ctx.reply(p ? `📌 *Pinned:*\n${p}` : "📭 Nothing pinned here.");
}

// ---------------------------------------------------------------------------
// .note / .notes / .getnote / .delnote — personal notes
// ---------------------------------------------------------------------------

async function noteHandler(ctx: CommandContext): Promise<void> {
  if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}note <text>* — saves a personal note.`);
  const list = notes.get(userKey(ctx)) ?? [];
  list.push(ctx.text);
  boundedInsert(notes, userKey(ctx), list);
  await ctx.reply(`✅ Note saved (#${list.length}).`);
}

async function notesHandler(ctx: CommandContext): Promise<void> {
  const list = notes.get(userKey(ctx)) ?? [];
  if (list.length === 0) return ctx.reply("📭 You have no notes. Use `.note <text>` to save one.");
  await ctx.reply(`🗒️ *Your notes (${list.length}):*\n${list.map((n, i) => `${i + 1}. ${n}`).join("\n")}`);
}

async function getnoteHandler(ctx: CommandContext): Promise<void> {
  const n = Number(ctx.args[0]);
  const list = notes.get(userKey(ctx)) ?? [];
  if (!n || n < 1 || n > list.length) return ctx.reply(`Usage: *${ctx.prefix}getnote <number>* (see ${ctx.prefix}notes)`);
  await ctx.reply(`🗒️ *Note #${n}:*\n${list[n - 1]}`);
}

async function delnoteHandler(ctx: CommandContext): Promise<void> {
  const n = Number(ctx.args[0]);
  const list = notes.get(userKey(ctx)) ?? [];
  if (!n || n < 1 || n > list.length) return ctx.reply(`Usage: *${ctx.prefix}delnote <number>*`);
  list.splice(n - 1, 1);
  boundedInsert(notes, userKey(ctx), list);
  await ctx.reply("🗑️ Note deleted.");
}

// ---------------------------------------------------------------------------
// .todo / .todos / .donetodo / .deltodo — personal to-do list
// ---------------------------------------------------------------------------

async function todoHandler(ctx: CommandContext): Promise<void> {
  if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}todo <task>* — adds to your to-do list.`);
  const list = todos.get(userKey(ctx)) ?? [];
  list.push(ctx.text);
  boundedInsert(todos, userKey(ctx), list);
  await ctx.reply(`✅ To-do added (#${list.length}).`);
}

async function todosHandler(ctx: CommandContext): Promise<void> {
  const list = todos.get(userKey(ctx)) ?? [];
  if (list.length === 0) return ctx.reply("📭 Nothing on your to-do list. Use `.todo <task>`.");
  await ctx.reply(`✅ *Your to-dos (${list.length}):*\n${list.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);
}

async function deltodoHandler(ctx: CommandContext): Promise<void> {
  const n = Number(ctx.args[0]);
  const list = todos.get(userKey(ctx)) ?? [];
  if (!n || n < 1 || n > list.length) return ctx.reply(`Usage: *${ctx.prefix}deltodo <number>*`);
  list.splice(n - 1, 1);
  boundedInsert(todos, userKey(ctx), list);
  await ctx.reply("🗑️ To-do removed.");
}

async function donetodoHandler(ctx: CommandContext): Promise<void> {
  const n = Number(ctx.args[0]);
  const list = todos.get(userKey(ctx)) ?? [];
  if (!n || n < 1 || n > list.length) return ctx.reply(`Usage: *${ctx.prefix}donetodo <number>*`);
  const done = list.splice(n - 1, 1)[0];
  boundedInsert(todos, userKey(ctx), list);
  await ctx.reply(`🎉 Done: ${done}`);
}

// ---------------------------------------------------------------------------
// .timer / .countdown — scheduled reply
// ---------------------------------------------------------------------------

async function timerHandler(ctx: CommandContext): Promise<void> {
  const secs = Number(ctx.args[0]);
  const msg = ctx.args.slice(1).join(" ") || "⏰ Time's up!";
  if (!secs || secs < 1 || secs > 86400) {
    return ctx.reply(`Usage: *${ctx.prefix}timer <seconds> [message]* (max 24h)`);
  }
  if (timers.has(ctx.sender)) return ctx.reply("⏳ You already have a timer running.");
  timers.set(ctx.sender, secs);
  await ctx.reply(`⏰ Timer set for *${secs}s*.`);
  setTimeout(() => {
    timers.delete(ctx.sender);
    void ctx.sock
      .sendMessage(ctx.from, { text: `⏰ *${ctx.pushName}*, your timer is up!\n${msg}` }, { quoted: ctx.msg })
      .catch(() => {});
  }, secs * 1000);
}

// ---------------------------------------------------------------------------
// .paste / .getpaste — simple shared snippets
// ---------------------------------------------------------------------------

async function pasteHandler(ctx: CommandContext): Promise<void> {
  const [key, ...rest] = ctx.args;
  if (!key || rest.length === 0) {
    return ctx.reply(`Usage: *${ctx.prefix}paste <key> <content>* — then anyone can view it with ${ctx.prefix}getpaste <key>`);
  }
  boundedInsert(pastes, `${ctx.tenantId}:${key.toLowerCase()}`, rest.join(" "));
  await ctx.reply(`📄 Saved to paste *${key}*.\nView: ${ctx.prefix}getpaste ${key}`);
}

async function getpasteHandler(ctx: CommandContext): Promise<void> {
  const key = ctx.args[0]?.toLowerCase();
  const p = key ? pastes.get(`${ctx.tenantId}:${key}`) : undefined;
  await ctx.reply(p ? `📄 *${key}:*\n${p}` : `❌ No paste found. Try *${ctx.prefix}paste <key> <content>*`);
}

// ---------------------------------------------------------------------------
// .fetch — fetch a public URL as text
// ---------------------------------------------------------------------------

async function fetchHandler(ctx: CommandContext): Promise<void> {
  const url = ctx.args[0] ?? "";
  if (!/^https?:\/\//i.test(url) || !isPublicHttpUrl(url)) {
    return ctx.reply("❌ Only public http(s) URLs are allowed.");
  }
  try {
    const text = await fetchText(url, 15000);
    await ctx.reply(`🌐 *${url}*\n\n${text.slice(0, 2000)}`);
  } catch {
    await ctx.reply("❌ Couldn't fetch that URL.");
  }
}

// ---------------------------------------------------------------------------
// .timezone — current time for a zone / list
// ---------------------------------------------------------------------------

const ZONES = ["UTC", "Asia/Karachi", "Asia/Kolkata", "Asia/Dubai", "Asia/Riyadh", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];

async function timezoneHandler(ctx: CommandContext): Promise<void> {
  const tz = ctx.args[0] ?? "Asia/Karachi";
  try {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "medium",
    }).format(new Date());
    await ctx.reply(`🕒 *${tz}*\n${time}\n\nAvailable: ${ZONES.join(", ")}`);
  } catch {
    await ctx.reply(`❌ Unknown timezone. Available: ${ZONES.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// .morse — text ⇄ morse
// ---------------------------------------------------------------------------

const MORSE: Record<string, string> = {
  a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....",
  i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.",
  q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-",
  y: "-.--", z: "--..", "0": "-----", "1": ".----", "2": "..---", "3": "...--",
  "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
};
const REVERSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

async function morseHandler(ctx: CommandContext): Promise<void> {
  const input = ctx.text.trim();
  if (!input) return ctx.reply(`Usage: *${ctx.prefix}morse <text>* — encode, or paste dots/dashes to decode.`);
  const looksLikeMorse = /^[.\- /]+$/.test(input);
  if (looksLikeMorse) {
    const decoded = input
      .split(/\s{2,}|\//)
      .map((w) => w.split(/\s+/).map((c) => REVERSE[c] ?? "?").join(""))
      .join(" ");
    await ctx.reply(`🔤 *Decoded:* ${decoded}`);
  } else {
    const encoded = input
      .toLowerCase()
      .split("")
      .map((c) => MORSE[c] ?? "")
      .filter(Boolean)
      .join(" ");
    await ctx.reply(`📡 *Morse:* ${encoded}`);
  }
}

// ---------------------------------------------------------------------------
// .compressvideo — shrink a replied-to video with ffmpeg
// ---------------------------------------------------------------------------

const COMPRESS_MAX_BYTES = 24 * 1024 * 1024;

async function quotedMedia(ctx: CommandContext): Promise<{ target: WAMessage; inner: unknown; kind: string } | null> {
  const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ci?.quotedMessage;
  if (!quoted) return null;
  const kind = quoted.videoMessage ? "video" : quoted.imageMessage ? "image" : quoted.audioMessage ? "audio" : quoted.documentMessage ? "document" : "";
  if (!kind) return null;
  return {
    target: {
      key: {
        remoteJid: ctx.from,
        fromMe: false,
        id: ci?.stanzaId ?? undefined,
        participant: ci?.participant ?? undefined,
      },
      message: quoted,
    } as WAMessage,
    inner: quoted,
    kind,
  };
}

async function compressvideoHandler(ctx: CommandContext): Promise<void> {
  const q = await quotedMedia(ctx);
  if (!q || q.kind !== "video") {
    await ctx.reply("🎞️ Reply to a *video* with this command to compress it.");
    return;
  }
  const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
  if (!slot.ok) {
    await ctx.reply(slot.reason);
    return;
  }
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "compress-"));
    await ctx.react("⏳");
    const buffer = (await downloadMediaMessage(
      q.target,
      "buffer",
      {},
      { logger, reuploadRequest: ctx.sock.updateMediaMessage },
    )) as Buffer;
    const inPath = join(dir, "in.bin");
    const outPath = join(dir, "out.mp4");
    await writeFile(inPath, buffer);
    const { code } = await runProcess(
      getFfmpegPath(),
      [
        "-y", "-i", inPath,
        "-vf", "scale='min(720,iw)':-2:flags=lanczos",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-c:a", "aac", "-b:a", "64k",
        "-fs", String(COMPRESS_MAX_BYTES),
        "-movflags", "+faststart",
        outPath,
      ],
      { timeoutMs: 120_000 },
    );
    if (code !== 0) {
      await ctx.react("❌");
      await ctx.reply("❌ Couldn't compress that video.");
      return;
    }
    const out = await readFile(outPath).catch(() => null);
    if (!out || out.length === 0 || out.length > COMPRESS_MAX_BYTES) {
      await ctx.react("❌");
      await ctx.reply("❌ Compressed file is too large to send.");
      return;
    }
    await ctx.sock.sendMessage(
      ctx.from,
      { document: out, mimetype: "video/mp4", fileName: "compressed.mp4", caption: `📦 Compressed video (${(out.length / 1048576).toFixed(1)} MB)` },
      { quoted: ctx.msg },
    );
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err }, "compressvideo failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't compress that video right now.");
  } finally {
    slot.release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// .memegen — generate a meme image via api.memegen.link
// ---------------------------------------------------------------------------

const MEME_TEMPLATES = ["drake", "disastergirl", "stonks", "buzz", "ugandanknuck"];

function memeEscape(s: string): string {
  return s
    .replace(/-/g, "~h")
    .replace(/\//g, "~s")
    .replace(/_/g, "~u")
    .replace(/\?/g, "~q")
    .replace(/!/g, "~excl")
    .replace(/ /g, "_");
}

async function memegenHandler(ctx: CommandContext): Promise<void> {
  const [top, bottom] = ctx.text.split("|").map((s) => s.trim());
  if (!top || !bottom) {
    return ctx.reply(`Usage: *${ctx.prefix}memegen top text | bottom text*`);
  }
  const tpl = pick(MEME_TEMPLATES);
  const url = `https://api.memegen.link/images/${tpl}/${memeEscape(top)}/${memeEscape(bottom)}.png`;
  try {
    const { buffer } = await fetchBuffer(url, { maxBytes: 4 * 1024 * 1024, timeoutMs: 20000 });
    await ctx.sock.sendMessage(
      ctx.from,
      { image: buffer, caption: `😅 *${top}* | *${bottom}*` },
      { quoted: ctx.msg },
    );
  } catch {
    await ctx.reply("❌ Couldn't generate that meme right now.");
  }
}

// ---------------------------------------------------------------------------
// Random group-member helper for games
// ---------------------------------------------------------------------------

async function randomMember(ctx: CommandContext): Promise<string | null> {
  if (!ctx.isGroup) return null;
  const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
  if (!meta) return null;
  const members = meta.participants
    .filter((p) => !participantHasNumber(p, ctx.sock.user?.id))
    .map((p) => p.id);
  if (members.length === 0) return null;
  return pick(members);
}

// ---------------------------------------------------------------------------
// .marry / .divorce / .marriages / .randomcouple
// ---------------------------------------------------------------------------

async function marryHandler(ctx: CommandContext): Promise<void> {
  const name = ctx.text.trim();
  if (!name) return ctx.reply(`Usage: *${ctx.prefix}marry <name>*`);
  const me = userKey(ctx);
  if (marriages.has(me)) return ctx.reply("💍 You're already married! Use `.divorce` first.");
  if (name === ctx.pushName) return ctx.reply("😅 You can't marry yourself!");
  boundedInsert(marriages, me, name);
  await ctx.reply(`💍 *${ctx.pushName}* just married *${name}*! Congratulations! 🎉`);
}

async function divorceHandler(ctx: CommandContext): Promise<void> {
  if (marriages.delete(userKey(ctx))) await ctx.reply("💔 Divorced. Take care of yourself.");
  else await ctx.reply("❌ You're not married.");
}

async function marriagesHandler(ctx: CommandContext): Promise<void> {
  const prefix = `${ctx.tenantId}:`;
  const list: string[] = [];
  for (const [k, v] of marriages) {
    if (k.startsWith(prefix)) list.push(`• ${k.slice(prefix.length)} 💍 ${v}`);
  }
  await ctx.reply(list.length ? `💞 *Marriages:*\n${list.join("\n")}` : "📭 No marriages yet.");
}

async function randomcoupleHandler(ctx: CommandContext): Promise<void> {
  const names = ctx.text ? ctx.text.split(/[\s,]+/).filter(Boolean) : [];
  if (names.length < 2) {
    const a = await randomMember(ctx);
    const b = await randomMember(ctx);
    if (!a || !b || a === b) return ctx.reply("❌ Give me names or use it in a group: `.randomcouple`.");
    await ctx.sock.sendMessage(
      ctx.from,
      { text: `💑 Random couple:\n\n@${jidBase(a)} 💕 @${jidBase(b)}`, mentions: [a, b] },
      { quoted: ctx.msg },
    );
    return;
  }
  const i = Math.floor(Math.random() * names.length);
  let j = Math.floor(Math.random() * names.length);
  while (j === i) j = Math.floor(Math.random() * names.length);
  await ctx.reply(`💑 Random couple: *${names[i]}* 💕 *${names[j]}*`);
}

// ---------------------------------------------------------------------------
// Fun one-liners
// ---------------------------------------------------------------------------

const ROASTS = [
  "You're the human equivalent of a browser tab that won't close.",
  "If I wanted to hear from an idiot, I'd check your chat history.",
  "You bring everyone so much joy... when you leave the room.",
  "You're proof that evolution can go in reverse.",
  "I'd tell you a joke, but you'd think I was describing you.",
  "You're not stupid; you just have bad luck thinking.",
  "Your secrets are safe with me. I never listen anyway.",
  "You have the kind of face that makes radio a good idea.",
];

const NHIE = [
  "Never have I ever sent a message to the wrong chat.",
  "Never have I ever eaten an entire pizza alone.",
  "Never have I ever fallen asleep mid-conversation.",
  "Never have I ever replayed my own voice message.",
  "Never have I ever pretended to laugh at a joke I didn't get.",
  "Never have I ever texted an ex at 2am.",
  "Never have I ever stalked someone's profile.",
  "Never have I ever cried at a movie.",
];

const EMOJI_QUIZ = [
  { emoji: "🍕", name: "pizza" },
  { emoji: "🐬", name: "dolphin" },
  { emoji: "🦄", name: "unicorn" },
  { emoji: "🍔", name: "burger" },
  { emoji: "🐧", name: "penguin" },
  { emoji: "🎸", name: "guitar" },
  { emoji: "🛸", name: "ufo" },
  { emoji: "🌮", name: "taco" },
  { emoji: "🦍", name: "gorilla" },
  { emoji: "🧠", name: "brain" },
];

const QUOTE_TPL = [
  (q: string, a: string) => `“${q}”\n\n— ${a}`,
  (q: string, a: string) => `"${q}"\n   ~ ${a}`,
  (q: string, a: string) => `📜 *Quote*\n“${q}”\n\n_by ${a}_`,
];

export const extrasCommands: Command[] = [
  // FUN
  {
    name: "qmaker",
    category: "FUN",
    desc: "Make a quote: qmaker <text> | <author>",
    handler: async (ctx) => {
      const [q, a] = ctx.text.split("|").map((s) => s.trim());
      if (!q || !a) return ctx.reply(`Usage: *${ctx.prefix}qmaker <quote> | <author>*`);
      await ctx.reply(pick(QUOTE_TPL)(q, a));
    },
  },
  { name: "roast", category: "FUN", desc: "Roast someone", handler: async (ctx) => ctx.reply(`🔥 ${pick(ROASTS)}`) },
  {
    name: "memegen",
    category: "FUN",
    desc: "Meme generator: memegen top | bottom",
    handler: memegenHandler,
  },
  { name: "marry", category: "FUN", desc: "Marry someone", handler: marryHandler },
  { name: "divorce", category: "FUN", desc: "Divorce", handler: divorceHandler },
  { name: "marriages", category: "FUN", desc: "List all marriages", handler: marriagesHandler },
  { name: "randomcouple", category: "FUN", desc: "Pick a random couple", handler: randomcoupleHandler },

  // GAMES
  {
    name: "coinflip",
    category: "GAMES",
    desc: "Heads or tails",
    handler: async (ctx) => {
      const result = Math.random() < 0.5 ? "Heads 🪙" : "Tails 🪙";
      await ctx.react("🪙");
      await ctx.reply(`🪙 *Coinflip:* ${result}`);
    },
  },
  {
    name: "dice",
    category: "GAMES",
    desc: "Roll dice (NdM or plain)",
    handler: async (ctx) => {
      const m = /^(\d*)d(\d+)$/i.exec(ctx.text.trim());
      const [n, s] = m ? [Math.min(Number(m[1]) || 1, 10), Number(m[2])] : [1, 6];
      const rolls = Array.from({ length: n }, () => Math.floor(Math.random() * s) + 1);
      await ctx.reply(`🎲 *Dice:* ${rolls.join(", ")}${n > 1 ? ` = *${rolls.reduce((a, b) => a + b)}*` : ""}`);
    },
  },
  {
    name: "lucky",
    category: "GAMES",
    desc: "Lucky number",
    handler: async (ctx) => {
      const n = Math.floor(Math.random() * 100) + 1;
      await ctx.reply(`🍀 Your lucky number is *${n}*!`);
    },
  },
  {
    name: "guesstheemoji",
    category: "GAMES",
    desc: "Guess the emoji",
    handler: async (ctx) => {
      const e = pick(EMOJI_QUIZ);
      await ctx.reply(`🤔 What is this emoji?\n\n${e.emoji}\n\n_Answer: ||${e.name}||_`);
    },
  },
  {
    name: "neverhaveiever",
    category: "GAMES",
    desc: "Never have I ever",
    handler: async (ctx) => ctx.reply(`🙈 *Never have I ever...*\n${pick(NHIE)}`),
  },
  {
    name: "spinthebottle",
    category: "GAMES",
    desc: "Spin the bottle (group)",
    handler: async (ctx) => {
      const m = await randomMember(ctx);
      if (!m) return ctx.reply("❌ Use this in a group.");
      await ctx.sock.sendMessage(
        ctx.from,
        { text: `🍾 The bottle points at...\n\n@${jidBase(m)}`, mentions: [m] },
        { quoted: ctx.msg },
      );
    },
  },

  // GROUP
  { name: "rules", category: "GROUP", desc: "Show group rules", handler: rulesHandler },
  { name: "setrules", category: "GROUP", adminOnly: true, desc: "Set group rules", handler: setrulesHandler },
  { name: "addcmd", category: "GROUP", adminOnly: true, desc: "Add a custom command", handler: addcmdHandler },
  { name: "delcmd", aliases: ["removecmd"], category: "GROUP", adminOnly: true, desc: "Delete a custom command", handler: delcmdHandler },
  { name: "listcmd", aliases: ["listcmds", "cmds"], category: "GROUP", desc: "List custom commands", handler: listcmdHandler },
  { name: "pin", category: "GROUP", adminOnly: true, desc: "Pin a message", handler: pinHandler },
  { name: "unpin", category: "GROUP", adminOnly: true, desc: "Unpin", handler: unpinHandler },
  { name: "getpin", category: "GROUP", desc: "Show pinned text", handler: getpinHandler },

  // TOOLS
  { name: "note", category: "TOOLS", desc: "Save a note", handler: noteHandler },
  { name: "notes", category: "TOOLS", desc: "List your notes", handler: notesHandler },
  { name: "getnote", category: "TOOLS", desc: "View a note", handler: getnoteHandler },
  { name: "delnote", category: "TOOLS", desc: "Delete a note", handler: delnoteHandler },
  { name: "todo", category: "TOOLS", desc: "Add a to-do", handler: todoHandler },
  { name: "todos", category: "TOOLS", desc: "List to-dos", handler: todosHandler },
  { name: "donetodo", category: "TOOLS", desc: "Mark to-do done", handler: donetodoHandler },
  { name: "deltodo", category: "TOOLS", desc: "Delete a to-do", handler: deltodoHandler },
  { name: "timer", category: "TOOLS", desc: "Set a timer", handler: timerHandler },
  { name: "countdown", category: "TOOLS", desc: "Countdown timer", handler: timerHandler },
  { name: "paste", category: "TOOLS", desc: "Save a snippet", handler: pasteHandler },
  { name: "getpaste", category: "TOOLS", desc: "View a snippet", handler: getpasteHandler },
  { name: "fetch", category: "TOOLS", desc: "Fetch a public URL", handler: fetchHandler },
  { name: "timezone", category: "TOOLS", desc: "Time in a timezone", handler: timezoneHandler },
  { name: "morse", category: "TOOLS", desc: "Morse encode/decode", handler: morseHandler },
];
