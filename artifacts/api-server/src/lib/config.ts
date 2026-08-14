import { db, botConfigTable, contactsTable, LEGACY_TENANT_ID } from "@workspace/db";
import { and, eq, or } from "drizzle-orm";

export type BotConfigData = {
  prefix: string;
  botName: string;
  ownerName: string;
  ownerNumber: string;
  mode: "public" | "private";
  menuImage: string;
  packname: string;
  author: string;
} & Record<string, string>;

const DEFAULTS: BotConfigData = {
  prefix: ".",
  botName: "Heer MD Bot",
  ownerName: "Heer MD Bot",
  ownerNumber: "",
  mode: "public",
  menuImage: "",
  packname: "Heer MD Bot",
  author: "Heer MD Bot",
  // Owner-protection features default ON; toggle off with `.antidelete off` /
  // `.antiviewonce off` / `.antibug off` (writes "false" to bot_config, which
  // overrides these).
  antidelete: "true",
  antiviewonce: "true",
  antibug: "true",
};

// Per-tenant config cache. Each tenant has its own key/value map; callers that
// don't yet have a tenant in scope operate on the legacy tenant.
const cache = new Map<number, Record<string, string>>();

export async function loadConfig(tenantId: number = LEGACY_TENANT_ID): Promise<BotConfigData> {
  let entry = cache.get(tenantId);
  if (!entry) {
    const rows = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.tenantId, tenantId));
    entry = {};
    for (const r of rows) entry[r.key] = r.value;
    cache.set(tenantId, entry);
  }
  return { ...DEFAULTS, ...entry } as BotConfigData;
}

export async function getConfig(key: string, tenantId: number = LEGACY_TENANT_ID): Promise<string> {
  const cfg = await loadConfig(tenantId);
  return cfg[key] ?? "";
}

export async function setConfig(key: string, value: string, tenantId: number = LEGACY_TENANT_ID): Promise<void> {
  await db
    .insert(botConfigTable)
    .values({ tenantId, key, value })
    .onConflictDoUpdate({ target: [botConfigTable.tenantId, botConfigTable.key], set: { value } });
  let entry = cache.get(tenantId);
  if (!entry) {
    entry = {};
    cache.set(tenantId, entry);
  }
  entry[key] = value;
}

export async function getBool(key: string, tenantId: number = LEGACY_TENANT_ID): Promise<boolean> {
  const v = await getConfig(key, tenantId);
  return v === "true" || v === "on" || v === "1";
}

export function invalidateConfigCache(tenantId?: number): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}

// --- Sudo users -----------------------------------------------------------
// When the bot is in private mode, only the owner can use commands. Numbers in
// the per-tenant "sudo" list are also allowed. Stored as a comma-separated
// string of digits-only numbers (same format as `jidBase(sender)`).
const SUDO_KEY = "sudo";

/** Parse a raw comma-separated sudo string into normalized digits-only numbers. */
export function parseSudo(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.replace(/[^0-9]/g, ""))
    .filter(Boolean);
}

export async function getSudoNumbers(tenantId: number = LEGACY_TENANT_ID): Promise<string[]> {
  return parseSudo(await getConfig(SUDO_KEY, tenantId));
}

/** Add a number to the sudo list. Returns false if it was already present/invalid. */
export async function addSudoNumber(
  num: string,
  tenantId: number = LEGACY_TENANT_ID,
): Promise<boolean> {
  const clean = num.replace(/[^0-9]/g, "");
  if (!clean) return false;
  const list = await getSudoNumbers(tenantId);
  if (list.includes(clean)) return false;
  list.push(clean);
  await setConfig(SUDO_KEY, list.join(","), tenantId);
  return true;
}

/** Remove a number from the sudo list. Returns false if it wasn't present. */
export async function removeSudoNumber(
  num: string,
  tenantId: number = LEGACY_TENANT_ID,
): Promise<boolean> {
  const clean = num.replace(/[^0-9]/g, "");
  const list = await getSudoNumbers(tenantId);
  if (!list.includes(clean)) return false;
  await setConfig(SUDO_KEY, list.filter((n) => n !== clean).join(","), tenantId);
  return true;
}

/**
 * Resolve every known bare-number identity for a sender JID within a tenant.
 * Baileys 7 exposes users as `@lid` OR phone (`@s.whatsapp.net`) identities,
 * and a sudo/owner number may be stored in either form. This returns the
 * sender's own number plus any aliases recorded in the contacts table
 * (populated from `contacts.update` and group metadata), so an owner/sudo
 * match succeeds no matter which identity form the message arrived as.
 */
export async function resolveIdentityAliases(
  jid: string | null | undefined,
  tenantId: number = LEGACY_TENANT_ID,
): Promise<string[]> {
  const base = (jid ?? "").split(":")[0].split("@")[0];
  if (!base) return [];
  const aliases = new Set<string>([base]);
  try {
    const rows = await db
      .select({ jid: contactsTable.jid, lid: contactsTable.lid, phoneNumber: contactsTable.phoneNumber })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.tenantId, tenantId),
          or(
            eq(contactsTable.jid, jid ?? ""),
            eq(contactsTable.jid, base + "@lid"),
            eq(contactsTable.jid, base + "@s.whatsapp.net"),
            eq(contactsTable.lid, base + "@lid"),
            eq(contactsTable.phoneNumber, base + "@s.whatsapp.net"),
          ),
        ),
      );
    for (const r of rows) {
      for (const v of [r.jid, r.lid, r.phoneNumber]) {
        if (v) aliases.add(v.split(":")[0].split("@")[0]);
      }
    }
  } catch {
    /* alias lookup is best-effort */
  }
  return [...aliases];
}
