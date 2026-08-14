import { pgTable, text, integer, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const economyTable = pgTable(
  "economy",
  {
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    userJid: text("user_jid").notNull(),
    balance: integer("balance").notNull().default(0),
    bank: integer("bank").notNull().default(0),
    xp: integer("xp").notNull().default(0),
    rep: integer("rep").notNull().default(0),
    totalEarned: integer("total_earned").notNull().default(0),
    streak: integer("streak").notNull().default(0),
    lastDaily: text("last_daily"),
    lastWork: text("last_work"),
    lastRep: text("last_rep"),
    prestige: integer("prestige").notNull().default(0),
    marriedTo: text("married_to"),
    inventory: jsonb("inventory").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("economy_tenant_user_unq").on(t.tenantId, t.userJid)],
);

export const insertEconomySchema = createInsertSchema(economyTable).omit({ createdAt: true, updatedAt: true });
export type InsertEconomy = z.infer<typeof insertEconomySchema>;
export type Economy = typeof economyTable.$inferSelect;
