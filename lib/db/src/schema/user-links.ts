import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

/**
 * Maps a Clerk user (the person signed into the dashboard) to the tenant
 * (the Telegram-paired WhatsApp) they control. 1:1 in both directions:
 * `clerkUserId` is unique so a user controls at most one tenant, and
 * `tenantId` is unique so a tenant is controlled by at most one dashboard
 * account. The mapping is the ONLY source of truth for which tenant an
 * authenticated request may touch — it is never taken from the client.
 */
export const userLinksTable = pgTable("user_links", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  tenantId: integer("tenant_id")
    .notNull()
    .unique()
    .references(() => tenantsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertUserLinkSchema = createInsertSchema(userLinksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUserLink = z.infer<typeof insertUserLinkSchema>;
export type UserLink = typeof userLinksTable.$inferSelect;
