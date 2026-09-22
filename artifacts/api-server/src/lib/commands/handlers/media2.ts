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
  { name: "movie", category: "DOWNLOAD", desc: "Movie info", handler: async (ctx) => wikiLookup(ctx, "movie") },
  { name: "series", category: "DOWNLOAD", desc: "TV series info", handler: async (ctx) => wikiLookup(ctx, "series") },
  { name: "anime", category: "DOWNLOAD", desc: "Anime info", handler: async (ctx) => wikiLookup(ctx, "anime") },
  { name: "manga", category: "DOWNLOAD", desc: "Manga info", handler: async (ctx) => wikiLookup(ctx, "manga") },
  { name: "manhwa", category: "DOWNLOAD", desc: "Manhwa info", handler: async (ctx) => wikiLookup(ctx, "manhwa") },
  { name: "comic", category: "DOWNLOAD", desc: "Comic info", handler: async (ctx) => wikiLookup(ctx, "comic") },
  { name: "drama", category: "DOWNLOAD", desc: "Drama info", handler: async (ctx) => wikiLookup(ctx, "drama") },
  { name: "subtitle", category: "DOWNLOAD", desc: "Subtitle lookup", handler: async (ctx) => wikiLookup(ctx, "film") },
  { name: "trailer", category: "DOWNLOAD", desc: "Movie info (trailer search blocked)", handler: async (ctx) => wikiLookup(ctx, "movie") },
  { name: "steam", category: "DOWNLOAD", desc: "Steam store lookup", handler: steamHandler },
  { name: "netflix", category: "DOWNLOAD", desc: "Where to stream (Netflix etc.)", handler: streamingLookup },
  { name: "primevideo", category: "DOWNLOAD", desc: "Where to stream", handler: streamingLookup },
  { name: "disney", category: "DOWNLOAD", desc: "Where to stream", handler: streamingLookup },
  { name: "crunchyroll", category: "DOWNLOAD", desc: "Where to stream", handler: streamingLookup },
  { name: "hulu", category: "DOWNLOAD", desc: "Where to stream", handler: streamingLookup },
  { name: "hbo", category: "DOWNLOAD", desc: "Where to stream", handler: streamingLookup },
  { name: "appletv", category: "DOWNLOAD", desc: "Where to stream", handler: streamingLookup },
  { name: "paramount", category: "DOWNLOAD", desc: "Where to stream", handler: streamingLookup },

  // Cloud-host file downloads
  { name: "onedrive", category: "DOWNLOAD", desc: "OneDrive file", handler: fileCmd },
  { name: "pixeldrain", category: "DOWNLOAD", desc: "Pixeldrain file", handler: fileCmd },
  { name: "anonfiles", category: "DOWNLOAD", desc: "AnonFiles file", handler: fileCmd },
  { name: "workupload", category: "DOWNLOAD", desc: "WorkUpload file", handler: fileCmd },
  { name: "sendcm", category: "DOWNLOAD", desc: "SendCM file", handler: fileCmd },
  { name: "fileio", category: "DOWNLOAD", desc: "file.io file", handler: fileCmd },

  // APK / archives
  { name: "apkmod", category: "DOWNLOAD", desc: "APK (link)", handler: fileCmd },
  { name: "xapk", category: "DOWNLOAD", desc: "XAPK (link)", handler: fileCmd },
  { name: "obb", category: "DOWNLOAD", desc: "OBB (link)", handler: fileCmd },
  { name: "zip", category: "DOWNLOAD", desc: "Download a zip (link)", handler: fileCmd },
  { name: "rar", category: "DOWNLOAD", desc: "Download a rar (link)", handler: fileCmd },
  { name: "7z", category: "DOWNLOAD", desc: "Download a 7z (link)", handler: fileCmd },
  { name: "iso", category: "DOWNLOAD", desc: "Download an iso (link)", handler: fileCmd },

  // Emulation / gaming
  { name: "rom", category: "DOWNLOAD", desc: "ROM info", handler: retroHandler },
  { name: "emulator", category: "DOWNLOAD", desc: "Emulator info", handler: retroHandler },
  { name: "gameguide", category: "DOWNLOAD", desc: "Game guide lookup", handler: retroHandler },
  { name: "modgame", category: "DOWNLOAD", desc: "Game mod info", handler: retroHandler },
  { name: "ppsspp", category: "DOWNLOAD", desc: "PSP emulation info", handler: retroHandler },
  { name: "ps2", category: "DOWNLOAD", desc: "PS2 info", handler: retroHandler },
  { name: "psp", category: "DOWNLOAD", desc: "PSP info", handler: retroHandler },
  { name: "gba", category: "DOWNLOAD", desc: "GBA info", handler: retroHandler },
  { name: "nds", category: "DOWNLOAD", desc: "NDS info", handler: retroHandler },
  { name: "3ds", category: "DOWNLOAD", desc: "3DS info", handler: retroHandler },
  { name: "wii", category: "DOWNLOAD", desc: "Wii info", handler: retroHandler },
  { name: "switch", category: "DOWNLOAD", desc: "Switch info", handler: retroHandler },
  { name: "xbox", category: "DOWNLOAD", desc: "Xbox info", handler: retroHandler },
  { name: "psgame", category: "DOWNLOAD", desc: "PlayStation info", handler: retroHandler },
  { name: "epicgames", category: "DOWNLOAD", desc: "Epic Games info", handler: retroHandler },
];
