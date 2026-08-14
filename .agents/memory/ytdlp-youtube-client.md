---
name: yt-dlp audio source + vendored binary
description: Why audio downloads use SoundCloud (not YouTube) and why yt-dlp is vendored into the repo instead of using the Nix-provided one.
---

# yt-dlp audio source + vendored binary

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

## Why yt-dlp is vendored (not the Nix `yt-dlp`)

The Nix-provided `yt-dlp` is pinned to an old release whose **SoundCloud-search
extractor is broken** (builds an `api.soundcloud.com/tracks/soundcloud%3Atracks%3A...`
URL no extractor matches). So a current, pinned yt-dlp is committed at
`artifacts/api-server/bin/yt-dlp`.

It is the official **self-contained PyInstaller build** (`yt-dlp_linux`, ~39MB
ELF) run **DIRECTLY** — NOT via `python3`. An earlier *zipapp + Nix python3*
approach died in production because the Nix store's `libssl.so.3` was corrupted
(EIO) in the published image (and republishing reused the cached content-addressed
path, so it stayed broken). The PyInstaller binary bundles its own CPython +
OpenSSL (extracted to /tmp at runtime) so it never touches the Nix openssl.

**Why:** committed `bin/` survives deploys (esbuild-only prod build; `data/` +
`.pythonlibs` are gitignored), and the self-contained binary sidesteps the
corrupted-Nix-store class of failure.
**How to apply:** the runner in `commands/ytdlp.ts` anchors the path via
`import.meta.url` (app always runs as bundled `dist/index.mjs`). To bump yt-dlp,
download a pinned `yt-dlp_linux` release over `bin/yt-dlp`, keep its executable
bit, and re-verify `scsearch1:` resolves a full track — the SoundCloud-search
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
