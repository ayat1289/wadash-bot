import { db, economyTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import type { Command, CommandContext } from "../types";
import { getGroupMetadataCached, jidBase, participantHasNumber } from "../../group-meta";
import { groupActivity } from "../../activity-store";

type Row = typeof economyTable.$inferSelect;

const DAY = 86_400_000;
const HOUR = 3_600_000;

const SHOP: { item: string; price: number; desc: string }[] = [
  { item: "rose", price: 100, desc: "A rose to gift someone" },
  { item: "shield", price: 800, desc: "Protects you from one .rob" },
  { item: "lottery", price: 1500, desc: "A lottery ticket" },
  { item: "vip", price: 2500, desc: "VIP badge + bigger dailies" },
  { item: "crown", price: 5000, desc: "Crown badge — show it off" },
];

async function getRow(ctx: CommandContext, jid: string): Promise<Row> {
  const user = jidBase(jid);
  const [row] = await db
    .select()
    .from(economyTable)
    .where(and(eq(economyTable.tenantId, ctx.tenantId), eq(economyTable.userJid, user)))
    .limit(1);
  if (row) return row;
  const [created] = await db
    .insert(economyTable)
    .values({ tenantId: ctx.tenantId, userJid: user })
    .returning();
  return created;
}

async function patch(ctx: CommandContext, jid: string, p: Partial<Row>): Promise<void> {
  await db
    .update(economyTable)
    .set(p)
    .where(and(eq(economyTable.tenantId, ctx.tenantId), eq(economyTable.userJid, jidBase(jid))));
}

function addXp(ctx: CommandContext, row: Row, amt: number): number {
  const total = row.xp + amt;
  void patch(ctx, row.userJid, { xp: total });
  return total;
}

function levelOf(xp: number): { level: number; cur: number; need: number } {
  const level = Math.floor(Math.sqrt(xp / 25)) + 1;
  const cur = Math.floor((level - 1) ** 2 * 25);
  const next = level ** 2 * 25;
  return { level, cur: xp - cur, need: next - cur };
}

function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

function targetJid(ctx: CommandContext): string {
  const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
  const mentioned = ci?.mentionedJid ?? [];
  if (mentioned.length > 0) return mentioned[0];
  if (ci?.participant) return ci.participant;
  return ctx.sender;
}

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

async function balanceHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, targetJid(ctx));
  const lvl = levelOf(row.xp);
  await ctx.sock.sendMessage(
    ctx.from,
    {
      text: `💰 *Bank of ${ctx.pushName}*\n\n💵 Cash: *${row.balance}*\n🏦 Bank: *${row.bank}*\n⭐ XP: *${row.xp}* (Level ${lvl.level})\n🤝 Rep: *${row.rep}*\n👑 Prestige: *${row.prestige}*\n\n_Total worth: *${row.balance + row.bank}* coins_`,
      mentions: [targetJid(ctx)],
    },
    { quoted: ctx.msg },
  );
}

// ---------------------------------------------------------------------------
// daily
// ---------------------------------------------------------------------------

async function dailyHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  const today = new Date().toISOString().slice(0, 10);
  if (row.lastDaily === today) {
    await ctx.reply("⏳ You already claimed today's daily. Come back tomorrow!");
    return;
  }
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  const streak = row.lastDaily === yesterday ? row.streak + 1 : 1;
  const vip = row.inventory && (row.inventory as Record<string, number>)["vip"] ? 1.5 : 1;
  const base = 100 + Math.min(streak, 30) * 10;
  const amt = Math.floor(base * vip);
  await patch(ctx, ctx.sender, {
    balance: row.balance + amt,
    totalEarned: row.totalEarned + amt,
    lastDaily: today,
    streak,
  });
  addXp(ctx, row, 15);
  await ctx.reply(
    `📅 *Daily reward claimed!*\n+${amt} coins${vip > 1 ? " (VIP x1.5)" : ""}\n🔥 Streak: *${streak} day${streak > 1 ? "s" : ""}*\n+15 XP`,
  );
}

