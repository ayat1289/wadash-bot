import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

/**
 * One-time codes a tenant's Telegram owner generates to link a dashboard
 * (Clerk) account to that tenant. The raw code is never stored — only its
 * sha256 hash (`codeHash`, unique). Codes are single-use (`usedAt` is stamped
 * on consumption) and short-lived (`expiresAt`, ~10 minutes). Consumption is a
 * single atomic conditional UPDATE so a code can never be redeemed twice.
 */
export const linkCodesTable = pgTable("link_codes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLinkCodeSchema = createInsertSchema(linkCodesTable).omit({
  id: true,
  usedAt: true,
  createdAt: true,
});
export type InsertLinkCode = z.infer<typeof insertLinkCodeSchema>;
export type LinkCode = typeof linkCodesTable.$inferSelect;
