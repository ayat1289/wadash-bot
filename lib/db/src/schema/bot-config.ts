import { pgTable, text, serial, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const botConfigTable = pgTable(
  "bot_config",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [unique("bot_config_tenant_key_unq").on(t.tenantId, t.key)],
);

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({ id: true });
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
