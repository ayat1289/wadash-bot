import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  telegramChatId: text("telegram_chat_id").notNull().unique(),
  ownerNumber: text("owner_number"),
  ownerJid: text("owner_jid"),
  status: text("status").notNull().default("active"), // active | disconnected
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;

/**
 * All data created before the multi-tenant migration belongs to this seeded
 * tenant (row id = 1). Code paths that don't yet have a real tenant in scope
 * default to it so behaviour is unchanged for the original single owner.
 */
export const LEGACY_TENANT_ID = 1;
