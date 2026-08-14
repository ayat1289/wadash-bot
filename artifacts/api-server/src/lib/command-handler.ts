import type { WASocket, GroupMetadata } from "@whiskeysockets/baileys";
import { LEGACY_TENANT_ID } from "@workspace/db";
import { logger } from "./logger";
import { loadConfig, getBool, parseSudo } from "./config";
import { getGroupMetadataCached, jidBase, findParticipant } from "./group-meta";
import { registerAllCommands, findCommand } from "./commands";
import { loadPlugins } from "./commands/handlers/plugins";
import { allMenuCommands } from "./commands/menu-data";
import { customCommands } from "./commands/handlers/extras";
import { lockedCommands, blacklist } from "./commands/handlers/extras2";
import type { CommandContext, WAMessage } from "./commands/types";

registerAllCommands();
void loadPlugins().catch((err) => logger.warn({ err }, "Plugin startup load failed"));
const knownMenuCommands = allMenuCommands();
/**
 * Pulls the selected id of a tapped interactive button (quick-reply / template /
 * list / native-flow) so taps dispatch like a typed command. Native-flow taps
 * carry the id inside a JSON blob.
 */
function extractButtonReplyId(m: NonNullable<WAMessage["message"]>): string {
  const id =
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (id) return id;
  const paramsJson =
    m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (paramsJson) {
    try {
      const parsed = JSON.parse(paramsJson) as { id?: unknown };
      if (typeof parsed.id === "string") return parsed.id;
    } catch {
      /* ignore malformed button params */
    }
  }
  return "";
}

function extractBody(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    extractButtonReplyId(m) ||
    ""
  );
}

/**
 * Resolve the canonical sender JID for a message, matching how `CommandContext.sender`
 * is derived: in a group it's the participant; the owner's own (`fromMe`) messages
 * map to the bot JID; otherwise it's the chat JID. Exported so other dispatch paths
 * (e.g. the interactive `.play` download menu) key state on the exact same sender.
 */
export function resolveSender(msg: WAMessage, botJid: string): string {
  const from = msg.key.remoteJid ?? "";
  if (from.endsWith("@g.us")) return msg.key.participant ?? "";
  if (msg.key.fromMe) return botJid;
  return from;
}

function extractQuotedText(msg: WAMessage): string | null {
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q) return null;
  return (
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    null
  );
}

