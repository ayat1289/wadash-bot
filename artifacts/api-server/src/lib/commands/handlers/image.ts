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

export const imageCommands: Command[] = [];
