---
name: Dashboard per-user tenant isolation
description: The security invariant that scopes the WhatsApp dashboard to one tenant per Clerk user, and how a user gets linked.
---

The dashboard is multi-tenant and each Clerk user sees exactly one tenant's data.

**Invariant (do not break):** the tenant id is ALWAYS resolved server-side from the verified Clerk session (`requireAuth` → `req.clerkUserId` → `user_links` → `req.tenantId` via `requireTenant`). It is NEVER read from the client — no route may read a tenant id from `req.body/query/params`. Every data query scopes by `req.tenantId`, and path-id update/delete must filter by BOTH `tenantId` AND the row id/groupJid.

**Why:** the only thing standing between two paying users is server-derived tenant scoping. If any handler trusted a client-supplied tenant id, one user could read/modify another's WhatsApp data. There is deliberately no tenant id anywhere in the client API surface, which makes cross-tenant "ID tampering" structurally impossible.

**Linking flow:** Telegram `/link` issues a one-time code (random, 8 chars, ~10 min, **sha256-hashed** in `link_codes` — raw code never stored or logged). The signed-in user pastes it; `consumeLinkCode` redeems it in one `SELECT ... FOR UPDATE` transaction that burns the code only on commit. Relink policy: same-tenant = idempotent; user already linked to a *different* tenant = rejected (must unlink first, code left unused); tenant already linked to another user = replaced (Telegram possession is the authority).

**How to apply:** when adding any new dashboard data route, mount it behind the `requireAuth, requireTenant` boundary in `routes/index.ts` and scope all queries by `req.tenantId`. The `/link` router is the one exception — it sits behind `requireAuth` only (tenant not yet known).
