import { downloadMediaMessage, type proto, type WAMessage } from "@whiskeysockets/baileys";
import { logger } from "../logger";
import type { CommandContext } from "./types";

type MediaKind = "image" | "video" | "sticker" | "audio";

function messageKey(kind: MediaKind): keyof proto.IMessage {
  switch (kind) {
    case "image":
      return "imageMessage";
    case "video":
      return "videoMessage";
    case "sticker":
      return "stickerMessage";
    case "audio":
      return "audioMessage";
  }
}

export async function downloadMedia(ctx: CommandContext, kind: MediaKind): Promise<Buffer | null> {
  const key = messageKey(kind);
  const direct = ctx.msg.message?.[key];
  const quoted = ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

  let target: WAMessage | null = null;
  if (direct) {
    target = ctx.msg;
  } else if (quoted?.[key]) {
    // Rebuild the quoted message's own key so re-upload (expired media) works.
    const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
    target = {
      key: {
        remoteJid: ctx.from,
        fromMe: false,
        id: ci?.stanzaId ?? undefined,
        participant: ci?.participant ?? undefined,
      },
      message: quoted,
    } as WAMessage;
  }
  if (!target) return null;

  const buf = await downloadMediaMessage(
    target,
    "buffer",
    {},
    { logger, reuploadRequest: ctx.sock.updateMediaMessage },
  );
  return buf as Buffer;
}

export function hasMedia(ctx: CommandContext, kind: MediaKind): boolean {
  const key = messageKey(kind);
  return Boolean(
    ctx.msg.message?.[key] ||
      ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.[key],
  );
}
