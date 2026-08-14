import type { Command } from "../types";
import { fetchJson } from "../http-utils";

type Rates = Record<string, Record<string, number>>;

/** Currency/crypto codes are restricted to keep them safe in the URL path. */
const CODE_RE = /^[a-z0-9]{2,12}$/;

/**
 * Fetch the rate table for a base currency/coin from the free, key-free
 * fawazahmed0 currency-api (same CDN family used by the religion commands).
 * Falls back to the mirror host if the jsDelivr CDN is unavailable.
 */
async function ratesFor(base: string): Promise<Record<string, number>> {
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${base}.json`,
  ];
  let lastErr: unknown;
  for (const u of urls) {
    try {
      const data = await fetchJson<Rates>(u);
      const map = data[base];
      if (map && typeof map === "object") return map;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("rates unavailable");
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export const financeCommands: Command[] = [
  {
    name: "currency",
    aliases: ["convert", "exchange"],
    category: "TOOLS",
    desc: "Convert currency: <amount> <from> <to>",
    handler: async (ctx) => {
      const parts = ctx.text.trim().split(/\s+/);
      if (parts.length < 3) {
        return ctx.reply(`Usage: *${ctx.prefix}currency 100 usd kes*`);
      }
      const amount = Number(parts[0]);
      const from = parts[1].toLowerCase();
      const to = parts[2].toLowerCase();
      if (!Number.isFinite(amount) || !CODE_RE.test(from) || !CODE_RE.test(to)) {
        return ctx.reply("❌ Bad input. Example: *currency 100 usd kes*");
      }
      try {
        const map = await ratesFor(from);
        const rate = map[to];
        if (typeof rate !== "number") {
          return ctx.reply(`❌ Unknown currency code "${to.toUpperCase()}".`);
        }
        const result = amount * rate;
        await ctx.reply(
          `💱 *Currency Converter*\n\n${fmt(amount)} ${from.toUpperCase()} = *${fmt(result)} ${to.toUpperCase()}*\n_Rate: 1 ${from.toUpperCase()} = ${fmt(rate)} ${to.toUpperCase()}_`,
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch exchange rates right now. Try again in a moment.");
      }
    },
  },
  {
    name: "crypto",
    aliases: ["coin", "price"],
    category: "TOOLS",
    desc: "Crypto price: <symbol> [vs currency]",
    handler: async (ctx) => {
      const parts = ctx.text.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        return ctx.reply(`Usage: *${ctx.prefix}crypto btc* or *${ctx.prefix}crypto eth eur*`);
      }
      const sym = parts[0].toLowerCase();
      const vs = (parts[1] ?? "usd").toLowerCase();
      if (!CODE_RE.test(sym) || !CODE_RE.test(vs)) {
        return ctx.reply("❌ Bad input. Example: *crypto btc usd*");
      }
      try {
        const map = await ratesFor(sym);
        const price = map[vs];
        if (typeof price !== "number") {
          return ctx.reply("❌ Unknown coin/currency. Example: *crypto btc usd*");
        }
        await ctx.reply(
          `🪙 *${sym.toUpperCase()} Price*\n\n1 ${sym.toUpperCase()} = *${fmt(price)} ${vs.toUpperCase()}*`,
        );
      } catch {
        await ctx.reply("❌ Couldn't fetch the price right now. Try again in a moment.");
      }
    },
  },
];
