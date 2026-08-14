import os from "os";
import { generateWAMessageFromContent, proto } from "@whiskeysockets/baileys";
import type { Command, CommandContext } from "../types";
import { MENU, type MenuCategory } from "../menu-data";
import { toBold, toFancy } from "../text-utils";
import { fetchImageBuffer } from "../http-utils";
import { isPublicHttpUrl } from "../url-utils";
import { readMenuImage } from "../../menu-image";
import { logger } from "../../logger";

const BOOT_TIME = Date.now();

// The single external link the button menu exposes — the bot's WhatsApp channel.
const WHATSAPP_CHANNEL_URL =
  "https://whatsapp.com/channel/0029VbDLGl64SpkNW1Tr2Z1z";

function formatUptime(): string {
  const sec = (Date.now() - BOOT_TIME) / 1000;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

/** Time-of-day greeting, computed in the bot's display timezone (EAT). */
function timeGreeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "Africa/Nairobi",
    }).format(new Date()),
  );
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  if (hour < 21) return "Good Evening";
  return "Good Night";
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** Builds the full text command list (the classic, always-renders menu). */
function buildMenuText(ctx: CommandContext): string {
  const p = ctx.prefix;
  const totalCmds = MENU.reduce((n, c) => n + c.commands.length, 0);
  const styledBot = toBold(ctx.config.botName);
  const styledOwner = toBold(ctx.config.ownerName);
  const header =
    `┏━━━━━━━━━━━━━━━━━┓\n` +
    `   ✦ ❒ ${styledBot} ❒ ✦\n` +
    `┗━━━━━━━━━━━━━━━━━┛\n` +
    `╭━━━〔 ⚡ ${toFancy("info")} ⚡ 〕━━┈⊷\n` +
    `┃ 👋 ${toFancy("hi")} : *${ctx.pushName || "there"}*\n` +
    `┃ ✨ ${timeGreeting()}\n` +
    `┃ 👑 ${toFancy("owner")} : ${styledOwner}\n` +
    `┃ 🔣 ${toFancy("prefix")} : [ ${p} ]\n` +
    `┃ 🟢 ${toFancy("mode")} : ${ctx.config.mode}\n` +
    `┃ ⏱️ ${toFancy("uptime")} : ${formatUptime()}\n` +
    `┃ 📦 ${toFancy("commands")} : ${totalCmds}\n` +
    `┃ 🖥️ ${toFancy("host")} : ${os.platform()}\n` +
    `╰━━━━━━━━━━━━━━━┈⊷\n`;

  const body = MENU.map((cat) => {
    const lines = cat.commands.map((c) => `┃ ◦ ${p}${c}`).join("\n");
    return `╭━━━〔 ${cat.emoji} *${cat.name}* 〕━━┈⊷\n${lines}\n╰━━━━━━━━━━━━━━━┈⊷`;
  }).join("\n");

  const footer = `\n\n_Tip: many media commands work by replying to an image, video, or audio._`;
  return header + "\n" + body + footer;
}

/**
 * Sends the full text command list. When a menu image is configured we download
 * it ourselves and send it as an uploaded buffer (not `{ image: { url } }`,
 * which would let Baileys fetch the URL server-side with no redirect/size guards).
 * This path ALWAYS renders, so it is the guaranteed fallback for the button menu.
 */
async function sendMenuText(ctx: CommandContext): Promise<void> {
  const menuText = buildMenuText(ctx);
  const img = ctx.config.menuImage?.trim();
  if (img) {
    try {
      // `menuImage` is either a locally stored image (set by `.setmenuimage`,
      // read from disk) or a legacy http URL (downloaded with redirect/size
      // guards — never `{ image: { url } }`).
      const buffer = isPublicHttpUrl(img)
        ? await fetchImageBuffer(img)
        : await readMenuImage(img);
      if (buffer && buffer.length) {
        await ctx.sock.sendMessage(
          ctx.from,
          { image: buffer, caption: menuText },
          { quoted: ctx.msg },
        );
        return;
      }
    } catch (err) {
      logger.warn({ err }, "menu image fetch failed; sending text only");
    }
  }
  await ctx.reply(menuText);
}

/** Compact greeting card shown as the body of the interactive button menu. */
function buildGreetingCard(ctx: CommandContext): string {
  const p = ctx.prefix;
  const totalCmds = MENU.reduce((n, c) => n + c.commands.length, 0);
  const styledBot = toBold(ctx.config.botName);
  const styledOwner = toBold(ctx.config.ownerName);
  return (
    `╭━━〔 「 ${toFancy("greeting")} 」 〕━━┈⊷\n` +
    `┃ 👋 ${toFancy("hi")} : *${ctx.pushName || "there"}*\n` +
    `┃ ✨ ${timeGreeting()}\n` +
    `┃ 🤖 ${styledBot}\n` +
    `╰━━━━━━━━━━━━━┈⊷\n` +
    `╭━━〔 ⚡ ${toFancy("info")} ⚡ 〕━━┈⊷\n` +
    `┃ 👑 ${toFancy("owner")} : ${styledOwner}\n` +
    `┃ 🔣 ${toFancy("prefix")} : [ ${p} ]\n` +
    `┃ 🟢 ${toFancy("mode")} : ${ctx.config.mode}\n` +
    `┃ ⏱️ ${toFancy("uptime")} : ${formatUptime()}\n` +
    `┃ 📦 ${toFancy("commands")} : ${totalCmds}\n` +
    `┃ 🖥️ ${toFancy("host")} : ${os.platform()}\n` +
    `╰━━━━━━━━━━━━━┈⊷\n\n` +
    `📂 *Tap "SELECT MENU" below and pick a category.*`
  );
}

