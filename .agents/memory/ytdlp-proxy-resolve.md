# Free YouTube audio (no VPN/proxy — REMOVED by user directive)

## Dec 2025 user directive: "remove proxy/vpn from code forever."
All proxy egress was removed: `YTDLP_PROXY_URL`, `proxyArgs()`,
`downloadProxyStream()`, compose `extra_hosts`, docker/.env entry, env docs.
Consequence accepted: Instagram reverted to senator(IG_API_KEY) → cobalt → plain
yt-dlp (cobalt for IG may also fail from DC IP). YouTube audio now uses a free
public converter API so yt-dlp is NOT needed for songs.

## The free YouTube→MP3 converter (verified working 2025-12)
No API key. Fully tested end-to-end from the production container (4201389-byte
Blinding Lights mp3, ID3 header). Off-Site egress = this host's NIC; the
converter does ALL the YouTube work, so the host IP-block (bot-check) is moot.

1. `POST https://youtubemp4free.com/wp-admin/admin-ajax.php`
   - form: `action=yt_convert`, `nonce`, `youtube_url=https://youtube.com/watch?v=<id>`
   - headers: `Origin: https://easyconv.com`, `X-Requested-With: mark.via.gp`,
     `Referer: https://easyconv.com/`, UA `Chrome/126`, urlencoded content-type.
   - nonce: scrape homepage `https://youtubemp4free.com/` regex
     `/nonce["'\s]*[:=]\s*["']([0-9a-f]{10})["']/i`; fallback `1495b10e48`;
     cache 5 min; on ajax `nonce|security|cookie` error reset cache and retry.
   - response JSON: `{success:true, data:{slug, size, info:{title}}}`.
2. `GET https://ryin.info/<slug>` → regex
   `/https:\/\/[^"'\s]+get\.php\?[^"'\s]+/` for the file link. The link can take
   a few seconds to appear (conversion finishing) → poll page up to ~8x/4s.
3. `GET <file link>` (`https://*.ytmp3free.cc/get.php?cid=…&t=…&i=<b64 ip>`)
   can return 0 bytes briefly → poll until bytes>0 and content-type
   `audio|octet`, up to 8x/3.5s. Guard size via `data.size` (bytes) or buffer.

Name queries (no VPN): Invidious **search only**
`https://invidious.f5.si/api/v1/search?q=…&type=video&fields=videoId,title`
(fallback `https://yewtu.be`) → first result videoId → converter. Don't touch
invidious media endpoints (Anubis) or googlevideo player URLs (IP-signed → 403).

## Wiring
- `artifacts/api-server/src/lib/commands/youtube-mp3.ts`: `getNonce()`,
  `convert(videoUrl)`, `downloadYouTubeAudioUrl(videoUrl, opts)`,
  `searchYouTubeVideo(q)`, `tryYouTubeAudio(input, opts)` (URL → converter;
  else search→converter; returns null, never throws).
- `handlers/download.ts`: `sendAudio()` tries the converter for YouTube links
  before yt-dlp; `.play`/`.song` (`startPlay`) tries it for names and YT links
  (direct audio, skips the menu card). `handlers/downloads2.ts` `audioCmd(music)`
  same fast-path. Fallbacks intact.

## False paths (don't revisit)
- TurboScribe `_htmx/...` endpoint user suggested: 401 w/o login + Cloudflare → dead.
- VPN round-robin (~60 workers, ttl 1s) resets YouTube signed connections → 403.
- Invidious public instances: media endpoints Anubis-gated; googlevideo URLs are
  egress-IP-signed (403 from any other IP). Search-only.
- Endpoint: health is `/api/healthz`. Note this file REPLACES the old
  `ytdlp-proxy-resolve.md`; the proxy it documented is permanently removed.