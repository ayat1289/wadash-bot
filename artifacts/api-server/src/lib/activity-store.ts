import { jidBase } from "./group-meta";

// In-memory group activity counters (tenant + group + day + user → message count).
// Bounded, lost on restart. Used by .activemembers / .activetoday.

const store = new Map<string, number>();
const MAX = 5000;

export function recordActivity(tenantId: number, groupJid: string, userJid: string): void {
  const day = new Date().toISOString().slice(0, 10);
  const k = `${tenantId}:${jidBase(groupJid)}:${day}:${jidBase(userJid)}`;
  const n = (store.get(k) ?? 0) + 1;
  store.set(k, n);
  if (store.size > MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

/** { jidBase: count } for a group, optionally restricted to today. */
export function groupActivity(tenantId: number, groupJid: string, todayOnly: boolean): Map<string, number> {
  const g = `${tenantId}:${jidBase(groupJid)}:`;
  const day = new Date().toISOString().slice(0, 10);
  const out = new Map<string, number>();
  for (const [k, v] of store) {
    if (!k.startsWith(g)) continue;
    if (todayOnly && !k.includes(`:${day}:`)) continue;
    const user = k.slice(g.length).split(":")[1];
    out.set(user, (out.get(user) ?? 0) + v);
  }
  return out;
}
