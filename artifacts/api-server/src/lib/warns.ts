import { db, warnsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

// Group "warn" counters, persisted per tenant + group + member. Admin-triggered
// and low-concurrency, so the increment is a read-then-write rather than an
// atomic upsert; that is acceptable for this use.

export async function addWarn(
  tenantId: number,
  groupJid: string,
  userJid: string,
  reason?: string,
): Promise<number> {
  const [existing] = await db
    .select()
    .from(warnsTable)
    .where(and(eq(warnsTable.tenantId, tenantId), eq(warnsTable.groupJid, groupJid), eq(warnsTable.userJid, userJid)))
    .limit(1);

  if (existing) {
    const next = existing.count + 1;
    await db
      .update(warnsTable)
      .set({ count: next, reason: reason ?? existing.reason, updatedAt: new Date() })
      .where(eq(warnsTable.id, existing.id));
    return next;
  }

  await db.insert(warnsTable).values({ tenantId, groupJid, userJid, count: 1, reason });
  return 1;
}

export async function getWarnCount(tenantId: number, groupJid: string, userJid: string): Promise<number> {
  const [row] = await db
    .select()
    .from(warnsTable)
    .where(and(eq(warnsTable.tenantId, tenantId), eq(warnsTable.groupJid, groupJid), eq(warnsTable.userJid, userJid)))
    .limit(1);
  return row?.count ?? 0;
}

export async function resetWarns(tenantId: number, groupJid: string, userJid: string): Promise<void> {
  await db
    .delete(warnsTable)
    .where(and(eq(warnsTable.tenantId, tenantId), eq(warnsTable.groupJid, groupJid), eq(warnsTable.userJid, userJid)));
}
