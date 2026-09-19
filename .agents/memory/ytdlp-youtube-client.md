---
name: yt-dlp audio source + vendored binary
description: Why audio downloads use SoundCloud (not YouTube) and why yt-dlp is vendored into the repo instead of using the Nix-provided one.
---

# yt-dlp audio source + vendored binary

## TikTok & Instagram (as of 2026): use API dispatch, NOT yt-dlp

Both TikTok and Instagram are IP-blocked from this host for yt-dlp — TikTok's
extractor answers "Your IP address is blocked from accessing this post" and
Instagram's returns an EMPTY media response. So `commands/ytdlp.ts` ships two
smart dispatchers used by ALL video senders (`.video`, `.ytmp4`, `.ttslide`,
`.tiktok`/`.tt`/`.ttmp3`, `.ig`/`.reels`/`.igvideo`):

- `downloadTikTok(url, {audio, maxSizeMb})` — the public **tikwm** API
  (`https://www.tikwm.com/api/?url=...`) resolves posts from clean infra and the
  returned `*.tiktokcdn*.com` media files ARE fetchable from this host's DC IP
  (verified live: 58.5MB mp4, HTTP 200). It sends a browser UA + `Referer:
  https://www.tiktok.com/`, caps the size (~1.2× budget), falls back to the
  watermarked copy, and picks the audio mimetype from the source extension
  (`audio/mpeg` for mp3, else `audio/mp4`).
- `downloadVideoSmart(url, {maxSizeMb})` — dispatches: TikTok → tikwm; Instagram
  → hosted SenatorAPI (`downloadInstagramViaApi`) WHEN `INSTAGRAM_API_KEY` is set
  in `docker/.env`, otherwise falls through to yt-dlp (blocked → callers reply
  with the "get a free key from @Api_ManagerRoBot" message); everything else
  (YouTube/Facebook/X/Pinterest origins) → yt-dlp with format best[mp4]≤720.

**KEY ROUTING INSIGHT:** command aliases must NOT blur these boundaries —
`commands.set()` last-registration-wins in `registry.ts` (import order in
`index.ts`: download → downloads2 → extras2). TikTok video now lives ONLY in the
`tiktokhd` entry (aliases `tt`/`tiktok`/`tik`/`tiktokvideo`); the old
`platformVideo("tiktok"|"instagram")` yt-dlp entries in `handlers/download.ts`
were REMOVED. Instagram lives ONLY in extras2 `reels` (aliases
`story`/`ig`/`instagram`/`igvideo`). If someone re-adds a `.tiktokvideo`/
`.igvideo` handler elsewhere that talks directly to yt-dlp, it will silently
break again.

## Cobalt (free/OSS) is the downloader backbone; IP block is the real enemy

