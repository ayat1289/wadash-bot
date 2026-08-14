import type { Command } from "../types";
import { fetchJson } from "../http-utils";

const API = "https://www.thesportsdb.com/api/v1/json/3";

interface League {
  id: string;
  name: string;
}

const LEAGUES: Record<string, League> = {
  epl: { id: "4328", name: "Premier League" },
  laliga: { id: "4335", name: "La Liga" },
  seriea: { id: "4332", name: "Serie A" },
  bundesliga: { id: "4331", name: "Bundesliga" },
  ligue1: { id: "4334", name: "Ligue 1" },
  ucl: { id: "4480", name: "UEFA Champions League" },
};

const LEAGUE_ALIASES: Record<string, string> = {
  premierleague: "epl",
  premier: "epl",
  england: "epl",
  spain: "laliga",
  italy: "seriea",
  germany: "bundesliga",
  france: "ligue1",
  championsleague: "ucl",
  champions: "ucl",
};

function resolveLeague(input: string): League | null {
  const k = input.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return null;
  return LEAGUES[k] ?? LEAGUES[LEAGUE_ALIASES[k] ?? ""] ?? null;
}

/** Current football season string, e.g. "2025-2026" (season spans Aug–May). */
function currentSeason(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

interface StandingRow {
  intRank?: string;
  strTeam?: string;
  intPlayed?: string;
  intPoints?: string;
}

interface TableResponse {
  table?: StandingRow[] | null;
}

interface EventItem {
  strEvent?: string;
  dateEvent?: string;
  strTime?: string;
  intHomeScore?: string | null;
  intAwayScore?: string | null;
  strStatus?: string;
}

interface EventsResponse {
  events?: EventItem[] | null;
}

async function getStandings(id: string): Promise<{ rows: StandingRow[]; season: string } | null> {
  const cur = currentSeason();
  const [a, b] = cur.split("-").map(Number);
  for (const season of [cur, `${a - 1}-${b - 1}`]) {
    const data = await fetchJson<TableResponse>(`${API}/lookuptable.php?l=${id}&s=${season}`).catch(
      () => null,
    );
    if (data?.table?.length) return { rows: data.table, season };
  }
  return null;
}

function formatStandings(name: string, season: string, rows: StandingRow[]): string {
  const lines = rows
    .slice(0, 10)
    .map((r) => `${r.intRank}. ${r.strTeam} — ${r.intPoints} pts (${r.intPlayed} pl)`)
    .join("\n");
  return `🏆 *${name} — Standings ${season}*\n\n${lines}`;
}

async function replyStandings(
  ctx: Parameters<Command["handler"]>[0],
  league: League,
): Promise<void> {
  try {
    const res = await getStandings(league.id);
    if (!res) {
      await ctx.reply(`❌ No standings available for ${league.name} right now (off-season?).`);
      return;
    }
    await ctx.reply(formatStandings(league.name, res.season, res.rows));
  } catch {
    await ctx.reply("❌ Couldn't fetch standings right now. Try again in a moment.");
  }
}

async function replyFixtures(
  ctx: Parameters<Command["handler"]>[0],
  league: League,
): Promise<void> {
  try {
    const next = await fetchJson<EventsResponse>(
      `${API}/eventsnextleague.php?id=${league.id}`,
    ).catch(() => null);
    if (next?.events?.length) {
      const body = next.events
        .slice(0, 10)
        .map(
          (e) =>
            `• ${e.strEvent}\n  📅 ${e.dateEvent ?? ""}${
              e.strTime ? ` ${e.strTime.slice(0, 5)}` : ""
            }`,
        )
        .join("\n");
      await ctx.reply(`📅 *${league.name} — Upcoming Fixtures*\n\n${body}`);
      return;
    }
    const past = await fetchJson<EventsResponse>(
      `${API}/eventspastleague.php?id=${league.id}`,
    ).catch(() => null);
    if (past?.events?.length) {
      const body = past.events
        .slice(0, 10)
        .map(
          (e) =>
            `• ${e.strEvent} — ${e.intHomeScore ?? "?"}:${e.intAwayScore ?? "?"}\n  📅 ${
              e.dateEvent ?? ""
            }`,
        )
        .join("\n");
      await ctx.reply(`📅 *${league.name} — Recent Results*\n\n${body}`);
      return;
    }
    await ctx.reply(`❌ No fixtures available for ${league.name} right now (off-season?).`);
  } catch {
    await ctx.reply("❌ Couldn't fetch fixtures right now. Try again in a moment.");
  }
}

function leagueShortcut(name: string, leagueKey: string): Command {
  const league = LEAGUES[leagueKey];
  return {
    name,
    category: "SPORTS",
    desc: `${league.name} table`,
    handler: async (ctx) => replyStandings(ctx, league),
  };
}

export const sportsCommands: Command[] = [
  {
    name: "standings",
    aliases: ["table", "standing"],
    category: "SPORTS",
    desc: "League table (default Premier League)",
    handler: async (ctx) => {
      const league = resolveLeague(ctx.text) ?? LEAGUES.epl;
      await replyStandings(ctx, league);
    },
  },
  {
    name: "fixtures",
    aliases: ["fixture", "matches"],
    category: "SPORTS",
    desc: "Upcoming/recent fixtures (default Premier League)",
    handler: async (ctx) => {
      const league = resolveLeague(ctx.text) ?? LEAGUES.epl;
      await replyFixtures(ctx, league);
    },
  },
  {
    name: "livescore",
    aliases: ["live", "scores"],
    category: "SPORTS",
    desc: "Today's football scores",
    handler: async (ctx) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const data = await fetchJson<EventsResponse>(`${API}/eventsday.php?d=${today}&s=Soccer`);
        const events = (data.events ?? []).slice(0, 15);
        if (events.length === 0) {
          await ctx.reply(`⚽ No football matches scheduled for today (${today}).`);
          return;
        }
        const body = events
          .map((e) => {
            const hasScore = e.intHomeScore != null && e.intHomeScore !== "";
            const score = hasScore ? ` — ${e.intHomeScore}:${e.intAwayScore}` : "";
            const status =
              e.strStatus && e.strStatus !== "Not Started"
                ? ` [${e.strStatus}]`
                : e.strTime
                  ? ` (${e.strTime.slice(0, 5)})`
                  : "";
            return `• ${e.strEvent}${score}${status}`;
          })
          .join("\n");
        await ctx.reply(`⚽ *Today's Football — ${today}*\n\n${body}`);
      } catch {
        await ctx.reply("❌ Couldn't fetch live scores right now. Try again in a moment.");
      }
    },
  },
  leagueShortcut("epl", "epl"),
  leagueShortcut("laliga", "laliga"),
  leagueShortcut("seriea", "seriea"),
  {
    name: "ucl",
    category: "SPORTS",
    desc: "Champions League fixtures & results",
    handler: async (ctx) => replyFixtures(ctx, LEAGUES.ucl),
  },
];
