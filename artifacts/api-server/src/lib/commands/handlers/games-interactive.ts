import type { WASocket } from "@whiskeysockets/baileys";
import type { Command, CommandContext, WAMessage } from "../types";
import { jidBase } from "../../group-meta";
import {
  getGame,
  setGame,
  clearGame,
  type HangmanGame,
  type TicTacToeGame,
  type WordChainGame,
} from "../pending-games";

const HANGMAN_WORDS = [
  "python",
  "javascript",
  "computer",
  "keyboard",
  "internet",
  "elephant",
  "mountain",
  "rainbow",
  "guitar",
  "diamond",
  "pyramid",
  "volcano",
  "dolphin",
  "penguin",
  "octopus",
  "giraffe",
  "kangaroo",
  "chocolate",
  "umbrella",
  "butterfly",
  "telephone",
  "hospital",
  "language",
  "treasure",
  "adventure",
  "midnight",
  "sandwich",
  "football",
  "birthday",
  "universe",
];

const MAX_WRONG = 6;
const WORDCHAIN_START_LETTERS = "abcdefghilmnoprstuw".split("");

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ---------------------------------- hangman --------------------------------- */

function renderHangman(g: HangmanGame): string {
  const masked = g.word
    .split("")
    .map((c) => (g.guessed.has(c) ? c.toUpperCase() : "_"))
    .join(" ");
  const wrongLetters = [...g.guessed].filter((c) => !g.word.includes(c));
  return (
    `🎯 *HANGMAN*\n\n` +
    `\`${masked}\`\n\n` +
    `❌ Wrong: ${g.wrong}/${MAX_WRONG}` +
    (wrongLetters.length ? `  (${wrongLetters.join(", ")})` : "") +
    `\n\nReply with a *single letter* to guess, or the *whole word*.`
  );
}

function hangmanWon(g: HangmanGame): boolean {
  return g.word.split("").every((c) => g.guessed.has(c));
}

/* -------------------------------- tic-tac-toe ------------------------------- */

const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function renderBoard(g: TicTacToeGame): string {
  const cells = g.board.map((v, i) => (v === "X" ? "❌" : v === "O" ? "⭕" : `${i + 1}️⃣`));
  return (
    `${cells[0]}${cells[1]}${cells[2]}\n` +
    `${cells[3]}${cells[4]}${cells[5]}\n` +
    `${cells[6]}${cells[7]}${cells[8]}`
  );
}

