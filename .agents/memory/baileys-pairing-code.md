---
name: Baileys pairing-code linking reliability
description: Why /pair codes get issued but WhatsApp won't link them, and the two fixes (qrTimeout window + don't request when already registered).
---

# Baileys pairing-code ("Link with phone number") reliability

Symptom: user runs `/pair <number>`, receives an 8-char code, but WhatsApp never
links the device ("got a code but can't link").

Two distinct root causes, both addressed:

## 1. The QR timer voids the code (~60s window)
`requestPairingCode()` does NOT stop Baileys' parallel QR/connection timer. The
unpaired socket still runs on `qrTimeout` (default **60s**). When it fires before
the user finishes linking, `connection.update` emits `connection:"close"`, our
handler nulls `session.socket` and `scheduleReconnect()` spins up a **new** socket
— which invalidates the previously issued pairing code.

**Fix / rule:** set a longer `qrTimeout` in `makeWASocket` (we use `120_000`) so
the pairing window is wide enough to navigate WhatsApp and type the code. Longer
qrTimeout only delays reconnect for *unpaired* sockets that time out; it does not
affect already-connected tenants or the normal `/qr` flow.

## 2. Never request a pairing code on an already-registered/connected session
`requestPairingCode()` mutates live auth creds (`creds.pairingCode`, `creds.me`)
and, on an already-registered socket, returns a code WhatsApp will reject (and can
corrupt persisted auth metadata). **Guard before requesting:** throw if
`session.state.state === "connected"` or `socket.authState.creds.registered` — tell
the user to `/disconnect` (logout, clears creds) first, then re-pair.

**Why:** these two are the common "code issued but unusable" failure modes; the
mechanics of `requestPairingCode` (sends an IQ over the open WS, returns a Crockford
base32 code) otherwise work fine.

**How to apply:** any change to the pair flow in `whatsapp.ts`
(`requestPairingCodeForTenant`) / `telegram.ts` `/pair` must keep both the wider
qrTimeout and the registered/connected guard. Also recommend `/qr` (scan) as a
fallback — it works on every WhatsApp version and sidesteps the "Link with phone
number instead" UI entirely. Default Baileys browser is already `macOS('Chrome')`,
so setting `browser` is NOT the fix.

## 3. Don't mint the code before the websocket is actually up (concurrency)
Never gate `requestPairingCode` on a FIXED sleep after connect. Under concurrent
multi-user load the WS handshake routinely takes longer than a couple seconds, so
the code is minted on a half-open socket and WhatsApp rejects it — the dominant
cause of "many users pairing at once → flaky codes".

**Fix / rule:** wait for a real readiness signal, not a timer. Baileys emits its
first `qr` event only AFTER the handshake is far enough to mint a code, so poll
for readiness (`waitForPairingReady`, ~20s cap) and proceed when
`state === "connected"` OR (`socket` && a per-session `pairingReady` flag). Set
`pairingReady` on the RAW `qr` event, BEFORE rendering the QR image — coupling
readiness to `qrCode` (the rendered data-URL) lets a QR-render failure wrongly
time out an otherwise-ready socket. Reset `pairingReady=false` on connect start
and on `connection:"close"`.

**Why:** event-derived readiness scales with load; a fixed delay cannot.

## 4. Serialize pair requests per tenant + typed capacity sentinel
`requestPairingCode` mutates live auth creds, so two overlapping requests on one
socket (dashboard + Telegram, or a double-click) corrupt the pairing. Keep a
per-session `pairLock` promise chain so pair requests for a tenant run one at a
time. For the multi-tenant connection cap, throw a typed `Error("CAPACITY")`
(env `MAX_WA_TENANTS`, default 50) and map it everywhere to a friendly "busy,
try again" (Telegram `/pair`+`/qr`, dashboard routes → 503); map
`ALREADY_LINKED`/`ALREADY_REGISTERED` → "disconnect first" (routes → 409). Share
ONE in-flight `getBaileysVersion()` fetch across tenants on cold start (reset on
error) so N simultaneous first-connects don't each hit the network. Audit every
fire-and-forget `connectTenant(...)` (boot-restore, reconnect, restartConnection)
to `.catch` — a thrown `CAPACITY` there would be an unhandled rejection.
