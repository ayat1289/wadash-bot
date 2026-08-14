import { Router, type IRouter } from "express";
import { getBotState, connectWhatsApp, disconnectWhatsApp, requestPairingCode } from "../lib/whatsapp";

const router: IRouter = Router();

router.get("/whatsapp/status", async (req, res): Promise<void> => {
  const state = getBotState(req.tenantId!);
  res.json(state);
});

router.post("/whatsapp/connect", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  try {
    await connectWhatsApp(tenantId);
  } catch (err) {
    if (err instanceof Error && err.message === "CAPACITY") {
      res.status(503).json({ error: "The bot is at capacity right now. Please try again later." });
      return;
    }
    throw err;
  }
  const state = getBotState(tenantId);
  res.json(state);
});

router.post("/whatsapp/disconnect", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  await disconnectWhatsApp(tenantId);
  const state = getBotState(tenantId);
  res.json(state);
});

router.post("/whatsapp/pair", async (req, res): Promise<void> => {
  const tenantId = req.tenantId!;
  const { phoneNumber } = req.body as { phoneNumber?: string };
  if (!phoneNumber) {
    res.status(400).json({ error: "phoneNumber is required" });
    return;
  }
  try {
    const code = await requestPairingCode(phoneNumber, tenantId);
    res.json({ code });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "ALREADY_LINKED" || msg === "ALREADY_REGISTERED") {
      res.status(409).json({ error: "WhatsApp is already linked. Disconnect first, then pair again." });
    } else if (msg === "CAPACITY") {
      res.status(503).json({ error: "The bot is at capacity right now. Please try again later." });
    } else {
      res.status(500).json({ error: "Couldn't generate a pairing code. Please try again, or use the QR code." });
    }
  }
});

export default router;
