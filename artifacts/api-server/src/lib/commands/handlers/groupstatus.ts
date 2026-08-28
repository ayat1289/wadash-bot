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
const DIMENSIONS_RE = /Stream #0:\d+[^\n]*Video:[^\n]*,\s*(\d+)x(\d+)/;

interface VideoProbe {
  seconds: number;
  width?: number;
  height?: number;
}

/**
 * WhatsApp silently drops *video* group-status updates that carry no valid
 * duration (`seconds`) or no `width`/`height` dimensions. Baileys'
 * `generateWAMessageContent` builds a `videoMessage` with a thumbnail but never
 * fills in the length, and only sets dimensions for images (not videos) — so
 * re-uploaded videos resolve fine on the wire yet never appear in the group.
 * Probe the downloaded buffer with the vendored ffmpeg and return its duration
 * and frame size (0/undefined when they cannot be read).
 */
async function probeVideo(media: Buffer): Promise<VideoProbe> {
  const result: VideoProbe = { seconds: 0 };
  const dir = await mkdtemp(join(tmpdir(), "gst-video-"));
  try {
    const src = join(dir, "in.bin");
    await writeFile(src, media);
    const { code, stderr } = await runProcess(getFfmpegPath(), ["-hide_banner", "-i", src, "-f", "null", "-"], {
      timeoutMs: 60_000,
      maxStdoutBytes: 1024,
    });
    if (code !== 0) return result;
    const m = DURATION_RE.exec(stderr);
    if (m) {
      const h = Number(m[1]);
      const mm = Number(m[2]);
      const s = Number(m[3]);
      result.seconds = Math.max(0, Math.round(h * 3600 + mm * 60 + s));
    }
    const d = DIMENSIONS_RE.exec(stderr);
    if (d) {
      result.width = Number(d[1]);
      result.height = Number(d[2]);
    }
  } catch (error) {
    logger.warn({ err: error }, "gst: failed to probe video");
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

/**
 * The `<meta is_group_status="true">` protocol attribute is what actually makes
 * WhatsApp treat a relayed message as a "group status". Standard WhiskeySockets
 * Baileys v7 dropped this entirely (that's why media group statuses never post
 * while text helpers in patched forks like gifted/itsliaaa do). We inject the
 * exactly-matching meta node through `relayMessage`'s `additionalNodes` option
 * so no library swap / re-pairing is needed.
 */
const GROUP_STATUS_META_NODE = {
  tag: "meta",
  attrs: { is_group_status: "true" },
};

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

      const caption =
        kind === "image"
          ? quoted.imageMessage?.caption ?? ""
          : kind === "video"
            ? quoted.videoMessage?.caption ?? ""
            : undefined;
      const quotedText = quoted.conversation || quoted.extendedTextMessage?.text || "";

      // Rebuild the quoted message's own key so media can be downloaded for
      // re-upload.
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

            // For a video the inner content IS the videoMessage itself
            // (`inner["videoMessage"]`), so set its duration/dimensions directly —
            // WhatsApp silently drops video statuses with no valid `seconds`
            // and/or `width`/`height`.
            if (kind === "video") {
              innerObj.gifPlayback = false;
              if (!innerObj.mimetype) innerObj.mimetype = "video/mp4";
              if (!innerObj.seconds || !innerObj.width || !innerObj.height) {
                const p = await probeVideo(media as Buffer);
                if (!innerObj.seconds) innerObj.seconds = p.seconds;
                if (!innerObj.width) innerObj.width = p.width;
                if (!innerObj.height) innerObj.height = p.height;
              }
              logger.info(
                {
                  group: gid,
                  sizeBytes: (media as Buffer)?.length,
                  seconds: innerObj.seconds,
                  width: innerObj.width,
                  height: innerObj.height,
                  mimetype: innerObj.mimetype,
                  hasThumbnail: Boolean(innerObj.jpegThumbnail),
                  directPath: Boolean(innerObj.directPath),
                },
                "gst: video status prepared",
              );
            }
          }

          // Route every kind through the group-jid mechanism that works for
          // text (`groupStatusMessageV2` relayed straight to the group), and
          // inject the `<meta is_group_status="true">` attribute that patched
          // Baileys forks emit — the protocol flag that actually makes WhatsApp
          // render a *media* group status (missing in stock v7 for media).
          const wrapped = { groupStatusMessageV2: { message: inner } };
          const fullMsg = generateWAMessageFromContent(gid, wrapped, {
            timestamp: new Date(),
            userJid: ctx.sock.user?.id,
          });
          await ctx.sock.relayMessage(gid, fullMsg.message, {
            messageId: fullMsg.key.id,
            additionalNodes: [GROUP_STATUS_META_NODE],
          });
          logger.info(
            { group: gid, kind, messageId: fullMsg.key.id },
            "gst: relayed status",
          );
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
