import type { Command, CommandContext } from "../types";
import { fetchJson } from "../http-utils";
import { getGroupMetadataCached, jidBase, participantHasNumber } from "../../group-meta";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Who a "meter" command targets: a @-mentioned user, the replied-to user, else the sender. */
function targetJid(ctx: CommandContext): string {
  const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
  const mentioned = ci?.mentionedJid ?? [];
  if (mentioned.length > 0) return mentioned[0];
  if (ci?.participant) return ci.participant;
  return ctx.sender;
}

function bar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

/** A flavor line for a ship compatibility score. */
function shipVerdict(pct: number): string {
  if (pct >= 80) return "💍 A match made in heaven!";
  if (pct >= 60) return "💖 There's real chemistry here!";
  if (pct >= 40) return "😊 Could work with a little effort.";
  if (pct >= 20) return "😬 It's... complicated.";
  return "💔 Maybe just stay friends.";
}

const JOKES = [
  "Why don't scientists trust atoms? Because they make up everything!",
  "I told my computer I needed a break, and it said 'No problem — I'll go to sleep.'",
  "Why did the scarecrow win an award? Because he was outstanding in his field!",
  "I would tell you a UDP joke, but you might not get it.",
  "Why do programmers prefer dark mode? Because light attracts bugs!",
  "How many programmers does it take to change a light bulb? None, that's a hardware problem.",
  "I'm reading a book about anti-gravity. It's impossible to put down!",
  "Why did the developer go broke? Because he used up all his cache.",
];

const QUOTES = [
  "The only way to do great work is to love what you do. — Steve Jobs",
  "Success is not final, failure is not fatal. — Winston Churchill",
  "The future belongs to those who believe in the beauty of their dreams. — Eleanor Roosevelt",
  "It always seems impossible until it's done. — Nelson Mandela",
  "Don't watch the clock; do what it does. Keep going. — Sam Levenson",
  "Believe you can and you're halfway there. — Theodore Roosevelt",
];

const FACTS = [
  "Honey never spoils. Archaeologists have found 3000-year-old honey still edible.",
  "Octopuses have three hearts and blue blood.",
  "Bananas are berries, but strawberries aren't.",
  "A day on Venus is longer than its year.",
  "The Eiffel Tower can be 15 cm taller during hot days.",
  "Sharks existed before trees did.",
];

const TRIVIA = [
  { q: "What is the largest planet in our solar system?", a: "Jupiter" },
  { q: "How many continents are there on Earth?", a: "7" },
  { q: "What is the chemical symbol for gold?", a: "Au" },
  { q: "Who painted the Mona Lisa?", a: "Leonardo da Vinci" },
  { q: "What is the fastest land animal?", a: "Cheetah" },
];

const PICKUPLINES = [
  "Are you a magician? Because whenever I look at you, everyone else disappears.",
  "Do you have a map? I keep getting lost in your eyes.",
  "Are you Wi-Fi? Because I'm really feeling a connection.",
  "If you were a vegetable, you'd be a cute-cumber.",
];

const FLIRTS = [
  "I must be a snowflake, because I've fallen for you.",
  "Is your name Google? Because you have everything I'm searching for.",
  "You must be tired, because you've been running through my mind all day.",
];

const INSULTS = [
  "You're as useful as a screen door on a submarine.",
  "I'd agree with you but then we'd both be wrong.",
  "You bring everyone so much joy... when you leave the room.",
];

const COMPLIMENTS = [
  "You light up every room you walk into.",
  "Your smile is contagious.",
  "You're more helpful than you realize.",
  "You have a great sense of humor.",
];

const ADVICE = [
  "Don't compare your beginning to someone else's middle.",
  "Progress is progress, no matter how small.",
  "Take the risk or lose the chance.",
  "Be patient. Good things take time.",
];

const WYR = [
  "Would you rather be able to fly or be invisible?",
  "Would you rather have unlimited money or unlimited time?",
  "Would you rather live without music or without movies?",
  "Would you rather always be 10 minutes late or 20 minutes early?",
];

const EIGHTBALL = [
  "It is certain.", "Without a doubt.", "Yes, definitely.", "Most likely.",
  "Ask again later.", "Cannot predict now.", "Don't count on it.",
  "My reply is no.", "Very doubtful.", "Signs point to yes.",
];

