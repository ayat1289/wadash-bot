import {
  getOrCreateTenantByTelegramChat,
  createLinkCode,
  listActiveTenantTelegramChats,
  acquireAdvisoryLock,
  type AdvisoryLock,
} from "@workspace/db";
import { logger } from "./logger";
import {
  requestPairingCode,
  getBotState,
  connectWhatsApp,
  disconnectWhatsApp,
} from "./whatsapp";

const token = process.env.TELEGRAM_BOT_TOKEN;
const BASE = token ? `https://api.telegram.org/bot${token}` : "";

let running = false;
let offset = 0;
// Bumped each time polling (re)starts so a stale poll loop from a previous
// lock-holding stint exits instead of running alongside the new one.
let pollEpoch = 0;
// Aborts the in-flight getUpdates request the moment the poller lock is lost, so
// a demoted instance stops talking to Telegram immediately (no lingering
// long-poll that would 409 the new holder).
let activePollAbort: AbortController | null = null;

// --- Force-join channel enforcement -----------------------------------------
// Users must be a member of this Telegram channel to use the bot. Telegram's
// Bot API only lets us verify membership (getChatMember) when this bot is an
// ADMIN of the channel. Set TELEGRAM_FORCE_JOIN_CHAT="" to disable the feature.
const FORCE_JOIN_CHAT = (process.env.TELEGRAM_FORCE_JOIN_CHAT ?? "@CyropesTriks").trim();
const FORCE_JOIN_ENABLED = FORCE_JOIN_CHAT.length > 0;
const FORCE_JOIN_URL = `https://t.me/${FORCE_JOIN_CHAT.replace(/^@/, "")}`;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Single-poller election. Telegram allows only ONE getUpdates per bot token, so
// even among deployed instances that pass telegramPollingEnabled() exactly one
// may poll. A Postgres session-level advisory lock (on the shared DB) elects
// that poller; standbys wait and take over automatically if the holder dies.
const TELEGRAM_POLLER_LOCK_KEY = 0x57414454; // "WADT" — stable, app-unique key
const POLLER_LOCK_RETRY_MS = 10_000;

type TgUpdate = {
  update_id: number;
  message?: {
    chat: { id: number; type?: string };
    from?: { id: number };
    text?: string;
  };
};

async function tg(method: string, params: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (err) {
    logger.error({ err, method }, "Telegram API call failed");
  }
}

async function send(chatId: number, text: string): Promise<void> {
  await tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

async function sendPhoto(chatId: number, buffer: Buffer, caption: string): Promise<void> {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption);
    form.append("photo", new Blob([new Uint8Array(buffer)], { type: "image/png" }), "qr.png");
    await fetch(`${BASE}/sendPhoto`, { method: "POST", body: form });
  } catch (err) {
    logger.error({ err }, "Telegram sendPhoto failed");
  }
}

/** Telegram API call that returns the parsed `result` (or null on error / not-ok). */
async function tgGet<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) {
      logger.warn({ method, description: data.description }, "Telegram API returned not-ok");
      return null;
    }
    return data.result ?? null;
  } catch (err) {
    logger.error({ err, method }, "Telegram API call failed");
    return null;
  }
}

const JOINED_STATUSES = new Set(["creator", "administrator", "member"]);

/**
 * Check whether a Telegram user is a member of the force-join channel. Returns
 * true (member), false (left/kicked/never joined), or null when membership
 * can't be determined — an API error, or (most commonly) the bot not being an
 * admin of the channel. Callers fail OPEN on null so a misconfiguration never
 * bricks the bot.
 */
async function isChannelMember(userId: number): Promise<boolean | null> {
  const member = await tgGet<{ status: string; is_member?: boolean }>("getChatMember", {
    chat_id: FORCE_JOIN_CHAT,
    user_id: userId,
  });
  if (!member) return null;
  if (member.status === "restricted") return member.is_member === true;
  return JOINED_STATUSES.has(member.status);
}

/** Prompt a user to join the required channel, with a tap-to-join button. */
async function sendJoinPrompt(chatId: number): Promise<void> {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "🔒 *Members only*\n\n" +
      "To use this bot you must join our channel first.\n\n" +
      "Tap the button below to join, then send your command again.",
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "📢 Join Channel", url: FORCE_JOIN_URL }]] },
  });
}

