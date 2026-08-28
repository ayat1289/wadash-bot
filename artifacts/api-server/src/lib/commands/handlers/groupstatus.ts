import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "../types";
import { setConfig } from "../../config";
import { logger } from "../../logger";
import { getFfmpegPath } from "../ffmpeg";
import { runProcess } from "../proc";
import {
  downloadMediaMessage,
  generateWAMessageContent,
  generateWAMessageFromContent,
  type proto,
  type WAMessage,
} from "@whiskeysockets/baileys";

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;

/**
 * WhatsApp silently drops *video* group-status updates that carry no valid
 * duration (`seconds`). Baileys' `generateWAMessageContent` builds a
 * `videoMessage` with a thumbnail + dimensions but never fills in the length,
 * so re-uploaded videos resolve fine on the wire yet never appear in the
 * group. Probe the downloaded buffer with the vendored ffmpeg and return its
 * duration in seconds (0 when it cannot be read).
 */
async function videoDurationSeconds(media: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "gst-video-"));
  try {
    const src = join(dir, "in.bin");
    await writeFile(src, media);
    const { code, stderr } = await runProcess(getFfmpegPath(), ["-hide_banner", "-i", src, "-f", "null", "-"], {
      timeoutMs: 60_000,
      maxStdoutBytes: 1024,
    });
    if (code !== 0) return 0;
    const match = DURATION_RE.exec(stderr);
    if (!match) return 0;
    const h = Number(match[1]);
    const m = Number(match[2]);
    const s = Number(match[3]);
    return Math.max(0, Math.round(h * 3600 + m * 60 + s));
  } catch (error) {
    logger.warn({ err: error }, "gst: failed to probe video duration");
    return 0;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function toggle(name: string, aliases: string[] | undefined, label: string, keyPrefix: string): Command {
  return {
    name,
    aliases,
    category: "GROUPSTATUS",
    desc: `Toggle ${label}`,
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}${name} on/off*`);
      await setConfig(`${keyPrefix}:${ctx.from}`, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(`${val === "on" ? "✅" : "🚫"} ${label} is now *${val.toUpperCase()}* for this group.`);
    },
  };
}

export const groupStatusCommands: Command[] = [
  {
    name: "gst",
    aliases: ["groupstatus"],
    category: "GROUPSTATUS",
    desc: "Update group status",
    handler: async (ctx) => {
      const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
      const quoted = ci?.quotedMessage;
      if (!quoted) {
        await ctx.reply("Reply to a message with *" + ctx.prefix + "gst*");
        return;
      }

      // Identify what was replied to: image, video, or text.
      let kind: "image" | "video" | "text" | null = null;
      if (quoted.imageMessage) kind = "image";
      else if (quoted.videoMessage) kind = "video";
      else if (quoted.conversation || quoted.extendedTextMessage?.text) kind = "text";

      if (!kind) {
        await ctx.reply("Reply to a message with *" + ctx.prefix + "gst*");
        return;
      }

      // Rebuild the quoted message's own key so media can be re-uploaded.
      const target = {
        key: {
          remoteJid: ctx.from,
          fromMe: false,
          id: ci?.stanzaId ?? undefined,
          participant: ci?.participant ?? undefined,
        },
        message: quoted,
      } as WAMessage;

      let media: Buffer | null = null;
      if (kind !== "text") {
        media = (await downloadMediaMessage(
          target,
          "buffer",
          {},
          { logger, reuploadRequest: ctx.sock.updateMediaMessage },
        )) as Buffer;
      }

      const caption =
        kind === "image"
          ? quoted.imageMessage?.caption ?? undefined
          : kind === "video"
            ? quoted.videoMessage?.caption ?? undefined
            : undefined;
      const quotedText = quoted.conversation || quoted.extendedTextMessage?.text || "";

      const groups = Object.values(await ctx.sock.groupFetchAllParticipating());
      let updated = 0;

      for (const g of groups) {
        try {
          const gid = g.id;
          if (!gid) continue;

          const inner = (await generateWAMessageContent(
            kind === "text"
              ? { text: quotedText }
              : kind === "image"
                ? { image: media as Buffer, caption }
                : { video: media as Buffer, caption },
            {
              jid: gid,
              upload: ctx.sock.waUploadToServer,
              getProfilePicUrl: ctx.sock.profilePictureUrl,
              getCallLink: ctx.sock.createCallLink,
            },
          )) as proto.Message;

          const innerKey = Object.keys(inner).find(
            (k) => k === "conversation" || k.endsWith("Message"),
          );
          if (innerKey && inner[innerKey]) {
            const innerObj = inner[innerKey] as Record<string, unknown>;
            const existingCtx = (innerObj.contextInfo ?? {}) as Record<string, unknown>;
            innerObj.contextInfo = { ...existingCtx, isGroupStatus: true };

            if (kind === "video" && innerObj.videoMessage) {
              const vm = innerObj.videoMessage as Record<string, unknown>;
              vm.gifPlayback = false;
              if (!vm.mimetype) vm.mimetype = "video/mp4";
              if (!vm.seconds) vm.seconds = await videoDurationSeconds(media as Buffer);
            }
          }

          const wrapped = { groupStatusMessageV2: { message: inner } };
          const fullMsg = generateWAMessageFromContent(gid, wrapped, {
            timestamp: new Date(),
            userJid: ctx.sock.user?.id,
          });
          await ctx.sock.relayMessage(gid, fullMsg.message, { messageId: fullMsg.key.id });
          updated++;
        } catch (error) {
          logger.warn({ err: error, group: g.id }, "gst: group status send failed");
        }
      }

      await ctx.reply(`Updated *${updated}*`);
    },
  },
  toggle("welcome", undefined, "Welcome messages", "welcome"),
  toggle("goodbye", ["exit", "left"], "Goodbye messages", "goodbye"),
  toggle("antispam", undefined, "Anti-spam protection", "antispam"),
  {
    name: "setwelcome",
    category: "GROUPSTATUS",
    desc: "Set the welcome message",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) {
        return ctx.reply(
          `Usage: *${ctx.prefix}setwelcome <message>*\n\nPlaceholders:\n• *@user* — the new member\n• *@group* — the group name`,
        );
      }
      await setConfig(`welcometext:${ctx.from}`, ctx.text, ctx.tenantId);
      await setConfig(`welcome:${ctx.from}`, "true", ctx.tenantId);
      await ctx.reply(`✅ Welcome message saved and enabled.`);
    },
  },
  {
    name: "setgoodbye",
    aliases: ["setleft", "setexit"],
    category: "GROUPSTATUS",
    desc: "Set the goodbye message",
    groupOnly: true,
    adminOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) {
        return ctx.reply(
          `Usage: *${ctx.prefix}setgoodbye <message>*\n\nPlaceholders:\n• *@user* — the leaving member\n• *@group* — the group name`,
        );
      }
      await setConfig(`goodbyetext:${ctx.from}`, ctx.text, ctx.tenantId);
      await setConfig(`goodbye:${ctx.from}`, "true", ctx.tenantId);
      await ctx.reply(`✅ Goodbye message saved and enabled.`);
    },
  },
];
