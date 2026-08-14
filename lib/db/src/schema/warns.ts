import { pgTable, text, serial, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const warnsTable = pgTable(
  "warns",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    groupJid: text("group_jid").notNull(),
    userJid: text("user_jid").notNull(),
    count: integer("count").notNull().default(0),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("warns_tenant_group_user_unq").on(t.tenantId, t.groupJid, t.userJid)],
);

export const insertWarnSchema = createInsertSchema(warnsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWarn = z.infer<typeof insertWarnSchema>;
export type Warn = typeof warnsTable.$inferSelect;
