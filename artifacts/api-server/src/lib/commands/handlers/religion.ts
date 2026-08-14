import type { Command } from "../types";
import { fetchJson } from "../http-utils";

interface BibleApiResponse {
  reference?: string;
  text?: string;
  translation_name?: string;
}

interface BibleRandomResponse {
  random_verse?: { book: string; chapter: number; verse: number; text: string };
}

interface AyahEdition {
  text: string;
  numberInSurah: number;
  surah: { number: number; englishName: string; name: string };
}

interface QuranAyahResponse {
  data?: AyahEdition[];
}

interface SurahResponse {
  data?: {
    number: number;
    name: string;
    englishName: string;
    englishNameTranslation: string;
    revelationType: string;
    numberOfAyahs: number;
  };
}

interface PrayerResponse {
  data?: {
    timings?: Record<string, string>;
    date?: { readable?: string };
  };
}

interface HadithResponse {
  hadiths?: Array<{ hadithnumber?: number; text?: string }>;
}

export const religionCommands: Command[] = [
  {
    name: "bible",
    category: "RELIGION",
    desc: "Look up a Bible passage",
    handler: async (ctx) => {
      const ref = ctx.text.trim();
      if (!ref) return ctx.reply(`Usage: *${ctx.prefix}bible <reference>*\nExample: *${ctx.prefix}bible John 3:16*`);
      try {
        const data = await fetchJson<BibleApiResponse>(`https://bible-api.com/${encodeURIComponent(ref)}`);
        if (!data.text) throw new Error("not found");
        await ctx.reply(`📖 *${data.reference}* (${data.translation_name ?? "WEB"})\n\n${data.text.trim()}`);
      } catch {
        await ctx.reply("❌ Couldn't find that passage. Try a reference like *John 3:16*.");
      }
    },
  },
  {
    name: "verse",
    category: "RELIGION",
    desc: "Random Bible verse",
    handler: async (ctx) => {
      try {
        const data = await fetchJson<BibleRandomResponse>("https://bible-api.com/data/web/random");
        const v = data.random_verse;
        if (!v) throw new Error("no verse");
        await ctx.reply(`📖 *${v.book} ${v.chapter}:${v.verse}* (WEB)\n\n${v.text.trim()}`);
      } catch {
        await ctx.reply("❌ Couldn't fetch a verse right now. Try again later.");
      }
    },
  },
  {
    name: "quran",
    category: "RELIGION",
    desc: "Random Quran ayah (Arabic + English)",
    handler: async (ctx) => {
      try {
        const n = 1 + Math.floor(Math.random() * 6236);
        const data = await fetchJson<QuranAyahResponse>(
          `https://api.alquran.cloud/v1/ayah/${n}/editions/quran-uthmani,en.asad`,
        );
        const ar = data.data?.[0];
        const en = data.data?.[1];
        if (!ar) throw new Error("no ayah");
        await ctx.reply(
          `🕌 *Surah ${ar.surah.englishName} (${ar.surah.number}:${ar.numberInSurah})*\n\n` +
            `${ar.text}\n\n_${en?.text ?? ""}_`,
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch an ayah right now. Try again later.");
      }
    },
  },
  {
    name: "surah",
    category: "RELIGION",
    desc: "Quran surah info (1-114)",
    handler: async (ctx) => {
      const n = parseInt(ctx.text.trim(), 10);
      if (!n || n < 1 || n > 114) return ctx.reply(`Usage: *${ctx.prefix}surah <1-114>*`);
      try {
        const data = await fetchJson<SurahResponse>(`https://api.alquran.cloud/v1/surah/${n}`);
        const s = data.data;
        if (!s) throw new Error("not found");
        await ctx.reply(
          `🕌 *Surah ${s.number} — ${s.englishName}*\n\n` +
            `📜 Arabic: ${s.name}\n` +
            `🔤 Meaning: ${s.englishNameTranslation}\n` +
            `📍 Revelation: ${s.revelationType}\n` +
            `🔢 Ayahs: ${s.numberOfAyahs}`,
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch that surah. Use a number from 1 to 114.");
      }
    },
  },
  {
    name: "prayertime",
    aliases: ["prayer", "salah"],
    category: "RELIGION",
    desc: "Prayer times for a place",
    handler: async (ctx) => {
      const place = ctx.text.trim();
      if (!place) return ctx.reply(`Usage: *${ctx.prefix}prayertime <city>*\nExample: *${ctx.prefix}prayertime London*`);
      try {
        const data = await fetchJson<PrayerResponse>(
          `https://api.aladhan.com/v1/timingsByAddress?address=${encodeURIComponent(place)}&method=2`,
        );
        const t = data.data?.timings;
        if (!t) throw new Error("no timings");
        await ctx.reply(
          `🕋 *Prayer Times — ${place}*\n${data.data?.date?.readable ?? ""}\n\n` +
            `🌅 Fajr: ${t.Fajr}\n` +
            `☀️ Sunrise: ${t.Sunrise}\n` +
            `🌞 Dhuhr: ${t.Dhuhr}\n` +
            `🌤️ Asr: ${t.Asr}\n` +
            `🌇 Maghrib: ${t.Maghrib}\n` +
            `🌙 Isha: ${t.Isha}`,
        );
      } catch {
        await ctx.reply("❌ Couldn't get prayer times for that place. Check the spelling and try again.");
      }
    },
  },
  {
    name: "hadith",
    category: "RELIGION",
    desc: "Random Hadith (Sahih al-Bukhari)",
    handler: async (ctx) => {
      try {
        const n = 1 + Math.floor(Math.random() * 7563);
        const data = await fetchJson<HadithResponse>(
          `https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/eng-bukhari/${n}.json`,
        );
        const h = data.hadiths?.[0];
        if (!h?.text) throw new Error("no hadith");
        await ctx.reply(`📜 *Sahih al-Bukhari — Hadith ${h.hadithnumber ?? n}*\n\n${h.text.trim()}`);
      } catch {
        await ctx.reply("❌ Couldn't fetch a hadith right now. Try again later.");
      }
    },
  },
];
