import { Router, type IRouter } from "express";
import { db, messagesTable, autoReplyRulesTable, scheduledStatusesTable, broadcastsTable, groupSettingsTable, contactsTable, activityLogTable } from "@workspace/db";
import { eq, count, desc, and } from "drizzle-orm";
import { getBotState } from "../lib/whatsapp";

const router: IRouter = Router();

router.get("/stats", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const [totalMsg] = await db
    .select({ count: count() })
    .from(messagesTable)
    .where(eq(messagesTable.tenantId, tenantId));
  const [activeRules] = await db
    .select({ count: count() })
    .from(autoReplyRulesTable)
    .where(and(eq(autoReplyRulesTable.tenantId, tenantId), eq(autoReplyRulesTable.isActive, true)));
  const [scheduledStatuses] = await db
    .select({ count: count() })
    .from(scheduledStatusesTable)
    .where(and(eq(scheduledStatusesTable.tenantId, tenantId), eq(scheduledStatusesTable.status, "pending")));
  const [broadcastsSent] = await db
    .select({ count: count() })
    .from(broadcastsTable)
    .where(and(eq(broadcastsTable.tenantId, tenantId), eq(broadcastsTable.status, "done")));
  const [groupsManaged] = await db
    .select({ count: count() })
    .from(groupSettingsTable)
    .where(eq(groupSettingsTable.tenantId, tenantId));
  const [contactsCount] = await db
    .select({ count: count() })
    .from(contactsTable)
    .where(eq(contactsTable.tenantId, tenantId));

  const recentActivity = await db
    .select()
    .from(activityLogTable)
    .where(eq(activityLogTable.tenantId, tenantId))
    .orderBy(desc(activityLogTable.timestamp))
    .limit(10);

  const bot = getBotState(tenantId);

  res.json({
    totalMessages: totalMsg?.count ?? 0,
    activeRules: activeRules?.count ?? 0,
    scheduledStatuses: scheduledStatuses?.count ?? 0,
    broadcastsSent: broadcastsSent?.count ?? 0,
    groupsManaged: groupsManaged?.count ?? 0,
    contactsCount: contactsCount?.count ?? 0,
    connectionState: bot.state,
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      type: a.type,
      description: a.description,
      timestamp: a.timestamp.toISOString(),
    })),
  });
});

export default router;
