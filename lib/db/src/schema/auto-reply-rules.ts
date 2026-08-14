import { pgTable, text, serial, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const autoReplyRulesTable = pgTable(
  "auto_reply_rules",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    keyword: text("keyword").notNull(),
    response: text("response").notNull(),
    matchType: text("match_type").notNull().default("contains"), // exact | contains | startsWith | regex
    isActive: boolean("is_active").notNull().default(true),
    scope: text("scope").notNull().default("all"), // all | dm | group
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("auto_reply_rules_tenant_id_idx").on(t.tenantId)],
);

export const insertAutoReplyRuleSchema = createInsertSchema(autoReplyRulesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAutoReplyRule = z.infer<typeof insertAutoReplyRuleSchema>;
export type AutoReplyRule = typeof autoReplyRulesTable.$inferSelect;
