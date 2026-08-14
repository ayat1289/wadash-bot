---
name: Replit Vite dev-server port detection
description: When a Vite artifact's workflow reports DIDNT_OPEN_A_PORT but the app is actually healthy — how to confirm it, and why it's supervisor-side (not an app bug).
---

Observed 2026-06-19: both Vite dev-server artifacts (`whatsapp-dashboard`, `mockup-sandbox`) had their workflows fail with `DIDNT_OPEN_A_PORT`, even though Vite started cleanly (`ready in ~330ms`) and bound its port. The api-server (a prebuilt Node bundle on the same `pnpm --filter ... run dev` pattern) was detected normally. So the differentiator is Vite-dev-server vs Node-bundle, not the workflow command.

## How to tell a healthy app from a supervisor detection flake
Do NOT trust the workflow "FAILED" status alone — verify the app directly:
- Run the exact dev command manually with the workflow env (`PORT=<localPort> BASE_PATH=<path>`) and check `/proc/net/tcp` for the port in hex (e.g. 23097 = `5A39`; state `0A` = LISTEN). `ss` is NON-functional in this sandbox (reports 0 listeners total) — ignore it entirely.
- `curl -s -o /dev/null -w '%{http_code}' http://localhost:80/<previewPath>` through the shared proxy. A 200 proves the app AND the proxy route are fine, so the only failing piece is the supervisor's port detection. The socket is stable (polled 40s+, no flapping/reload).

## Known non-fixes — don't burn turns on these
- Editing `artifact.toml` `[services.env] PORT` is a NO-OP: the proxy routes to `localPort` and the platform effectively injects `PORT=localPort`, so removing/changing it doesn't change what Vite binds. The artifacts skill states port assignment is platform-managed and can't be set manually.
- The Vite config is already correct (host `0.0.0.0`, `allowedHosts: true`, reads `PORT`/`BASE_PATH`).
- Repeating `restart_workflow` just times out (~120–240s each) with the identical error.

**Why:** this is supervisor-side port detection, not an app/config bug.
**How to apply:** confirm health with the two checks above, then treat it as a platform issue (a full repl/container restart often clears supervisor state) rather than re-diagnosing or hand-editing managed config.
