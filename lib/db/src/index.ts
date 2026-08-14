import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq, and, isNull, gt } from "drizzle-orm";
import { createHash, randomInt } from "node:crypto";
import pg from "pg";
import * as schema from "./schema";
import {
  LEGACY_TENANT_ID,
  tenantsTable,
  userLinksTable,
  linkCodesTable,
  type Tenant,
} from "./schema";

const { Pool, Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * Guarantees the legacy tenant (id = {@link LEGACY_TENANT_ID}) exists so that
 * the pre-multi-tenant data and any not-yet-migrated code paths always have a
 * valid tenant to attach rows to. Idempotent — safe to call on every boot and
 * on a freshly-pushed database.
 */
export async function ensureLegacyTenant(): Promise<void> {
  await db.execute(sql`
    INSERT INTO tenants (id, telegram_chat_id, status)
    VALUES (${LEGACY_TENANT_ID}, 'legacy', 'active')
    ON CONFLICT (id) DO NOTHING
  `);
  // Keep the serial sequence ahead of any explicitly-inserted ids so the next
  // real tenant doesn't collide with the legacy row.
  await db.execute(sql`
    SELECT setval(pg_get_serial_sequence('tenants', 'id'), GREATEST((SELECT MAX(id) FROM tenants), 1))
  `);
}

/**
 * Find the tenant bound to a Telegram chat id, creating it on first contact.
 * New tenants start `disconnected` (no WhatsApp paired yet). The unique
 * constraint on `telegram_chat_id` plus `onConflictDoNothing` makes this safe
 * against concurrent first messages from the same chat.
 */
export async function getOrCreateTenantByTelegramChat(chatId: string): Promise<Tenant> {
  const existing = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.telegramChatId, chatId))
    .limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(tenantsTable)
    .values({ telegramChatId: chatId, status: "disconnected" })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const again = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.telegramChatId, chatId))
    .limit(1);
  if (again[0]) return again[0];
  throw new Error(`Failed to get or create tenant for telegram chat ${chatId}`);
}

/**
 * List every currently-active tenant together with the Telegram chat id that
 * owns it. Used by the Telegram force-join sweep to verify each paired user is
 * still a member of the required channel.
 */
export async function listActiveTenantTelegramChats(): Promise<
  { id: number; telegramChatId: string }[]
> {
  return db
    .select({ id: tenantsTable.id, telegramChatId: tenantsTable.telegramChatId })
    .from(tenantsTable)
    .where(eq(tenantsTable.status, "active"));
}

// ---------------------------------------------------------------------------
// Dashboard account linking (Clerk user <-> tenant)
// ---------------------------------------------------------------------------

// Unambiguous alphabet (no 0/O/1/I) so the code is easy to read/type.
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_CODE_LENGTH = 8;
const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateRawLinkCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) {
    out += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  }
  return out;
}

/** Canonicalise user input so display formatting (dashes/spaces/case) doesn't matter. */
function normalizeLinkCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashLinkCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Generate a one-time, short-lived link code bound to a tenant. Only the
 * sha256 hash is stored; the raw code is returned once to be relayed to the
 * user (over Telegram). Codes expire in {@link LINK_CODE_TTL_MS}.
 */
export async function createLinkCode(
  tenantId: number,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateRawLinkCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await db.insert(linkCodesTable).values({
    tenantId,
    codeHash: hashLinkCode(code),
    expiresAt,
  });
  return { code, expiresAt };
}

export type ConsumeLinkResult =
  | { ok: true; tenantId: number }
  | { ok: false; reason: "invalid" | "already_linked" };

/**
 * Redeem a link code for the given Clerk user, atomically. The code row is
 * locked FOR UPDATE and only marked used once we commit to linking, so a
 * code can never be redeemed twice and a rejected attempt (user already linked
 * to a different tenant) does not burn the code.
 *
 * Relink policy:
 *  - user already linked to THIS tenant  -> idempotent success
 *  - user already linked to ANOTHER tenant -> rejected ("already_linked"); they
 *    must unlink first (the code is left unused)
 *  - tenant already linked to ANOTHER user -> replaced (Telegram possession is
 *    the tenant authority)
 */
