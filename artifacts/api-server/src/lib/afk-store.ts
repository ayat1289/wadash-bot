import { jidBase } from "./group-meta";

// In-memory AFK ("away from keyboard") state, mirroring the other in-memory
// stores (pending-downloads / pending-games): lost on restart, bounded in size.
// Keyed by tenant + the base of the user's JID so auto-clear (the user sending
// any message again) always matches the JID we stored.

export interface AfkEntry {
  reason: string;
  since: number;
}

const MAX_ENTRIES = 2000;
const store = new Map<string, AfkEntry>();

function key(tenantId: number, jid: string): string {
  return `${tenantId}:${jidBase(jid)}`;
}

export function setAfk(tenantId: number, jid: string, reason: string): void {
  const k = key(tenantId, jid);
  store.delete(k);
  store.set(k, { reason, since: Date.now() });
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

export function getAfk(tenantId: number, jid: string): AfkEntry | null {
  return store.get(key(tenantId, jid)) ?? null;
}

export function clearAfk(tenantId: number, jid: string): AfkEntry | null {
  const k = key(tenantId, jid);
  const entry = store.get(k) ?? null;
  if (entry) store.delete(k);
  return entry;
}

// Per (tenant, chat, away-user) throttle for "this user is AFK" notices so a
// member can't make the bot spam by repeatedly tagging an away user.
const ANNOUNCE_COOLDOWN_MS = 60_000;
const announceAt = new Map<string, number>();

export function canAnnounceAfk(tenantId: number, chat: string, jid: string): boolean {
  const k = `${tenantId}:${chat}:${jidBase(jid)}`;
  const now = Date.now();
  const last = announceAt.get(k);
  if (last !== undefined && now - last < ANNOUNCE_COOLDOWN_MS) return false;
  announceAt.delete(k);
  announceAt.set(k, now);
  if (announceAt.size > MAX_ENTRIES) {
    const oldest = announceAt.keys().next().value;
    if (oldest !== undefined) announceAt.delete(oldest);
  }
  return true;
}