const HELP =
  "👋 *WADash WhatsApp Bot — Pairing Console*\n\n" +
  "Each Telegram account runs its *own* WhatsApp bot.\n\n" +
  "*Commands*\n" +
  "`/pair <number>` — get a WhatsApp pairing code\n" +
  "`/qr` — get a QR code to scan\n" +
  "`/status` — show your WhatsApp connection status\n" +
  "`/disconnect` — log out your WhatsApp session\n" +
  "`/link` — get a one-time code to sign in to the dashboard\n\n" +
  "*Example*\n`/pair 2348012345678` (include country code, no +)" +
  (FORCE_JOIN_ENABLED
    ? `\n\n📢 *Note:* You must join our channel to use this bot:\n${FORCE_JOIN_URL}`
    : "");

async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  // Private pairing console only: ignore groups/channels so a group chat id can
  // never create a tenant or bypass force-join (in a group chat.id != user id).
  if (msg.chat.type && msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  const parts = msg.text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().replace(/@.*$/, "");
  const args = parts.slice(1);

  // Each Telegram chat maps to its own tenant (its own WhatsApp connection),
  // created on first contact. There is no single-admin lock anymore.
  let tenantId: number;
  try {
    const tenant = await getOrCreateTenantByTelegramChat(String(chatId));
    tenantId = tenant.id;
  } catch (err) {
    logger.error({ err, chatId }, "Failed to resolve tenant for Telegram chat");
    await send(chatId, "⚠️ Something went wrong setting up your account. Please try again.");
    return;
  }

  // Force-join gate: every command except /start and /help requires the user to
  // be a member of the channel. In a private chat, chatId is the user's id.
  if (FORCE_JOIN_ENABLED && command !== "/start" && command !== "/help") {
    const member = await isChannelMember(userId);
    if (member === false) {
      await sendJoinPrompt(chatId);
      return;
    }
  }

  switch (command) {
    case "/start":
    case "/help": {
      await send(chatId, HELP);
      break;
    }
    case "/pair": {
      const number = (args[0] ?? "").replace(/[^0-9]/g, "");
      if (!number) {
        await send(chatId, "Usage: `/pair <number>`\nInclude country code, e.g. `/pair 2348012345678`");
        return;
      }
      await send(chatId, "⏳ Requesting a pairing code...");
      try {
        const code = await requestPairingCode(number, tenantId);
        const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        await send(
          chatId,
          `✅ *Pairing code:* \`${pretty}\`\n\n` +
            "On the phone with that number — first make sure *WhatsApp is updated to the latest version*, then:\n" +
            "1. Open *WhatsApp* → *Settings*\n" +
            "2. Tap *Linked Devices* → *Link a Device*\n" +
            "3. On the QR scanner screen, tap *Link with phone number instead* (small text link near the bottom)\n" +
            "4. Type the code above (it contains letters *and* numbers)\n\n" +
            "_The code stays valid for about 2 minutes._\n\n" +
            "🔁 Don't see *Link with phone number instead*? Send `/qr` instead and just scan the QR code — that works on every WhatsApp version.",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "ALREADY_LINKED" || msg === "ALREADY_REGISTERED") {
          await send(
            chatId,
            "✅ This number looks already linked. Send `/disconnect` first, then `/pair` again.",
          );
        } else if (msg === "CAPACITY") {
          await send(
            chatId,
            "⚠️ The bot is busy at the moment. Please wait a few minutes and try `/pair` again.",
          );
        } else {
          await send(
            chatId,
            "❌ Couldn't generate a pairing code. Send `/disconnect` first and try again — or use `/qr` to link by scanning a QR code instead.",
          );
        }
      }
      break;
    }
    case "/qr": {
      const st = getBotState(tenantId);
      if (st.state === "connected") {
        await send(chatId, "✅ Your WhatsApp is already connected.");
        return;
      }
      if (!st.qrCode) {
        try {
          await connectWhatsApp(tenantId);
          await send(chatId, "⏳ Generating a QR code — send `/qr` again in a few seconds.");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          await send(
            chatId,
            msg === "CAPACITY"
              ? "⚠️ The bot is busy at the moment. Please wait a few minutes and try `/qr` again."
              : "❌ Couldn't start a connection. Please try `/qr` again shortly.",
          );
        }
        return;
      }
      const base64 = st.qrCode.split(",")[1] ?? "";
      await sendPhoto(chatId, Buffer.from(base64, "base64"), "📲 Scan this in WhatsApp → Linked Devices");
      break;
    }
    case "/status": {
      const st = getBotState(tenantId);
      await send(
        chatId,
        `📡 *WhatsApp Status*\n\n` +
          `State: *${st.state}*\n` +
          `Number: ${st.phoneNumber ?? "—"}\n` +
          `Name: ${st.profileName ?? "—"}`,
      );
      break;
    }
    case "/disconnect": {
      await disconnectWhatsApp(tenantId);
      await send(chatId, "✅ Your WhatsApp session was logged out.");
      break;
    }
    case "/link": {
      try {
        const { code } = await createLinkCode(tenantId);
        await send(
          chatId,
          "🔗 *Dashboard link code*\n\n" +
            `\`${code}\`\n\n` +
            "Open the WADash dashboard, sign in, and enter this code to connect it to *this* WhatsApp.\n\n" +
            "_The code is single-use and expires in about 10 minutes._",
        );
      } catch (err) {
        logger.error({ err, tenantId }, "Failed to create dashboard link code");
        await send(chatId, "❌ Couldn't generate a link code. Please try again.");
      }
      break;
    }
    default:
      await send(chatId, "❓ Unknown command. Send /help to see what I can do.");
  }
}