Deep-research + live-test (Sep 2026): the ONLY bankable lever is egress IP.
Verified on this host: yt-dlp, oembed/og, the IG graphql `__a=1`, AND a
self-hosted **imputnet/cobalt** API all return *empty* for Instagram and a
*bot-check/login* for YouTube from the host NIC — every tool fetches from the
same blocked IP, so swapping tools changes nothing. TikTok is the exception:
both the **tikwm** API and **cobalt** resolve and stream real media from here
(cobalt's /tunnel even supports Range).

So `docker-compose.yml` now runs a `cobalt` service (ghcr.io/imputnet/cobalt:11,
bound 127.0.0.1:9000, `API_URL=http://cobalt:9000/`, cookies at
`/cookies.json`). `ytdlp.ts` exports `downloadCobalt(url,{audio,maxSizeMb})`
(general + tunnel stream + size cap) and routes `downloadVideoSmart`:
TikTok → Cobalt→tikwm fallback; Instagram → Cobalt→SenatorAPI(key)→yt-dlp; else
yt-dlp. The bot passes `COBALT_URL=http://cobalt:9000`.

Instagram & YouTube stay blocked UNTIL one of two unlocks is applied (both
plumbed, no code change needed):
  1. **cookies**: real session cookies into `./cobalt-cookies.json` (COBALT
     format, not Netscape; see imputnet/cobalt docs/examples/cookies.example.json).
  2. **proxy egress**: uncomment `API_EXTERNAL_PROXY` on the cobalt service —
     this host already runs a free/OSS **rotating VPN proxy** (`vpn-front-squid`,
     squid on 127.0.0.1:6969, `vpn-worker-*` exit nodes, Basic-auth). It will
     bypass the blocks, but burns the user's VPN egress bandwidth, so it is
     intentionally left OFF — ask before enabling.
The old paid-only message was replaced to point at these two options. A paid
`INSTAGRAM_API_KEY` (SenatorAPI) remains as a third, non-default fallback.

Audio commands (`.play`/`.song`/`.ytmp3`) download from **SoundCloud**, not
YouTube. Search uses the `scsearch1:<query>` prefix (in `handlers/download.ts`).
Video commands (`.ytmp4`/`.video`) with a **typed name** are short-circuited in
`fromUrlOrSearch` (non-URL input + `searchPrefix === "ytsearch1"`) with an
immediate "send a direct link" message — they no longer hand a doomed
`ytsearch1:` query to yt-dlp and wait out the timeout. A pasted **link** on the
`MEDIA_DOMAINS` allowlist still goes through to `sendVideo` (TikTok/IG/FB work;
a YouTube link usually still fails from this IP) — see below.

## Why not YouTube (audio AND video are dead from this host)

As of mid-2026, YouTube blocks **all** anonymous yt-dlp player clients from this
host's datacenter IP. Audio search fails with "Sign in to confirm you're not a
bot." **Video** was separately re-tested across every player client and is also
fully blocked: `tv`=DRM, `ios`/`mweb`/`web_safari`=requested-format-unavailable,
`android_vr`/`default`=HTTP 403. So **video-by-song-NAME is impossible** — the
interactive `.play` menu only offers video when the user pastes a real link on
the `MEDIA_DOMAINS` allowlist (TikTok/IG/FB/etc.), and even a pasted *YouTube*
video link will usually fail. Audio (SoundCloud) is the only reliable path.

Public Piped/Cobalt instances are also down or auth-gated. SoundCloud is **not**
IP-walled, so it's the durable audio source. `player_client=android` is kept as
a harmless no-op (namespaced to youtube) in case YouTube access is ever restored.

**If audio breaks again:** re-probe `scsearch1:` first; if SoundCloud also gets
walled, re-probe YouTube clients (`yt-dlp -j --extractor-args
"youtube:player_client=<c>" -- "ytsearch1:test"`) and swap the search prefix /
client to whatever currently returns JSON.

## YouTube is unblockable ONLY with cookies (as of 2026)

Exhaustive re-test (Sep 2026) confirmed no player client / PO-token/POT-provider
setup defeats the block from this IP — the ban is applied at the player-API
level *before* tokens matter, for **every** client (android, tv, web_safari, ios,
mweb, android_vr, android_music, ytmusic, ios_music, web_creator, tv_simply,
web_embedded, tv_embedded, web_music, `default,-web_safari`). The ONLY reliable
bypass shipped in the app is **browser cookies**: the operator sets
`YOUTUBE_COOKIES` (cookies.txt CONTENT) or `YOUTUBE_COOKIES_FILE` (mounted path)
in `docker/.env`. `commands/ytdlp.ts` writes it once to a temp file (memorized,
removed on exit) and passes `--cookies` to every invocation.

While cookies are set, download.ts/downloads2.ts flip the audio name-search
prefix from `scsearch1:` to `ytsearch1:` (constants `AUDIO_SEARCH_PREFIX` /
`AUDIO_SEARCH`, computed at module load from env), and name-based *video* also
activates (`.play` reply `2`, `.ytmp4`/`.video` name search). Without cookies,
audio stays SoundCloud-first and video-by-name replies with a clear "YouTube
blocks this server" message. Export cookies with the "Get cookies.txt LOCALLY"
extension (fresh incognito session), refresh when the bot-check returns, and
never commit the file/secret.

## Why yt-dlp is vendored (not the Nix `yt-dlp`)

The Nix-provided `yt-dlp` is pinned to an old release whose **SoundCloud-search
extractor is broken** (builds an `api.soundcloud.com/tracks/soundcloud%3Atracks%3A...`
URL no extractor matches). So a current, pinned yt-dlp is committed at
`artifacts/api-server/bin/yt-dlp`.

It is currently a pinned **python3 zipapp** (~3MB) committed at
`artifacts/api-server/bin/yt-dlp`, run via a bare `yt-dlp` command (python3 must
be present in the runtime image — the Dockerfile apt-get includes python3). It is
NOT invoked as a bare self-contained ELF; earlier infra used a PyInstaller build
or a *zipapp + Nix python3* approach, and the latter died in production because
the Nix store's `libssl.so.3` was corrupted (EIO) in the published image (and
republishing reused the cached content-addressed path, so it stayed broken).
The vendored binary bundles its own CPython + OpenSSL (extracted to /tmp at
runtime) so it never touches the Nix openssl.

**Why:** committed `bin/` survives deploys (esbuild-only prod build; `data/` +
`.pythonlibs` are gitignored), and the self-contained binary sidesteps the
corrupted-Nix-store class of failure.
**How to apply:** the runner in `commands/ytdlp.ts` anchors the path via
`import.meta.url` (app always runs as bundled `dist/index.mjs`). To bump yt-dlp,
download a pinned release's zipapp over `bin/yt-dlp`, keep its executable bit,
and re-verify `scsearch1:` resolves a full track — the SoundCloud-search
extractor regresses across versions (known-good: 2026.06.09).

## Prod-only "audio won't play" / `.play` failures = SoundCloud network timeout, NOT ffmpeg

A recurring trap: the WHOLE audio pipeline works perfectly in the dev workspace
(metadata ~5s, `bestaudio/best -x --audio-format mp3` yields a valid mp3 that
ffprobe confirms) yet `.play` fails in the **published** app. Diagnose with the
deployment logs, not by re-testing in dev — the prod signature is
`.../bin/yt-dlp timed out after <N>ms cmd=play`, i.e. a network hang while
resolving SoundCloud, because the **deployed datacenter IP gets throttled** under
real traffic (dev makes one request and isn't throttled). It is NOT ffmpeg/mimetype
(ffmpeg-dependent `.tts`/`.tomp3`/audio-effects working in prod proves ffmpeg is
on PATH, and yt-dlp's transcode shares it).

**Why:** without a per-socket bound, one stalled read runs until the hard process
SIGKILL timeout and the command fails outright; and the interactive `.play`→reply-`1`
path used to re-resolve metadata a SECOND time in `sendAudio` (another throttle-prone
round-trip) even though `startPlay` already resolved + length-checked the track.

**How to apply:** every yt-dlp invocation carries `NET_ARGS` (`--socket-timeout 30`
`--retries 5` `--extractor-retries 3` `--fragment-retries 10`) so a stalled read
fails fast and retries inside the window; `fetchMeta`'s hard timeout is 90s. The
selection step passes the already-resolved title into `sendAudio(pre=...)` to skip
the redundant `fetchMeta` (`.ytmp3`/`.spotify` still resolve once). If prod STILL
times out after these, the next step is an app-level retry wrapping a FRESH
`fetchMeta` process (log the target class — `scsearch`/soundcloud-URL/direct-URL —
to tell throttling apart from an extractor regression), not bigger timeouts.
