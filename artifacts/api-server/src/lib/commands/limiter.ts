/**
 * Lightweight in-memory guards for expensive commands (media downloads, audio
 * processing, AI/image generation). Protects the single bot process from abuse
 * AND keeps tenants from starving each other:
 *  - a per-user cooldown stops one chat from spamming heavy commands;
 *  - a per-tenant concurrency cap stops one tenant from hogging every slot;
 *  - a global concurrency cap stops everyone together from saturating CPU/bandwidth.
 *
 * Tune MAX_GLOBAL_CONCURRENT / MAX_TENANT_CONCURRENT for the host. With many
 * tenants the per-tenant cap is what guarantees fairness: a single busy tenant
 * can never consume more than MAX_TENANT_CONCURRENT slots, so other tenants'
 * commands still get through.
 */
const MAX_GLOBAL_CONCURRENT = 6;
const MAX_TENANT_CONCURRENT = 2;
const PER_USER_COOLDOWN_MS = 4000;
const PRUNE_THRESHOLD = 500;
const PRUNE_AGE_MS = 60_000;

let active = 0;
const perTenantActive = new Map<string, number>();
const lastStart = new Map<string, number>();

export type Acquire =
  | { ok: true; release: () => void }
  | { ok: false; reason: string };

/**
 * Heavy-command user keys are formatted `${tenantId}:${sender}`. The part before
 * the first colon is the tenant bucket used for the per-tenant fairness cap.
 */
function tenantBucket(userKey: string): string {
  const i = userKey.indexOf(":");
  return i === -1 ? userKey : userKey.slice(0, i);
}

/**
 * Try to reserve capacity for a heavy command. Pass `concurrency: true` for
 * CPU/bandwidth-heavy work (downloads, ffmpeg, image gen); leave it false for
 * lighter network calls (chat) that only need spam protection.
 * Always call `release()` (in a finally) on the `ok` path.
 */
export function tryAcquire(
  userKey: string,
  opts: { concurrency?: boolean; skipCooldown?: boolean } = {},
): Acquire {
  const now = Date.now();

  if (lastStart.size > PRUNE_THRESHOLD) {
    for (const [k, t] of lastStart) {
      if (now - t > PRUNE_AGE_MS) lastStart.delete(k);
    }
  }

  // `skipCooldown` is for a continuation of an already-rate-limited action (e.g.
  // the download triggered by replying to the interactive `.play` menu): the
  // cooldown was paid when the menu was issued, the pending choice is single-use,
  // so it can't be used to spam — but the concurrency caps below still apply.
  const prev = lastStart.get(userKey) ?? 0;
  if (!opts.skipCooldown && now - prev < PER_USER_COOLDOWN_MS) {
    return {
      ok: false,
      reason: "⏳ Please wait a few seconds before sending another command like this.",
    };
  }

  const tenant = tenantBucket(userKey);
  if (opts.concurrency) {
    if (active >= MAX_GLOBAL_CONCURRENT) {
      return {
        ok: false,
        reason: "⚠️ I'm busy processing requests right now — please try again in a moment.",
      };
    }
    if ((perTenantActive.get(tenant) ?? 0) >= MAX_TENANT_CONCURRENT) {
      return {
        ok: false,
        reason: "⏳ You already have a couple of heavy commands running — let those finish first.",
      };
    }
  }

  lastStart.set(userKey, now);
  if (opts.concurrency) {
    active++;
    perTenantActive.set(tenant, (perTenantActive.get(tenant) ?? 0) + 1);
  }

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      if (opts.concurrency) {
        active = Math.max(0, active - 1);
        const n = (perTenantActive.get(tenant) ?? 0) - 1;
        if (n <= 0) perTenantActive.delete(tenant);
        else perTenantActive.set(tenant, n);
      }
    },
  };
}