/** Builds the command list for a single category (shown when a category is tapped). */
function buildCategoryText(ctx: CommandContext, cat: MenuCategory): string {
  const p = ctx.prefix;
  const lines = cat.commands.map((c) => `┃ ◦ ${p}${c}`).join("\n");
  return (
    `╭━━━〔 ${cat.emoji} *${cat.name}* 〕━━┈⊷\n` +
    `${lines}\n` +
    `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
    `_${cat.commands.length} command${plural(cat.commands.length)} • ` +
    `type ${p}menu for categories • ${p}allmenu for everything_`
  );
}

/** Resolve a category by (case-insensitive) name, e.g. "fun" → the FUN category. */
function findCategory(arg: string): MenuCategory | undefined {
  const a = arg.trim().toLowerCase();
  if (!a) return undefined;
  return MENU.find((c) => c.name.toLowerCase() === a);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Sends the interactive (native-flow) button menu: a greeting card, a
 * "SELECT MENU" single-select list whose rows are the command categories
 * (tapping one re-dispatches `<prefix>menu <category>`), an "ALL COMMANDS"
 * quick-reply, and a "WhatsApp Channel" URL button.
 *
 * Native-flow buttons are an UNOFFICIAL WhatsApp feature that many recipient
 * builds silently drop — and `relayMessage` resolves WITHOUT throwing when they
 * do, so the try/catch in the caller only catches real relay errors, not a
 * non-render. This is shipped as the `.menu` command by explicit user request
 * (they accepted the blank-on-some-phones tradeoff); `.allmenu` is the always-
 * renders text fallback and is advertised in the footer.
 * See `.agents/memory/whatsapp-native-flow-buttons.md`.
 */
async function sendButtonMenu(ctx: CommandContext): Promise<void> {
  const p = ctx.prefix;

  // Categories as single-select rows. WhatsApp caps rows per section (~10), so
  // chunk into sections to stay safe with 19 categories.
  const sections = chunk(MENU, 10).map((group, i) => ({
    title: i === 0 ? "📂 Categories" : "📂 More categories",
    rows: group.map((cat) => ({
      header: "",
      title: `${cat.emoji} ${cat.name}`,
      description: `${cat.commands.length} command${plural(cat.commands.length)}`,
      // Tapping sends this id back as the message body → dispatches like a typed
      // command. Uses the live prefix so it matches the user's configured prefix.
      id: `${p}menu ${cat.name.toLowerCase()}`,
    })),
  }));

  const buttons: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton[] =
    [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: "📂 SELECT MENU",
          sections,
        }),
      },
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: "📋 ALL COMMANDS",
          id: `${p}allmenu`,
        }),
      },
      {
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: "📢 WhatsApp Channel",
          url: WHATSAPP_CHANNEL_URL,
          merchant_url: WHATSAPP_CHANNEL_URL,
        }),
      },
    ];

  const content: proto.IMessage = {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
        },
        interactiveMessage: proto.Message.InteractiveMessage.create({
          body: proto.Message.InteractiveMessage.Body.create({
            text: buildGreetingCard(ctx),
          }),
          footer: proto.Message.InteractiveMessage.Footer.create({
            text: `Pick a category • no buttons? type ${p}allmenu`,
          }),
          header: proto.Message.InteractiveMessage.Header.create({
            title: "",
            hasMediaAttachment: false,
          }),
          nativeFlowMessage:
            proto.Message.InteractiveMessage.NativeFlowMessage.create({
              buttons,
            }),
        }),
      },
    },
  };

  const generated = generateWAMessageFromContent(ctx.from, content, {
    userJid: ctx.sock.user?.id ?? "",
    quoted: ctx.msg,
  });
  await ctx.sock.relayMessage(ctx.from, generated.message!, {
    messageId: generated.key.id!,
  });
}

export const menuCommands: Command[] = [
  {
    name: "menu",
    aliases: ["menulist"],
    category: "OTHER",
    desc: "Show the interactive button menu",
    handler: async (ctx) => {
      // `.menu <category>` — also fired when a category button is tapped —
      // shows that category's commands as a text list.
      const cat = findCategory(ctx.text);
      if (cat) {
        await ctx.reply(buildCategoryText(ctx, cat));
        return;
      }
      // `.menu` (no / unknown arg) → the interactive button menu.
      try {
        await sendButtonMenu(ctx);
      } catch (err) {
        // Only catches real relay errors (a silent non-render can't be caught) —
        // fall back to the full text menu so the user always gets a response.
        logger.warn({ err }, "button menu failed to relay; sending text menu");
        await sendMenuText(ctx);
      }
    },
  },
  {
    name: "allmenu",
    aliases: ["help", "cmd", "commands", "list", "fullmenu"],
    category: "OTHER",
    desc: "Show the full command list (plain text)",
    handler: async (ctx) => {
      await sendMenuText(ctx);
    },
  },
];
