---
name: Deploy system deps (ffmpeg) must be in replit.nix, not just dev
description: Tools present in the dev runtime-path are absent in the deployed image unless declared in replit.nix
---

The dev workspace has many common system tools (ffmpeg, ffprobe, etc.) available via the
Replit **runtime-path** even when they are NOT listed in `replit.nix`. The DEPLOYED image
(GCE deploymentTarget) is built from `replit.nix` deps only — so a tool that "works in dev"
can be **completely missing in production**.

**Symptom seen:** audio downloads played fine in dev but the live bot sent files WhatsApp
rejected with "this audio is not available because something is wrong with the audio file".
Root cause: `ffmpeg` was missing from `replit.nix` (only `yt-dlp` was declared), so in prod
yt-dlp's `-x --audio-format mp3` post-processing had no ffmpeg and kept the raw SoundCloud
`media.m4a`; the sender then mislabeled m4a bytes as `audio/mpeg`.

**Declaring the dep in `replit.nix` is NECESSARY but NOT SUFFICIENT.** Adding `pkgs.ffmpeg`
made the binary present, but the published image's Nix-store copy was later found to be
**corrupted** — every ffmpeg spawn died with `spawn EIO` (errno -5) even though the dep was
declared. So audio stayed broken in prod. The durable fix was to stop using the Nix ffmpeg
entirely: vendor a self-contained **static** ffmpeg at `artifacts/api-server/bin/ffmpeg`
(committed alongside the vendored yt-dlp), resolve it via `getFfmpegPath()`, use it at every
spawn site, and pass it to yt-dlp via `--ffmpeg-location`. See
`.agents/memory/nix-store-image-corruption.md`.

**Rules:**
- Any native CLI a command shells out to (ffmpeg, ffprobe, imagemagick, etc.) must exist in
  prod. `replit.nix` deps is the baseline, but if a declared binary still fails in prod with
  `spawn EIO` (corrupted Nix store), vendor a self-contained/static binary in committed
  `bin/` and point the code at it — don't rely on the Nix copy.
- Defense-in-depth for media sends: label the outgoing file by its ACTUAL produced
  extension (mp3→audio/mpeg, m4a/aac→audio/mp4, opus/ogg→audio/ogg; codecs=opus), never a
  hardcoded mimetype — so a missing/failed converter degrades to a playable file, not a
  corrupt one.
