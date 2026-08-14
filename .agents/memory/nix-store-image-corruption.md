---
name: Nix store corruption in published image
description: Production-only native-lib load errors (e.g. yt-dlp/python libssl EIO) that work in dev — corrupted Nix store in the deployed image; republish does NOT reliably clear it, prefer a self-contained binary.
---

# Production-only native library load failure = corrupted Nix store in the published image

Symptom seen: `.play`/yt-dlp failing **only in production** with
`ImportError: /nix/store/.../openssl-3.x/lib/libssl.so.3: cannot read file data: Input/output error`
while the **dev workspace works fine** (same vendored yt-dlp, same python3, ssl imports OK).

**Diagnosis:** This is NOT a code or yt-dlp bug. An `Input/output error` (EIO) reading a
`/nix/store/...*.so` means a file in the published image's Nix store is physically corrupted.

**Republish does NOT reliably fix it.**
- Nix store paths are content-addressed and **reused from a cache** across builds, so a
  republish can re-link the SAME corrupted store path instead of producing a clean copy.
- Confirmed the hard way: republishing the bot left the exact same corrupted
  `openssl-3.6.0/lib/libssl.so.3` in place and `.play`/`.song`/`.ytmp3` kept failing at
  `fetchMeta`. The earlier "a fresh publish rebuilds the store clean" assumption was WRONG.

**The durable fix: remove the dependency on the corruptible Nix lib.**
- For yt-dlp specifically: vendor yt-dlp's official **self-contained PyInstaller binary**
  (`yt-dlp_linux`) at `artifacts/api-server/bin/yt-dlp` and run it DIRECTLY (not via the Nix
  `python3`). It bundles its own CPython + OpenSSL (extracted to /tmp at runtime), so it never
  touches the Nix store openssl. The runtime here is Ubuntu-based with the FHS loader
  (`/lib64/ld-linux-x86-64.so.2`) present, so a normal manylinux ELF runs fine.
- General principle: when a prod-only `.so` EIO/ImportError hits a Nix-store native lib, prefer
  swapping to a self-contained/static binary for that tool over hoping a republish rebuilds the
  corrupted path. Republish is worth one try but is not a reliable fix.

**How to apply:**
- Confirm via deployment logs that it's an EIO/`cannot read file data` on a `/nix/store/...so`
  and that dev is healthy — that's this class, not the *other* yt-dlp failure modes (YouTube
  anon-IP block → SoundCloud; broken Nix-pinned SoundCloud extractor → vendored binary) in
  `ytdlp-youtube-client.md`, which reproduce in dev too.
**The corruption is NOT openssl-specific — it also hit the Nix ffmpeg binary itself.**
Later symptom: every ffmpeg spawn in prod died with `spawn EIO` (errno -5, `code:"EIO"`) —
seen first in the `.tts`/`.say` transcode log, and it also silently broke `.play`/`.song`
mp3 conversion (yt-dlp's ExtractAudio postprocessor couldn't run ffmpeg, so it shipped the
raw SoundCloud container and WhatsApp rejected it as "something is wrong with the audio
file"). `spawn EIO` on the binary file is the SAME class as the libssl `.so` EIO: a
corrupted `/nix/store/...` path in the published image, and declaring `pkgs.ffmpeg` in
`replit.nix` does NOT fix it (the dep is present, the bytes are unreadable). Fix mirrors
yt-dlp: vendor a self-contained **static** ffmpeg at `artifacts/api-server/bin/ffmpeg`
(johnvansickle build, own codecs), resolve it via `getFfmpegPath()` (anchored to `import.meta.url`),
use it at every spawn site, and pass it to yt-dlp via `--ffmpeg-location`.

**Generalize:** any prod-only `spawn EIO` / `.so` EIO on a `/nix/store/...` path = corrupted
published-image store. Republish is unreliable; the durable fix is always a vendored
self-contained/static binary in committed `bin/`, never the Nix one.
