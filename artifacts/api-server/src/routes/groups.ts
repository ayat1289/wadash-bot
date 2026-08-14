import { Router, type IRouter } from "express";
import { db, groupsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/groups", async (req, res): Promise<void> => {
  const groups = await db
    .select()
    .from(groupsTable)
    .where(eq(groupsTable.tenantId, req.tenantId!))
    .orderBy(asc(groupsTable.name));
  res.json(groups);
});

export default router;
