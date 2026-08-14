import type { Command } from "../types";
import { fetchJson, fetchText } from "../http-utils";

interface WttrResponse {
  current_condition?: Array<{
    temp_C: string;
    FeelsLikeC: string;
    humidity: string;
    windspeedKmph: string;
    weatherDesc?: Array<{ value: string }>;
  }>;
  nearest_area?: Array<{
    areaName?: Array<{ value: string }>;
    country?: Array<{ value: string }>;
  }>;
}

interface WikiSummary {
  type?: string;
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

type DictionaryResponse = Array<{
  word: string;
  phonetic?: string;
  meanings: Array<{
    partOfSpeech: string;
    definitions: Array<{ definition: string; example?: string }>;
  }>;
}>;

interface NpmResponse {
  "dist-tags"?: { latest?: string };
  description?: string;
  homepage?: string;
  license?: string;
  versions?: Record<string, { description?: string }>;
}

interface GithubRepo {
  full_name?: string;
  description?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string;
  html_url?: string;
}

interface DdgRelatedTopic {
  Text?: string;
  FirstURL?: string;
}

interface DdgResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Image?: string;
  RelatedTopics?: DdgRelatedTopic[];
}

interface LrclibTrack {
  trackName?: string;
  artistName?: string;
  plainLyrics?: string | null;
}

interface WallhavenSearch {
  data?: Array<{ path?: string }>;
}

interface UrbanResponse {
  list?: Array<{
    word?: string;
    definition?: string;
    example?: string;
    thumbs_up?: number;
    thumbs_down?: number;
  }>;
}

