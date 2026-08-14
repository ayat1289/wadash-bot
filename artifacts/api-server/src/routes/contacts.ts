import { Router, type IRouter } from "express";
import { db, contactsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/contacts", async (req, res): Promise<void> => {
  const contacts = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.tenantId, req.tenantId!))
    .orderBy(asc(contactsTable.name));
  res.json(contacts);
});

export default router;
