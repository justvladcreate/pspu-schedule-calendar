#!/usr/bin/env bash
# Автодеплой на hp-server: подтянуть main и перезапустить парсер.
#
# Ставится в cron/systemd timer (см. deploy/README.md). Запускается от
# serveradmin: у root нет доступа к репозиторию и ssh-алиасу github-pspu.
# Перезапуск сервиса разрешён через /etc/sudoers.d/pspu-deploy.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/serveradmin/pspu-schedule-calendar}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-pspu-schedule-calendar.service}"

cd "$REPO_DIR"

# Локальная публикация (web/data) не должна блокировать деплой:
# сервис всё равно пересоберёт данные после перезапуска.
git checkout -- web/data 2>/dev/null || true

before="$(git rev-parse HEAD)"

git fetch --quiet origin "$BRANCH"
remote="$(git rev-parse "origin/$BRANCH")"

if [ "$before" = "$remote" ]; then
    exit 0
fi

echo "deploy: $before -> $remote"
git pull --ff-only --quiet origin "$BRANCH"

# Перезапуск обязателен: Python не перечитывает код на ходу.
# Сервис деплоя работает от serveradmin, поэтому нужен NOPASSWD-доступ
# только к этой команде (см. deploy/README.md).
sudo -n systemctl restart "$SERVICE"
echo "deploy: обновлено, $SERVICE перезапущен"
