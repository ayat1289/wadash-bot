---
name: Multi-tenant data foundation
description: How this WhatsApp bot is being converted single-owner -> multi-tenant, and the legacy-tenant compatibility model.
---

# Multi-tenant conversion model

The bot is being converted from single-owner to multi-tenant in stages: (1) data
foundation — add `tenant_id` scoping to every table + read/write path with ZERO
visible behavior change; (2) runtime per-tenant routing (each Telegram user pairs
their own WhatsApp); (3) per-user dashboard login (Clerk).

**Legacy tenant.** A row in `tenants` with `id = 1` (exported as `LEGACY_TENANT_ID`)
owns all pre-existing data. Stage 1 defaults every query/insert/config call to
`LEGACY_TENANT_ID` so nothing changes for the existing owner.

**Why the LEGACY defaults are temporary.** `loadConfig/getConfig/setConfig` etc.
take `tenantId = LEGACY_TENANT_ID`, and routes hardcode it. This is intentional for
stage 1 but will MASK missing tenant propagation in stage 2 — when adding runtime
routing, make `tenantId` an explicit required param threaded through the request
auth context, the command context, and WhatsApp session helpers; remove the broad
LEGACY defaults except deliberate compatibility shims.

**How to apply (safe online schema migration of a populated DB while the old
bundle is still running):** the server is an esbuild bundle with no watch/reload, so
editing files does NOT change the running process — the OLD bundle keeps serving
until `restart_workflow`. To add a `NOT NULL` FK column without breaking the running
old bundle's inserts: add the column with a transitional `DEFAULT 1` (backfills
existing rows AND lets the old code insert without the column), apply FKs / composite
uniques / indexes, COMMIT, THEN `restart_workflow` to load the new bundle that always
supplies `tenant_id`, THEN drop the column DEFAULT so the schema is fail-loud.
Run the migration with `psql "$DATABASE_URL" -f file.sql` (the code_execution sandbox
cannot resolve `pg` from the workspace root).

**`ensureLegacyTenant()`** (idempotent INSERT id=1 ON CONFLICT DO NOTHING + setval)
must run BEFORE anything that inserts. The entrypoint awaits `bootstrap()` (which
runs it) before `app.listen()` so HTTP writes on a fresh DB can't race ahead of it.

**tenant_id is internal** — deliberately NOT in the OpenAPI spec. It leaks into JSON
responses (full-row selects return the column) but that is additive/harmless for the
internal dashboard, so no codegen change is needed.
