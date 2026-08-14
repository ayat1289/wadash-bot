import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const messagesTable = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    fromJid: text("from_jid").notNull(),
    fromName: text("from_name"),
    toJid: text("to_jid").notNull(),
    body: text("body").notNull(),
    type: text("type").notNull().default("dm"), // dm | group
    groupName: text("group_name"),
    timestamp: text("timestamp").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_tenant_id_idx").on(t.tenantId)],
);

export const insertMessageSchema = createInsertSchema(messagesTable).omit({ id: true, createdAt: true });
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;
