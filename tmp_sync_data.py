"""Проверка публикации в ветку data без прокси (временный скрипт)."""

import os

from parser.runner import _sync_commit_and_push

for key in list(os.environ):
    if key.upper() in {"ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"}:
        os.environ.pop(key, None)

print("result:", _sync_commit_and_push())
