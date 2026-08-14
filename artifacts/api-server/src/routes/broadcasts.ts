import { Router, type IRouter } from "express";
import { db, broadcastsTable, activityLogTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  CreateBroadcastBody,
  GetBroadcastParams,
} from "@workspace/api-zod";
import { sendBroadcastMessage } from "../lib/whatsapp";

const router: IRouter = Router();

router.get("/broadcasts", async (req, res): Promise<void> => {
  const broadcasts = await db
    .select()
    .from(broadcastsTable)
    .where(eq(broadcastsTable.tenantId, req.tenantId!))
    .orderBy(desc(broadcastsTable.createdAt));
  res.json(broadcasts);
});

router.post("/broadcasts", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const parsed = CreateBroadcastBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [broadcast] = await db
    .insert(broadcastsTable)
    .values({
      tenantId,
      message: parsed.data.message,
      recipients: parsed.data.recipients,
      status: "sending",
    })
    .returning();

  // Fire-and-forget send — scoped to the requesting tenant's WhatsApp session.
  sendBroadcastMessage(parsed.data.recipients, parsed.data.message, tenantId)
    .then(async ({ sentCount, failCount }) => {
      await db
        .update(broadcastsTable)
        .set({ status: failCount === parsed.data.recipients.length ? "failed" : "done", sentCount, failCount })
        .where(and(eq(broadcastsTable.tenantId, tenantId), eq(broadcastsTable.id, broadcast.id)));
      await db.insert(activityLogTable).values({
        tenantId,
        type: "broadcast",
        description: `Broadcast sent to ${sentCount} recipients (${failCount} failed)`,
      });
    })
    .catch((err) => {
      req.log?.error({ err }, "Broadcast send failed");
    });

  res.status(201).json(broadcast);
});

router.get("/broadcasts/:id", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const params = GetBroadcastParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [broadcast] = await db
    .select()
    .from(broadcastsTable)
    .where(and(eq(broadcastsTable.tenantId, tenantId), eq(broadcastsTable.id, params.data.id)));
  if (!broadcast) {
    res.status(404).json({ error: "Broadcast not found" });
    return;
  }
  res.json(broadcast);
});

export default router;
