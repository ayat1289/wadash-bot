import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const scheduledStatusesTable = pgTable(
  "scheduled_statuses",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    text: text("text").notNull(),
    mediaUrl: text("media_url"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | failed | cancelled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("scheduled_statuses_tenant_id_idx").on(t.tenantId)],
);

export const insertScheduledStatusSchema = createInsertSchema(scheduledStatusesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertScheduledStatus = z.infer<typeof insertScheduledStatusSchema>;
export type ScheduledStatus = typeof scheduledStatusesTable.$inferSelect;
