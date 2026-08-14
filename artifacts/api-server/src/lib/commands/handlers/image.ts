import type { Command, CommandContext } from "../types";
import { fetchJson } from "../http-utils";

async function sendImage(ctx: CommandContext, url: string, caption: string): Promise<void> {
  await ctx.sock.sendMessage(ctx.from, { image: { url }, caption }, { quoted: ctx.msg });
}

function imageCommand(
  name: string,
  aliases: string[] | undefined,
  desc: string,
  emoji: string,
  fetchUrl: () => Promise<string>,
): Command {
  return {
    name,
    aliases,
    category: "IMAGE",
    desc,
    handler: async (ctx) => {
      try {
        const url = await fetchUrl();
        if (!url) throw new Error("no image");
        await sendImage(ctx, url, `${emoji} ${desc}`);
      } catch {
        await ctx.reply("❌ Couldn't fetch an image right now. Try again in a moment.");
      }
    },
  };
}

const NEKO_CATEGORIES = ["neko", "waifu", "husbando", "kitsune"];

interface WallhavenSearch {
  data?: Array<{ path?: string; resolution?: string }>;
}

async function wallhaven(
  query: string,
  atleast?: string,
): Promise<{ path: string; resolution: string } | null> {
  const params = new URLSearchParams({
    sorting: query ? "relevance" : "toplist",
    purity: "100",
  });
  if (query) params.set("q", query);
  if (atleast) params.set("atleast", atleast);
  const data = await fetchJson<WallhavenSearch>(
    `https://wallhaven.cc/api/v1/search?${params.toString()}`,
  );
  const hit = data.data?.[0];
  if (!hit?.path) return null;
  return { path: hit.path, resolution: hit.resolution ?? "" };
}

export const imageCommands: Command[] = [
  {
    name: "wallpaper",
    aliases: ["wp"],
    category: "IMAGE",
    desc: "HD wallpaper by keyword",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      try {
        const hit = await wallhaven(q, "1920x1080");
        if (!hit) {
          return ctx.reply(
            q ? `❌ No wallpapers found for "${q}".` : "❌ Couldn't fetch a wallpaper right now.",
          );
        }
        await sendImage(
          ctx,
          hit.path,
          `🖼️ ${q || "Wallpaper"}${hit.resolution ? ` (${hit.resolution})` : ""}`,
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch a wallpaper right now. Try again in a moment.");
      }
    },
  },
  {
    name: "image",
    aliases: ["img"],
    category: "IMAGE",
    desc: "Image search by keyword",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`Usage: *${ctx.prefix}image <keyword>*`);
      try {
        const hit = await wallhaven(q);
        if (!hit) return ctx.reply(`❌ No images found for "${q}".`);
        await sendImage(ctx, hit.path, `🖼️ ${q}`);
      } catch {
        await ctx.reply("❌ Couldn't fetch an image right now. Try again in a moment.");
      }
    },
  },
  imageCommand("dog", ["puppy"], "Random dog", "🐶", async () => {
    const data = await fetchJson<{ message: string }>("https://dog.ceo/api/breeds/image/random");
    return data.message;
  }),
  imageCommand("cat", ["kitty"], "Random cat", "🐱", async () => {
    const data = await fetchJson<Array<{ url: string }>>("https://api.thecatapi.com/v1/images/search");
    return data[0]?.url;
  }),
  imageCommand("neko", undefined, "Random neko", "🐾", async () => {
    const data = await fetchJson<{ results: Array<{ url: string }> }>("https://nekos.best/api/v2/neko");
    return data.results[0]?.url;
  }),
  imageCommand("waifu", undefined, "Random waifu", "🌸", async () => {
    const data = await fetchJson<{ url: string }>("https://api.waifu.pics/sfw/waifu");
    return data.url;
  }),
  imageCommand("bird", undefined, "Random bird", "🐦", async () => {
    const data = await fetchJson<string[]>("https://shibe.online/api/birds?count=1");
    return data[0];
  }),
  imageCommand("anime", undefined, "Random anime image", "🎴", async () => {
    const cat = NEKO_CATEGORIES[Math.floor(Math.random() * NEKO_CATEGORIES.length)];
    const data = await fetchJson<{ results: Array<{ url: string }> }>(`https://nekos.best/api/v2/${cat}`);
    return data.results[0]?.url;
  }),
];
