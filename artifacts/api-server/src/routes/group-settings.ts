import { Router, type IRouter } from "express";
import { db, groupSettingsTable } from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import {
  GetGroupSettingsParams,
  UpdateGroupSettingsParams,
  UpdateGroupSettingsBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/group-settings", async (req, res): Promise<void> => {
  const settings = await db
    .select()
    .from(groupSettingsTable)
    .where(eq(groupSettingsTable.tenantId, req.tenantId!))
    .orderBy(asc(groupSettingsTable.groupName));
  res.json(settings);
});

router.get("/group-settings/:groupId", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const params = GetGroupSettingsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [settings] = await db
    .select()
    .from(groupSettingsTable)
    .where(and(eq(groupSettingsTable.tenantId, tenantId), eq(groupSettingsTable.groupJid, params.data.groupId)));
  if (!settings) {
    res.status(404).json({ error: "Group settings not found" });
    return;
  }
  res.json(settings);
});

router.patch("/group-settings/:groupId", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const params = UpdateGroupSettingsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateGroupSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Upsert: if no settings exist yet, create with defaults then update
  const [existing] = await db
    .select()
    .from(groupSettingsTable)
    .where(and(eq(groupSettingsTable.tenantId, tenantId), eq(groupSettingsTable.groupJid, params.data.groupId)));

  if (!existing) {
    const [created] = await db
      .insert(groupSettingsTable)
      .values({
        tenantId,
        groupJid: params.data.groupId,
        groupName: params.data.groupId,
        ...parsed.data,
      })
      .returning();
    res.json(created);
    return;
  }

  const [updated] = await db
    .update(groupSettingsTable)
    .set(parsed.data)
    .where(and(eq(groupSettingsTable.tenantId, tenantId), eq(groupSettingsTable.groupJid, params.data.groupId)))
    .returning();
  res.json(updated);
});

export default router;
