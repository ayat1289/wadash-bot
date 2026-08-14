import { Router, type IRouter } from "express";
import { db, autoReplyRulesTable } from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import {
  CreateAutoReplyRuleBody,
  UpdateAutoReplyRuleParams,
  UpdateAutoReplyRuleBody,
  DeleteAutoReplyRuleParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/auto-reply", async (req, res): Promise<void> => {
  const rules = await db
    .select()
    .from(autoReplyRulesTable)
    .where(eq(autoReplyRulesTable.tenantId, req.tenantId!))
    .orderBy(asc(autoReplyRulesTable.createdAt));
  res.json(rules);
});

router.post("/auto-reply", async (req, res): Promise<void> => {
  const parsed = CreateAutoReplyRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [rule] = await db
    .insert(autoReplyRulesTable)
    .values({
      tenantId: req.tenantId!,
      keyword: parsed.data.keyword,
      response: parsed.data.response,
      matchType: parsed.data.matchType ?? "contains",
      isActive: parsed.data.isActive ?? true,
      scope: parsed.data.scope ?? "all",
    })
    .returning();
  res.status(201).json(rule);
});

router.patch("/auto-reply/:id", async (req, res): Promise<void> => {
  const params = UpdateAutoReplyRuleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAutoReplyRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [rule] = await db
    .update(autoReplyRulesTable)
    .set(parsed.data)
    .where(and(eq(autoReplyRulesTable.tenantId, req.tenantId!), eq(autoReplyRulesTable.id, params.data.id)))
    .returning();
  if (!rule) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json(rule);
});

router.delete("/auto-reply/:id", async (req, res): Promise<void> => {
  const params = DeleteAutoReplyRuleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(autoReplyRulesTable)
    .where(and(eq(autoReplyRulesTable.tenantId, req.tenantId!), eq(autoReplyRulesTable.id, params.data.id)))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
