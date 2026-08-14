---
name: WhatsApp auth state must not be committed
description: Baileys auth/session files under api-server/data/wa-auth are runtime secrets that churn constantly and must be gitignored.
---

# WhatsApp auth state must not be committed

Baileys persists pairing/session state as thousands of JSON files under
`artifacts/api-server/data/wa-auth/` (creds, identity keys, pre-keys,
app-state-sync, per-contact session + lid-mapping files). These are
**credentials** — anyone with `creds.json` + session keys can impersonate the
paired WhatsApp account.

**Rule:** `artifacts/api-server/data/` is gitignored — never commit it.

**Why:** the dir was historically tracked (~16k files) and committed by the
auto-checkpoint, leaking session secrets into git history and churning the repo
on every message (Baileys rewrites these files constantly). It was gitignored to
stop new files being tracked.

**How to apply / still outstanding:** gitignore does **not** untrack
already-tracked files. The previously-committed `wa-auth` files remain in the
index/history until someone runs `git rm -r --cached artifacts/api-server/data/wa-auth`
(keeps the working tree, so pairing is preserved) — a destructive git op that
must go through the proper delegated/Project-Task flow, not a direct command.
Re-pairing via Telegram is the safe recovery if the secrets are ever rotated.
Note: the deployment target is `autoscale`, which is also wrong for a
single-instance, local-file-state, Telegram-long-poll bot (separate issue).
