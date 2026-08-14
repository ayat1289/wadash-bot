/**
 * Short-lived, in-memory store for the interactive `.play` download menu. When a
 * user runs `.play <song>` the bot shows the track and asks them to reply `1`
 * (audio) or `2` (video); the chosen format is downloaded on that reply. The
 * pending choice is keyed by tenant + chat + sender so only the same person who
 * asked can answer, and it expires so a stale `1`/`2` never triggers a download.
 *
 * In-memory is intentional (like the anti-delete `recentMessages` cache): the bot
 * runs single-instance, the state is tiny and ephemeral, and losing it on restart
 * just means the user re-runs `.play`.
 */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

export interface PendingDownload {
  /** yt-dlp target for the audio (mp3) choice — a resolved URL or `scsearch1:` query. */
  audioTarget: string;
  /** yt-dlp target for the video (mp4) choice — a URL, or a `ytsearch1:` query. */
  videoTarget: string;
  /** True when `.play` was given a direct link (video is only attempted then). */
  fromUrl: boolean;
  /** Track title, used for the file name / caption. */
  title: string;
  createdAt: number;
}

const store = new Map<string, PendingDownload>();

function keyOf(tenantId: number, chat: string, sender: string): string {
  return `${tenantId}\u0000${chat}\u0000${sender}`;
}

export function setPendingDownload(
  tenantId: number,
  chat: string,
  sender: string,
  data: Omit<PendingDownload, "createdAt">,
): void {
  if (store.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now - v.createdAt > TTL_MS) store.delete(k);
    }
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest) store.delete(oldest);
    }
  }
  store.set(keyOf(tenantId, chat, sender), { ...data, createdAt: Date.now() });
}

/** Return a live (non-expired) pending choice without consuming it. */
export function getPendingDownload(
  tenantId: number,
  chat: string,
  sender: string,
): PendingDownload | null {
  const k = keyOf(tenantId, chat, sender);
  const v = store.get(k);
  if (!v) return null;
  if (Date.now() - v.createdAt > TTL_MS) {
    store.delete(k);
    return null;
  }
  return v;
}

export function clearPendingDownload(tenantId: number, chat: string, sender: string): void {
  store.delete(keyOf(tenantId, chat, sender));
}
