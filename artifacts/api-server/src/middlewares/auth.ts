import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { getTenantForClerkUser } from "@workspace/db";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Clerk user id of the verified session (set by requireAuth). */
      clerkUserId?: string;
      /**
       * Tenant the caller controls, resolved server-side from the verified
       * Clerk session (set by requireTenant). NEVER taken from the client.
       */
      tenantId?: number;
    }
  }
}

/**
 * Reject requests without a verified Clerk session. On success, attaches the
 * Clerk user id to the request. Does NOT require the user to be linked to a
 * tenant — used for the link endpoints where the user has no tenant yet.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.clerkUserId = userId;
  next();
};

/**
 * Resolve the caller's tenant from the verified Clerk session and attach it to
 * the request. Must run after requireAuth. Returns 409 when the signed-in user
 * has not linked a WhatsApp tenant yet. The tenant id is the ONLY thing route
 * handlers may use to scope data — it is never read from params/body/query.
 */
export const requireTenant: RequestHandler = async (req, res, next) => {
  const userId = req.clerkUserId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const tenantId = await getTenantForClerkUser(userId);
    if (tenantId == null) {
      res.status(409).json({ error: "Not linked", code: "not_linked" });
      return;
    }
    req.tenantId = tenantId;
    next();
  } catch (err) {
    req.log.error({ err }, "Failed to resolve tenant for user");
    res.status(500).json({ error: "Internal error" });
  }
};
