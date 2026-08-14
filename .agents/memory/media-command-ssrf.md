---
name: Media command SSRF/DoS hardening
description: Security rules for chat commands that hand user input to yt-dlp / ffmpeg / fetch (downloaders, audio effects, AI).
---

# Media/downloader command hardening

These bot commands take raw WhatsApp message text and feed it to `yt-dlp`,
`ffmpeg`, or `fetch`. That makes them SSRF + DoS sinks. Rules:

## SSRF

- **A "public host" check is NOT enough for yt-dlp.** Any URL handed to yt-dlp
  must pass a **domain allowlist** of sites that have a dedicated extractor
  (youtube, tiktok, instagram, facebook, twitter/x, pinterest, dailymotion,
  vimeo, soundcloud). yt-dlp's *generic* extractor follows attacker-controlled
  HTTP redirects to internal/link-local targets even when the original URL
  looked public. Non-URL text → route to `ytsearch1:` instead.
  **Why:** allowing arbitrary public URLs reopened SSRF via redirect after the
  public-host check passed.
- **The literal-host SSRF guard must decode IPv4-mapped IPv6.** WHATWG `URL`
  normalizes `http://[::ffff:127.0.0.1]` to host `[::ffff:7f00:1]`; a naive
  private-range check misses it. Decode both dotted (`::ffff:127.0.0.1`) and hex
  (`::ffff:7f00:1`, incl. expanded `0:0:0:0:0:ffff:`) mapped forms and test the
  embedded IPv4 against private/reserved ranges (loopback, 10/8, 172.16/12,
  192.168/16, 169.254/16 metadata, 100.64/10 CGNAT).
- Re-validate any URL **scraped** from a fetched page (e.g. a MediaFire direct
  link) with the public-host check before fetching it — the page is attacker-influenced.
- **How to apply:** keep regression cases for userinfo `@` hosts, IPv4-mapped
  IPv6, private IPv4, and allowlisted vs non-allowlisted downloader URLs.

## DoS / resource safety

- Gate every heavy command (download, ffmpeg, image-gen) through an in-memory
  limiter: per-user cooldown + global concurrency cap; always `release()` in a
  `finally`. Lighter calls (chat) take cooldown only.
- Spawn child processes **detached** (own process group) and `SIGKILL -pid` the
  whole group on timeout, or yt-dlp's ffmpeg grandchild survives.
- Cap input/output sizes everywhere: `fetch` streams with a hard byte cap (don't
  trust Content-Length), yt-dlp `--max-filesize` + post-download `stat` recheck,
  audio-effect input cap before ffmpeg. Pass `--` before user targets so a
  leading `-` can't be read as a flag.
