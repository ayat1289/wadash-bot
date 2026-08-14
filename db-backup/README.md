# Database backup

This folder contains a full dump of the bot's Postgres database (`wadash`),
including messages, contacts, groups, bot_config, economy, and other tables.

- `wadash.sql` — plain-text dump (easiest to inspect / restore with psql)
- `wadash.dump` — custom-format dump (restore with pg_restore)

## Restore

Prereqs: Postgres running, `DATABASE_URL` in `.env` pointing at the target DB.

```bash
# create the database if it does not exist
createdb wadash

# restore (plain SQL dump)
psql "$DATABASE_URL" -f db-backup/wadash.sql

# OR restore (custom dump)
pg_restore --dbname "$DATABASE_URL" --no-owner --no-privileges db-backup/wadash.dump
```

## Refresh

Re-dump the current DB before pushing a new backup:

```bash
pg_dump "$DATABASE_URL" > db-backup/wadash.sql
pg_dump -Fc "$DATABASE_URL" -f db-backup/wadash.dump
```

Note: dumps are committed alongside the code so the GitHub backup is fully
restorable. If the DB changes, re-dump and push again.