/** Returns true if the message was a command and was handled (so callers can skip other processing). */
export async function handleCommand(
  sock: WASocket,
  msg: WAMessage,
  tenantId: number = LEGACY_TENANT_ID,
): Promise<boolean> {
  const from = msg.key.remoteJid ?? "";
  if (!from || from === "status@broadcast") return false;

  const body = extractBody(msg);
  if (!body) return false;

  const config = await loadConfig(tenantId);
  const prefix = config.prefix || ".";
  if (!body.startsWith(prefix)) return false;

  const withoutPrefix = body.slice(prefix.length).trim();
  if (!withoutPrefix) return false;

  const parts = withoutPrefix.split(/\s+/);
  const rawCmd = parts[0];
  const args = parts.slice(1);
  const command = rawCmd.toLowerCase();
  const text = withoutPrefix.slice(rawCmd.length).trim();

  const isGroup = from.endsWith("@g.us");
  const fromMe = Boolean(msg.key.fromMe);
  const botJid = sock.user?.id ?? "";
  const botNumber = jidBase(botJid);

  const sender = resolveSender(msg, botJid);
  const senderNumber = jidBase(sender);

  const ownerNumber = config.ownerNumber;
  let isOwner =
    fromMe || senderNumber === botNumber || (ownerNumber !== "" && senderNumber === ownerNumber);
  // Sudo users get full owner power: they may use the bot in DM or group,
  // run owner-only commands, bypass locks/blacklist, and are treated as
  // admins. The list lives in `bot_config.sudo`.
  const sudoNumbers = parseSudo(config.sudo);
  let isSudo = !isOwner && sudoNumbers.includes(senderNumber);
  // In groups, Baileys 7 may present the sender as an `@lid` identity, so a
  // phone-number sudo entry won't match `senderNumber` directly. Only when it
  // actually matters (private mode, in a group, a sudo list exists, and the
  // direct match missed) resolve the sender to a group participant and check
  // all of its identity fields. This keeps the common/public path metadata-free.
  if (config.mode === "private" && !isOwner && !isSudo && isGroup && sudoNumbers.length > 0) {
    const meta = await getGroupMetadataCached(sock, tenantId, from);
    const p = meta ? findParticipant(meta.participants, sender) : undefined;
    if (p) {
      const alt = p as unknown as Record<string, unknown>;
      for (const v of [p.id, alt.lid, alt.jid, alt.phoneNumber, alt.pn]) {
        if (typeof v === "string" && sudoNumbers.includes(jidBase(v))) {
          isSudo = true;
          break;
        }
      }
    }
  }

  // Sudo users inherit every owner privilege — wherever they chat.
  if (isSudo) isOwner = true;

  if (config.mode === "private" && !isOwner && !isSudo) return false;

  const reply = async (t: string): Promise<void> => {
    await sock.sendMessage(from, { text: t }, { quoted: msg });
  };
  const react = async (emoji: string): Promise<void> => {
    try {
      await sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
    } catch {
      /* reactions are best-effort */
    }
  };

  const cmd = findCommand(command);
  const gKey = `${tenantId}:${jidBase(from)}`;
  const locked = lockedCommands.get(gKey);
  if (cmd && locked?.has(command) && !isOwner && !isSudo) {
    await reply(`🔒 *${command}* is locked in this group.`);
    return true;
  }
  if (blacklist.has(`${tenantId}:${senderNumber}`) && !isOwner && !isSudo) {
    await reply("🚫 You're blacklisted from using this bot.");
    return true;
  }
  if (!cmd) {    const custom = customCommands.get(`${tenantId}:${jidBase(from)}:${command}`);
    if (custom) {
      await reply(custom);
      return true;
    }
    if (knownMenuCommands.has(command)) {
      await reply(
        `🔧 *${prefix}${command}* is recognized but not yet available in this build.\n\n` +
          `It likely needs an API key or external service. Ask the owner to set it up, or type *${prefix}menu*.`,
      );
      return true;
    }
    return false;
  }

  // Only fetch group metadata once we know a real command will run.
  let groupMetadata: GroupMetadata | null = null;
  let isAdmin = false;
  let isBotAdmin = false;
  if (isGroup) {
    groupMetadata = await getGroupMetadataCached(sock, tenantId, from);
    if (groupMetadata) {
      const senderP = findParticipant(groupMetadata.participants, sender);
      isAdmin = Boolean(senderP?.admin);
      const botP = findParticipant(groupMetadata.participants, botJid);
      isBotAdmin = Boolean(botP?.admin);
    }
  }
  if (isOwner || isSudo) isAdmin = true;

  const ctx: CommandContext = {
    sock,
    tenantId,
    msg,
    from,
    sender,
    senderNumber,
    pushName: msg.pushName ?? "",
    isGroup,
    command,
    prefix,
    args,
    text,
    body,
    config,
    isOwner,
    isSudo,
    groupMetadata,
    isAdmin,
    isBotAdmin,
    quotedText: extractQuotedText(msg),
    reply,
    react,
  };

  if (cmd.ownerOnly && !isOwner && !isSudo) {
    await reply("🚫 This command is for the *owner* only.");
    return true;
  }
  if (cmd.groupOnly && !isGroup) {
    await reply("🚫 This command only works in *groups*.");
    return true;
  }
  if (cmd.adminOnly && !isAdmin) {
    await reply("🚫 This command is for *group admins* only.");
    return true;
  }
  if (cmd.botAdminOnly && !isBotAdmin) {
    await reply("🚫 I need to be a *group admin* to do that.");
    return true;
  }

  if (await getBool("autotyping", tenantId)) {
    try {
      await sock.sendPresenceUpdate("composing", from);
    } catch {
      /* presence is best-effort */
    }
  }

  try {
    await cmd.handler(ctx);
  } catch (err) {
    logger.error({ err, command }, "Command handler error");
    await reply("❌ Something went wrong running that command.");
  }
  return true;
}