// ---------------------------------------------------------------------------
// work
// ---------------------------------------------------------------------------

async function workHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  const last = row.lastWork ? Number(row.lastWork) : 0;
  if (Date.now() - last < HOUR) {
    const wait = Math.ceil((HOUR - (Date.now() - last)) / 60_000);
    await ctx.reply(`⏳ You're tired. Come back in *${wait} minutes*.`);
    return;
  }
  const jobs = [
    { t: "flipping burgers", p: 40 },
    { t: "coding freelance", p: 150 },
    { t: "walking dogs", p: 55 },
    { t: "driving a taxi", p: 90 },
    { t: "selling lemonade", p: 30 },
    { t: "streaming games", p: 120 },
  ];
  const job = jobs[Math.floor(Math.random() * jobs.length)];
  const amt = Math.floor(job.p * (0.8 + Math.random() * 0.4));
  await patch(ctx, ctx.sender, { balance: row.balance + amt, totalEarned: row.totalEarned + amt, lastWork: String(Date.now()) });
  addXp(ctx, row, 10);
  await ctx.reply(`💼 You spent the hour *${job.t}* and earned *+${amt} coins*.\n+10 XP`);
}

// ---------------------------------------------------------------------------
// gamble
// ---------------------------------------------------------------------------

async function gambleHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  let bet = ctx.args[0] === "all" ? row.balance : Number(ctx.args[0]);
  if (!bet || bet < 10) {
    await ctx.reply(`Usage: *${ctx.prefix}gamble <amount|all>* — 50/50 double-or-nothing.`);
    return;
  }
  if (bet > row.balance) {
    await ctx.reply(`❌ You only have *${row.balance}* coins.`);
    return;
  }
  const win = Math.random() < 0.5;
  const delta = win ? bet : -bet;
  await patch(ctx, ctx.sender, {
    balance: Math.max(0, row.balance + delta),
    totalEarned: win ? row.totalEarned + bet : row.totalEarned,
  });
  if (win) addXp(ctx, row, 20);
  await ctx.reply(
    win
      ? `🎰 You gambled ${bet} and WON! +${bet} coins 🎉 (+20 XP)`
      : `🎰 You gambled ${bet} and lost... -${bet} coins 💸`,
  );
}

// ---------------------------------------------------------------------------
// rob
// ---------------------------------------------------------------------------

async function robHandler(ctx: CommandContext): Promise<void> {
  const target = targetJid(ctx);
  if (jidBase(target) === jidBase(ctx.sender)) {
    await ctx.reply("😅 You can't rob yourself!");
    return;
  }
  const [me, them] = await Promise.all([getRow(ctx, ctx.sender), getRow(ctx, target)]);
  if ((them.inventory as Record<string, number>)?.["shield"] > 0) {
    await patch(ctx, target, { inventory: { ...(them.inventory as object), shield: (them.inventory as Record<string, number>)["shield"] - 1 } });
    await ctx.reply("🛡️ Your target's *shield* blocked your robbery!");
    return;
  }
  if (them.balance < 20) {
    await ctx.reply("❌ Nothing worth stealing there.");
    return;
  }
  const success = Math.random() < 0.5;
  if (!success) {
    const fine = Math.floor(me.balance * 0.1);
    await patch(ctx, ctx.sender, { balance: Math.max(0, me.balance - fine) });
    await ctx.sock.sendMessage(
      ctx.from,
      { text: `🚔 Robbery failed! You got caught and fined *${fine}* coins.`, mentions: [target] },
      { quoted: ctx.msg },
    );
    return;
  }
  const loot = Math.floor(them.balance * (0.1 + Math.random() * 0.15));
  await patch(ctx, target, { balance: Math.max(0, them.balance - loot) });
  await patch(ctx, ctx.sender, { balance: me.balance + loot });
  addXp(ctx, me, 15);
  await ctx.sock.sendMessage(
    ctx.from,
    { text: `🦹 You robbed @${jidBase(target)} and got away with *${loot}* coins! (+15 XP)`, mentions: [target] },
    { quoted: ctx.msg },
  );
}

