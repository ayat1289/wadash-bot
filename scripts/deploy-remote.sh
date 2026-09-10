#!/usr/bin/env bash
# Runs on the VPS after the workflow has written ./docker/.env secrets.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wadash-bot}"
DEPLOY_KEY_PATH="${DEPLOY_KEY_PATH:-/root/.ssh/wadash_deploy}"

cd "$APP_DIR"

export GIT_SSH_COMMAND="ssh -i ${DEPLOY_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

echo "==> Pulling latest code from gh"
git fetch origin master
git reset --hard origin/master

echo "==> Ensuring PostgreSQL is up"
docker compose up -d db
for _ in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U wadash -d wadash >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Building api image"
docker compose build api

echo "==> Syncing DB schema (drizzle push-force)"
docker compose run --rm --no-deps api pnpm --filter @workspace/db push-force

echo "==> (Re)starting stack"
docker compose up -d

echo "==> Done. Healthy services:"
docker compose ps