// Per-chat serialization. Updates for the SAME Telegram chat run in order (so a
// user's rapid `/pair` then `/qr` stay sequential), but different chats run
// concurrently — one user's multi-second pairing never blocks another user's
// command. Still a SINGLE poll loop / offset (see startTelegramBot).
const chatChains = new Map<number, Promise<void>>();

function dispatchUpdate(update: TgUpdate): void {
  const chatId = update.message?.chat.id;
  if (chatId === undefined) return;
  const prev = chatChains.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(() => handleUpdate(update))
    .catch((err) => logger.error({ err, chatId }, "Telegram update handling error"));
  chatChains.set(chatId, next);
  // Drop the chain entry once it settles, unless newer work queued behind it.
  void next.finally(() => {
    if (chatChains.get(chatId) === next) chatChains.delete(chatId);
  });
}

async function drainBacklog(epoch: number): Promise<void> {
  try {
    const res = await fetch(`${BASE}/getUpdates?timeout=0`);
    const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };
    // Lost the lock (or a newer stint started) mid-request — don't touch offset.
    if (!running || epoch !== pollEpoch) return;
    if (data.ok && data.result.length) {
      offset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch {
    /* ignore backlog drain errors */
  }
}

async function poll(epoch: number): Promise<void> {
  while (running && epoch === pollEpoch) {
    const ac = new AbortController();
    activePollAbort = ac;
    try {
      const res = await fetch(`${BASE}/getUpdates?timeout=30&offset=${offset}`, {
        signal: ac.signal,
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: TgUpdate[];
        error_code?: number;
        description?: string;
      };
      // Lost the lock (or a newer stint started) while this request was in
      // flight — drop the result without dispatching or advancing the offset;
      // another instance is the active poller now.
      if (!running || epoch !== pollEpoch) return;
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          dispatchUpdate(update);
        }
      } else if (!data.ok) {
        // A 409 means another getUpdates poller is active for this bot token —
        // i.e. a SECOND instance (e.g. the deployed app and this dev workspace
        // both running). Back off instead of hot-looping; the conflict starves
        // both pollers and is why the bot appears dead. Single-instance only.
        logger.warn(
          { errorCode: data.error_code, description: data.description },
          "Telegram getUpdates returned not-ok",
        );
        await new Promise((r) => setTimeout(r, data.error_code === 409 ? 10000 : 3000));
      }
    } catch (err) {
      if (ac.signal.aborted) return; // poller lock lost — exit quietly
      logger.error({ err }, "Telegram polling error");
      await new Promise((r) => setTimeout(r, 5000));
    } finally {
      if (activePollAbort === ac) activePollAbort = null;
    }
  }
}

/**
 * Periodic force-join sweep: every active tenant's owning Telegram user is
 * re-checked for channel membership; anyone who left (or was removed) has their
 * WhatsApp connection logged out and is told to rejoin. Only acts on a
 * definitive "not a member" (false), never on an inconclusive check (null).
 * Guarded so overlapping ticks can't run two sweeps at once.
 */
let sweepRunning = false;

