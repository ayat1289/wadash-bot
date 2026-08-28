import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  proto,
  type WASocket,
  type ConnectionState,
  type WAMessage,
  type GroupParticipant,
  type ParticipantAction,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";
import {
  db,
  messagesTable,
  contactsTable,
  groupsTable,
  activityLogTable,
  autoReplyRulesTable,
  tenantsTable,
  LEGACY_TENANT_ID,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";
import { handleCommand, resolveSender } from "./command-handler";
import { recordActivity } from "./activity-store";
import { handleDownloadSelection } from "./commands/handlers/download";
import { handleGameInput } from "./commands/handlers/games-interactive";
import { handleAfk } from "./commands/handlers/afk";
import { handleAlinksForward } from "./commands/handlers/alinks";
import { loadConfig, setConfig, getBool, getConfig } from "./config";
import {
  getGroupMetadataCached,
  invalidateGroupMetadata,
  jidBase,
  findParticipant,
  participantHasNumber,
} from "./group-meta";
import { tryAcquire } from "./commands/limiter";
import { unwrapViewOnce } from "./commands/handlers/media";
import { saveCaptureMedia, recordCapture } from "./captures";

const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server"))
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();

// Root directory holding every tenant's Baileys auth state. Each tenant gets
// its own subdirectory `tenant-<id>/` so sessions never mix.
const AUTH_ROOT = path.resolve(workspaceRoot, "artifacts/api-server/data/wa-auth");

function authDirFor(tenantId: number): string {
  return path.join(AUTH_ROOT, `tenant-${tenantId}`);
}

/**
 * Remove a tenant's on-disk WhatsApp auth so the NEXT connect pairs fresh.
 * WhatsApp revokes creds on logout (401); leaving the stale "registered" creds
 * on disk makes every reconnect retry a dead login — the 401 loop that silently
 * blocks re-pairing (no QR / pairing code is ever emitted for registered creds).
 */
function clearAuthDir(tenantId: number): void {
  try {
    fs.rmSync(authDirFor(tenantId), { recursive: true, force: true });
    logger.info({ tenantId }, "Cleared WhatsApp auth dir (stale/revoked creds)");
  } catch (err) {
    logger.warn({ err, tenantId }, "Failed to clear WhatsApp auth dir");
  }
}

// Cap on simultaneously-open WhatsApp sockets to bound this single process's
// memory/CPU. New connections beyond the cap are refused; boot restore stops
// scheduling once it is reached.
const MAX_TENANTS = Math.max(1, Number(process.env.MAX_WA_TENANTS) || 50);

const RECENT_LIMIT = 800;
const VIEWONCE_MAX_BYTES = 64 * 1024 * 1024;

// Timezone used to render "TIME SENT" / "DATE SENT" in anti-delete reports.
const ANTIDELETE_TZ = "Africa/Nairobi";
const ANTIDELETE_TZ_LABEL = "EAT";

// Anti-spam: per-group, per-sender sliding window of message timestamps.
const SPAM_WINDOW_MS = 7000;
const SPAM_LIMIT = 6;

export type BotState = {
  state: "disconnected" | "connecting" | "connected";
  qrCode: string | null;
  phoneNumber: string | null;
  profileName: string | null;
};

/**
 * Everything that used to be a module global is now scoped to a tenant so each
 * Telegram user operates an independent WhatsApp connection: its own socket,
 * auth dir, anti-delete cache, anti-spam tracker, and reconnect/presence timers.
 */
type Session = {
  tenantId: number;
  socket: WASocket | null;
  state: BotState;
  authDir: string;
  // Bounded store of recent messages so anti-delete can restore revoked ones.
  recentMessages: Map<string, WAMessage>;
  spamTracker: Map<string, number[]>;
  // Anti-link warning counter: `${groupId}:${senderBase}` -> warnings issued.
  // A member is warned (and their link message deleted) up to 2 times; the 3rd
  // time they are kicked immediately. In-memory and per-tenant (like the spam
  // tracker) — reset on bot restart.
  antilinkWarnings: Map<string, number>;
  presenceInterval: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  // Guards against re-entrant connect() within the same tick.
  connecting: boolean;
  // True once the websocket is up far enough to mint a pairing code. Set on the
  // raw `qr` event (independent of whether the QR image renders) and used by
  // waitForPairingReady — decoupled from qrCode so a QR-render failure can't
  // wrongly stall pairing.
  pairingReady: boolean;
  // Per-tenant mutex: requestPairingCode mutates live auth creds, so overlapping
  // pair requests for one tenant (dashboard + Telegram, or a double click) must
  // run one at a time on the same socket.
  pairLock: Promise<unknown>;
};

const sessions = new Map<number, Session>();

function freshState(): BotState {
  return { state: "disconnected", qrCode: null, phoneNumber: null, profileName: null };
}

function getOrCreateSession(tenantId: number): Session {
  let session = sessions.get(tenantId);
  if (!session) {
    session = {
      tenantId,
      socket: null,
      state: freshState(),
      authDir: authDirFor(tenantId),
      recentMessages: new Map(),
      spamTracker: new Map(),
      antilinkWarnings: new Map(),
      presenceInterval: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      connecting: false,
      pairingReady: false,
      pairLock: Promise.resolve(),
    };
    sessions.set(tenantId, session);
  }
  return session;
}

function activeConnectionCount(): number {
  let n = 0;
  // Count in-flight connects too: connectTenant sets `connecting` synchronously
  // (before it awaits auth/version), so concurrent first connections can't race
  // past the MAX_TENANTS cap before any socket is assigned.
  for (const s of sessions.values()) if (s.socket || s.connecting) n += 1;
  return n;
}

// Baileys version is the same for every tenant; fetch it once.
type WaVersion = Awaited<ReturnType<typeof fetchLatestBaileysVersion>>["version"];
let cachedVersion: WaVersion | null = null;
// In-flight de-dupe: when many tenants connect at once on a cold process, share
// a SINGLE version fetch instead of hitting the network once per connection.
let versionFetch: Promise<WaVersion> | null = null;
async function getBaileysVersion(): Promise<WaVersion> {
  if (cachedVersion) return cachedVersion;
  if (!versionFetch) {
    versionFetch = fetchLatestBaileysVersion()
      .then((r) => {
        cachedVersion = r.version;
        return r.version;
      })
      .catch((err) => {
        versionFetch = null; // allow a retry on the next connect
        throw err;
      });
  }
  return versionFetch;
}

/** Resolve the tenant owner's self-chat JID from its config, or null if unset. */
async function ownerJid(session: Session): Promise<string | null> {
  const cfg = await loadConfig(session.tenantId);
  const num = cfg.ownerNumber.replace(/\D/g, "");
  return num ? `${num}@s.whatsapp.net` : null;
}

/** Describe where a message came from for owner notifications. */
async function describeChat(session: Session, chat: string): Promise<string> {
  if (!chat.endsWith("@g.us")) return "private chat";
  const meta = session.socket ? await getGroupMetadataCached(session.socket, session.tenantId, chat) : null;
  return meta?.subject ? `group "${meta.subject}"` : "a group";
}

/** A human chat name: group subject for groups, sender's name/number for DMs. */
async function chatLabel(session: Session, chat: string, dmFallback: string): Promise<string> {
  if (chat.endsWith("@g.us")) {
    const meta = session.socket ? await getGroupMetadataCached(session.socket, session.tenantId, chat) : null;
    return meta?.subject || "Group";
  }
  return dmFallback || "Private chat";
}

/** Resolve a human-readable group/chat name for capture records. */
async function captureChatName(session: Session, chat: string): Promise<string | null> {
  if (!chat.endsWith("@g.us")) return null;
  const meta = session.socket ? await getGroupMetadataCached(session.socket, session.tenantId, chat) : null;
  return meta?.subject ?? null;
}

/** Classify a message's content and extract any text body for capture records. */
function describeContent(message: proto.IMessage): { contentType: string; body: string | null } {
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    null;
  if (message.imageMessage) return { contentType: "image", body: text };
  if (message.videoMessage) return { contentType: "video", body: text };
  if (message.audioMessage) return { contentType: "audio", body: text };
  if (message.stickerMessage) return { contentType: "sticker", body: text };
  if (message.documentMessage) return { contentType: "document", body: text };
  if (text != null) return { contentType: "text", body: text };
  return { contentType: "other", body: text };
}

/** Format a WA message timestamp (unix seconds) into report time + date fields. */
function formatSentAt(tsSeconds: number): { time: string; date: string } {
  const d = new Date(tsSeconds * 1000);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: ANTIDELETE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: ANTIDELETE_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
  return { time, date };
}

/** Extract a printable body + whether the deleted message carried media. */
function describeDeletedContent(message: proto.IMessage): {
  text: string;
  isMedia: boolean;
} {
  const caption =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    "";
  if (message.imageMessage) return { text: caption || "[photo]", isMedia: true };
  if (message.videoMessage) return { text: caption || "[video]", isMedia: true };
  if (message.audioMessage)
    return {
      text: message.audioMessage.ptt ? "[voice note]" : "[audio]",
      isMedia: true,
    };
  if (message.stickerMessage) return { text: "[sticker]", isMedia: true };
  if (message.documentMessage)
    return {
      text: message.documentMessage.fileName
        ? `[document] ${message.documentMessage.fileName}`
        : "[document]",
      isMedia: true,
    };
  return { text: caption || "[message]", isMedia: false };
}

function rememberMessage(session: Session, msg: WAMessage): void {
  const id = msg.key.id;
  const chat = msg.key.remoteJid;
  if (!id || !chat) return;
  session.recentMessages.set(`${chat}|${id}`, msg);
  if (session.recentMessages.size > RECENT_LIMIT) {
    const oldest = session.recentMessages.keys().next().value;
    if (oldest) session.recentMessages.delete(oldest);
  }
}

/** Forward a "delete for everyone" message to the tenant owner when enabled. */
async function handleAntiDelete(session: Session, revokeMsg: WAMessage): Promise<void> {
  try {
    if (!session.socket) return;
    if (!(await getBool("antidelete", session.tenantId))) return;
    const owner = await ownerJid(session);
    if (!owner) return;
    const revokedKey = revokeMsg.message?.protocolMessage?.key;
    const id = revokedKey?.id;
    const chat = revokeMsg.key.remoteJid ?? "";
    if (!id || !chat) return;
    const lookupKey = `${chat}|${id}`;
    const original = session.recentMessages.get(lookupKey);
    if (!original?.message || original.key.fromMe) return;

    const senderJid = original.key.participant ?? original.key.remoteJid ?? "";
    const senderNum = senderJid ? jidBase(senderJid) : "unknown";
    const deleterJid = revokeMsg.key.participant ?? revokeMsg.key.remoteJid ?? "";
    const deleterNum = deleterJid ? jidBase(deleterJid) : senderNum;

    const tsRaw = original.messageTimestamp;
    const ts = tsRaw ? Number(tsRaw.toString()) : Math.floor(Date.now() / 1000);
    const { time, date } = formatSentAt(ts);
    const name = await chatLabel(session, chat, original.pushName || senderNum);
    const { text, isMedia } = describeDeletedContent(original.message);

    const mentions = Array.from(
      new Set([senderJid, deleterJid].filter((j) => j.includes("@"))),
    );
    const report =
      `🚨 *DELETED MESSAGE!* 🚨\n\n` +
      `*CHAT:* ${name}\n` +
      `*SENT BY:* @${senderNum}\n` +
      `*TIME SENT:* ${time} ${ANTIDELETE_TZ_LABEL}\n` +
      `*DATE SENT:* ${date}\n` +
      `*DELETED BY:* @${deleterNum}\n\n` +
      `*MESSAGE:* ${text}`;
    await session.socket.sendMessage(owner, { text: report, mentions });
    if (isMedia) await session.socket.sendMessage(owner, { forward: original });
    session.recentMessages.delete(lookupKey);
    void persistDeletedCapture(
      session,
      original,
      chat,
      senderJid,
      original.pushName || senderNum,
    );
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-delete forward failed");
  }
}

/**
 * Persist a deleted message so the owner can browse it later in the dashboard.
 * Text + metadata is always stored; media is downloaded best-effort (size-capped
 * and concurrency-gated) so it can be viewed/downloaded from the dashboard.
 */
async function persistDeletedCapture(
  session: Session,
  original: WAMessage,
  chat: string,
  senderJid: string,
  senderName: string,
): Promise<void> {
  let slot: ReturnType<typeof tryAcquire> | null = null;
  try {
    if (!original.message) return;
    const { contentType, body } = describeContent(original.message);
    const chatType = chat.endsWith("@g.us") ? "group" : "dm";
    const chatName = await captureChatName(session, chat);

    let mediaPath: string | null = null;
    let mediaMimetype: string | null = null;
    let mediaSize: number | null = null;

    const mediaMsg =
      original.message.imageMessage ??
      original.message.videoMessage ??
      original.message.audioMessage ??
      original.message.stickerMessage ??
      original.message.documentMessage;
    const advertised = mediaMsg?.fileLength;
    const tooBig = advertised != null && Number(advertised.toString()) > VIEWONCE_MAX_BYTES;

    if (mediaMsg && !tooBig && session.socket) {
      slot = tryAcquire(`${session.tenantId}:${jidBase(senderJid) || "anon"}`, { concurrency: true });
      if (slot.ok) {
        try {
          const buffer = (await downloadMediaMessage(
            original,
            "buffer",
            {},
            { logger, reuploadRequest: session.socket.updateMediaMessage },
          )) as Buffer;
          if (buffer.length <= VIEWONCE_MAX_BYTES) {
            mediaMimetype = mediaMsg.mimetype ?? null;
            mediaPath = await saveCaptureMedia(buffer, contentType, mediaMsg.mimetype ?? undefined);
            mediaSize = buffer.length;
          }
        } catch (err) {
          // Media may already be purged — keep the text/metadata record anyway.
          logger.warn({ err }, "Deleted-media download for capture failed");
        }
      }
    }

    await recordCapture({
      tenantId: session.tenantId,
      kind: "deleted",
      senderJid: jidBase(senderJid) || "unknown",
      senderName,
      chatJid: chat,
      chatName,
      chatType,
      contentType,
      body,
      mediaPath,
      mediaMimetype,
      mediaSize,
      timestamp: String(original.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    });
  } catch (err) {
    logger.warn({ err }, "Persist deleted capture failed");
  } finally {
    if (slot?.ok) slot.release();
  }
}

/**
 * Auto-forward a received view-once photo/video/voice to the tenant owner's
 * number when anti-view-once is enabled. The owner's own view-once is ignored,
 * and the download is concurrency-gated + size-capped like the manual `.vv`.
 */
async function handleAntiViewOnce(session: Session, msg: WAMessage): Promise<void> {
  let slot: ReturnType<typeof tryAcquire> | null = null;
  try {
    if (!session.socket || !msg.message || msg.key.fromMe) return;
    const found = unwrapViewOnce(msg.message);
    if (!found) return;
    if (!(await getBool("antiviewonce", session.tenantId))) return;
    const owner = await ownerJid(session);
    if (!owner) return;

    // Skip obviously-oversized media before buffering it into memory.
    const advertised =
      found.inner.imageMessage?.fileLength ??
      found.inner.videoMessage?.fileLength ??
      found.inner.audioMessage?.fileLength;
    if (advertised && Number(advertised.toString()) > VIEWONCE_MAX_BYTES) return;

    const sender = msg.key.participant ?? msg.key.remoteJid ?? "";
    slot = tryAcquire(`${session.tenantId}:${jidBase(sender) || "anon"}`, { concurrency: true });
    if (!slot.ok) return; // best-effort: skip silently when busy/cooled down

    const target = { key: msg.key, message: found.inner } as WAMessage;
    const buffer = (await downloadMediaMessage(
      target,
      "buffer",
      {},
      { logger, reuploadRequest: session.socket.updateMediaMessage },
    )) as Buffer;
    if (buffer.length > VIEWONCE_MAX_BYTES) return;

    const whoNum = sender ? jidBase(sender) : "unknown";
    const name = msg.pushName ? `${msg.pushName} (${whoNum})` : whoNum;
    const where = await describeChat(session, msg.key.remoteJid ?? "");
    const caption = `👁️ *Anti view-once*\nFrom: ${name}\nIn: ${where}`;

    if (found.kind === "image") {
      await session.socket.sendMessage(owner, { image: buffer, caption });
    } else if (found.kind === "video") {
      await session.socket.sendMessage(owner, { video: buffer, caption });
    } else {
      await session.socket.sendMessage(owner, {
        audio: buffer,
        mimetype: found.inner.audioMessage?.mimetype ?? "audio/ogg; codecs=opus",
        ptt: found.inner.audioMessage?.ptt ?? true,
      });
      await session.socket.sendMessage(owner, { text: caption });
    }

    const mimetype =
      found.inner.imageMessage?.mimetype ??
      found.inner.videoMessage?.mimetype ??
      found.inner.audioMessage?.mimetype ??
      undefined;
    const mediaBody =
      found.inner.imageMessage?.caption ?? found.inner.videoMessage?.caption ?? null;
    const mediaPath = await saveCaptureMedia(buffer, found.kind, mimetype);
    await recordCapture({
      tenantId: session.tenantId,
      kind: "viewonce",
      senderJid: whoNum,
      senderName: name,
      chatJid: msg.key.remoteJid ?? "",
      chatName: await captureChatName(session, msg.key.remoteJid ?? ""),
      chatType: (msg.key.remoteJid ?? "").endsWith("@g.us") ? "group" : "dm",
      contentType: found.kind,
      body: mediaBody,
      mediaPath,
      mediaMimetype: mimetype ?? null,
      mediaSize: buffer.length,
      timestamp: String(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    });
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti view-once forward failed");
  } finally {
    if (slot?.ok) slot.release();
  }
}

/**
 * Anti-spam flood detection. Warns once per burst when a non-admin sends more
 * than SPAM_LIMIT messages within SPAM_WINDOW_MS. Non-destructive (never deletes).
 */
async function enforceAntiSpam(session: Session, groupJid: string, msg: WAMessage): Promise<void> {
  try {
    if (!session.socket) return;
    if (!(await getBool(`antispam:${groupJid}`, session.tenantId))) return;
    const sender = msg.key.participant ?? "";
    if (!sender) return;

    const meta = await getGroupMetadataCached(session.socket, session.tenantId, groupJid);
    const sp = meta ? findParticipant(meta.participants, sender) : undefined;
    if (sp?.admin) return; // never throttle admins

    const key = `${groupJid}|${jidBase(sender)}`;
    const now = Date.now();
    const recent = (session.spamTracker.get(key) ?? []).filter((t) => now - t < SPAM_WINDOW_MS);
    recent.push(now);
    session.spamTracker.set(key, recent);

    // Warn exactly once when the burst first crosses the limit.
    if (recent.length === SPAM_LIMIT + 1) {
      await session.socket.sendMessage(groupJid, {
        text: `⚠️ @${jidBase(sender)} please slow down — that's a lot of messages in a few seconds.`,
        mentions: [sender],
      });
    }
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-spam check failed");
  }
}

/** Send welcome/goodbye messages when group membership changes, if enabled. */
async function handleWelcomeGoodbye(
  session: Session,
  groupId: string,
  participants: GroupParticipant[],
  action: ParticipantAction,
): Promise<void> {
  try {
    if (!session.socket || !groupId) return;
    const isAdd = action === "add";
    const isLeave = action === "remove";
    if (!isAdd && !isLeave) return;

    const enabled = await getBool(`${isAdd ? "welcome" : "goodbye"}:${groupId}`, session.tenantId);
    if (!enabled) return;

    const template =
      (await getConfig(`${isAdd ? "welcometext" : "goodbyetext"}:${groupId}`, session.tenantId)) ||
      (isAdd ? "👋 Welcome @user to the group!" : "👋 @user has left the group.");

    let subject = "";
    try {
      const meta = await getGroupMetadataCached(session.socket, session.tenantId, groupId);
      subject = meta?.subject ?? "";
    } catch {
      /* subject is optional */
    }

    for (const p of participants) {
      const jid = p.id;
      const text = template.replace(/@user/g, `@${jidBase(jid)}`).replace(/@group/g, subject);
      await session.socket.sendMessage(groupId, { text, mentions: [jid] });
    }
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Welcome/goodbye message failed");
  }
}

/**
 * Anti-promote: when enabled for a group, only the bot itself (acting on the
 * owner's command) and the group's creator may hand out admin. If any other
 * admin promotes someone, the bot posts the reason and KICKS BOTH the newly-
 * promoted member(s) and the offending admin from the group. Requires the bot
 * to be a group admin to act.
 */
async function handleAntiPromote(
  session: Session,
  groupId: string,
  author: string,
  participants: GroupParticipant[],
  action: ParticipantAction,
): Promise<void> {
  try {
    if (action !== "promote" || !session.socket || !groupId) return;

    const enabled = await getBool(`antipromote:${groupId}`, session.tenantId);
    if (!enabled) return;

    const meta = await getGroupMetadataCached(session.socket, session.tenantId, groupId);
    if (!meta) return;

    // The bot can only demote/kick when it is itself a group admin.
    const botP = findParticipant(meta.participants, session.socket.user?.id);
    if (!botP?.admin) {
      logger.warn(
        { groupJid: groupId, tenantId: session.tenantId },
        "Anti-promote is enabled but the bot is not a group admin",
      );
      return;
    }

    // Promotions performed by the bot itself or the group's creator are the
    // only sanctioned way to create admins — leave those alone.
    const authorP = findParticipant(meta.participants, author);
    const creatorP = findParticipant(meta.participants, meta.owner);
    if (authorP && authorP.id === botP.id) return;
    if (authorP && creatorP && authorP.id === creatorP.id) return;

    // Never kick the bot or the group creator. A kick candidate from the event
    // can arrive as a different identity variant (@lid vs phone) for the same
    // user, so each candidate is resolved against group metadata and compared by
    // resolved participant identity — not just one base string — with the base
    // set kept only as a fallback for unresolved candidates.
    const protectedBases = new Set([jidBase(botP.id)]);
    if (creatorP) protectedBases.add(jidBase(creatorP.id));

    const offenderId = authorP?.id ?? author;
    const offenderBase = jidBase(offenderId);

    // Kick BOTH the newly-promoted member(s) and the offending admin.
    const toKick: string[] = [];
    const mentions: string[] = [];
    const seen = new Set<string>();
    // Returns the canonical JID actually queued (so the reason text only ever
    // @-mentions users that are also in `mentions`), or null when skipped.
    const queue = (jid: string | null | undefined): string | null => {
      if (!jid) return null;
      const resolved = findParticipant(meta.participants, jid);
      if (resolved && (resolved.id === botP.id || (creatorP && resolved.id === creatorP.id))) return null;
      const id = resolved?.id ?? jid;
      const base = jidBase(id);
      if (!base || protectedBases.has(base) || seen.has(base)) return null;
      seen.add(base);
      toKick.push(id);
      mentions.push(id);
      return id;
    };

    const promotedKicked: string[] = [];
    for (const p of participants) {
      const id = queue(p.id); // member(s) who were given admin
      if (id) promotedKicked.push(id);
    }
    const offenderKicked = queue(offenderId); // the admin who promoted them
    if (!toKick.length) return;

    // Show the reason FIRST, then kick both — a send failure must not block the kick.
    const promotedText = promotedKicked.map((id) => `@${jidBase(id)}`).join(", ");
    const offenderText = offenderKicked ? `@${jidBase(offenderKicked)}` : "An admin";
    try {
      await session.socket.sendMessage(groupId, {
        text:
          `🛡️ *Anti-promote enforced.* Only the bot owner can appoint admins here.\n` +
          `${offenderText} tried to make ${promotedText || "a member"} an admin — removing both from the group.`,
        mentions,
      });
    } catch (err) {
      logger.warn({ err, tenantId: session.tenantId }, "Anti-promote reason message failed");
    }

    await session.socket.groupParticipantsUpdate(groupId, toKick, "remove");

    await db.insert(activityLogTable).values({
      tenantId: session.tenantId,
      type: "message",
      description: `Anti-promote kicked the promoter (${offenderBase}) and the promoted member(s) for an unauthorized promotion`,
    });
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-promote enforcement failed");
  }
}

/**
 * Admin-change announcement: when enabled for a group, post a message whenever a
 * member is promoted to admin or an admin is demoted, naming the affected
 * user(s) and (when known) who made the change — all as @mentions. Toggle with
 * `.adminevents on/off`; default OFF.
 */
async function handleAdminChange(
  session: Session,
  groupId: string,
  author: string,
  participants: GroupParticipant[],
  action: ParticipantAction,
): Promise<void> {
  try {
    if ((action !== "promote" && action !== "demote") || !session.socket || !groupId) return;

    const enabled = await getBool(`adminevents:${groupId}`, session.tenantId);
    if (!enabled) return;

    const targets = participants.map((p) => p.id).filter((id) => jidBase(id));
    if (!targets.length) return;

    const targetText = targets.map((id) => `@${jidBase(id)}`).join(", ");
    const mentions = [...targets];
    const actorBase = jidBase(author);
    const verb = action === "promote" ? "promoted to *admin* 👑" : "*demoted* from admin 👤";

    let text: string;
    if (actorBase) {
      mentions.push(author);
      text = `📢 ${targetText} was ${verb} by @${actorBase}.`;
    } else {
      text = `📢 ${targetText} was ${verb}.`;
    }

    await session.socket.sendMessage(groupId, { text, mentions });
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Admin-change announcement failed");
  }
}

/**
 * Anti-demote: when enabled for a group, only the bot (acting on the owner's
 * command), the group's creator, and the configured bot owner may strip admin.
 * If any other admin demotes an admin, the bot posts the reason and KICKS the
 * offending admin from the group. Requires the bot to be a group admin to act.
 */
async function handleAntiDemote(
  session: Session,
  groupId: string,
  author: string,
  participants: GroupParticipant[],
  action: ParticipantAction,
): Promise<void> {
  try {
    if (action !== "demote" || !session.socket || !groupId) return;

    const enabled = await getBool(`antidemote:${groupId}`, session.tenantId);
    if (!enabled) return;

    const meta = await getGroupMetadataCached(session.socket, session.tenantId, groupId);
    if (!meta) return;

    // The bot can only kick when it is itself a group admin.
    const botP = findParticipant(meta.participants, session.socket.user?.id);
    if (!botP?.admin) {
      logger.warn(
        { groupJid: groupId, tenantId: session.tenantId },
        "Anti-demote is enabled but the bot is not a group admin",
      );
      return;
    }

    // Demotions by the bot itself, the group creator, or the configured owner
    // are sanctioned — leave those alone.
    const authorP = findParticipant(meta.participants, author);
    const creatorP = findParticipant(meta.participants, meta.owner);
    if (authorP && authorP.id === botP.id) return;
    if (authorP && creatorP && authorP.id === creatorP.id) return;
    const ownerNumber = await getConfig("ownerNumber", session.tenantId);
    if (ownerNumber && participantHasNumber(authorP ?? { id: author }, ownerNumber)) return;

    const offenderId = authorP?.id ?? author;
    const offenderBase = jidBase(offenderId);
    if (!offenderBase) return;

    // Never kick the bot, the creator, or the configured owner.
    if (offenderId === botP.id) return;
    if (creatorP && offenderId === creatorP.id) return;

    const demotedText = participants
      .map((p) => `@${jidBase(p.id)}`)
      .filter((t) => t !== "@")
      .join(", ");
    const mentions = [...participants.map((p) => p.id), offenderId];

    try {
      await session.socket.sendMessage(groupId, {
        text:
          `🛡️ *Anti-demote enforced.* Only the bot owner or group creator may change admins here.\n` +
          `@${offenderBase} demoted ${demotedText || "an admin"} — removing them from the group.`,
        mentions,
      });
    } catch (err) {
      logger.warn({ err, tenantId: session.tenantId }, "Anti-demote reason message failed");
    }

    await session.socket.groupParticipantsUpdate(groupId, [offenderId], "remove");

    await db.insert(activityLogTable).values({
      tenantId: session.tenantId,
      type: "message",
      description: `Anti-demote kicked the admin (${offenderBase}) for an unauthorized demotion`,
    });
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-demote enforcement failed");
  }
}

// Matches any URL the sender may post: http(s)://..., www. subdomains, and
// bare domains/paths such as "facebook.com", "tiktok.com/@x", "chat.whatsapp.com/...".
const LINK_REGEX =
  /(?:https?:\/\/|www\.)[^\s<>]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>]*)?/i;

/**
 * Anti-link: when a member posts ANY link (WhatsApp invite, Facebook, TikTok,
 * Instagram, YouTube, every URL) in a group, the bot deletes the message and
 * gives them a warning — for the 1st and 2nd offence. On the 3rd offence the
 * bot kicks them immediately. This runs regardless of the `.antilink` toggle.
 * The bot's own account, the configured owner, and group admins are exempt (the
 * owner may post from their own account — possibly as an `@lid` identity —
 * without it being a `fromMe` message, so the match must be LID/phone-aware).
 * The bot can only act when it is itself a group admin.
 *
 * Warning counters are tracked per group+user (in-memory, per tenant) and are
 * enforced once the bot has reached the kick threshold.
 *
 * Returns true when it removed the message (+ sender on the 3rd strike): the
 * caller should stop processing the message.
 */
async function enforceAntiLink(session: Session, groupJid: string, msg: WAMessage, body: string): Promise<boolean> {
  try {
    if (!LINK_REGEX.test(body) || !session.socket) return false;

    const meta = await getGroupMetadataCached(session.socket, session.tenantId, groupJid);
    if (!meta) return false;

    const sender = msg.key.participant ?? "";
    if (!sender) return false;
    const senderBase = jidBase(sender);
    const senderP = findParticipant(meta.participants, sender);

    // The bot itself and the configured owner are always exempt.
    const botNumber = jidBase(session.socket.user?.id);
    const ownerNumber = await getConfig("ownerNumber", session.tenantId);
    const isBot = senderBase === botNumber || participantHasNumber(senderP, botNumber);
    const isOwner =
      ownerNumber !== "" && (senderBase === ownerNumber || participantHasNumber(senderP, ownerNumber));
    if (isBot || isOwner) return false;

    if (senderP?.admin) return false; // admins are exempt

    // The bot can only delete messages when it is a group admin.
    const botP = findParticipant(meta.participants, session.socket.user?.id);
    if (!botP?.admin) {
      logger.warn({ groupJid, tenantId: session.tenantId }, "Anti-link is active but the bot is not a group admin");
      return false;
    }

    // First delete the offending link message.
    await session.socket.sendMessage(groupJid, { delete: msg.key });

    // Bump the warning counter for this user in this group.
    const key = `${groupJid}:${senderBase}`;
    const strike = (session.antilinkWarnings.get(key) ?? 0) + 1;
    session.antilinkWarnings.set(key, strike);

    if (strike < 3) {
      // 1st / 2nd offence: warn but don't kick.
      await session.socket.sendMessage(groupJid, {
        text:
          `⚠️ @${senderBase}, group links are not allowed here.\n` +
          `*Warning ${strike}/3*. ${
            strike === 1 ? "Next time you'll get a 2nd warning." : "One more and you'll be removed."
          }`,
        mentions: [sender],
      });
      await db.insert(activityLogTable).values({
        tenantId: session.tenantId,
        type: "message",
        description: `Anti-link deleted a link from ${senderBase} (warning ${strike}/3)`,
      });
      return true;
    }

    // 3rd offence: kick immediately.
    await session.socket.groupParticipantsUpdate(groupJid, [sender], "remove");
    await session.socket.sendMessage(groupJid, {
      text: `🚫 @${senderBase} removed for posting links after 3 warnings.`,
      mentions: [sender],
    });
    session.antilinkWarnings.delete(key);
    await db.insert(activityLogTable).values({
      tenantId: session.tenantId,
      type: "message",
      description: `Anti-link removed ${senderBase} after 3 warnings`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-link enforcement failed");
    return false;
  }
}

// Anti-badword: a curated list of strong profanity / slurs. Matched as whole
// words (case-insensitive, `\b` boundaries) so compound words like "class",
// "passion" or "peacock" never trigger a false positive. This is intentionally
// conservative — it targets unambiguous profanity, not every rude word.
const BAD_WORDS = [
  "fuck",
  "fucker",
  "fucking",
  "motherfucker",
  "shit",
  "bullshit",
  "bitch",
  "bastard",
  "asshole",
  "dickhead",
  "cunt",
  "slut",
  "whore",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "pussy",
  "cock",
  "dick",
  "wanker",
  "prick",
  "jerk",
];
const BADWORD_REGEX = new RegExp(`\\b(?:${BAD_WORDS.join("|")})\\b`, "i");

/**
 * Anti-badword: when enabled for a group, a member who sends a banned word is
 * removed from the group immediately — no warning. Admins and the owner are
 * exempt, and the bot can only act when it is itself a group admin. The
 * offending message is deleted and a short notice posted after removal.
 *
 * Returns true when it removed the sender (caller should stop processing the
 * message). Opt-in per group via `.antibadword on` (default OFF).
 */
async function enforceAntiBadword(
  session: Session,
  groupJid: string,
  msg: WAMessage,
  body: string,
): Promise<boolean> {
  try {
    if (!BADWORD_REGEX.test(body)) return false;
    const enabled = await getBool(`antibadword:${groupJid}`, session.tenantId);
    if (!enabled || !session.socket) return false;

    const meta = await getGroupMetadataCached(session.socket, session.tenantId, groupJid);
    if (!meta) return false;

    const sender = msg.key.participant ?? "";
    if (!sender) return false;
    const senderBase = jidBase(sender);
    const senderP = findParticipant(meta.participants, sender);

    // The bot itself and the configured owner are always exempt (the owner may
    // post from their own account — possibly as an `@lid` identity — without it
    // being a `fromMe` message), so the match must be LID/phone-aware.
    const botNumber = jidBase(session.socket.user?.id);
    const ownerNumber = await getConfig("ownerNumber", session.tenantId);
    const isBot = senderBase === botNumber || participantHasNumber(senderP, botNumber);
    const isOwner =
      ownerNumber !== "" && (senderBase === ownerNumber || participantHasNumber(senderP, ownerNumber));
    if (isBot || isOwner) return false;

    if (senderP?.admin) return false; // admins are exempt

    // The bot can only delete/remove when it is a group admin.
    const botP = findParticipant(meta.participants, session.socket.user?.id);
    if (!botP?.admin) {
      logger.warn(
        { groupJid, tenantId: session.tenantId },
        "Anti-badword is enabled but the bot is not a group admin",
      );
      return false;
    }

    await session.socket.sendMessage(groupJid, { delete: msg.key });
    await session.socket.groupParticipantsUpdate(groupJid, [sender], "remove");
    await session.socket.sendMessage(groupJid, {
      text: `🚫 @${senderBase} was removed for using inappropriate language.`,
      mentions: [sender],
    });
    await db.insert(activityLogTable).values({
      tenantId: session.tenantId,
      type: "message",
      description: `Anti-badword removed ${senderBase}`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-badword enforcement failed");
    return false;
  }
}

/**
 * Anti-status: when enabled for a group, a status a member shares INTO the group
 * (WhatsApp's "mention this group in my status" feature — delivered as a
 * groupStatusMention / statusMention message) is deleted immediately, with no
 * notice. The bot's own account, the configured owner, and group admins are
 * exempt, and the bot can only delete when it is itself a group admin.
 *
 * Returns true when it deleted the message (caller should stop processing it).
 * Opt-in per group via `.antistatus on` (default OFF).
 */
async function enforceAntiStatus(session: Session, groupJid: string, msg: WAMessage): Promise<boolean> {
  try {
    const m = msg.message;
    const isStatusShare = Boolean(m?.groupStatusMentionMessage || m?.statusMentionMessage);
    if (!isStatusShare) return false;

    const enabled = await getBool(`antistatus:${groupJid}`, session.tenantId);
    if (!enabled || !session.socket) return false;

    const meta = await getGroupMetadataCached(session.socket, session.tenantId, groupJid);
    if (!meta) return false;

    const sender = msg.key.participant ?? "";
    if (!sender) return false;
    const senderBase = jidBase(sender);
    const senderP = findParticipant(meta.participants, sender);

    // The bot itself and the configured owner are always exempt (the owner may
    // post from their own account — possibly as an `@lid` identity — without it
    // being a `fromMe` message), so the match must be LID/phone-aware.
    const botNumber = jidBase(session.socket.user?.id);
    const ownerNumber = await getConfig("ownerNumber", session.tenantId);
    const isBot = senderBase === botNumber || participantHasNumber(senderP, botNumber);
    const isOwner =
      ownerNumber !== "" && (senderBase === ownerNumber || participantHasNumber(senderP, ownerNumber));
    if (isBot || isOwner) return false;

    if (senderP?.admin) return false; // admins are exempt

    // The bot can only delete others' messages when it is a group admin.
    const botP = findParticipant(meta.participants, session.socket.user?.id);
    if (!botP?.admin) {
      logger.warn(
        { groupJid, tenantId: session.tenantId },
        "Anti-status is enabled but the bot is not a group admin",
      );
      return false;
    }

    await session.socket.sendMessage(groupJid, { delete: msg.key });
    await db.insert(activityLogTable).values({
      tenantId: session.tenantId,
      type: "message",
      description: `Anti-status removed a status from ${senderBase}`,
    });
    return true;
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-status enforcement failed");
    return false;
  }
}

// Crash-payload ("bug") detection. WhatsApp crash messages try to freeze the
// client with one of a few signatures: an abnormally long body, a flood of
// invisible/format-control characters, stacked "zalgo" combining marks, or a
// mention bomb (thousands of @mentions). Normal messages never reach these
// limits, and the destructive `remove` tier is kept conservative so that a long
// legitimate paste or a big-group tag-all is never grounds for a kick.

// Invisible / format controls (zero-width, bidi overrides, joiners, fillers,
// variation selectors, soft hyphen). These essentially never appear in real text
// in any quantity, so a flood is judged by raw count.
const BUG_INVISIBLE_REGEX =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/gu;
// Tag characters (U+E0000–E01EF) — a staple of modern crash payloads — counted
// as invisible too.
const BUG_TAG_REGEX = /[\u{E0000}-\u{E01EF}]/gu;
// "Zalgo" combining marks. These DO occur in legitimate scripts, so they are
// judged by DENSITY (marks per visible base char) with a minimum count, never by
// raw count alone — real text has a couple per base; zalgo stacks dozens.
const BUG_COMBINING_REGEX =
  /[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0711\u0730-\u074A\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/gu;

const BUG_DROP_LEN = 30000;
const BUG_REMOVE_LEN = 60000;
const BUG_INVISIBLE_DROP = 200;
const BUG_INVISIBLE_REMOVE = 800;
const BUG_COMBINING_MIN = 200; // floor before zalgo density is considered at all
const BUG_ZALGO_RATIO_DROP = 2.5; // combining marks per visible base char
const BUG_ZALGO_RATIO_REMOVE = 5; // well above heavily-vocalized real text (~≤2)
const BUG_MENTION_DROP = 400;
const BUG_MENTION_REMOVE = 1024; // beyond any real group => duplicated/fake jids

/** Pulls every text/caption surface a crash payload can hide in. */
const extractScanText = (msg: WAMessage): string => {
  const m = msg.message;
  if (!m) return "";
  const q = m.extendedTextMessage?.contextInfo?.quotedMessage;
  const parts: Array<string | null | undefined> = [
    m.conversation,
    m.extendedTextMessage?.text,
    m.imageMessage?.caption,
    m.videoMessage?.caption,
    m.documentMessage?.caption,
    m.documentWithCaptionMessage?.message?.documentMessage?.caption,
    m.buttonsMessage?.contentText,
    m.listMessage?.description,
    m.templateMessage?.hydratedTemplate?.hydratedContentText,
    // a bug can also ride inside the quoted message it replies to
    q?.conversation,
    q?.extendedTextMessage?.text,
    q?.imageMessage?.caption,
    q?.videoMessage?.caption,
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
};

/** Counts @mentions across every message surface (mention-bomb signal). */
const countMentions = (msg: WAMessage): number => {
  const m = msg.message as unknown as
    | Record<string, { contextInfo?: { mentionedJid?: unknown } } | null | undefined>
    | null
    | undefined;
  if (!m) return 0;
  let total = 0;
  for (const v of Object.values(m)) {
    const mj = v?.contextInfo?.mentionedJid;
    if (Array.isArray(mj)) total += mj.length;
  }
  return total;
};

/**
 * Classifies a message as a crash ("bug") payload. `drop` => never process it
 * (safe, non-destructive); `remove` => signature strong enough to also delete +
 * kick the sender in a group. `remove` stays deliberately conservative.
 */
function classifyBugPayload(text: string, mentions: number): { drop: boolean; remove: boolean } {
  const len = text.length;
  const invisible =
    (text.match(BUG_INVISIBLE_REGEX) ?? []).length + (text.match(BUG_TAG_REGEX) ?? []).length;
  const combining = (text.match(BUG_COMBINING_REGEX) ?? []).length;
  const bases = Math.max(len - combining - invisible, 1);
  const zalgoRatio = combining / bases;

  const remove =
    len > BUG_REMOVE_LEN ||
    invisible > BUG_INVISIBLE_REMOVE ||
    // zalgo kicks ONLY on density, never raw count — long vocalized Arabic/Hebrew
    // has a high mark count but low (~≤2) density and must never be grounds to kick.
    (combining >= BUG_COMBINING_MIN && zalgoRatio > BUG_ZALGO_RATIO_REMOVE) ||
    mentions > BUG_MENTION_REMOVE;

  const drop =
    remove ||
    len > BUG_DROP_LEN ||
    invisible > BUG_INVISIBLE_DROP ||
    (combining >= BUG_COMBINING_MIN && zalgoRatio > BUG_ZALGO_RATIO_DROP) ||
    mentions > BUG_MENTION_DROP;

  return { drop, remove };
}

/**
 * Anti-bug: when enabled, drop a detected crash ("bug") payload so it never
 * reaches caching, command dispatch, logging, or auto-reply. In groups, on a
 * clear malicious signature and when the bot is an admin (and the sender is a
 * normal member), also delete the message and remove the sender.
 *
 * Returns true when the message was a bug payload the caller should stop
 * processing. Fails CLOSED: a detected payload is still dropped even if the
 * config lookup or group cleanup errors out (removal is best-effort), but the
 * destructive kick only runs when the toggle is confirmed ON.
 */
async function enforceAntiBug(session: Session, msg: WAMessage): Promise<boolean> {
  const scanText = extractScanText(msg);
  const mentions = countMentions(msg);
  const { drop, remove } = classifyBugPayload(scanText, mentions);
  if (!drop) return false;

  let enabled = true;
  let configRead = true;
  try {
    enabled = await getBool("antibug", session.tenantId);
  } catch {
    // Config/DB read failed: fail closed and drop (default is ON), but skip the
    // destructive removal since we can't confirm the toggle is on.
    configRead = false;
  }
  if (!enabled) return false;

  const fromJid = msg.key.remoteJid ?? "";
  try {
    logger.warn(
      { tenantId: session.tenantId, fromJid, length: scanText.length, mentions, remove },
      "Anti-bug blocked a crash payload",
    );
    await db.insert(activityLogTable).values({
      tenantId: session.tenantId,
      type: "message",
      description: "Anti-bug blocked a crash payload",
    });

    if (remove && configRead && fromJid.endsWith("@g.us") && session.socket) {
      const sender = msg.key.participant ?? "";
      const meta = sender
        ? await getGroupMetadataCached(session.socket, session.tenantId, fromJid)
        : null;
      if (sender && meta) {
        const senderBase = jidBase(sender);
        const senderP = findParticipant(meta.participants, sender);
        const botP = findParticipant(meta.participants, session.socket.user?.id);

        // The bot itself and the configured owner are always exempt — the owner
        // may post from their own account (possibly as an `@lid` identity) without
        // it being a `fromMe` message — so the match must be LID/phone-aware.
        const botNumber = jidBase(session.socket.user?.id);
        const ownerNumber = await getConfig("ownerNumber", session.tenantId);
        const isBot = senderBase === botNumber || participantHasNumber(senderP, botNumber);
        const isOwner =
          ownerNumber !== "" &&
          (senderBase === ownerNumber || participantHasNumber(senderP, ownerNumber));

        // The bot can only delete/remove when it is a group admin; never act on
        // the bot, the owner, or another admin.
        if (!isBot && !isOwner && !senderP?.admin && botP?.admin) {
          await session.socket.sendMessage(fromJid, { delete: msg.key });
          await session.socket.groupParticipantsUpdate(fromJid, [sender], "remove");
        } else if (!botP?.admin) {
          logger.warn(
            { fromJid, tenantId: session.tenantId },
            "Anti-bug detected a payload but the bot is not a group admin",
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ err, tenantId: session.tenantId }, "Anti-bug enforcement failed");
  }
  return true;
}

async function handleAutoReply(session: Session, jid: string, body: string, type: "dm" | "group"): Promise<void> {
  try {
    const rules = await db
      .select()
      .from(autoReplyRulesTable)
      .where(and(eq(autoReplyRulesTable.tenantId, session.tenantId), eq(autoReplyRulesTable.isActive, true)));

    for (const rule of rules) {
      if (rule.scope !== "all" && rule.scope !== type) continue;

      let matched = false;
      const lowerBody = body.toLowerCase();
      const lowerKeyword = rule.keyword.toLowerCase();

      switch (rule.matchType) {
        case "exact":
          matched = lowerBody === lowerKeyword;
          break;
        case "contains":
          matched = lowerBody.includes(lowerKeyword);
          break;
        case "startsWith":
          matched = lowerBody.startsWith(lowerKeyword);
          break;
        case "regex":
          try {
            matched = new RegExp(rule.keyword, "i").test(body);
          } catch {}
          break;
        default:
          matched = lowerBody.includes(lowerKeyword);
      }

      if (matched && session.socket) {
        await session.socket.sendMessage(jid, { text: rule.response });
        await db.insert(activityLogTable).values({
          tenantId: session.tenantId,
          type: "auto_reply",
          description: `Auto-replied to "${body.slice(0, 30)}" with rule "${rule.keyword}"`,
        });
        break;
      }
    }
  } catch (err) {
    logger.error({ err, tenantId: session.tenantId }, "Error handling auto-reply");
  }
}

/** Persist a tenant's connection status without throwing on DB hiccups. */
async function markTenantStatus(tenantId: number, status: "active" | "disconnected"): Promise<void> {
  try {
    await db.update(tenantsTable).set({ status }).where(eq(tenantsTable.id, tenantId));
  } catch (err) {
    logger.warn({ err, tenantId, status }, "Failed to update tenant status");
  }
}

function scheduleReconnect(session: Session): void {
  if (session.reconnectTimer) return;
  session.reconnectAttempts += 1;
  const base = Math.min(3000 * 2 ** (session.reconnectAttempts - 1), 60_000);
  const delay = base + Math.floor(Math.random() * 1000);
  logger.info(
    { tenantId: session.tenantId, attempt: session.reconnectAttempts, delay },
    "Scheduling WhatsApp reconnect",
  );
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    void connectTenant(session.tenantId).catch((err) =>
      logger.warn({ err, tenantId: session.tenantId }, "Reconnect attempt failed"),
    );
  }, delay);
}

function wireSocketEvents(
  session: Session,
  sock: WASocket,
  saveCreds: () => Promise<void>,
): void {
  const tenantId = session.tenantId;
  // True only while `sock` is still the session's live socket. Baileys can emit
  // delayed events (notably a late "close") from a socket we've already replaced
  // on reconnect; dropping those prevents an old socket from nulling/rescheduling
  // the new connection or writing stale creds over fresh ones.
  const isLive = () => session.socket === sock;

  sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
    if (!isLive()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // The raw qr event means the websocket handshake is far enough along to
      // request a pairing code — flag readiness BEFORE rendering so a QR image
      // failure below can't make pairing time out.
      session.pairingReady = true;
      try {
        const QRCode = await import("qrcode");
        const qrDataUrl = await QRCode.toDataURL(qr);
        session.state.qrCode = qrDataUrl;
        session.state.state = "connecting";
        logger.info({ tenantId }, "QR code generated");
      } catch (e) {
        session.state.qrCode = null;
        logger.warn({ err: e, tenantId }, "Failed to generate QR data URL");
      }
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      // Do NOT auto-reconnect when another connection replaced us (conflict/440).
      // Reconnecting on "replaced" just kicks the other session off, which kicks
      // us off again — an endless ping-pong that hammers WhatsApp and can get the
      // number banned. Only one instance may hold a WhatsApp account at a time
      // (single-instance rule); the most recent connection wins and the rest stay
      // down. Logged-out (creds revoked) also must not reconnect.
      const replaced = reason === DisconnectReason.connectionReplaced;
      const shouldReconnect = reason !== DisconnectReason.loggedOut && !replaced;
      session.state = freshState();
      session.socket = null;
      session.pairingReady = false;
      if (replaced) {
        logger.warn(
          { reason, tenantId },
          "WhatsApp session replaced by another connection — not reconnecting. Another instance/device holds this account; run a single instance, then /disconnect and re-pair if this one should own it.",
        );
        await markTenantStatus(tenantId, "disconnected");
      } else {
        logger.info({ reason, shouldReconnect, tenantId }, "WhatsApp connection closed");
        if (shouldReconnect) {
          scheduleReconnect(session);
        } else {
          // reason === loggedOut (401): WhatsApp revoked these creds. Wipe them
          // so the next /pair or /qr starts a fresh session and can actually
          // emit a QR / pairing code. Leaving stale "registered" creds on disk
          // is what makes every reconnect retry a dead login (the 401 loop that
          // blocks re-pairing). NOT done for transient/replaced closes.
          if (reason === DisconnectReason.loggedOut) {
            clearAuthDir(tenantId);
          }
          await markTenantStatus(tenantId, "disconnected");
        }
      }
    }

    if (connection === "open") {
      session.state.state = "connected";
      session.state.qrCode = null;
      session.reconnectAttempts = 0;
      const me = sock.user;
      session.state.phoneNumber = me?.id?.split(":")[0] ?? null;
      session.state.profileName = me?.name ?? null;
      logger.info({ phone: session.state.phoneNumber, tenantId }, "WhatsApp connected");

      // The account that paired this tenant becomes its owner by default.
      const ownerNum = session.state.phoneNumber ? session.state.phoneNumber.split("@")[0] : null;
      try {
        const cfg = await loadConfig(tenantId);
        if (!cfg.ownerNumber && ownerNum) {
          await setConfig("ownerNumber", ownerNum, tenantId);
        }
      } catch (err) {
        logger.warn({ err, tenantId }, "Failed to auto-set owner number");
      }

      try {
        await db
          .update(tenantsTable)
          .set({ status: "active", ownerNumber: ownerNum, ownerJid: me?.id ?? null })
          .where(eq(tenantsTable.id, tenantId));
      } catch (err) {
        logger.warn({ err, tenantId }, "Failed to persist tenant owner/status");
      }

      await db.insert(activityLogTable).values({
        tenantId,
        type: "message",
        description: `Bot connected as ${session.state.profileName ?? session.state.phoneNumber}`,
      });
    }
  });

  sock.ev.on("creds.update", async () => {
    if (!isLive()) return;
    await saveCreds();
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!isLive()) return;
    for (const msg of messages) {
      if (!msg.message) continue;

      // Anti-delete: a "delete for everyone" arrives as a REVOKE protocol message.
      if (msg.message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
        await handleAntiDelete(session, msg);
        continue;
      }

      // Anti-bug: drop crash/"bug" payloads as early as possible — before
      // caching, view-once handling, command dispatch, logging, or auto-reply.
      // In groups it also deletes the message and removes the sender (when the
      // bot is an admin). Owner messages are skipped.
      if (!msg.key.fromMe && (await enforceAntiBug(session, msg))) continue;

      rememberMessage(session, msg);

      // Anti view-once: auto-forward a one-time photo/video/voice to the owner.
      void handleAntiViewOnce(session, msg);

      // Auto-read: mark other people's incoming messages as read when enabled.
      if (!msg.key.fromMe && (await getBool("autoread", tenantId))) {
        try {
          await session.socket?.readMessages([msg.key]);
        } catch {
          /* read receipts are best-effort */
        }
      }

      const fromJid = msg.key.remoteJid ?? "";
      const isGroup = fromJid.endsWith("@g.us");
      const body =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.imageMessage?.caption ??
        msg.message.videoMessage?.caption ??
        "";

      // Anti-link runs BEFORE command dispatch so a link hidden inside a
      // command or a media caption is still moderated. Owner messages are skipped.
      if (isGroup && !msg.key.fromMe && body) {
        const removed = await enforceAntiLink(session, fromJid, msg, body);
        if (removed) continue;
      }

      // Alinks: when enabled (owner-configured), forward any WhatsApp group
      // invite links seen in incoming messages to the configured target chats.
      // Fire-and-forget — never blocks dispatch; errors are swallowed inside.
      if (session.socket && !msg.key.fromMe && body) {
        void handleAlinksForward(session.socket, tenantId, msg, body);
      }

      // Anti-badword: a group member who sends a banned word is removed
      // immediately (no warning). Admins/owner exempt; bot must be group admin.
      if (isGroup && !msg.key.fromMe && body) {
        const removed = await enforceAntiBadword(session, fromJid, msg, body);
        if (removed) continue;
      }

      // Anti-status: delete a status a member shares into the group (WhatsApp's
      // "mention this group in my status"). NOT gated on `body` — a status share
      // carries no text. Admins/owner exempt; bot must be a group admin.
      if (isGroup && !msg.key.fromMe) {
        const removed = await enforceAntiStatus(session, fromJid, msg);
        if (removed) continue;
      }

      // Anti-spam flood detection (group, non-owner). Non-blocking warning.
      if (isGroup && !msg.key.fromMe) {
        await enforceAntiSpam(session, fromJid, msg);
      }

      // A bare reply to an interactive `.play` menu (1/2/mp3/mp4) is intercepted
      // BEFORE command dispatch — it isn't a prefixed command, so the dispatcher
      // would otherwise ignore it. No-op when there's no pending menu.
      try {
        if (session.socket && body) {
          const sender = resolveSender(msg, session.socket.user?.id ?? "");
          const handled = await handleDownloadSelection({
            sock: session.socket,
            msg,
            tenantId,
            from: fromJid,
            sender,
            body,
          });
          if (handled) continue;
        }
      } catch (err) {
        logger.error({ err, tenantId }, "Download selection error");
      }

      // A bare reply (single letter / digit / word) to an active chat game
      // (hangman / tic-tac-toe / word-chain) is routed to that game BEFORE
      // command dispatch. Cheap no-op when no game is active in this chat.
      try {
        if (session.socket && body) {
          const sender = resolveSender(msg, session.socket.user?.id ?? "");
          const handled = await handleGameInput({
            sock: session.socket,
            msg,
            tenantId,
            from: fromJid,
            sender,
            body,
          });
          if (handled) continue;
        }
      } catch (err) {
        logger.error({ err, tenantId }, "Game input error");
      }

      // AFK: announce when an away user is mentioned/replied-to, and clear +
      // welcome-back when an away user returns. Fire-and-forget (never blocks
      // the loop, never stops dispatch — a returning user's command still runs).
      // Skip the bot's own (fromMe) messages: they'd otherwise re-announce the
      // very AFK notice the bot just sent (mention echo / loop).
      if (session.socket && !msg.key.fromMe) {
        const sock = session.socket;
        const sender = resolveSender(msg, sock.user?.id ?? "");
        void handleAfk({ sock, msg, tenantId, from: fromJid, sender, body }).catch((err) =>
          logger.error({ err, tenantId }, "AFK handler error"),
        );
      }

      // Auto-react: when enabled, react to incoming (non-self) messages with a
      // random emoji. Fire-and-forget so it never blocks the message loop.
      if (session.socket && !msg.key.fromMe) {
        const sock = session.socket;
        void (async () => {
          try {
            if (!(await getBool("autoreact", tenantId))) return;
            const emojis = ["❤️", "🔥", "😂", "👍", "🎉", "💯", "😮", "🥳", "👏", "✨"];
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            await sock.sendMessage(fromJid, { react: { text: emoji, key: msg.key } });
          } catch (err) {
            logger.error({ err, tenantId }, "Auto-react error");
          }
        })();
      }

      // Command dispatch runs for all messages (including the owner's own
      // messages so they can self-command). If handled, skip logging/auto-reply.
      try {
        if (session.socket) {
          const handled = await handleCommand(session.socket, msg, tenantId);
          if (handled) continue;
        }
      } catch (err) {
        logger.error({ err, tenantId }, "Command dispatch error");
      }

      if (msg.key.fromMe) continue;
      if (!body) continue;

      if (isGroup) {
        recordActivity(tenantId, fromJid, msg.key.participant ?? fromJid);
      }

      const fromName =
        msg.pushName ??
        msg.key.participant?.split("@")[0] ??
        fromJid.split("@")[0];

      let groupName: string | null = null;
      if (isGroup && session.socket) {
        const meta = await getGroupMetadataCached(session.socket, tenantId, fromJid);
        groupName = meta?.subject ?? null;
      }

      await db.insert(messagesTable).values({
        tenantId,
        fromJid,
        fromName,
        toJid: session.socket?.user?.id ?? "",
        body,
        type: isGroup ? "group" : "dm",
        groupName,
        timestamp: new Date().toISOString(),
      });

      await handleAutoReply(session, fromJid, body, isGroup ? "group" : "dm");
    }
  });

  sock.ev.on("contacts.update", async (updates) => {
    if (!isLive()) return;
    for (const contact of updates) {
      if (!contact.id) continue;
      await db
        .insert(contactsTable)
        .values({
          tenantId,
          jid: contact.id,
          name: contact.notify ?? contact.id.split("@")[0],
          notify: contact.notify ?? null,
          lid: contact.lid ?? (contact.id.endsWith("@lid") ? contact.id : null),
          phoneNumber: contact.phoneNumber ?? (contact.id.endsWith("@s.whatsapp.net") ? contact.id : null),
        })
        .onConflictDoUpdate({
          target: [contactsTable.tenantId, contactsTable.jid],
          set: {
            name: contact.notify ?? contact.id.split("@")[0],
            notify: contact.notify ?? null,
            lid: contact.lid ?? (contact.id.endsWith("@lid") ? contact.id : null),
            phoneNumber: contact.phoneNumber ?? (contact.id.endsWith("@s.whatsapp.net") ? contact.id : null),
          },
        });
    }
  });

  sock.ev.on("groups.update", async (updates) => {
    if (!isLive()) return;
    for (const group of updates) {
      if (!group.id) continue;
      invalidateGroupMetadata(tenantId, group.id);
      await db
        .insert(groupsTable)
        .values({
          tenantId,
          jid: group.id,
          name: group.subject ?? group.id,
          participantCount: group.size ?? 0,
          description: group.desc ?? null,
        })
        .onConflictDoUpdate({
          target: [groupsTable.tenantId, groupsTable.jid],
          set: {
            name: group.subject ?? group.id,
            participantCount: group.size ?? 0,
            description: group.desc ?? null,
          },
        });
    }
  });

  // Membership and admin changes invalidate cached metadata so permission
  // checks (admin exemptions, bot-admin status) stay accurate.
  sock.ev.on("group-participants.update", async ({ id, author, participants, action }) => {
    if (!isLive() || !id) return;
    invalidateGroupMetadata(tenantId, id);
    await handleWelcomeGoodbye(session, id, participants, action);
    await handleAntiPromote(session, id, author, participants, action);
    await handleAntiDemote(session, id, author, participants, action);
    await handleAdminChange(session, id, author, participants, action);
  });

  // Anti-call: auto-reject incoming calls when enabled.
  sock.ev.on("call", async (calls) => {
    try {
      if (!isLive()) return;
      if (!(await getBool("anticall", tenantId)) || !session.socket) return;
      for (const call of calls) {
        if (call.status !== "offer") continue;
        await session.socket.rejectCall(call.id, call.from);
        await session.socket.sendMessage(call.from, {
          text: "📵 Sorry, calls are not allowed. Please send a message instead.",
        });
      }
    } catch (err) {
      logger.warn({ err, tenantId }, "Anti-call rejection failed");
    }
  });

  // Periodic housekeeping: refresh presence (always-online) and prune the
  // anti-spam tracker so stale per-sender entries don't accumulate forever.
  // Created once per session; the closure reads the live socket/state so it
  // survives reconnects, and is cleared only on a full disconnect.
  if (!session.presenceInterval) {
    session.presenceInterval = setInterval(async () => {
      const now = Date.now();
      for (const [key, times] of session.spamTracker) {
        if (times.every((t) => now - t >= SPAM_WINDOW_MS)) session.spamTracker.delete(key);
      }
      try {
        if (session.state.state !== "connected" || !session.socket) return;
        if (await getBool("alwaysonline", tenantId)) {
          await session.socket.sendPresenceUpdate("available");
        }
      } catch {
        /* presence is best-effort */
      }
    }, 10_000);
  }
}

/**
 * Open (or resume) the WhatsApp connection for a single tenant. Idempotent
 * while connecting/connected. Throws if the active-connection cap is hit.
 */
export async function connectTenant(tenantId: number): Promise<void> {
  const session = getOrCreateSession(tenantId);
  if (session.state.state === "connected" || session.state.state === "connecting" || session.connecting) {
    return;
  }
  if (!session.socket && activeConnectionCount() >= MAX_TENANTS) {
    logger.warn({ tenantId, max: MAX_TENANTS }, "Refusing new WhatsApp connection: max active tenants reached");
    // Typed sentinel so callers can show a friendly "try again later" instead of
    // a raw 500 (raise the ceiling with env MAX_WA_TENANTS).
    throw new Error("CAPACITY");
  }

  session.connecting = true;
  session.state.state = "connecting";
  session.state.qrCode = null;
  session.pairingReady = false;
  try {
    fs.mkdirSync(session.authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(session.authDir);
    const version = await getBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: authState,
      logger: logger.child({ module: "baileys", tenantId }) as any,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Keep the pairing/QR window open longer than the 60s default. When a user
      // requests a pairing code, Baileys still runs the QR timer; if it fires
      // before they finish linking, the socket closes and is replaced — which
      // voids the issued pairing code. 2 minutes gives time to find "Link with
      // phone number instead" in WhatsApp and type the code.
      qrTimeout: 120_000,
    });
    session.socket = sock;
    wireSocketEvents(session, sock, saveCreds);
  } catch (err) {
    session.state = freshState();
    session.socket = null;
    throw err;
  } finally {
    session.connecting = false;
  }
}

/** Log out and fully tear down a tenant's WhatsApp connection. */
export async function disconnectTenant(tenantId: number): Promise<void> {
  const session = sessions.get(tenantId);
  if (session) {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    if (session.presenceInterval) {
      clearInterval(session.presenceInterval);
      session.presenceInterval = null;
    }
    if (session.socket) {
      try {
        await session.socket.logout();
      } catch (err) {
        logger.warn({ err, tenantId }, "WhatsApp logout failed");
      }
      session.socket = null;
    }
    session.state = freshState();
    session.reconnectAttempts = 0;
    session.pairingReady = false;
  }
  // ALWAYS wipe on-disk creds, even with no in-memory session (e.g. right after
  // a fresh deploy, where sessions is empty): otherwise stale/revoked creds
  // survive, /disconnect silently no-ops, and the user can never re-pair.
  clearAuthDir(tenantId);
  await markTenantStatus(tenantId, "disconnected");
}

export function getTenantState(tenantId: number): BotState {
  const session = sessions.get(tenantId);
  return session ? { ...session.state } : freshState();
}

// Live socket for a tenant (or null if offline). Used by the task scheduler to
// deliver reminders / scheduled group open-close without exposing the sessions map.
export function getTenantSocket(tenantId: number): WASocket | null {
  return sessions.get(tenantId)?.socket ?? null;
}

// Block (or unblock) a JID on EVERY connected WhatsApp session — i.e. on every
// number currently linked to the bot. Used by the owner-only `.report` scammer
// command so a single report blocks the scammer across the whole bot fleet.
// Failures on an individual session are logged and skipped, never thrown.
export async function blockOnAllSessions(
  jid: string,
  action: "block" | "unblock",
): Promise<{ total: number; ok: number }> {
  let total = 0;
  let ok = 0;
  for (const session of sessions.values()) {
    const sock = session.socket;
    if (!sock) continue;
    total += 1;
    try {
      await sock.updateBlockStatus(jid, action);
      ok += 1;
    } catch (err) {
      logger.warn({ err, tenantId: session.tenantId, jid, action }, "blockOnAllSessions: failed on a session");
    }
  }
  return { total, ok };
}

/**
 * Wait until a freshly-opened (unregistered) socket is actually ready to mint a
 * pairing code. Baileys emits its first `qr` only AFTER the websocket handshake
 * completes, and `requestPairingCode` needs that same open socket — calling it
 * earlier races and yields a code WhatsApp rejects. This is the root cause of
 * pairing flakiness when many users pair at once (the old code used a fixed 2s
 * sleep, which is too short under concurrent CPU/network load). Resolves as soon
 * as the socket is ready; throws if the connect dies or it never comes up.
 */
async function waitForPairingReady(session: Session, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (session.state.state === "connected") return; // linked while we waited
    if (session.socket && session.pairingReady) return; // WS up → safe to pair
    // The socket can briefly be null mid-(re)connect; only give up if the
    // connect truly ended (disconnected and not retrying).
    if (!session.socket && !session.connecting && session.state.state === "disconnected") {
      throw new Error("Socket not initialized");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("PAIRING_TIMEOUT");
}

async function doRequestPairingCode(session: Session, phoneNumber: string): Promise<string> {
  const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
  if (!cleanNumber) throw new Error("Invalid phone number");

  // Already linked: requesting a pairing code here mutates the live auth creds
  // (creds.pairingCode/me) and hands back a code WhatsApp won't accept. The user
  // must unlink first. This is a common cause of "got a code but can't link".
  if (session.state.state === "connected") {
    throw new Error("ALREADY_LINKED");
  }

  if (session.state.state === "disconnected" && !session.connecting) {
    await connectTenant(session.tenantId);
  }

  // Wait for the websocket to actually be up before asking for the code (was a
  // fragile fixed 2s sleep that lost the race under concurrent multi-user load).
  await waitForPairingReady(session);

  if (!session.socket) throw new Error("Socket not initialized");

  // Stale creds that reconnected as already-registered would likewise yield an
  // unusable code — force a clean /disconnect (logout) before re-pairing.
  if (session.socket.authState.creds.registered) {
    throw new Error("ALREADY_REGISTERED");
  }

  return session.socket.requestPairingCode(cleanNumber);
}

export async function requestPairingCodeForTenant(tenantId: number, phoneNumber: string): Promise<string> {
  const session = getOrCreateSession(tenantId);
  // Serialize pair requests per tenant: requestPairingCode mutates live auth
  // creds, so two overlapping requests on one socket (dashboard + Telegram, or a
  // double click) would corrupt the pairing. Chain each request after the prior.
  const task = session.pairLock.then(() => doRequestPairingCode(session, phoneNumber));
  // Keep the chain alive regardless of this request's outcome (swallow here only
  // to protect the chain; the original rejection still propagates via `task`).
  session.pairLock = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/**
 * Soft restart: drop the tenant's socket so the connection.update "close"
 * handler reconnects automatically. We intentionally do NOT call process.exit —
 * the workflow does not auto-restart a killed process.
 */
export async function restartConnection(tenantId: number = LEGACY_TENANT_ID): Promise<void> {
  const session = sessions.get(tenantId);
  try {
    session?.socket?.end(new Error("manual restart"));
  } catch (err) {
    logger.warn({ err, tenantId }, "restartConnection: socket end failed");
  }
  setTimeout(() => {
    const s = sessions.get(tenantId);
    if (!s || s.state.state === "disconnected") {
      void connectTenant(tenantId).catch((err) =>
        logger.warn({ err, tenantId }, "restartConnection: reconnect failed"),
      );
    }
  }, 2000);
}

export async function sendBroadcastMessage(
  recipients: string[],
  message: string,
  tenantId: number = LEGACY_TENANT_ID,
): Promise<{ sentCount: number; failCount: number }> {
  const session = sessions.get(tenantId);
  if (!session?.socket || session.state.state !== "connected") {
    return { sentCount: 0, failCount: recipients.length };
  }

  let sentCount = 0;
  let failCount = 0;

  for (const jid of recipients) {
    try {
      await session.socket.sendMessage(jid, { text: message });
      sentCount++;
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.error({ err, jid, tenantId }, "Failed to send broadcast to recipient");
      failCount++;
    }
  }

  return { sentCount, failCount };
}

export async function postStatus(text: string, tenantId: number = LEGACY_TENANT_ID): Promise<boolean> {
  const session = sessions.get(tenantId);
  if (!session?.socket || session.state.state !== "connected") return false;
  try {
    await session.socket.sendMessage("status@broadcast", { text });
    return true;
  } catch (err) {
    logger.error({ err, tenantId }, "Failed to post status");
    return false;
  }
}

/**
 * One-time migration of the original single-owner auth state into the legacy
 * tenant's directory. Runs at cold boot BEFORE any connect: if root-level
 * `creds.json` exists and `tenant-1/creds.json` does not yet, move every
 * non-`tenant-*` entry into `tenant-1/`, with `creds.json` moved last so the
 * migration is crash-safe and idempotent.
 */
export function migrateLegacyAuthDir(): void {
  try {
    const legacyCreds = path.join(AUTH_ROOT, "creds.json");
    const tenant1Dir = authDirFor(LEGACY_TENANT_ID);
    if (!fs.existsSync(legacyCreds)) return; // nothing to migrate
    if (fs.existsSync(path.join(tenant1Dir, "creds.json"))) return; // already migrated

    // Move each root entry directly into tenant-1/ (creating it, or merging into
    // a pre-existing partial dir). creds.json is moved LAST so the operation is
    // crash-safe and idempotent: the "already migrated" guard above only trips
    // once creds.json has fully landed, and a crash mid-move leaves the root
    // creds.json in place so the next boot retries (overwriting any half-moved
    // files). Per-tenant dirs are never touched.
    fs.mkdirSync(tenant1Dir, { recursive: true });
    const entries = fs
      .readdirSync(AUTH_ROOT)
      .filter((name) => !name.startsWith("tenant-"))
      .sort((a, b) => (a === "creds.json" ? 1 : b === "creds.json" ? -1 : 0));
    for (const name of entries) {
      const dest = path.join(tenant1Dir, name);
      try {
        fs.renameSync(path.join(AUTH_ROOT, name), dest);
      } catch {
        // A prior partial run may have left this entry behind; overwrite it.
        fs.rmSync(dest, { force: true, recursive: true });
        fs.renameSync(path.join(AUTH_ROOT, name), dest);
      }
    }
    logger.info("Migrated legacy WhatsApp auth into the tenant-1 directory");
  } catch (err) {
    logger.error({ err }, "Legacy auth migration failed");
  }
}

/**
 * On boot, reconnect every tenant previously marked active that still has a
 * paired session on disk. Connections are staggered and capped to avoid a
 * thundering herd of socket opens.
 */
export async function bootRestoreTenants(): Promise<void> {
  let rows: { id: number }[] = [];
  try {
    rows = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.status, "active"));
  } catch (err) {
    logger.error({ err }, "Boot restore: failed to list active tenants");
    return;
  }

  let started = 0;
  for (const { id } of rows) {
    if (started >= MAX_TENANTS) {
      logger.warn({ max: MAX_TENANTS }, "Boot restore: hit max active tenants cap");
      break;
    }
    if (!fs.existsSync(path.join(authDirFor(id), "creds.json"))) continue; // never paired / logged out
    started += 1;
    setTimeout(() => {
      void connectTenant(id).catch((err) =>
        logger.warn({ err, tenantId: id }, "Boot restore connect failed"),
      );
    }, started * 1500);
  }
  logger.info({ count: started }, "Boot restore scheduled tenant reconnects");
}

// ---------------------------------------------------------------------------
// Legacy-compatible facade. The dashboard routes and status scheduler still
// operate on the single legacy tenant until per-user dashboard auth lands; they
// import these and get LEGACY_TENANT_ID by default.
// ---------------------------------------------------------------------------

export async function connectWhatsApp(tenantId: number = LEGACY_TENANT_ID): Promise<void> {
  return connectTenant(tenantId);
}

export function getBotState(tenantId: number = LEGACY_TENANT_ID): BotState {
  return getTenantState(tenantId);
}

export async function disconnectWhatsApp(tenantId: number = LEGACY_TENANT_ID): Promise<void> {
  return disconnectTenant(tenantId);
}

export async function requestPairingCode(
  phoneNumber: string,
  tenantId: number = LEGACY_TENANT_ID,
): Promise<string> {
  return requestPairingCodeForTenant(tenantId, phoneNumber);
}
