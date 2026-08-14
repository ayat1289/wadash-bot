/**
 * Short-lived, in-memory store for interactive chat games (hangman, tic-tac-toe,
 * word-chain). One active game per chat, keyed by tenant + chat. Like the
 * `pending-downloads` store this is intentionally in-memory: the bot runs
 * single-instance, the state is tiny and ephemeral, and losing it on restart
 * just ends any in-progress game (players re-start it).
 */
const TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 500;

interface BaseGame {
  createdAt: number;
  starter: string;
}

export interface HangmanGame extends BaseGame {
  type: "hangman";
  word: string;
  guessed: Set<string>;
  wrong: number;
}

export interface TicTacToeGame extends BaseGame {
  type: "tictactoe";
  board: Array<"X" | "O" | null>;
  playerX: string;
  playerO: string | null;
  turn: "X" | "O";
}

export interface WordChainGame extends BaseGame {
  type: "wordchain";
  lastLetter: string;
  used: Set<string>;
  count: number;
}

export type Game = HangmanGame | TicTacToeGame | WordChainGame;

const store = new Map<string, Game>();

function keyOf(tenantId: number, chat: string): string {
  return `${tenantId}\u0000${chat}`;
}

function evictIfNeeded(): void {
  if (store.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.createdAt > TTL_MS) store.delete(k);
  }
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
}

export function getGame(tenantId: number, chat: string): Game | null {
  const k = keyOf(tenantId, chat);
  const v = store.get(k);
  if (!v) return null;
  if (Date.now() - v.createdAt > TTL_MS) {
    store.delete(k);
    return null;
  }
  return v;
}

export function setGame(tenantId: number, chat: string, game: Game): void {
  evictIfNeeded();
  store.set(keyOf(tenantId, chat), game);
}

export function clearGame(tenantId: number, chat: string): void {
  store.delete(keyOf(tenantId, chat));
}
