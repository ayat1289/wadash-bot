import { Router, type IRouter } from "express";
import { db, messagesTable } from "@workspace/db";
import { eq, desc, count, and, sql } from "drizzle-orm";
import {
  ListMessagesQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/messages", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const parsed = ListMessagesQueryParams.safeParse(req.query);
  const type = parsed.success ? parsed.data.type : "all";
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const offset = parsed.success ? (parsed.data.offset ?? 0) : 0;

  const conditions = [eq(messagesTable.tenantId, tenantId)];
  if (type && type !== "all") {
    conditions.push(eq(messagesTable.type, type));
  }

  const messages = await db
    .select()
    .from(messagesTable)
    .where(and(...conditions))
    .orderBy(desc(messagesTable.createdAt))
    .limit(limit)
    .offset(offset);
  res.json(messages);
});

router.get("/messages/stats", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const tenant = eq(messagesTable.tenantId, tenantId);
  const [total] = await db.select({ count: count() }).from(messagesTable).where(tenant);
  const [dms] = await db
    .select({ count: count() })
    .from(messagesTable)
    .where(and(tenant, eq(messagesTable.type, "dm")));
  const [groups] = await db
    .select({ count: count() })
    .from(messagesTable)
    .where(and(tenant, eq(messagesTable.type, "group")));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [todayCount] = await db
    .select({ count: count() })
    .from(messagesTable)
    .where(and(tenant, sql`${messagesTable.createdAt} >= ${today}`));

  const activeChatsResult = await db
    .selectDistinct({ fromJid: messagesTable.fromJid })
    .from(messagesTable)
    .where(tenant);

  res.json({
    totalMessages: total?.count ?? 0,
    dmCount: dms?.count ?? 0,
    groupCount: groups?.count ?? 0,
    todayCount: todayCount?.count ?? 0,
    activeChats: activeChatsResult.length,
  });
});

export default router;
