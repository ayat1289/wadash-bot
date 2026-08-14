import { Router, type IRouter } from "express";
import fs from "fs";
import { db, capturesTable, type Capture } from "@workspace/db";
import { and, eq, desc, count, sql, gte, lte } from "drizzle-orm";
import { ListCapturesQueryParams } from "@workspace/api-zod";
import { captureMediaPath } from "../lib/captures";

const router: IRouter = Router();

function toDto(c: Capture) {
  return {
    id: c.id,
    kind: c.kind,
    senderJid: c.senderJid,
    senderName: c.senderName,
    chatJid: c.chatJid,
    chatName: c.chatName,
    chatType: c.chatType,
    contentType: c.contentType,
    body: c.body,
    mediaUrl: c.mediaPath ? `/api/captures/${c.id}/media` : null,
    mediaMimetype: c.mediaMimetype,
    mediaSize: c.mediaSize,
    timestamp: c.timestamp,
    createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
  };
}

router.get("/captures", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const parsed = ListCapturesQueryParams.safeParse(req.query);
  const q = parsed.success ? parsed.data : {};
  const limit = q.limit ?? 100;
  const offset = q.offset ?? 0;

  const conditions = [eq(capturesTable.tenantId, tenantId)];
  if (q.kind && q.kind !== "all") conditions.push(eq(capturesTable.kind, q.kind));
  if (q.chatType && q.chatType !== "all") conditions.push(eq(capturesTable.chatType, q.chatType));
  if (q.senderJid) conditions.push(eq(capturesTable.senderJid, q.senderJid));
  if (q.chatJid) conditions.push(eq(capturesTable.chatJid, q.chatJid));
  if (q.from) {
    const d = new Date(q.from);
    if (!Number.isNaN(d.getTime())) conditions.push(gte(capturesTable.createdAt, d));
  }
  if (q.to) {
    const d = new Date(q.to);
    if (!Number.isNaN(d.getTime())) conditions.push(lte(capturesTable.createdAt, d));
  }

  const rows = await db
    .select()
    .from(capturesTable)
    .where(and(...conditions))
    .orderBy(desc(capturesTable.createdAt))
    .limit(limit)
    .offset(offset);
  res.json(rows.map(toDto));
});

router.get("/captures/stats", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const scope = eq(capturesTable.tenantId, tenantId);
  const [total] = await db.select({ count: count() }).from(capturesTable).where(scope);
  const [deleted] = await db
    .select({ count: count() })
    .from(capturesTable)
    .where(and(scope, eq(capturesTable.kind, "deleted")));
  const [viewonce] = await db
    .select({ count: count() })
    .from(capturesTable)
    .where(and(scope, eq(capturesTable.kind, "viewonce")));
  const [withMedia] = await db
    .select({ count: count() })
    .from(capturesTable)
    .where(and(scope, sql`${capturesTable.mediaPath} is not null`));

  res.json({
    total: total?.count ?? 0,
    deleted: deleted?.count ?? 0,
    viewonce: viewonce?.count ?? 0,
    withMedia: withMedia?.count ?? 0,
  });
});

router.get("/captures/senders", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const rows = await db
    .select({
      senderJid: capturesTable.senderJid,
      senderName: sql<string | null>`max(${capturesTable.senderName})`,
      count: count(),
    })
    .from(capturesTable)
    .where(eq(capturesTable.tenantId, tenantId))
    .groupBy(capturesTable.senderJid)
    .orderBy(desc(count()));

  res.json(rows);
});

router.get("/captures/chats", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const rows = await db
    .select({
      chatJid: capturesTable.chatJid,
      chatName: sql<string | null>`max(${capturesTable.chatName})`,
      chatType: sql<string>`max(${capturesTable.chatType})`,
      count: count(),
    })
    .from(capturesTable)
    .where(eq(capturesTable.tenantId, tenantId))
    .groupBy(capturesTable.chatJid)
    .orderBy(desc(count()));

  res.json(rows);
});

router.get("/captures/:id/media", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [row] = await db
    .select()
    .from(capturesTable)
    .where(and(eq(capturesTable.id, id), eq(capturesTable.tenantId, tenantId)));
  if (!row?.mediaPath) {
    res.status(404).json({ error: "no media" });
    return;
  }
  const filePath = captureMediaPath(row.mediaPath);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: "media file missing" });
    return;
  }
  if (row.mediaMimetype) res.type(row.mediaMimetype);
  res.sendFile(filePath);
});

export default router;
