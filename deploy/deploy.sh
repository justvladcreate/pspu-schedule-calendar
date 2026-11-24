#!/usr/bin/env bash
# Автодеплой на hp-server: подтянуть main и перезапустить парсер.
#
# Ставится в cron/systemd timer (см. deploy/README.md). Запускается от
# root: нужен только ему, чтобы перезапускать сервис.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/serveradmin/pspu-schedule-calendar}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-pspu-schedule-calendar.service}"

cd "$REPO_DIR"

before="$(git rev-parse HEAD)"

git fetch --quiet origin "$BRANCH"
remote="$(git rev-parse "origin/$BRANCH")"

if [ "$before" = "$remote" ]; then
    exit 0
fi

echo "deploy: $before -> $remote"
git pull --ff-only --quiet origin "$BRANCH"

# Перезапуск обязателен: Python не перечитывает код на ходу.
systemctl restart "$SERVICE"
echo "deploy: обновлено, $SERVICE перезапущен"
