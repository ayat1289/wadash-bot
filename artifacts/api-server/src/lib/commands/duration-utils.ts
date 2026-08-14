// Parse a human duration like "30s", "10m", "2h", "1h30m", "1d", or a bare
// number (interpreted as minutes) into milliseconds. Returns null when the
// input is empty/invalid or outside the sane 1s–30d range.
export function parseDuration(input: string): number | null {
  const s = (input ?? "").trim().toLowerCase();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    const ms = Number(s) * 60_000; // bare number = minutes
    return ms > 0 && ms <= 30 * 86_400_000 ? ms : null;
  }

  const re = /(\d+)\s*(d|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "d" ? n * 86_400_000 : m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : n * 1_000;
  }
  if (!matched || total <= 0 || total > 30 * 86_400_000) return null;
  return total;
}

export function formatDuration(ms: number): string {
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3_600);
  s -= h * 3_600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}
