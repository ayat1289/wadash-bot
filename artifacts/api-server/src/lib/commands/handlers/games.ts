import type { Command } from "../types";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const TRUTHS = [
  "What is your biggest fear?",
  "What is the most embarrassing thing you've ever done?",
  "Who was your first crush?",
  "What is a secret you've never told anyone?",
  "What is the worst lie you've ever told?",
  "What is your most awkward moment?",
];

const DARES = [
  "Send the last photo in your gallery.",
  "Text your crush 'hi' right now.",
  "Do 10 push-ups and tell us when done.",
  "Speak in an accent for the next 3 messages.",
  "Send a voice note singing your favorite song.",
  "Change your profile picture to a meme for 1 hour.",
];

const RIDDLES = [
  { q: "What has keys but can't open locks?", a: "A piano" },
  { q: "What gets wetter the more it dries?", a: "A towel" },
  { q: "What has a head and a tail but no body?", a: "A coin" },
  { q: "What can travel around the world while staying in a corner?", a: "A stamp" },
];

export const gamesCommands: Command[] = [
  { name: "truth", category: "GAMES", desc: "Truth question", handler: async (ctx) => ctx.reply(`🤫 *Truth*\n${pick(TRUTHS)}`) },
  { name: "dare", category: "GAMES", desc: "Dare challenge", handler: async (ctx) => ctx.reply(`🔥 *Dare*\n${pick(DARES)}`) },
  {
    name: "truthordare",
    aliases: ["tod"],
    category: "GAMES",
    desc: "Random truth or dare",
    handler: async (ctx) => {
      const isTruth = Math.random() < 0.5;
      await ctx.reply(isTruth ? `🤫 *Truth*\n${pick(TRUTHS)}` : `🔥 *Dare*\n${pick(DARES)}`);
    },
  },
  {
    name: "rps",
    category: "GAMES",
    desc: "Rock paper scissors",
    handler: async (ctx) => {
      const choices = ["rock", "paper", "scissors"];
      const user = ctx.text.toLowerCase().trim();
      if (!choices.includes(user)) return ctx.reply(`✊ ✋ ✌️ Usage: *${ctx.prefix}rps rock|paper|scissors*`);
      const bot = pick(choices);
      let result = "It's a tie!";
      if ((user === "rock" && bot === "scissors") || (user === "paper" && bot === "rock") || (user === "scissors" && bot === "paper")) {
        result = "You win! 🎉";
      } else if (user !== bot) {
        result = "I win! 🤖";
      }
      await ctx.reply(`🎮 *Rock Paper Scissors*\nYou: ${user}\nMe: ${bot}\n\n${result}`);
    },
  },
  {
    name: "math",
    aliases: ["mathgame"],
    category: "GAMES",
    desc: "Math challenge",
    handler: async (ctx) => {
      const a = Math.floor(Math.random() * 50) + 1;
      const b = Math.floor(Math.random() * 50) + 1;
      const ops = ["+", "-", "*"];
      const op = pick(ops);
      const ans = op === "+" ? a + b : op === "-" ? a - b : a * b;
      await ctx.reply(`🧮 *Math Challenge*\nSolve: *${a} ${op} ${b}*\n\n_Answer: ||${ans}||_`);
    },
  },
  {
    name: "riddle",
    category: "GAMES",
    desc: "Random riddle",
    handler: async (ctx) => {
      const r = pick(RIDDLES);
      await ctx.reply(`🧩 *Riddle*\n${r.q}\n\n_Answer: ||${r.a}||_`);
    },
  },
  {
    name: "guess",
    category: "GAMES",
    desc: "Guess the number (1-10)",
    handler: async (ctx) => {
      const n = parseInt(ctx.text.trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > 10) return ctx.reply(`🔢 Guess a number 1-10.\nUsage: *${ctx.prefix}guess 7*`);
      const secret = Math.floor(Math.random() * 10) + 1;
      await ctx.reply(n === secret ? `🎉 Correct! It was ${secret}.` : `❌ Wrong! It was ${secret}. Try again.`);
    },
  },
];