function tttWinner(board: TicTacToeGame["board"]): "X" | "O" | null {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

/* --------------------------------- replies ---------------------------------- */

interface GameInputArgs {
  sock: WASocket;
  msg: WAMessage;
  tenantId: number;
  from: string;
  sender: string;
  body: string;
}

async function send(
  sock: WASocket,
  from: string,
  msg: WAMessage,
  text: string,
  mentions?: string[],
): Promise<void> {
  await sock.sendMessage(from, mentions?.length ? { text, mentions } : { text }, { quoted: msg });
}

/* --------------------------------- handlers --------------------------------- */

export const interactiveGameCommands: Command[] = [
  {
    name: "hangman",
    category: "GAMES",
    desc: "Start a game of Hangman",
    handler: async (ctx: CommandContext) => {
      if (getGame(ctx.tenantId, ctx.from)) {
        return ctx.reply(`⚠️ A game is already running here. Finish it or use *${ctx.prefix}endgame*.`);
      }
      const game: HangmanGame = {
        type: "hangman",
        word: pick(HANGMAN_WORDS),
        guessed: new Set(),
        wrong: 0,
        createdAt: Date.now(),
        starter: ctx.sender,
      };
      setGame(ctx.tenantId, ctx.from, game);
      await ctx.reply(renderHangman(game));
    },
  },
  {
    name: "tictactoe",
    aliases: ["ttt"],
    category: "GAMES",
    groupOnly: true,
    desc: "Start Tic-Tac-Toe (two players)",
    handler: async (ctx: CommandContext) => {
      if (getGame(ctx.tenantId, ctx.from)) {
        return ctx.reply(`⚠️ A game is already running here. Finish it or use *${ctx.prefix}endgame*.`);
      }
      const game: TicTacToeGame = {
        type: "tictactoe",
        board: Array(9).fill(null),
        playerX: ctx.sender,
        playerO: null,
        turn: "X",
        createdAt: Date.now(),
        starter: ctx.sender,
      };
      setGame(ctx.tenantId, ctx.from, game);
      await ctx.sock.sendMessage(
        ctx.from,
        {
          text:
            `🎮 *TIC-TAC-TOE*\n\n@${jidBase(ctx.sender)} is *❌*.\n` +
            `Another player: send a number to join as *⭕*.\n\n${renderBoard(game)}\n\n` +
            `Reply with a number *1-9* to play.`,
          mentions: [ctx.sender],
        },
        { quoted: ctx.msg },
      );
    },
  },
  {
    name: "wordchain",
    aliases: ["wc"],
    category: "GAMES",
    desc: "Start a Word Chain game",
    handler: async (ctx: CommandContext) => {
      if (getGame(ctx.tenantId, ctx.from)) {
        return ctx.reply(`⚠️ A game is already running here. Finish it or use *${ctx.prefix}endgame*.`);
      }
      const letter = pick(WORDCHAIN_START_LETTERS);
      const game: WordChainGame = {
        type: "wordchain",
        lastLetter: letter,
        used: new Set(),
        count: 0,
        createdAt: Date.now(),
        starter: ctx.sender,
      };
      setGame(ctx.tenantId, ctx.from, game);
      await ctx.reply(
        `🔗 *WORD CHAIN*\n\nReply with a word starting with the letter *${letter.toUpperCase()}*.\n` +
          `Each next word must start with the last letter of the previous one. No repeats!`,
      );
    },
  },
  {
    name: "endgame",
    aliases: ["stopgame", "quitgame"],
    category: "GAMES",
    desc: "End the active game in this chat",
    handler: async (ctx: CommandContext) => {
      const game = getGame(ctx.tenantId, ctx.from);
      if (!game) return ctx.reply("ℹ️ No game is running here.");
      if (game.starter !== ctx.sender && !ctx.isOwner && !ctx.isAdmin) {
        return ctx.reply("🚫 Only the player who started the game (or an admin) can end it.");
      }
      clearGame(ctx.tenantId, ctx.from);
      await ctx.reply("🛑 Game ended.");
    },
  },
];

/* -------------------------- bare-message interceptor ------------------------ */

async function handleHangmanInput(
  args: GameInputArgs,
  game: HangmanGame,
  text: string,
): Promise<boolean> {
  const { sock, from, msg, tenantId } = args;
  const lower = text.toLowerCase();
  const isLetter = /^[a-z]$/.test(lower);
  const isWordGuess = lower.length > 1 && /^[a-z]+$/.test(lower) && lower.length === game.word.length;
  if (!isLetter && !isWordGuess) return false;

  if (isWordGuess) {
    if (lower === game.word) {
      for (const c of game.word) game.guessed.add(c);
      clearGame(tenantId, from);
      await send(sock, from, msg, `🎉 Correct! The word was *${game.word.toUpperCase()}*.`);
      return true;
    }
    game.wrong += 1;
  } else {
    if (game.guessed.has(lower)) {
      await send(sock, from, msg, `🔁 *${lower.toUpperCase()}* was already guessed.`);
      return true;
    }
    game.guessed.add(lower);
    if (!game.word.includes(lower)) game.wrong += 1;
  }

  if (hangmanWon(game)) {
    clearGame(tenantId, from);
    await send(sock, from, msg, `🎉 You won! The word was *${game.word.toUpperCase()}*.`);
    return true;
  }
  if (game.wrong >= MAX_WRONG) {
    clearGame(tenantId, from);
    await send(sock, from, msg, `💀 Game over! The word was *${game.word.toUpperCase()}*.`);
    return true;
  }
  setGame(tenantId, from, game);
  await send(sock, from, msg, renderHangman(game));
  return true;
}

async function handleTicTacToeInput(
  args: GameInputArgs,
  game: TicTacToeGame,
  text: string,
): Promise<boolean> {
  const { sock, from, msg, tenantId, sender } = args;
  if (!/^[1-9]$/.test(text)) return false;

  // A third party (both slots filled, not a player) — leave the message alone.
  if (game.playerO && sender !== game.playerX && sender !== game.playerO) return false;

  if (game.turn === "X") {
    if (sender !== game.playerX) {
      await send(sock, from, msg, `⏳ It's ❌ @${jidBase(game.playerX)}'s turn.`, [game.playerX]);
      return true;
    }
  } else {
    if (game.playerO === null) {
      if (sender === game.playerX) {
        await send(sock, from, msg, "⏳ Waiting for a second player to join as ⭕.");
        return true;
      }
      game.playerO = sender; // second distinct player joins as O
    } else if (sender !== game.playerO) {
      await send(sock, from, msg, `⏳ It's ⭕ @${jidBase(game.playerO)}'s turn.`, [game.playerO]);
      return true;
    }
  }

  const pos = Number(text) - 1;
  if (game.board[pos]) {
    await send(sock, from, msg, "🚫 That cell is taken. Pick another.");
    return true;
  }
  game.board[pos] = game.turn;

  const winner = tttWinner(game.board);
  if (winner) {
    const winJid = winner === "X" ? game.playerX : (game.playerO ?? sender);
    clearGame(tenantId, from);
    await send(
      sock,
      from,
      msg,
      `${renderBoard(game)}\n\n🏆 ${winner === "X" ? "❌" : "⭕"} @${jidBase(winJid)} wins!`,
      [winJid],
    );
    return true;
  }
  if (game.board.every((c) => c !== null)) {
    clearGame(tenantId, from);
    await send(sock, from, msg, `${renderBoard(game)}\n\n🤝 It's a draw!`);
    return true;
  }

  game.turn = game.turn === "X" ? "O" : "X";
  setGame(tenantId, from, game);
  const next =
    game.turn === "X"
      ? `❌ @${jidBase(game.playerX)}`
      : game.playerO
        ? `⭕ @${jidBase(game.playerO)}`
        : "⭕ (waiting for a second player)";
  const mentions = game.turn === "X" ? [game.playerX] : game.playerO ? [game.playerO] : [];
  await send(sock, from, msg, `${renderBoard(game)}\n\nNext: ${next}`, mentions);
  return true;
}

async function handleWordChainInput(
  args: GameInputArgs,
  game: WordChainGame,
  text: string,
): Promise<boolean> {
  const { sock, from, msg, tenantId } = args;
  const word = text.toLowerCase();
  if (!/^[a-z]{2,}$/.test(word)) return false; // single alpha token only

  if (word[0] !== game.lastLetter) {
    await send(sock, from, msg, `❌ Word must start with *${game.lastLetter.toUpperCase()}*.`);
    return true;
  }
  if (game.used.has(word)) {
    await send(sock, from, msg, `🔁 *${word}* was already used. Try another.`);
    return true;
  }
  game.used.add(word);
  game.count += 1;
  game.lastLetter = word[word.length - 1];
  setGame(tenantId, from, game);
  await send(
    sock,
    from,
    msg,
    `✅ *${word}* (${game.count})\n\nNext word starts with *${game.lastLetter.toUpperCase()}*.`,
  );
  return true;
}

/**
 * Intercept a bare (non-command) message and route it to the active game in this
 * chat. Mirrors `handleDownloadSelection`: called from the `messages.upsert` loop
 * BEFORE command dispatch. Returns true when the message was consumed as a move.
 * Cheap no-op (single Map lookup) when no game is active.
 */
export async function handleGameInput(args: GameInputArgs): Promise<boolean> {
  const text = args.body.trim();
  if (!text || text.includes("\n") || text.includes(" ")) return false;
  const game = getGame(args.tenantId, args.from);
  if (!game) return false;

  switch (game.type) {
    case "hangman":
      return handleHangmanInput(args, game, text);
    case "tictactoe":
      return handleTicTacToeInput(args, game, text);
    case "wordchain":
      return handleWordChainInput(args, game, text);
  }
}