// ---------------------------------------------------------------------------
// deposit / withdraw / bank
// ---------------------------------------------------------------------------

async function depositHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  let amt = ctx.args[0] === "all" ? row.balance : Number(ctx.args[0]);
  if (!amt || amt < 1) return ctx.reply(`Usage: *${ctx.prefix}deposit <amount|all>*`);
  if (amt > row.balance) return ctx.reply(`❌ You only have *${row.balance}* in cash.`);
  await patch(ctx, ctx.sender, { balance: row.balance - amt, bank: row.bank + amt });
  await ctx.reply(`🏦 Deposited *${amt}* coins into the bank.`);
}

async function withdrawHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  let amt = ctx.args[0] === "all" ? row.bank : Number(ctx.args[0]);
  if (!amt || amt < 1) return ctx.reply(`Usage: *${ctx.prefix}withdraw <amount|all>*`);
  if (amt > row.bank) return ctx.reply(`❌ You only have *${row.bank}* in the bank.`);
  await patch(ctx, ctx.sender, { balance: row.balance + amt, bank: row.bank - amt });
  await ctx.reply(`🏦 Withdrew *${amt}* coins to your cash.`);
}

async function bankHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  await ctx.reply(`🏦 *Bank*\nCash: *${row.balance}*\nBank: *${row.bank}*\nTotal: *${row.balance + row.bank}*`);
}

// ---------------------------------------------------------------------------
// shop / buy / inventory
// ---------------------------------------------------------------------------

async function shopHandler(ctx: CommandContext): Promise<void> {
  const lines = SHOP.map((s) => `• *${s.item}* — ${s.price} coins\n   _${s.desc}_`).join("\n");
  await ctx.reply(`🛒 *Shop*\n${lines}\n\nBuy with: *${ctx.prefix}buy <item>*`);
}

async function buyHandler(ctx: CommandContext): Promise<void> {
  const item = (ctx.args[0] ?? "").toLowerCase();
  const row = await getRow(ctx, ctx.sender);
  const entry = SHOP.find((s) => s.item === item);
  if (!entry) return ctx.reply(`❌ Unknown item. See *${ctx.prefix}shop*`);
  if (row.balance < entry.price) return ctx.reply(`❌ You need *${entry.price}* coins. You have *${row.balance}*.`);
  const inv = (row.inventory ?? {}) as Record<string, number>;
  await patch(ctx, ctx.sender, {
    balance: row.balance - entry.price,
    totalEarned: row.totalEarned - 0,
    inventory: { ...inv, [item]: (inv[item] ?? 0) + 1 },
  });
  await ctx.reply(`🛒 Bought *${item}* for ${entry.price} coins!`);
}

async function inventoryHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  const inv = (row.inventory ?? {}) as Record<string, number>;
  const entries = Object.entries(inv).filter(([, n]) => n > 0);
  await ctx.reply(entries.length ? `🎒 *Inventory:*\n${entries.map(([k, n]) => `• ${k} ×${n}`).join("\n")}` : "🎒 Your inventory is empty. Check the *shop*!");
}

// ---------------------------------------------------------------------------
// prestige / rep / achievements / badges
// ---------------------------------------------------------------------------

async function prestigeHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  if (row.xp < 2000) {
    await ctx.reply(`❌ You need *2000 XP* to prestige. You have *${row.xp}*.`);
    return;
  }
  const bonus = row.prestige + 1;
  await patch(ctx, ctx.sender, { balance: 0, bank: 0, xp: 100, prestige: row.prestige + 1 });
  await ctx.reply(`👑 *PRESTIGE!* Level reset with a fresh start.\nPrestige level now *${bonus}* (x${bonus} income).`);
}