async function sweepMemberships(): Promise<void> {
  if (!FORCE_JOIN_ENABLED || sweepRunning) return;
  sweepRunning = true;
  try {
    let tenants: { id: number; telegramChatId: string }[];
    try {
      tenants = await listActiveTenantTelegramChats();
    } catch (err) {
      logger.error({ err }, "Force-join sweep: failed to list active tenants");
      return;
    }
    for (const t of tenants) {
      const userId = Number(t.telegramChatId);
      if (!Number.isInteger(userId)) continue; // e.g. the seeded 'legacy' tenant
      const member = await isChannelMember(userId);
      if (member !== false) continue;
      logger.info({ tenantId: t.id }, "Force-join: user left channel — disconnecting WhatsApp");
      try {
        await disconnectWhatsApp(t.id);
      } catch (err) {
        logger.error({ err, tenantId: t.id }, "Force-join sweep: disconnect failed");
      }
      await send(
        userId,
        "⚠️ You left our channel, so your WhatsApp connection was turned off.\n\n" +
          `Rejoin ${FORCE_JOIN_URL} and send /pair to reconnect.`,
      );
    }
  } finally {
    sweepRunning = false;
  }
}

/**
 * Whether THIS process should run the Telegram long-poll loop. Telegram allows
 * only one active getUpdates per bot token, so a running dev workspace AND the
 * deployed app would 409 each other into silence (the bot appears dead).
 * Default: only the deployed (production) instance polls. Override with
 * TELEGRAM_POLLING=1 (force on) or TELEGRAM_POLLING=0 (force off) — but never
 * run two pollers on the same bot token at once.
 */
function telegramPollingEnabled(): boolean {
  const override = process.env.TELEGRAM_POLLING?.trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return process.env.NODE_ENV === "production" || !!process.env.REPLIT_DEPLOYMENT;
}

let started = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Begin the poll loop + force-join sweep. Only called while holding the lock. */
function startPollingWork(): void {
  running = true;
  const epoch = ++pollEpoch;
  logger.info("Telegram pairing bot started (per-user multi-tenant)");
  void drainBacklog(epoch).then(() => poll(epoch));
  if (FORCE_JOIN_ENABLED) {
    logger.info({ chat: FORCE_JOIN_CHAT }, "Force-join channel enforcement enabled");
    void sweepMemberships();
    sweepTimer = setInterval(() => void sweepMemberships(), SWEEP_INTERVAL_MS);
  }
}

/** Stop polling + sweeps when the poller lock is lost. */
function stopPollingWork(): void {
  running = false;
  activePollAbort?.abort(); // cut any in-flight long-poll immediately
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * Hold the shared poller lock for the process lifetime: acquire it, poll while
 * held, and automatically pause + re-contend if its connection drops (e.g. the
 * holder crashed and another instance should take over).
 */
async function pollerSupervisor(): Promise<void> {
  for (;;) {
    logger.info("Waiting for Telegram poller lock (only one instance polls at a time)");
    let lock: AdvisoryLock;
    try {
      lock = await acquireAdvisoryLock(TELEGRAM_POLLER_LOCK_KEY, POLLER_LOCK_RETRY_MS);
    } catch (err) {
      logger.error({ err }, "Telegram poller lock acquisition failed — retrying");
      await new Promise((r) => setTimeout(r, POLLER_LOCK_RETRY_MS));
      continue;
    }
    logger.info("Acquired Telegram poller lock — this instance is now the active poller");
    startPollingWork();
    await lock.lost;
    logger.warn(
      "Lost Telegram poller lock (db connection dropped) — pausing polling until re-acquired",
    );
    stopPollingWork();
    await lock.release();
    await new Promise((r) => setTimeout(r, POLLER_LOCK_RETRY_MS));
  }
}

/**
 * Telegram long-polling must stay a SINGLE active poller per bot token — one
 * global poll loop and offset. Multi-tenant means many chats handled by this
 * one loop, not multiple pollers. Among deployed instances that pass
 * {@link telegramPollingEnabled}, a Postgres advisory lock elects exactly one
 * active poller; the rest stand by and take over if it dies. NOTE: this only
 * coordinates instances running THIS code against the same database — an OLD
 * deployment still running pre-lock code won't respect it, so stop any
 * duplicate/old deployment of this app.
 */
export function startTelegramBot(): void {
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram pairing disabled");
    return;
  }
  if (!telegramPollingEnabled()) {
    logger.warn(
      "Telegram polling disabled on this instance — single-instance long-polling means only the deployed app polls. Set TELEGRAM_POLLING=1 to force-enable here (never run two pollers on one bot token).",
    );
    return;
  }
  if (started) return;
  started = true;
  void pollerSupervisor();
}
