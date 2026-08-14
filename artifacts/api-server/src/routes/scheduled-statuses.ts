import { Router, type IRouter } from "express";
import { db, scheduledStatusesTable, activityLogTable } from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import {
  CreateScheduledStatusBody,
  UpdateScheduledStatusParams,
  UpdateScheduledStatusBody,
  DeleteScheduledStatusParams,
  SendScheduledStatusNowParams,
} from "@workspace/api-zod";
import { postStatus } from "../lib/whatsapp";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/scheduled-statuses", async (req, res): Promise<void> => {
  const statuses = await db
    .select()
    .from(scheduledStatusesTable)
    .where(eq(scheduledStatusesTable.tenantId, req.tenantId!))
    .orderBy(asc(scheduledStatusesTable.scheduledAt));
  res.json(statuses);
});

router.post("/scheduled-statuses", async (req, res): Promise<void> => {
  const parsed = CreateScheduledStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [status] = await db
    .insert(scheduledStatusesTable)
    .values({
      tenantId: req.tenantId!,
      text: parsed.data.text,
      mediaUrl: parsed.data.mediaUrl ?? null,
      scheduledAt: new Date(parsed.data.scheduledAt),
    })
    .returning();
  res.status(201).json(status);
});

router.patch("/scheduled-statuses/:id", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const params = UpdateScheduledStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateScheduledStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.scheduledAt) {
    updateData.scheduledAt = new Date(parsed.data.scheduledAt);
  }
  const [updated] = await db
    .update(scheduledStatusesTable)
    .set(updateData)
    .where(and(eq(scheduledStatusesTable.tenantId, tenantId), eq(scheduledStatusesTable.id, params.data.id)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Scheduled status not found" });
    return;
  }
  res.json(updated);
});

router.delete("/scheduled-statuses/:id", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const params = DeleteScheduledStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(scheduledStatusesTable)
    .where(and(eq(scheduledStatusesTable.tenantId, tenantId), eq(scheduledStatusesTable.id, params.data.id)))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Scheduled status not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/scheduled-statuses/:id/send", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const params = SendScheduledStatusNowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [statusItem] = await db
    .select()
    .from(scheduledStatusesTable)
    .where(and(eq(scheduledStatusesTable.tenantId, tenantId), eq(scheduledStatusesTable.id, params.data.id)));
  if (!statusItem) {
    res.status(404).json({ error: "Scheduled status not found" });
    return;
  }
  const success = await postStatus(statusItem.text, tenantId);
  const newStatus = success ? "sent" : "failed";
  const [updated] = await db
    .update(scheduledStatusesTable)
    .set({ status: newStatus })
    .where(and(eq(scheduledStatusesTable.tenantId, tenantId), eq(scheduledStatusesTable.id, params.data.id)))
    .returning();
  if (success) {
    await db.insert(activityLogTable).values({
      tenantId,
      type: "status_posted",
      description: `Status posted: "${statusItem.text.slice(0, 50)}"`,
    });
  }
  res.json(updated);
});

// Background scheduler — runs every minute across ALL tenants, posting each
// pending status to the WhatsApp session of the tenant that owns it.
export function startStatusScheduler(): void {
  setInterval(async () => {
    try {
      const now = new Date();
      const pending = await db
        .select()
        .from(scheduledStatusesTable)
        .where(eq(scheduledStatusesTable.status, "pending"));

      for (const item of pending) {
        if (new Date(item.scheduledAt) <= now) {
          const success = await postStatus(item.text, item.tenantId);
          await db
            .update(scheduledStatusesTable)
            .set({ status: success ? "sent" : "failed" })
            .where(and(eq(scheduledStatusesTable.tenantId, item.tenantId), eq(scheduledStatusesTable.id, item.id)));
          if (success) {
            await db.insert(activityLogTable).values({
              tenantId: item.tenantId,
              type: "status_posted",
              description: `Scheduled status posted: "${item.text.slice(0, 50)}"`,
            });
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Status scheduler error");
    }
  }, 60_000);
}

export default router;