async function repHandler(ctx: CommandContext): Promise<void> {
  const target = targetJid(ctx);
  if (jidBase(target) === jidBase(ctx.sender)) return ctx.reply("😅 You can't rep yourself.");
  const row = await getRow(ctx, ctx.sender);
  if (row.lastRep && Date.now() - Number(row.lastRep) < DAY) {
    return ctx.reply("⏳ You already gave your rep today.");
  }
  await patch(ctx, ctx.sender, { lastRep: String(Date.now()) });
  const them = await getRow(ctx, target);
  await patch(ctx, target, { rep: them.rep + 1 });
  await ctx.sock.sendMessage(
    ctx.from,
    { text: `🤝 You gave +1 rep to @${jidBase(target)}!`, mentions: [target] },
    { quoted: ctx.msg },
  );
}

async function achievementsHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  const a: string[] = [];
  if (row.totalEarned >= 1000) a.push("🪙 *Money Maker* — earned 1,000+ coins");
  if (row.totalEarned >= 10000) a.push("💰 *Tycoon* — earned 10,000+ coins");
  if (row.streak >= 7) a.push("🔥 *Week Warrior* — 7-day streak");
  if (row.rep >= 10) a.push("🤝 *Popular* — 10+ rep");
  if (row.prestige >= 1) a.push("👑 *Prestigious* — prestiged");
  if (row.xp >= 500) a.push("⭐ *Dedicated* — 500+ XP");
  await ctx.reply(a.length ? `🏆 *Achievements:*\n${a.join("\n")}` : "🏆 No achievements yet. Keep playing!");
}

async function badgesHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, ctx.sender);
  const b: string[] = [];
  if (row.prestige > 0) b.push("👑 PRESTIGE");
  if ((row.inventory as Record<string, number>)?.["vip"]) b.push("💎 VIP");
  if ((row.inventory as Record<string, number>)?.["crown"]) b.push("👑 CROWN");
  await ctx.reply(b.length ? `🎖️ *Badges:* ${b.join(" ")}` : "🎖️ No badges yet.");
}

// ---------------------------------------------------------------------------
// leaderboard / rank / levelcard
// ---------------------------------------------------------------------------

async function leaderboardHandler(ctx: CommandContext): Promise<void> {
  const rows = await db
    .select()
    .from(economyTable)
    .where(eq(economyTable.tenantId, ctx.tenantId))
    .orderBy(desc(economyTable.balance))
    .limit(10);
  if (rows.length === 0) return ctx.reply("📭 No players yet. Start earning with *" + ctx.prefix + "daily*!");
  const lines = rows.map((r: { userJid: string; balance: number; bank: number }, i: number) => `${i + 1}. ${r.userJid.split("@")[0]} — 💵 ${r.balance} (+${r.bank} bank)`).join("\n");
  await ctx.reply(`🏆 *Leaderboard:*\n${lines}`);
}

async function rankHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, targetJid(ctx));
  const lvl = levelOf(row.xp);
  await ctx.sock.sendMessage(
    ctx.from,
    { text: `⭐ *@${jidBase(targetJid(ctx))}*\nLevel: *${lvl.level}*\nXP: ${row.xp} (${lvl.cur}/${lvl.need})\n${bar((lvl.cur / lvl.need) * 100)}`, mentions: [targetJid(ctx)] },
    { quoted: ctx.msg },
  );
}

async function levelcardHandler(ctx: CommandContext): Promise<void> {
  const row = await getRow(ctx, targetJid(ctx));
  const lvl = levelOf(row.xp);
  await ctx.sock.sendMessage(
    ctx.from,
    {
      text: `🎴 *LEVEL CARD*\n\n👤 @${jidBase(targetJid(ctx))}\n🎯 Level ${lvl.level}  |  👑 Prestige ${row.prestige}\n⭐ ${row.xp} XP\n${bar((lvl.cur / lvl.need) * 100)}`,
      mentions: [targetJid(ctx)],
    },
    { quoted: ctx.msg },
  );
}

