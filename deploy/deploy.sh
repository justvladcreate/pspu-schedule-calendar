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

# Миграция со старой схемы: раньше web/data лежал в main. Теперь он
# живёт в ветке data, а в рабочем дереве это только кэш парсера.
# Проверяем, отслеживается ли файл, — после перехода на data-ветку
# эта ветка просто не сработает и ничего не удалит.
if git ls-files --error-unmatch web/data/index.json >/dev/null 2>&1; then
    git checkout -- web/data 2>/dev/null || true
fi

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