export async function consumeLinkCode(
  rawCode: string,
  clerkUserId: string,
): Promise<ConsumeLinkResult> {
  const hash = hashLinkCode(normalizeLinkCode(rawCode));
  return await db.transaction(async (tx) => {
    const codeRows = await tx
      .select({ id: linkCodesTable.id, tenantId: linkCodesTable.tenantId })
      .from(linkCodesTable)
      .where(
        and(
          eq(linkCodesTable.codeHash, hash),
          isNull(linkCodesTable.usedAt),
          gt(linkCodesTable.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for("update");
    const codeRow = codeRows[0];
    if (!codeRow) return { ok: false, reason: "invalid" };
    const tenantId = codeRow.tenantId;

    const existing = await tx
      .select({ tenantId: userLinksTable.tenantId })
      .from(userLinksTable)
      .where(eq(userLinksTable.clerkUserId, clerkUserId))
      .limit(1);
    const current = existing[0];

    // Linked to a different tenant already -> do NOT consume the code.
    if (current && current.tenantId !== tenantId) {
      return { ok: false, reason: "already_linked" };
    }

    // Committed to linking — burn the code.
    await tx
      .update(linkCodesTable)
      .set({ usedAt: new Date() })
      .where(eq(linkCodesTable.id, codeRow.id));

    if (current && current.tenantId === tenantId) {
      return { ok: true, tenantId }; // idempotent relink
    }

    // Replace any prior dashboard link to this tenant, then map it to the user.
    await tx.delete(userLinksTable).where(eq(userLinksTable.tenantId, tenantId));
    await tx.insert(userLinksTable).values({ clerkUserId, tenantId });
    return { ok: true, tenantId };
  });
}

/** Resolve the tenant a Clerk user controls, or null if they haven't linked. */
export async function getTenantForClerkUser(
  clerkUserId: string,
): Promise<number | null> {
  const rows = await db
    .select({ tenantId: userLinksTable.tenantId })
    .from(userLinksTable)
    .where(eq(userLinksTable.clerkUserId, clerkUserId))
    .limit(1);
  return rows[0]?.tenantId ?? null;
}

/** Remove a Clerk user's dashboard link. Returns true if a link was removed. */
export async function unlinkClerkUser(clerkUserId: string): Promise<boolean> {
  const deleted = await db
    .delete(userLinksTable)
    .where(eq(userLinksTable.clerkUserId, clerkUserId))
    .returning({ id: userLinksTable.id });
  return deleted.length > 0;
}

/**
 * A held Postgres SESSION-level advisory lock living on a dedicated connection.
 * If the process dies, the connection drops and Postgres releases the lock
 * automatically, so a crashed holder is replaced without manual cleanup.
 */
export interface AdvisoryLock {
  /**
   * Resolves if the lock is lost because its dedicated connection errored or
   * closed. Callers MUST stop the guarded work when this settles.
   */
  readonly lost: Promise<void>;
  /** Release the lock and close the dedicated connection. Idempotent. */
  release(): Promise<void>;
}

/**
 * Acquire a session-level advisory lock on a DEDICATED connection, retrying
 * every `retryMs` until it is held; resolves only once this process owns it.
 * Used to elect a single active worker across instances sharing this database
 * (e.g. the single Telegram long-poller) — only one connection can hold a given
 * key at a time. The returned handle exposes `lost` (so the caller can pause
 * work if the connection drops) and `release()`.
 */
export async function acquireAdvisoryLock(
  key: number,
  retryMs: number,
): Promise<AdvisoryLock> {
  for (;;) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    let resolveLost!: () => void;
    const lost = new Promise<void>((resolve) => {
      resolveLost = resolve;
    });
    try {
      await client.connect();
      // Any later disconnect means the lock is gone (Postgres releases session
      // locks on disconnect) — signal the caller to stop the guarded work.
      client.on("error", () => resolveLost());
      client.on("end", () => resolveLost());
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [key],
      );
      if (res.rows[0]?.locked) {
        let released = false;
        return {
          lost,
          async release() {
            if (released) return;
            released = true;
            try {
              await client.query("SELECT pg_advisory_unlock($1)", [key]);
            } catch {
              /* connection may already be gone */
            }
            try {
              await client.end();
            } catch {
              /* ignore */
            }
          },
        };
      }
      // Lock is held elsewhere — drop this connection and wait before retrying.
      await client.end().catch(() => undefined);
    } catch {
      await client.end().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

export * from "./schema";
