import { randomInt } from "node:crypto";

/**
 * In-memory store for member verification. Keys are `${tenantId}:${groupJid}:${senderNumber}`.
 * Lost on restart (like pending-downloads). Bounded to avoid unbounded growth.
 */
const pending = new Map<string, { code: string; expiresAt: number }>();
const MAX = 5000;

async function setPendingVerify(
  key: string,
  ttlMs = 2 * 60_000,
): Promise<string> {
  const code = String(randomInt(100000, 1000000));
  pending.delete(key);
  pending.set(key, { code, expiresAt: Date.now() + ttlMs });
  if (pending.size > MAX) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  return code;
}

function checkPendingVerify(key: string): string | null {
  const p = pending.get(key);
  if (!p) return null;
  if (p.expiresAt < Date.now()) {
    pending.delete(key);
    return null;
  }
  return p.code;
}

function clearPendingVerify(key: string): void {
  pending.delete(key);
}

export { setPendingVerify, checkPendingVerify, clearPendingVerify };