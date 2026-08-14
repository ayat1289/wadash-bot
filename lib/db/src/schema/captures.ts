import { pgTable, text, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const capturesTable = pgTable(
  "captures",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    kind: text("kind").notNull(), // deleted | viewonce
    senderJid: text("sender_jid").notNull(),
    senderName: text("sender_name"),
    chatJid: text("chat_jid").notNull(),
    chatName: text("chat_name"),
    chatType: text("chat_type").notNull().default("dm"), // dm | group
    contentType: text("content_type").notNull(), // text | image | video | audio | sticker | document | other
    body: text("body"),
    mediaPath: text("media_path"),
    mediaMimetype: text("media_mimetype"),
    mediaSize: integer("media_size"),
    timestamp: text("timestamp").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("captures_tenant_id_idx").on(t.tenantId)],
);

export const insertCaptureSchema = createInsertSchema(capturesTable).omit({ id: true, createdAt: true });
export type InsertCapture = z.infer<typeof insertCaptureSchema>;
export type Capture = typeof capturesTable.$inferSelect;
