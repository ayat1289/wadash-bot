import { Router, type IRouter } from "express";
import { getTenantForClerkUser, consumeLinkCode, unlinkClerkUser } from "@workspace/db";
import { LinkAccountBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Report whether the signed-in account is linked to a WhatsApp tenant. Requires
// a verified session but NOT an existing link.
router.get("/link", requireAuth, async (req, res): Promise<void> => {
  const tenantId = await getTenantForClerkUser(req.clerkUserId!);
  res.json({ linked: tenantId != null });
});

// Redeem a one-time code (issued over Telegram) to link this account to the
// tenant that owns the code. The tenant is derived entirely from the code +
// verified session — never from the client.
router.post("/link", requireAuth, async (req, res): Promise<void> => {
  const parsed = LinkAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await consumeLinkCode(parsed.data.code, req.clerkUserId!);
  if (!result.ok) {
    if (result.reason === "already_linked") {
      res.status(409).json({
        error: "This account is already linked to a different WhatsApp. Unlink it first.",
        code: "already_linked",
      });
      return;
    }
    res.status(400).json({ error: "Invalid or expired code.", code: "invalid_code" });
    return;
  }
  res.json({ linked: true });
});

// Revoke this account's dashboard link. Does NOT disconnect the WhatsApp
// session — Telegram remains the operational control plane for the bot.
router.delete("/link", requireAuth, async (req, res): Promise<void> => {
  await unlinkClerkUser(req.clerkUserId!);
  res.json({ linked: false });
});

export default router;