// ---------------------------------------------------------------------------
// activemembers / activetoday
// ---------------------------------------------------------------------------

async function activeHandler(ctx: CommandContext, todayOnly: boolean): Promise<void> {
  if (!ctx.isGroup) return ctx.reply("❌ Use this in a group.");
  const act = groupActivity(ctx.tenantId, ctx.from, todayOnly);
  const top = [...act.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length === 0) return ctx.reply("📭 No recorded activity yet.");
  await ctx.reply(`📊 *Active members${todayOnly ? " today" : ""}:*\n${top.map(([u, n], i) => `${i + 1}. ${u.split("@")[0]} — ${n} msgs`).join("\n")}`);
}

// ---------------------------------------------------------------------------
// randomadmin
// ---------------------------------------------------------------------------

async function randomadminHandler(ctx: CommandContext): Promise<void> {
  if (!ctx.isGroup) return ctx.reply("❌ Use this in a group.");
  const meta = await getGroupMetadataCached(ctx.sock, ctx.tenantId, ctx.from);
  if (!meta) return ctx.reply("❌ Couldn't read group info.");
  const admins = meta.participants.filter((p) => p.admin || participantHasNumber(p, ctx.sock.user?.id));
  if (admins.length === 0) return ctx.reply("😐 No admins to pick.");
  const a = admins[Math.floor(Math.random() * admins.length)];
  await ctx.sock.sendMessage(ctx.from, { text: `🎲 Random admin:\n\n@${jidBase(a.id)}`, mentions: [a.id] }, { quoted: ctx.msg });
}

export const economyCommands: Command[] = [
  { name: "balance", aliases: ["bal", "money"], category: "ECONOMY", desc: "Check balance", handler: balanceHandler },
  { name: "daily", category: "ECONOMY", desc: "Claim daily reward", handler: dailyHandler },
  { name: "work", category: "ECONOMY", desc: "Work for coins", handler: workHandler },
  { name: "gamble", category: "ECONOMY", desc: "Gamble coins", handler: gambleHandler },
  { name: "rob", category: "ECONOMY", desc: "Rob a member", handler: robHandler },
  { name: "deposit", aliases: ["dep"], category: "ECONOMY", desc: "Deposit to bank", handler: depositHandler },
  { name: "withdraw", aliases: ["wd"], category: "ECONOMY", desc: "Withdraw from bank", handler: withdrawHandler },
  { name: "bank", category: "ECONOMY", desc: "Check bank", handler: bankHandler },
  { name: "shop", category: "ECONOMY", desc: "View the shop", handler: shopHandler },
  { name: "buy", category: "ECONOMY", desc: "Buy an item", handler: buyHandler },
  { name: "inventory", aliases: ["inv"], category: "ECONOMY", desc: "View inventory", handler: inventoryHandler },
  { name: "prestige", category: "ECONOMY", desc: "Prestige for a fresh start", handler: prestigeHandler },
  { name: "rep", category: "ECONOMY", desc: "Give reputation", handler: repHandler },
  { name: "achievements", category: "ECONOMY", desc: "View achievements", handler: achievementsHandler },
  { name: "badges", category: "ECONOMY", desc: "View badges", handler: badgesHandler },
  { name: "leaderboard", aliases: ["lb"], category: "ECONOMY", desc: "Top balances", handler: leaderboardHandler },
  { name: "rank", category: "ECONOMY", desc: "Check level", handler: rankHandler },
  { name: "levelcard", category: "ECONOMY", desc: "Level card", handler: levelcardHandler },
  { name: "activemembers", category: "ECONOMY", desc: "Most active members", handler: async (ctx) => activeHandler(ctx, false) },
  { name: "activetoday", category: "ECONOMY", desc: "Active today", handler: async (ctx) => activeHandler(ctx, true) },
  { name: "randomadmin", category: "GROUP", desc: "Pick a random admin", handler: randomadminHandler },
];
