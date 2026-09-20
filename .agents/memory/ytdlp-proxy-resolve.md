# Free YouTube audio (no VPN/proxy — REMOVED by user directive)

## Dec 2025 user directive: "remove proxy/vpn from code forever."
All proxy egress was removed: `YTDLP_PROXY_URL`, `proxyArgs()`,
`downloadProxyStream()`, compose `extra_hosts`, docker/.env entry, env docs.
Consequence accepted: Instagram reverted to senator(IG_API_KEY) → cobalt → plain
yt-dlp (cobalt for IG may also fail from DC IP). YouTube audio now uses a free
public converter API so yt-dlp is NOT needed for songs.

## The free YouTube→MP3 flow (verified working 2025-12, from production container)
`youtube-mp3.ts` tries two independent free no-key converters, newest-first:

### 1. loader.to / YouLoader (PRIMARY — verified: 10.5MB audio/mpeg ID3, BL)
- `GET https://loader.to/` → capture Set-Cookie (needed on later calls).
- `GET https://loader.to/ajax/download.php?format=mp3&url=<enc yt url>`
  headers: UA Chrome/124, Cookie, `X-Requested-With: XMLHttpRequest`,
  Referer https://loader.to/, Accept application/json
  → JSON `{success:true, id, progress_url, title, info:{title}}`.
- Poll `progress_url` (GET, Cookie/UA/Accept) every ~4s up to ~20x until
  `download_url` ("https://<sub>.savenow.to/api/v2/download/<token>") appears
  (took ~15s in tests).
- GET `download_url` (UA + Cookie + Referer) → 200 audio/mpeg (~256k). Default
  ~10.5MB for a 4min song; fits Telegram 50MB cap.
- y2mate family (samenet) — direct y2mate.com fetches fail from this IP
  (connection reset). loader.to API stays GET-accessible.

### 2. youtubemp4free.com (fallback; works at LOW request volume only)
- `POST https://youtubemp4free.com/wp-admin/admin-ajax.php`
  - form: `action=yt_convert`, `nonce`, `youtube_url=https://youtube.com/watch?v=<id>`
  - headers: `Origin: https://easyconv.com`, `X-Requested-With: mark.via.gp`,
    `Referer: https://easyconv.com/`, UA Chrome/126, urlencoded content-type.
  - nonce: scrape homepage regex `/nonce["'\s]*[:=]\s*["']([0-9a-f]{10})["']/i`;
    fallback `1495b10e48`; cache 5 min; reset+retry on nonce/security/cookie.
  - response: `{success:true, data:{slug, size, info:{title}}}`.
- `GET https://ryin.info/<slug>` → regex `/https:\/\/[^"'\s]+get\.php\?[^"'\s]+/`
  → poll page up to ~8×4s (link can lag). If it redirects to
  `ryin.info/music.youtube.com` (186382-byte landing) the order NEVER
  materializes — that redirect means their backend isn't handing out files to
  this IP right now (rate-limit/backend state). Retrying won't help while hot;
  loader.to is the reliable path.
- `GET <get.php href>` (`https://*.ytmp3free.cc/get.php?cid=…&t=…&i=<b64 ip>`)
  can return 0 bytes briefly → poll to bytes>0 and `content-type audio|octet`.

Name queries (no VPN): Invidious **search only**
`https://invidious.f5.si/api/v1/search?q=…&type=video&fields=videoId,title`
(fallback `https://yewtu.be`) → first result videoId → converters. Don't touch
invidious media endpoints (Anubis) or googlevideo player URLs (IP-signed → 403).

## Wiring
- `artifacts/api-server/src/lib/commands/youtube-mp3.ts`: `loaderDownloadAudioUrl()`,
  `getNonce()`, `convert()`, `downloadYouTubeAudioUrl()`, `searchYouTubeVideo(q)`,
  `tryYouTubeAudio(input, opts)` (URL → both converters in order; name →
  search→converters; returns null, never throws).
- `handlers/download.ts`: `sendAudio()` tries the converter for YouTube links
  before yt-dlp; `.play`/`.song` (`startPlay`) tries it for names and YT links
  (direct audio, skips the menu card). `handlers/downloads2.ts` `audioCmd(music)`
  same fast-path. Fallbacks intact.

## False paths (don't revisit)
- TurboScribe `_htmx/...` endpoint user suggested: 401 w/o login + Cloudflare → dead.
- VPN round-robin (~60 workers, ttl 1s) resets YouTube signed connections → 403.
- Invidious public instances: media endpoints Anubis-gated; googlevideo URLs are
  egress-IP-signed (403 from any other IP). Search-only.
- api.cobalt.tools (public) shut down Nov 11 2024 ("v7 api shut down"); co.wuk.sh
  dead. Our self-hosted cobalt gives error.api.youtube.login for YouTube but is
  STILL used for TikTok.
- yt1s.com api/ajaxSearch → 404/challenge. y2mate.com direct → connection reset.
- Endpoint: health is `/api/healthz`. Note this file REPLACES the old
  `ytdlp-proxy-resolve.md`; the proxy it documented is permanently removed.