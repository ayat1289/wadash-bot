import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const broadcastsTable = pgTable(
  "broadcasts",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    message: text("message").notNull(),
    recipients: text("recipients").array().notNull().default([]),
    status: text("status").notNull().default("pending"), // pending | sending | done | failed
    sentCount: integer("sent_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("broadcasts_tenant_id_idx").on(t.tenantId)],
);

export const insertBroadcastSchema = createInsertSchema(broadcastsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBroadcast = z.infer<typeof insertBroadcastSchema>;
export type Broadcast = typeof broadcastsTable.$inferSelect;
