import type { WASocket, GroupMetadata } from "@whiskeysockets/baileys";
import { logger } from "./logger";

/**
 * Reduce a WhatsApp JID to its bare phone number, dropping the `:device`
 * suffix and `@server` host so linked-device variants compare equal
 * (e.g. `123:7@s.whatsapp.net` and `123@s.whatsapp.net` -> `123`).
 */
export function jidBase(jid: string | null | undefined): string {
  return (jid ?? "").split(":")[0].split("@")[0];
}

/** True when two JIDs refer to the same user (ignoring device/host suffixes). */
export function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = jidBase(a);
  const y = jidBase(b);
  return x !== "" && x === y;
}

/**
 * Find a group participant by JID in a way that is resilient to Baileys 7
 * identity variants (phone JID vs `@lid`). Matches the bare number against the
 * participant `id` and any alternate identity fields the metadata may expose.
 */
export function findParticipant<T extends { id: string }>(
  participants: T[],
  jid: string | null | undefined,
): T | undefined {
  const base = jidBase(jid);
  if (!base) return undefined;
  return participants.find((p) => {
    if (jidBase(p.id) === base) return true;
    const alt = p as unknown as Record<string, unknown>;
    for (const field of ["lid", "jid", "phoneNumber", "pn"]) {
      const v = alt[field];
      if (typeof v === "string" && jidBase(v) === base) return true;
    }
    return false;
  });
}

/**
 * True when a group participant matches a bare phone number across any of the
 * Baileys 7 identity fields it may expose (`id`, `lid`, `jid`, `phoneNumber`,
 * `pn`). Use for owner/bot checks that compare against a stored phone number:
 * a participant's `id` may be an `@lid` that won't equal that number directly.
 */
export function participantHasNumber<T extends { id: string }>(
  p: T | null | undefined,
  number: string | null | undefined,
): boolean {
  const base = jidBase(number);
  if (!p || !base) return false;
  if (jidBase(p.id) === base) return true;
  const alt = p as unknown as Record<string, unknown>;
  for (const field of ["lid", "jid", "phoneNumber", "pn"]) {
    const v = alt[field];
    if (typeof v === "string" && jidBase(v) === base) return true;
  }
  return false;
}

type Entry = { meta: GroupMetadata; at: number };

// Cache keyed by `${tenantId}|${jid}` so each tenant's socket has its own
// metadata view and tenants never read each other's cached groups.
const cache = new Map<string, Entry>();
const TTL_MS = 60_000;

function cacheKey(tenantId: number, jid: string): string {
  return `${tenantId}|${jid}`;
}

/**
 * Fetch group metadata with a short-lived in-memory cache so active groups
 * don't trigger a metadata request (and WhatsApp rate limits) on every message.
 * Serves stale data if a refresh fails. Scoped per tenant.
 */
export async function getGroupMetadataCached(
  sock: WASocket,
  tenantId: number,
  jid: string,
): Promise<GroupMetadata | null> {
  const now = Date.now();
  const key = cacheKey(tenantId, jid);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.meta;

  try {
    const meta = await sock.groupMetadata(jid);
    cache.set(key, { meta, at: now });
    return meta;
  } catch (err) {
    logger.warn({ err, tenantId, jid }, "Failed to fetch group metadata");
    return hit?.meta ?? null;
  }
}

export function invalidateGroupMetadata(tenantId: number, jid: string): void {
  cache.delete(cacheKey(tenantId, jid));
}
