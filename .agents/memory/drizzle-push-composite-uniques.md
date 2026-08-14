---
name: drizzle-kit push + composite unique constraints
description: Why `drizzle-kit push` keeps re-proposing existing named composite unique constraints, and how to actually verify DB/schema sync.
---

# drizzle-kit push re-proposes existing composite uniques

`drizzle-kit push` (0.31.x) has a diffing false-positive for **named composite
unique constraints** defined via `unique("name").on(colA, colB)`: even when the
constraint already exists in the DB exactly as defined, push re-plans it as an ADD
and then prompts "...table contains N items. Do you want to truncate?". That prompt
**requires a TTY**, so it crashes non-interactively ("Interactive prompts require a
TTY terminal") under workflows / piped shells — including `push-force`.

**Do not treat this as a real schema drift and do not loop on it.** Verify sync the
authoritative way instead: introspect the live DB directly with
`psql "$DATABASE_URL" -c "SELECT conrelid::regclass, conname, contype,
pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid::regclass::text IN (...)"`
and compare constraint defs against the schema. If the composite uniques, FKs, and
indexes match the Drizzle definitions, the DB is in sync regardless of what push says.

**Why:** push's introspection comparison for composite uniques is unreliable across
versions; direct `pg_constraint`/`pg_indexes` inspection is ground truth.

## Adding a NEW table when push is unusable

Because `push`/`push-force` crash on the TTY prompt above, you cannot rely on them
to create a brand-new table in this sandbox. Instead, run idempotent raw SQL via the
code-execution `executeSql` — `CREATE TABLE IF NOT EXISTS ...` matching the Drizzle
schema **exactly** (`timestamptz` for `timestamp(..., {withTimezone:true})`, snake_case
columns, same defaults/FKs), then verify with `information_schema.columns`.

**How to apply:** keep the Drizzle schema as the source of truth (so `pnpm typecheck`
+ ORM stay correct), and hand-create the table in dev with matching SQL. **The
production DB does NOT get these tables automatically** — push won't run cleanly there
either, so the same `CREATE TABLE IF NOT EXISTS` must be run against prod on deploy.
Tables created this way so far: `warns`, `scheduled_tasks`.
