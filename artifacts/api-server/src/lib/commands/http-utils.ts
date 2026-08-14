import { isPublicHttpUrl } from "./url-utils";

const UA = "SheikhLabeeqMDBot/1.0 (+https://replit.com)";

export async function fetchJson<T = unknown>(url: string, timeoutMs = 12000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a URL into a Buffer, aborting if it exceeds maxBytes (checked via
 * Content-Length when present, and enforced while streaming).
 */
export async function fetchBuffer(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const { maxBytes = 64 * 1024 * 1024, timeoutMs = 60000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared && declared > maxBytes) throw new Error("file too large");
    const contentType = res.headers.get("content-type");

    // Stream and enforce the cap as we go, so a missing/false Content-Length
    // can't make us buffer an unbounded body into memory.
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error("file too large");
      return { buffer: buf, contentType };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("file too large");
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a remote image into a Buffer with strict, defense-in-depth controls so a
 * URL we don't fully trust (e.g. assembled from a third-party scrape) can't be
 * used for SSRF or to exhaust memory:
 *  - every redirect hop's URL must pass `isAllowed` (default: public hosts only);
 *  - the response must be `image/*`;
 *  - the body is capped at `maxBytes` (checked via Content-Length and streaming).
 */
export async function fetchImageBuffer(
  url: string,
  opts: {
    isAllowed?: (u: string) => boolean;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
  } = {},
): Promise<Buffer> {
  const {
    isAllowed = isPublicHttpUrl,
    maxBytes = 16 * 1024 * 1024,
    timeoutMs = 20000,
    maxRedirects = 3,
  } = opts;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowed(current)) throw new Error("blocked host");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        signal: ctrl.signal,
        headers: { "User-Agent": UA },
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("redirect without location");
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!(res.headers.get("content-type") ?? "").startsWith("image/")) {
        throw new Error("not an image");
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared && declared > maxBytes) throw new Error("image too large");

      const reader = res.body?.getReader();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw new Error("image too large");
        return buf;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error("image too large");
          }
          chunks.push(Buffer.from(value));
        }
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("too many redirects");
}
