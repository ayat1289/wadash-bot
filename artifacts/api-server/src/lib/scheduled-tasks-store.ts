import { db, scheduledTasksTable, type ScheduledTask } from "@workspace/db";
import { and, asc, eq, lte } from "drizzle-orm";

export type TaskKind = "reminder" | "group_open" | "group_close";

export async function createScheduledTask(input: {
  tenantId: number;
  kind: TaskKind;
  targetJid: string;
  body?: string;
  dueAt: Date;
}): Promise<number> {
  const [row] = await db
    .insert(scheduledTasksTable)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      targetJid: input.targetJid,
      body: input.body ?? null,
      dueAt: input.dueAt,
    })
    .returning({ id: scheduledTasksTable.id });
  return row.id;
}

export async function listDueTasks(now: Date): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasksTable)
    .where(and(eq(scheduledTasksTable.status, "pending"), lte(scheduledTasksTable.dueAt, now)))
    .orderBy(asc(scheduledTasksTable.dueAt));
}

export async function markTaskStatus(id: number, status: "done" | "failed"): Promise<void> {
  await db.update(scheduledTasksTable).set({ status, updatedAt: new Date() }).where(eq(scheduledTasksTable.id, id));
}

export async function listPendingReminders(tenantId: number, targetJid: string): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasksTable)
    .where(
      and(
        eq(scheduledTasksTable.tenantId, tenantId),
        eq(scheduledTasksTable.targetJid, targetJid),
        eq(scheduledTasksTable.kind, "reminder"),
        eq(scheduledTasksTable.status, "pending"),
      ),
    )
    .orderBy(asc(scheduledTasksTable.dueAt));
}

// Cancel a pending reminder. Scoped to tenant + chat (targetJid) + kind so a
// user can only cancel reminders in the chat they issued the command from — a
// guessed numeric id can't cancel another chat's reminders or a scheduled
// group open/close task.
export async function cancelReminder(tenantId: number, targetJid: string, id: number): Promise<boolean> {
  const rows = await db
    .update(scheduledTasksTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(scheduledTasksTable.id, id),
        eq(scheduledTasksTable.tenantId, tenantId),
        eq(scheduledTasksTable.targetJid, targetJid),
        eq(scheduledTasksTable.kind, "reminder"),
        eq(scheduledTasksTable.status, "pending"),
      ),
    )
    .returning({ id: scheduledTasksTable.id });
  return rows.length > 0;
}
