/** Parse a string into an http(s) URL, or null if it isn't one. */
export function parseHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

/** True for an IPv4 (given its first two octets) in a private/reserved range. */
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Decode the embedded IPv4 of an IPv4-mapped/compatible IPv6 literal
 * (e.g. `::ffff:127.0.0.1` or its normalized hex form `::ffff:7f00:1`).
 * Returns the four octets, or null if `v6` isn't such an address.
 */
function ipv4FromMappedV6(v6: string): [number, number, number, number] | null {
  const idx = v6.lastIndexOf("ffff:");
  if (idx === -1) return null;
  // Everything before `ffff:` must be only zeros/colons for this to be a
  // genuine IPv4-mapped address (`::ffff:` or `0:0:0:0:0:ffff:`).
  if (!/^[0:]*$/.test(v6.slice(0, idx))) return null;
  const rest = v6.slice(idx + "ffff:".length);

  const dot = rest.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dot) {
    const o = dot.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return null;
    return [o[0], o[1], o[2], o[3]];
  }
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

/**
 * True for hostnames that point at the local machine or a private/reserved
 * network. Used to keep yt-dlp / fetch from reaching internal services (SSRF).
 * Literal-host checks only — does not resolve DNS.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }

  // IPv6
  const v6 = h.replace(/^\[/, "").replace(/\]$/, "");
  if (v6 === "::1" || v6 === "::") return true;
  if (/^fe80:/i.test(v6) || /^f[cd][0-9a-f]{2}:/i.test(v6)) return true;
  if (v6.includes(":")) {
    const mapped = ipv4FromMappedV6(v6);
    if (mapped && isPrivateIpv4(mapped[0], mapped[1])) return true;
  }

  // IPv4
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed → treat as unsafe
    if (isPrivateIpv4(o[0], o[1])) return true;
  }
  return false;
}

/** True only for public http(s) URLs (blocks localhost/private/reserved hosts). */
export function isPublicHttpUrl(raw: string): boolean {
  const u = parseHttpUrl(raw);
  if (!u) return false;
  return !isPrivateHost(u.hostname);
}

/**
 * True when a public http(s) URL's host equals or is a subdomain of one of the
 * allowed registrable domains (e.g. "tiktok.com" matches "vm.tiktok.com").
 */
export function hostMatches(raw: string, domains: string[]): boolean {
  if (!isPublicHttpUrl(raw)) return false;
  const u = parseHttpUrl(raw);
  if (!u) return false;
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => h === d || h.endsWith("." + d));
}
