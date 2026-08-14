import { pgTable, text, serial, timestamp, boolean, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const groupSettingsTable = pgTable(
  "group_settings",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    groupJid: text("group_jid").notNull(),
    groupName: text("group_name").notNull(),
    antiSpam: boolean("anti_spam").notNull().default(false),
    maxMessagesPerMinute: integer("max_messages_per_minute").notNull().default(20),
    welcomeMessage: text("welcome_message"),
    farewellMessage: text("farewell_message"),
    allowLinks: boolean("allow_links").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("group_settings_tenant_group_jid_unq").on(t.tenantId, t.groupJid)],
);

export const insertGroupSettingsSchema = createInsertSchema(groupSettingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertGroupSettings = z.infer<typeof insertGroupSettingsSchema>;
export type GroupSettings = typeof groupSettingsTable.$inferSelect;
