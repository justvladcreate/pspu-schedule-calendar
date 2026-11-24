# Автодеплой на hp-server

Сервер сам тянет `main` и перезапускает парсер, когда в GitHub появляется
новый коммит. Входящие соединения не нужны — сервер только опрашивает GitHub.

## Установка (один раз)

```bash
cd ~/pspu-schedule-calendar

sudo tee /etc/systemd/system/pspu-deploy.service >/dev/null <<'EOF'
[Unit]
Description=Deploy latest schedule code from GitHub

[Service]
Type=oneshot
ExecStart=/home/serveradmin/pspu-schedule-calendar/deploy/deploy.sh
EOF

sudo tee /etc/systemd/system/pspu-deploy.timer >/dev/null <<'EOF'
[Unit]
Description=Check GitHub for new schedule code every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=pspu-deploy.service

[Install]
WantedBy=timers.target
EOF

sudo chmod +x deploy/deploy.sh
sudo systemctl daemon-reload
sudo systemctl enable --now pspu-deploy.timer
```

Проверка:

```bash
systemctl list-timers pspu-deploy.timer --no-pager
sudo systemctl start pspu-deploy.service
journalctl -u pspu-deploy.service -n 20 --no-pager
```

Вывод `deploy: <sha> -> <sha>` и «перезапущен» означает, что деплой сработал.
Если коммит не менялся, сервис молча выходит (в журнале пусто).

## Как это работает

`deploy/deploy.sh` сравнивает локальный `HEAD` с `origin/main`. Если они
совпадают — ничего не делает. Если появился новый коммит — делает
`git pull --ff-only` и `systemctl restart pspu-schedule-calendar.service`
(без перезапуска Python продолжает работать со старым кодом).

## Важно

- деплой следит за веткой **main**. Пока правки живут в
  `feature/multi-source-schedule`, автодеплой их не увидит — нужно смержить;
- `pspu-deploy.service` работает от root (нужен перезапуск сервиса);
- если нужно деплоить другую ветку, поправьте `BRANCH=` в `deploy.sh`;
- локальные изменения на сервере (`data/`, `private/`) не мешают: они в
  `.gitignore`, `git pull --ff-only` их не трогает.