const HAPPY = [
  "😊 *Stay happy!* A smile is the shortest distance between two people.",
  "🌞 *Good vibes only!* Every day may not be good, but there's something good in every day.",
  "🌈 *Be happy!* Happiness is not something ready-made. It comes from your own actions.",
  "🎉 *You deserve to be happy!* Do what makes your soul shine.",
  "💖 *Spread happiness!* A kind word can change someone's entire day.",
  "✨ *Smile!* It's the best accessory you can wear today.",
  "🌸 *Choose joy.* Happiness blooms where you plant it.",
  "🥳 *Celebrate you!* You are doing better than you think.",
  "😄 *Positive energy!* Your mindset is your superpower.",
  "🌟 *Keep smiling!* The world always looks brighter with a smile.",
];

export const happyQuotes = HAPPY;

export const funCommands: Command[] = [
  { name: "joke", category: "FUN", desc: "Random joke", handler: async (ctx) => ctx.reply(`😂 ${pick(JOKES)}`) },
  { name: "quote", category: "FUN", desc: "Inspirational quote", handler: async (ctx) => ctx.reply(`💬 ${pick(QUOTES)}`) },
  { name: "happy", category: "FUN", desc: "Random happy message", handler: async (ctx) => ctx.reply(pick(HAPPY)) },
  { name: "fact", category: "FUN", desc: "Random fact", handler: async (ctx) => ctx.reply(`🧠 *Did you know?*\n${pick(FACTS)}`) },
  {
    name: "trivia",
    category: "FUN",
    desc: "Trivia question",
    handler: async (ctx) => {
      const t = pick(TRIVIA);
      await ctx.reply(`❓ *Trivia*\n${t.q}\n\n_Reply with your answer! (Answer: ||${t.a}||)_`);
    },
  },
  {
    name: "truthdetector",
    aliases: ["lie", "liedetector"],
    category: "FUN",
    desc: "Fake truth detector",
    handler: async (ctx) => {
      const pct = Math.floor(Math.random() * 101);
      const verdict = pct > 50 ? "✅ TRUTH" : "❌ LIE";
      await ctx.reply(`🔍 *Truth Detector*\n\nStatement analyzed...\nTruth level: *${pct}%*\nVerdict: ${verdict}`);
    },
  },
  {
    name: "8ball",
    aliases: ["8b"],
    category: "FUN",
    desc: "Ask the magic 8-ball",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`🎱 Ask a question.\nExample: *${ctx.prefix}8ball will I be rich?*`);
      await ctx.reply(`🎱 *Magic 8-Ball*\n❓ ${ctx.text}\n💫 ${pick(EIGHTBALL)}`);
    },
  },
  { name: "pickupline", aliases: ["pickup"], category: "FUN", desc: "Random pickup line", handler: async (ctx) => ctx.reply(`💘 ${pick(PICKUPLINES)}`) },
  { name: "flirt", category: "FUN", desc: "Random flirt line", handler: async (ctx) => ctx.reply(`😘 ${pick(FLIRTS)}`) },
  { name: "insult", category: "FUN", desc: "Playful insult", handler: async (ctx) => ctx.reply(`😈 ${pick(INSULTS)}`) },
  { name: "compliment", category: "FUN", desc: "Nice compliment", handler: async (ctx) => ctx.reply(`🌟 ${pick(COMPLIMENTS)}`) },
  { name: "advice", category: "FUN", desc: "Life advice", handler: async (ctx) => ctx.reply(`🧭 ${pick(ADVICE)}`) },
  { name: "wouldyourather", aliases: ["wyr"], category: "FUN", desc: "Would you rather", handler: async (ctx) => ctx.reply(`🤔 ${pick(WYR)}`) },
  {
    name: "rate",
    category: "FUN",
    desc: "Rate something",
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}rate <thing>*`);
      await ctx.reply(`📊 I rate "${ctx.text}" a *${Math.floor(Math.random() * 11)}/10*`);
    },
  },
  {
    name: "ship",
    category: "FUN",
    desc: "Ship two random group members (or two names)",
    handler: async (ctx) => {
      // If two names are typed, keep the classic love-calculator behavior.
      if (ctx.text) {
        await ctx.reply(
          `💞 *Love Calculator*\n${ctx.text}\nCompatibility: *${Math.floor(Math.random() * 101)}%*`,
        );
        return;
      }
      // No names + in a group → ship two random members and tag them.
      if (!ctx.isGroup) {
        await ctx.reply(
          `Usage: *${ctx.prefix}ship name1 name2* — or use it in a group to ship two random members.`,
        );
        return;
      }
      const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
      if (!meta) {
        await ctx.reply("❌ Couldn't read the group members right now.");
        return;
      }
      // Exclude the bot itself — LID/phone-aware, since a participant's id may
      // be an `@lid` while `sock.user.id` is a phone JID (a bare jidBase compare
      // would miss it and let the bot get shipped).
      const members = meta.participants
        .filter((p) => !participantHasNumber(p, ctx.sock.user?.id))
        .map((p) => p.id);
      if (members.length < 2) {
        await ctx.reply("❌ Need at least 2 other members to ship.");
        return;
      }
      const i = Math.floor(Math.random() * members.length);
      let j = Math.floor(Math.random() * members.length);
      while (j === i) j = Math.floor(Math.random() * members.length);
      const a = members[i];
      const b = members[j];
      const pct = Math.floor(Math.random() * 101);
      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: `💘 *Ship of the day!*\n\n@${jidBase(a)} ❤️ @${jidBase(b)}\n\nCompatibility: *${pct}%*\n${shipVerdict(pct)}`,
          mentions: [a, b],
        },
        { quoted: ctx.msg },
      );
    },
  },
  {
    name: "meme",
    category: "FUN",
    desc: "Random meme",
    handler: async (ctx) => {
      try {
        const data = await fetchJson<{ url: string; title: string; subreddit: string }>("https://meme-api.com/gimme");
        if (!data.url) throw new Error("no meme");
        await ctx.sock.sendMessage(
          ctx.from,
          { image: { url: data.url }, caption: `😂 ${data.title}\n— r/${data.subreddit}` },
          { quoted: ctx.msg },
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch a meme right now. Try again later.");
      }
    },
  },
  {
    name: "simp",
    category: "FUN",
    desc: "Simp meter",
    handler: async (ctx) => {
      const jid = targetJid(ctx);
      const pct = Math.floor(Math.random() * 101);
      await ctx.sock.sendMessage(
        ctx.from,
        { text: `🤤 *Simp Meter*\n\n@${jidBase(jid)} is *${pct}%* simp\n${bar(pct)}`, mentions: [jid] },
        { quoted: ctx.msg },
      );
    },
  },
  {
    name: "iq",
    category: "FUN",
    desc: "IQ meter",
    handler: async (ctx) => {
      const jid = targetJid(ctx);
      const iq = Math.floor(Math.random() * 181) + 20; // 20–200
      await ctx.sock.sendMessage(
        ctx.from,
        { text: `🧠 *IQ Test*\n\n@${jidBase(jid)} has an IQ of *${iq}*`, mentions: [jid] },
        { quoted: ctx.msg },
      );
    },
  },
  {
    name: "single",
    category: "FUN",
    desc: "Single meter",
    handler: async (ctx) => {
      const jid = targetJid(ctx);
      const pct = Math.floor(Math.random() * 101);
      await ctx.sock.sendMessage(
        ctx.from,
        { text: `💔 *Single Meter*\n\n@${jidBase(jid)} is *${pct}%* forever alone\n${bar(pct)}`, mentions: [jid] },
        { quoted: ctx.msg },
      );
    },
  },
  {
    name: "pp",
    aliases: ["ppsize"],
    category: "FUN",
    desc: "PP size meter (joke)",
    handler: async (ctx) => {
      const jid = targetJid(ctx);
      const size = Math.floor(Math.random() * 16);
      await ctx.sock.sendMessage(
        ctx.from,
        { text: `🍆 *PP Size*\n\n@${jidBase(jid)}\n8${"=".repeat(size)}D`, mentions: [jid] },
        { quoted: ctx.msg },
      );
    },
  },
  {
    name: "couple",
    aliases: ["coupleoftheday"],
    category: "FUN",
    groupOnly: true,
    desc: "Pick the couple of the day",
    handler: async (ctx) => {
      const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
      if (!meta) {
        await ctx.reply("❌ Couldn't read the group members right now.");
        return;
      }
      const members = meta.participants
        .filter((p) => !participantHasNumber(p, ctx.sock.user?.id))
        .map((p) => p.id);
      if (members.length < 2) {
        await ctx.reply("❌ Need at least 2 other members for a couple.");
        return;
      }
      const i = Math.floor(Math.random() * members.length);
      let j = Math.floor(Math.random() * members.length);
      while (j === i) j = Math.floor(Math.random() * members.length);
      const pct = Math.floor(Math.random() * 41) + 60; // 60–100
      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: `💑 *Couple of the day!*\n\n@${jidBase(members[i])} 💕 @${jidBase(members[j])}\n\nLove score: *${pct}%*\n${bar(pct)}`,
          mentions: [members[i], members[j]],
        },
        { quoted: ctx.msg },
      );
    },
  },
];
