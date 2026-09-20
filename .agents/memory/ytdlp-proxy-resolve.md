# YTDLP_PROXY_URL: fix IG/YT IP-blocks by resolving through proxy only

## Symptom
YouTube ("Sign in to confirm you're not a bot") and Instagram (empty media
response) are IP-blocked from this host's NIC (169.58.193.73) for EVERY yt-dlp
client/cookies/po-token combination, AND every hosted API (Cobalt gave
`error.api.fetch.empty` for IG, `error.api.youtube.login` for YT; yt-dlp,
oembed/og, graphql all fail).

## The trick (key insight)
Do NOT pipe the whole download through the proxy (`--proxy` makes every fetch
hop the VPN; big reels crawl at ~370 KiB/s and the rotating pool resets
YouTube connections). Instead:

1. RESOLVE the direct media URL (`yt-dlp ... --proxy $P -g <url>`) — one tiny
   proxied request. IG probe reels resolve fine.
2. STREAM the media DIRECT from the CDN (scontent.cdninstagram.com etc.) — the
   host's DC IP can fetch CDN bytes at full speed (~1.3 MB/s) even though the
   API/webpages are blocked.

Proxy bandwidth ≈ 0. Media = DC speed.

## Wiring
- `artifacts/api-server/bin/yt-dlp` vendored binary; set `YTDLP_PROXY_URL`
  (gitignored, in `docker/.env`) =
  `http://proxyadmin:CdPWzN3ilJfJX0qIBygjXH2OHjTHJUJd@host.docker.internal:6969`
- `host.docker.internal` resolves in the api container via compose
  `extra_hosts: ["host.docker.internal:host-gateway"]` → docker0 gateway
  172.17.0.1. Squid (`vpn-front-squid`) binds 0.0.0.0:6969 on the host. Basic
  auth creds live only on host at `/root/ovpn/auth/credentials.txt`.
- `ytdlp.ts`: `proxyArgs()`/`downloadProxyStream()` — only added to the IG/YT
  paths in `downloadVideoSmart`; TikTok stays direct (tikwm → cobalt) so 58 MB
  TT videos never burn proxy bandwidth. `fetchInfo/fetchMeta(target, viaProxy)`.
- IG order: proxy → senator(IG_API_KEY) → cobalt. YT: proxy → plain yt-dlp.

## Gotchas
- IG format filter `best[height<=*]` FAILS via proxy (progressive mp4 formats
  report "unknown" height and get excluded). Use `-f best[ext=mp4]` there.
- Cobalt's own `API_EXTERNAL_PROXY` (commented, same squid creds) FAILS with
  `error.api.fetch.fail` — don't switch back to it.
- YouTube remains flaky through the ROTATING pool (ConnectionReset on some
  worker hops); retries absorb most, but it can still give up. True unlock =
  browser cookies (`cookies.txt`/YOUTUBE_COOKIES) or Cobalt cookies.
- Endpoint: health is at `/api/healthz` (not `/healthz`, not `/api/health`).