type CountryResponse = Array<{
  name?: { common?: string; official?: string };
  capital?: string[];
  region?: string;
  subregion?: string;
  population?: number;
  flag?: string;
  currencies?: Record<string, { name?: string; symbol?: string }>;
  languages?: Record<string, string>;
}>;

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export const searchCommands: Command[] = [
  {
    name: "weather",
    category: "SEARCH",
    desc: "Current weather for a place",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`Usage: *${ctx.prefix}weather <city>*\nExample: *${ctx.prefix}weather London*`);
      try {
        const data = await fetchJson<WttrResponse>(`https://wttr.in/${encodeURIComponent(q)}?format=j1`);
        const cur = data.current_condition?.[0];
        if (!cur) throw new Error("no data");
        const area = data.nearest_area?.[0];
        const place = area
          ? `${area.areaName?.[0]?.value ?? q}, ${area.country?.[0]?.value ?? ""}`.replace(/, $/, "")
          : q;
        await ctx.reply(
          `🌤️ *Weather — ${place}*\n\n` +
            `🌡️ Temp: ${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C)\n` +
            `☁️ ${cur.weatherDesc?.[0]?.value ?? "—"}\n` +
            `💧 Humidity: ${cur.humidity}%\n` +
            `💨 Wind: ${cur.windspeedKmph} km/h`,
        );
      } catch {
        await ctx.reply("❌ Couldn't get the weather for that place. Check the spelling and try again.");
      }
    },
  },
  {
    name: "wiki",
    aliases: ["wikipedia"],
    category: "SEARCH",
    desc: "Wikipedia summary",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`Usage: *${ctx.prefix}wiki <topic>*`);
      try {
        const data = await fetchJson<WikiSummary>(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`,
        );
        if (!data.extract || data.type === "disambiguation") {
          return ctx.reply("❌ Couldn't find a clear article for that. Try a more specific term.");
        }
        const link = data.content_urls?.desktop?.page;
        await ctx.reply(`📖 *${data.title}*\n\n${data.extract}${link ? `\n\n🔗 ${link}` : ""}`);
      } catch {
        await ctx.reply("❌ Couldn't find a Wikipedia article for that.");
      }
    },
  },
  {
    name: "define",
    aliases: ["dict", "dictionary"],
    category: "SEARCH",
    desc: "Define an English word",
    handler: async (ctx) => {
      const word = ctx.text.trim().split(/\s+/)[0];
      if (!word) return ctx.reply(`Usage: *${ctx.prefix}define <word>*`);
      try {
        const data = await fetchJson<DictionaryResponse>(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
        );
        const entry = data[0];
        if (!entry) throw new Error("no entry");
        let out = `📚 *${entry.word}*${entry.phonetic ? `  ${entry.phonetic}` : ""}\n`;
        for (const m of entry.meanings.slice(0, 3)) {
          out += `\n*${m.partOfSpeech}*\n`;
          for (const d of m.definitions.slice(0, 2)) {
            out += `• ${d.definition}\n`;
            if (d.example) out += `  _e.g. ${d.example}_\n`;
          }
        }
        await ctx.reply(out.trim());
      } catch {
        await ctx.reply(`❌ No definition found for "${word}".`);
      }
    },
  },
  {
    name: "npm",
    category: "SEARCH",
    desc: "Look up an npm package",
    handler: async (ctx) => {
      const pkg = ctx.text.trim().split(/\s+/)[0];
      if (!pkg) return ctx.reply(`Usage: *${ctx.prefix}npm <package>*`);
      try {
        const data = await fetchJson<NpmResponse>(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
        const latest = data["dist-tags"]?.latest;
        const desc = (latest && data.versions?.[latest]?.description) || data.description || "—";
        await ctx.reply(
          `📦 *${pkg}*\n\n` +
            `🔖 Latest: ${latest ?? "—"}\n` +
            `📝 ${desc}\n` +
            `⚖️ License: ${data.license ?? "—"}\n` +
            `🔗 https://www.npmjs.com/package/${pkg}`,
        );
      } catch {
        await ctx.reply(`❌ No npm package named "${pkg}" was found.`);
      }
    },
  },
  {
    name: "github",
    aliases: ["gh"],
    category: "SEARCH",
    desc: "Look up a GitHub repo (owner/name)",
    handler: async (ctx) => {
      const repo = ctx.text.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
      if (!repo.includes("/")) return ctx.reply(`Usage: *${ctx.prefix}github owner/name*`);
      try {
        const data = await fetchJson<GithubRepo>(`https://api.github.com/repos/${repo}`);
        if (!data.full_name) throw new Error("not found");
        await ctx.reply(
          `🐙 *${data.full_name}*\n\n` +
            `${data.description ?? "—"}\n\n` +
            `⭐ Stars: ${data.stargazers_count ?? 0}\n` +
            `🍴 Forks: ${data.forks_count ?? 0}\n` +
            `🐛 Open issues: ${data.open_issues_count ?? 0}\n` +
            `💻 Language: ${data.language ?? "—"}\n` +
            `🔗 ${data.html_url}`,
        );
      } catch {
        await ctx.reply(`❌ Couldn't find the repo "${repo}".`);
      }
    },
  },
  {
    name: "google",
    aliases: ["g"],
    category: "SEARCH",
    desc: "Quick web answer",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`Usage: *${ctx.prefix}google <query>*`);
      try {
        const data = await fetchJson<DdgResponse>(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`,
        );
        const heading = data.Heading?.trim();
        const abstract = data.AbstractText?.trim();
        if (abstract) {
          await ctx.reply(
            `🔎 *${heading || q}*\n\n${abstract}${data.AbstractURL ? `\n\n🔗 ${data.AbstractURL}` : ""}`,
          );
          return;
        }
        const related = (data.RelatedTopics ?? [])
          .filter((t): t is Required<DdgRelatedTopic> => Boolean(t?.Text && t?.FirstURL))
          .slice(0, 5);
        if (related.length === 0) {
          return ctx.reply(`❌ No quick answer found for "${q}". Try rephrasing.`);
        }
        const lines = related.map((t, i) => `${i + 1}. ${t.Text}\n   🔗 ${t.FirstURL}`).join("\n\n");
        await ctx.reply(`🔎 *Results for "${q}"*\n\n${lines}`);
      } catch {
        await ctx.reply("❌ Couldn't search right now. Try again in a moment.");
      }
    },
  },
  {
    name: "lyrics",
    category: "SEARCH",
    desc: "Find song lyrics",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) {
        return ctx.reply(
          `Usage: *${ctx.prefix}lyrics <song>*\nExample: *${ctx.prefix}lyrics Adele - Hello*`,
        );
      }
      try {
        let track: { artist: string; title: string; lyrics: string } | null = null;
        const dash = q.match(/^(.+?)\s*-\s*(.+)$/);
        if (dash) {
          const artist = dash[1].trim();
          const title = dash[2].trim();
          const got = await fetchJson<LrclibTrack>(
            `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
          ).catch(() => null);
          if (got?.plainLyrics) track = { artist, title, lyrics: got.plainLyrics };
        }
        if (!track) {
          const results = await fetchJson<LrclibTrack[]>(
            `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`,
          ).catch(() => [] as LrclibTrack[]);
          const hit = results.find((r) => r.plainLyrics);
          if (hit?.plainLyrics) {
            track = { artist: hit.artistName ?? "", title: hit.trackName ?? q, lyrics: hit.plainLyrics };
          }
        }
        if (!track) return ctx.reply(`❌ Couldn't find lyrics for "${q}". Try *artist - title*.`);
        const header = `🎵 *${track.title}*${track.artist ? ` — ${track.artist}` : ""}\n\n`;
        const lyrics =
          track.lyrics.length > 3500 ? `${track.lyrics.slice(0, 3500)}\n…` : track.lyrics;
        await ctx.reply(header + lyrics);
      } catch {
        await ctx.reply("❌ Couldn't fetch lyrics right now. Try again in a moment.");
      }
    },
  },
  {
    name: "imdb",
    aliases: ["movie"],
    category: "SEARCH",
    desc: "Movie/show info",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) {
        return ctx.reply(`Usage: *${ctx.prefix}imdb <title>*\nExample: *${ctx.prefix}imdb Inception*`);
      }
      try {
        const data = await fetchJson<DdgResponse>(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(`${q} film`)}&format=json&no_html=1&skip_disambig=1`,
        );
        const abstract = data.AbstractText?.trim();
        if (!abstract) return ctx.reply(`❌ Couldn't find info for "${q}". Try the exact title.`);
        const caption =
          `🎬 *${data.Heading?.trim() || q}*\n\n${abstract}` +
          (data.AbstractURL ? `\n\n🔗 ${data.AbstractURL}` : "");
        const img = data.Image?.trim();
        if (img) {
          const imgUrl = img.startsWith("http") ? img : `https://duckduckgo.com${img}`;
          await ctx.sock.sendMessage(ctx.from, { image: { url: imgUrl }, caption }, { quoted: ctx.msg });
        } else {
          await ctx.reply(caption);
        }
      } catch {
        await ctx.reply("❌ Couldn't fetch movie info right now. Try again in a moment.");
      }
    },
  },
  {
    name: "news",
    category: "SEARCH",
    desc: "Latest news headlines",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      const url = q
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
        : "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
      try {
        const xml = await fetchText(url);
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map((m) => {
          const block = m[1];
          const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "");
          const link = ((block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? "").trim();
          return { title, link };
        });
        if (items.length === 0) throw new Error("no items");
        const body = items
          .map((it, i) => `${i + 1}. ${it.title}${it.link ? `\n   🔗 ${it.link}` : ""}`)
          .join("\n\n");
        await ctx.reply(`📰 *${q ? `News — ${q}` : "Top Headlines"}*\n\n${body}`);
      } catch {
        await ctx.reply("❌ Couldn't fetch the news right now. Try again in a moment.");
      }
    },
  },
  {
    name: "gimage",
    aliases: ["googleimage"],
    category: "SEARCH",
    desc: "Image search",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`Usage: *${ctx.prefix}gimage <query>*`);
      try {
        const data = await fetchJson<WallhavenSearch>(
          `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(q)}&sorting=relevance&purity=100`,
        );
        const hit = data.data?.[0]?.path;
        if (!hit) return ctx.reply(`❌ No images found for "${q}".`);
        await ctx.sock.sendMessage(
          ctx.from,
          { image: { url: hit }, caption: `🖼️ ${q}` },
          { quoted: ctx.msg },
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch an image right now. Try again in a moment.");
      }
    },
  },
  {
    name: "urban",
    aliases: ["ud", "urbandictionary"],
    category: "SEARCH",
    desc: "Urban Dictionary definition",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`Usage: *${ctx.prefix}urban <term>*`);
      try {
        const data = await fetchJson<UrbanResponse>(
          `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(q)}`,
        );
        const top = data.list?.[0];
        if (!top?.definition) return ctx.reply(`❌ No Urban Dictionary entry for "${q}".`);
        const clean = (s: string) => s.replace(/[[\]]/g, "").trim();
        const def = clean(top.definition).slice(0, 1500);
        const ex = top.example ? `\n\n_Example:_\n${clean(top.example).slice(0, 600)}` : "";
        await ctx.reply(
          `📖 *${top.word ?? q}*\n\n${def}${ex}\n\n👍 ${top.thumbs_up ?? 0}  👎 ${top.thumbs_down ?? 0}`,
        );
      } catch {
        await ctx.reply("❌ Couldn't reach Urban Dictionary right now. Try again in a moment.");
      }
    },
  },
  {
    name: "country",
    aliases: ["countryinfo"],
    category: "SEARCH",
    desc: "Country information",
    handler: async (ctx) => {
      const q = ctx.text.trim();
      if (!q) return ctx.reply(`Usage: *${ctx.prefix}country <name>*`);
      try {
        const data = await fetchJson<CountryResponse>(
          `https://restcountries.com/v3.1/name/${encodeURIComponent(q)}?fields=name,capital,region,subregion,population,flag,currencies,languages`,
        );
        const c = data[0];
        if (!c?.name?.common) return ctx.reply(`❌ No country found for "${q}".`);
        const cur = c.currencies
          ? Object.values(c.currencies)
              .map((x) => `${x.name ?? "—"}${x.symbol ? ` (${x.symbol})` : ""}`)
              .join(", ")
          : "—";
        const langs = c.languages ? Object.values(c.languages).join(", ") : "—";
        await ctx.reply(
          `${c.flag ?? "🏳️"} *${c.name.common}*\n` +
            `${c.name.official ? `_${c.name.official}_\n` : ""}` +
            `\n🏛️ Capital: ${c.capital?.[0] ?? "—"}` +
            `\n🌍 Region: ${c.region ?? "—"}${c.subregion ? ` (${c.subregion})` : ""}` +
            `\n👥 Population: ${(c.population ?? 0).toLocaleString()}` +
            `\n💱 Currency: ${cur}` +
            `\n🗣️ Languages: ${langs}`,
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch country info right now. Try again in a moment.");
      }
    },
  },
];
