#!/usr/bin/env bash
# One-time VPS provisioning for wadash-bot.
# Run as root on a fresh Debian/Ubuntu VPS.
#
#   WADASH_DEPLOY_KEY="$(cat /path/to/deploy_private_key)" bash provision-vps.sh
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wadash-bot}"
DEPLOY_KEY_PATH="${DEPLOY_KEY_PATH:-/root/.ssh/wadash_deploy}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin missing." >&2
  exit 1
fi

echo "==> Installing deploy key for gh pulls"
mkdir -p /root/.ssh
ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null || true
if [ -n "${WADASH_DEPLOY_KEY:-}" ]; then
  printf '%s\n' "$WADASH_DEPLOY_KEY" > "$DEPLOY_KEY_PATH"
  chmod 600 "$DEPLOY_KEY_PATH"
fi
if [ ! -f "$DEPLOY_KEY_PATH" ]; then
  echo "WADASH_DEPLOY_KEY not provided and no key at $DEPLOY_KEY_PATH." >&2
  exit 1
fi

export GIT_SSH_COMMAND="ssh -i ${DEPLOY_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

echo "==> Cloning repo"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone git@github.com:Zxornatoe/wadash-bot.git "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin master
  git -C "$APP_DIR" reset --hard origin/master
fi

echo "==> Provisioned. Run the 'Deploy wadash bot to VPS' workflow from gh to start the stack."