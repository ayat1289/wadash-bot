import type { Command, CommandContext } from "../types";
import { download, fetchMeta } from "../ytdlp";
import { fetchJson } from "../http-utils";
import { hostMatches } from "../url-utils";
import { logger } from "../../logger";

const UA = "WADashBot/1.0";

function arg(ctx: CommandContext): string {
  return (ctx.text.trim() || ctx.quotedText?.trim() || "").trim();
}

// ---------------------------------------------------------------------------
// Wikipedia-based info lookups (keyless, works from any host)
// ---------------------------------------------------------------------------

async function wikiLookup(ctx: CommandContext, hint: string): Promise<void> {
  const q = arg(ctx);
  if (!q) {
    await ctx.reply(`Usage: *${ctx.prefix}${ctx.command} <title>*`);
    return;
  }
  try {
    const search = (await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=1&origin=*`,
    )) as { query?: { search?: { title?: string }[] } };
    const title = search.query?.search?.[0]?.title;
    if (!title) {
      await ctx.reply(`❌ No ${hint} found for "${q}".`);
      return;
    }
    const page = (await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&origin=*&titles=${encodeURIComponent(title)}`,
    )) as { query?: { pages?: Record<string, { extract?: string; title?: string }> } };
    const p = Object.values(page.query?.pages ?? {})[0];
    const extract = p?.extract ?? "";
    await ctx.reply(`📖 *${p?.title ?? title}*\n\n${extract.slice(0, 1500) || "No summary available."}\n\nhttps://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`);
  } catch {
    await ctx.reply("❌ Lookup failed. Try again later.");
  }
}

// ---------------------------------------------------------------------------
// JustWatch streaming lookup (keyless)
// ---------------------------------------------------------------------------

async function streamingLookup(ctx: CommandContext): Promise<void> {
  const q = arg(ctx);
  if (!q) {
    await ctx.reply(`Usage: *${ctx.prefix}${ctx.command} <title>*`);
    return;
  }
  try {
    const j = (await fetch("https://apis.justwatch.com/content/titles/en_US/popular", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ query: q, page_size: 1 }),
      signal: AbortSignal.timeout(20_000),
    }).then((r) => r.json())) as { items?: { title?: string; object_type?: string; offers?: { monetization_type?: string; urls?: { standard_web?: string }; package_short_name?: string }[] }[] };
    const item = j.items?.[0];
    if (!item) {
      await ctx.reply(`❌ No results for "${q}".`);
      return;
    }
    const offers = (item.offers ?? []).filter((o) => o.monetization_type === "flatrate");
    const line = offers.length
      ? offers.slice(0, 6).map((o) => `• ${o.package_short_name ?? "?"}`).join("\n")
      : "_Not currently streaming for free._";
    await ctx.reply(`🎬 *${item.title}*\nType: ${item.object_type ?? "?"}\n\n*Streaming on:*\n${line}`);
  } catch {
    await ctx.reply("❌ Streaming lookup failed right now.");
  }
}

// ---------------------------------------------------------------------------
// Steam store lookup (keyless)
// ---------------------------------------------------------------------------

async function steamHandler(ctx: CommandContext): Promise<void> {
  const q = arg(ctx);
  if (!q) {
    await ctx.reply(`Usage: *${ctx.prefix}steam <game name>*`);
    return;
  }
  try {
    const search = (await fetchJson(`https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(q)}`)) as { appid?: number; name?: string }[];
    const app = search[0];
    if (!app?.appid) {
      await ctx.reply(`❌ No Steam game found for "${q}".`);
      return;
    }
    const details = (await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${app.appid}&l=en&cc=us`)) as Record<string, { success?: boolean; data?: { name?: string; price_overview?: { final?: number; currency?: string }; short_description?: string; header_image?: string; genres?: { description?: string }[] } }>;
    const d = details[String(app.appid)]?.data;
    if (!d) {
      await ctx.reply(`🎮 *${app.name}*\nhttps://store.steampowered.com/app/${app.appid}`);
      return;
    }
    const price = d.price_overview ? `${d.price_overview.currency ?? "$"}${((d.price_overview.final ?? 0) / 100).toFixed(2)}` : "Free/Unknown";
    const genres = (d.genres ?? []).map((g) => g.description).filter(Boolean).join(", ");
    await ctx.reply(
      `🎮 *${d.name}*\n💵 Price: ${price}\n${genres ? `🏷️ ${genres}\n` : ""}\n${(d.short_description ?? "").slice(0, 400)}\n\nhttps://store.steampowered.com/app/${app.appid}`,
    );
  } catch {
    await ctx.reply("❌ Steam lookup failed right now.");
  }
}

// ---------------------------------------------------------------------------
// Generic cloud-host file download (via yt-dlp generic extractors)
// ---------------------------------------------------------------------------

const FILE_DOMAINS = [
  "drive.google.com", "drive.usercontent.google.com", "mega.nz", "mega.co.nz",
  "mediafire.com", "dropbox.com", "dl.dropboxusercontent.com", "onedrive.live.com",
  "1drv.ms", "pixeldrain.com", "anonfiles.com", "workupload.com", "file.io",
  "send.cm", "sendcm.com", "hxfile.co", "gofile.io", "zippyshare.com",
];

async function fileCmd(ctx: CommandContext): Promise<void> {
  const input = arg(ctx);
  if (!input || !/^https?:\/\//i.test(input)) {
    await ctx.reply(`Send a *direct file link*.\nExample: *${ctx.prefix}${ctx.command} https://pixeldrain.com/u/...*`);
    return;
  }
  if (!hostMatches(input, FILE_DOMAINS)) {
    await ctx.reply("❌ That host isn't supported yet.");
    return;
  }
  await ctx.react("⏳");
  try {
    const meta = await fetchMeta(input);
    const { buffer } = await download(input, { format: "best/bestvideo+bestaudio", maxSizeMb: 256 });
    await ctx.sock.sendMessage(
      ctx.from,
      { document: buffer, mimetype: "application/octet-stream", fileName: meta.title ? `${meta.title}.${meta.ext ?? "bin"}` : "file.bin", caption: `📦 ${meta.title ?? "File"}` },
      { quoted: ctx.msg },
    );
    await ctx.react("✅");
  } catch (err) {
    logger.warn({ err, cmd: ctx.command }, "file download failed");
    await ctx.react("❌");
    await ctx.reply("❌ Couldn't download that file (host may block this server or require auth).");
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

async function retroHandler(ctx: CommandContext): Promise<void> {
  const q = arg(ctx);
  if (!q) {
    await ctx.reply(`Usage: *${ctx.prefix}${ctx.command} <game name>*`);
    return;
  }
  await ctx.reply(`🕹️ I can't download ROMs/emulator files (copyright). Try the game's official store, or check a retro wiki for the game you want.\n\n_Info about "${q}" from Wikipedia:_`);
  await wikiLookup(ctx, "game");
}

export const media2Commands: Command[] = [
  // APK / archives
  { name: "zip", category: "DOWNLOAD", desc: "Download a zip (link)", handler: fileCmd },
  { name: "rar", category: "DOWNLOAD", desc: "Download a rar (link)", handler: fileCmd },
  { name: "7z", category: "DOWNLOAD", desc: "Download a 7z (link)", handler: fileCmd },
  { name: "iso", category: "DOWNLOAD", desc: "Download an iso (link)", handler: fileCmd },
];
