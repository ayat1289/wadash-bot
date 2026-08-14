import { Router, type IRouter } from "express";
import healthRouter from "./health";
import linkRouter from "./link";
import whatsappRouter from "./whatsapp";
import messagesRouter from "./messages";
import contactsRouter from "./contacts";
import groupsRouter from "./groups";
import autoReplyRouter from "./auto-reply";
import broadcastsRouter from "./broadcasts";
import scheduledStatusesRouter from "./scheduled-statuses";
import groupSettingsRouter from "./group-settings";
import statsRouter from "./stats";
import { requireAuth, requireTenant } from "../middlewares/auth";
import capturesRouter from "./captures";

const router: IRouter = Router();

// Public — no auth.
router.use(healthRouter);

// Authenticated, but link to a tenant NOT required (link management itself).
router.use(linkRouter);

// Central authorization boundary: everything below requires a verified Clerk
// session AND a linked tenant. The tenant is resolved from the session and
// attached to req.tenantId — route handlers must scope all data by it and must
// never read a tenant id from the client.
router.use(requireAuth, requireTenant);

router.use(whatsappRouter);
router.use(messagesRouter);
router.use(contactsRouter);
router.use(groupsRouter);
router.use(autoReplyRouter);
router.use(broadcastsRouter);
router.use(scheduledStatusesRouter);
router.use(groupSettingsRouter);
router.use(statsRouter);
router.use(capturesRouter);

export default router;
