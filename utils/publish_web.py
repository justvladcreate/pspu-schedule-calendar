"""
Публикация данных расписания на GitHub Pages.

Логика:
  1. Копирует data/latest/groups_info_parsed.json → web/data.json
  2. git add web/data.json
  3. Если есть изменения — git commit + git push
  4. Если изменений нет — ничего не делает (не плодит пустые коммиты)

Требует, чтобы у сервера был настроен git-push (SSH-ключ или PAT)
и рабочая копия репозитория.

Запуск:
  • Как часть пайплайна — вызывается из parser/process.py
  • Вручную из PyCharm — правый клик по файлу → Run
"""
import asyncio
import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

BASE_DIR       = Path(__file__).resolve().parent.parent
PARSED_JSON    = BASE_DIR / "data" / "latest" / "groups_info_parsed.json"
WEB_DATA_JSON  = BASE_DIR / "docs" / "data.json"
COMMIT_MESSAGE = "chore: update web/data.json"


def _run_git(*args: str) -> subprocess.CompletedProcess:
    """Запуск git-команды в корне проекта."""
    return subprocess.run(
        ["git", *args],
        cwd=BASE_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def publish_web_sync() -> dict:
    """Синхронная версия. Возвращает статистику."""
    result = {
        "copied":    False,
        "committed": False,
        "pushed":    False,
        "reason":    "",
    }

    if not PARSED_JSON.exists():
        result["reason"] = f"Нет исходного файла: {PARSED_JSON}"
        logger.error(result["reason"])
        return result

    # 1. Копирование
    try:
        WEB_DATA_JSON.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PARSED_JSON, WEB_DATA_JSON)
        result["copied"] = True
    except OSError as e:
        result["reason"] = f"Ошибка копирования: {e}"
        logger.error(result["reason"])
        return result

    # 2. git add
    rel_path = WEB_DATA_JSON.relative_to(BASE_DIR).as_posix()
    add = _run_git("add", rel_path)
    if add.returncode != 0:
        result["reason"] = f"git add: {add.stderr.strip()}"
        logger.error(result["reason"])
        return result

    # 3. Проверка: есть ли что коммитить
    diff = _run_git("diff", "--cached", "--quiet", "--", rel_path)
    if diff.returncode == 0:
        result["reason"] = "Изменений нет — коммит не нужен"
        logger.info(result["reason"])
        return result

    # 4. git commit
    commit = _run_git("commit", "-m", COMMIT_MESSAGE, "--", rel_path)
    if commit.returncode != 0:
        result["reason"] = f"git commit: {commit.stderr.strip()}"
        logger.error(result["reason"])
        return result
    result["committed"] = True

    # 5. git push
    push = _run_git("push")
    if push.returncode != 0:
        result["reason"] = f"git push: {push.stderr.strip()}"
        logger.error(result["reason"])
        return result
    result["pushed"] = True

    logger.info("web/data.json обновлён и запушен")
    return result


async def publish_web() -> dict:
    """Асинхронная обёртка — git синхронный, уносим в поток."""
    return await asyncio.to_thread(publish_web_sync)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )
    res = publish_web_sync()
    print(res)