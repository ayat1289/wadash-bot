import os from "os";
import type { Command, CommandContext } from "../types";
import { MENU, type MenuCategory } from "../menu-data";
import { toBold, toFancy } from "../text-utils";
import { fetchImageBuffer } from "../http-utils";
import { isPublicHttpUrl } from "../url-utils";
import { readMenuImage } from "../../menu-image";
import { logger } from "../../logger";

const BOOT_TIME = Date.now();

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

export const menuCommands: Command[] = [
  {
    name: "menu",
    aliases: ["menulist"],
    category: "OTHER",
    desc: "Show the command list (all categories)",
    handler: async (ctx) => {
      // `.menu <category>` — shows that category's commands as a text list.
      const cat = findCategory(ctx.text);
      if (cat) {
        await ctx.reply(buildCategoryText(ctx, cat));
        return;
      }
      // `.menu` (no / unknown arg) → the full plain-text menu. Native-flow
      // buttons silently drop on many phones (relayMessage resolves without
      // throwing even when they don't render), so text is the reliable default.
      await sendMenuText(ctx);
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
