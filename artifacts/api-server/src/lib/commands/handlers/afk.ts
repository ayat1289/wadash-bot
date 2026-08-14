import type { WASocket } from "@whiskeysockets/baileys";
import type { Command, WAMessage } from "../types";
import { jidBase } from "../../group-meta";
import { formatDuration } from "../duration-utils";
import { setAfk, getAfk, clearAfk, canAnnounceAfk } from "../../afk-store";

export const afkCommands: Command[] = [
  {
    name: "afk",
    aliases: ["away", "brb"],
    category: "TOOLS",
    desc: "Mark yourself away — I'll reply when someone tags you",
    handler: async (ctx) => {
      const reason = ctx.text.trim().slice(0, 200) || "AFK";
      setAfk(ctx.tenantId, ctx.sender, reason);
      await ctx.reply(`💤 You're now AFK: *${reason}*\nI'll let people know when they mention you, and welcome you back when you return.`);
    },
  },
];

function mentionedJids(msg: WAMessage): string[] {
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const out: string[] = [];
  for (const j of ctxInfo?.mentionedJid ?? []) out.push(j);
  if (ctxInfo?.participant) out.push(ctxInfo.participant);
  return out;
}

// Called for every incoming message BEFORE command dispatch (fire-and-forget):
//  - if the SENDER was AFK, clear it and welcome them back (unless this very
//    message is them (re)setting AFK);
//  - if the message MENTIONS / replies to an AFK user, announce that they're away.
export async function handleAfk(params: {
  sock: WASocket;
  msg: WAMessage;
  tenantId: number;
  from: string;
  sender: string;
  body: string;
}): Promise<void> {
  const { sock, msg, tenantId, from, sender, body } = params;

  const firstWord = body.trim().replace(/^[^\p{L}\p{N}]+/u, "").split(/\s+/)[0]?.toLowerCase();
  const isAfkCmd = firstWord === "afk" || firstWord === "away" || firstWord === "brb";
  if (!isAfkCmd) {
    const back = clearAfk(tenantId, sender);
    if (back) {
      await sock.sendMessage(
        from,
        {
          text: `👋 Welcome back @${jidBase(sender)}! You were AFK for ${formatDuration(Date.now() - back.since)}.`,
          mentions: [sender],
        },
        { quoted: msg },
      );
    }
  }

  const targets = mentionedJids(msg);
  if (targets.length === 0) return;
  const seen = new Set<string>();
  const lines: string[] = [];
  const mentions: string[] = [];
  for (const jid of targets) {
    const base = jidBase(jid);
    if (seen.has(base)) continue;
    seen.add(base);
    const entry = getAfk(tenantId, jid);
    if (!entry) continue;
    if (!canAnnounceAfk(tenantId, from, jid)) continue;
    lines.push(`💤 @${base} is AFK: *${entry.reason}* (${formatDuration(Date.now() - entry.since)} ago)`);
    mentions.push(jid);
  }
  if (lines.length) {
    await sock.sendMessage(from, { text: lines.join("\n"), mentions }, { quoted: msg });
  }
}
