"""
Публикация данных расписания на GitHub Pages.

Копирует:
  • data/latest/groups_info_parsed.json → docs/data.json
  • data/old/groups_info_parsed.json    → docs/old_data.json  (если есть)
  • README.md                            → docs/readme.md      (если есть)

Затем git add / commit / push — только если есть изменения.

Запуск:
  • Как часть пайплайна — вызывается из parser/process.py
  • Вручную — правый клик по файлу → Run
"""
import asyncio
import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent

PARSED_JSON       = BASE_DIR / "data" / "latest" / "groups_info_parsed.json"
OLD_PARSED_JSON   = BASE_DIR / "data" / "old"    / "groups_info_parsed.json"
README_MD         = BASE_DIR / "README.md"

WEB_DATA_JSON     = BASE_DIR / "docs" / "data.json"
WEB_OLD_DATA_JSON = BASE_DIR / "docs" / "old_data.json"
WEB_README_MD     = BASE_DIR / "docs" / "readme.md"

COMMIT_MESSAGE = "chore: update web data"


def _run_git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=BASE_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def publish_web_sync() -> dict:
    result = {
        "copied_current": False,
        "copied_old":     False,
        "copied_readme":  False,
        "committed":      False,
        "pushed":         False,
        "reason":         "",
    }

    if not PARSED_JSON.exists():
        result["reason"] = f"Нет исходного файла: {PARSED_JSON}"
        logger.error(result["reason"])
        return result

    # 1. Текущая версия
    try:
        WEB_DATA_JSON.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PARSED_JSON, WEB_DATA_JSON)
        result["copied_current"] = True
    except OSError as e:
        result["reason"] = f"Ошибка копирования data.json: {e}"
        logger.error(result["reason"])
        return result

    files_to_add = ["docs/data.json"]

    # 2. Прошлая версия (если есть)
    if OLD_PARSED_JSON.exists():
        try:
            shutil.copyfile(OLD_PARSED_JSON, WEB_OLD_DATA_JSON)
            result["copied_old"] = True
            files_to_add.append("docs/old_data.json")
        except OSError as e:
            logger.warning(f"Не удалось скопировать old_data.json: {e}")

    # 3. readme.md для модалки
    if README_MD.exists():
        try:
            shutil.copyfile(README_MD, WEB_README_MD)
            result["copied_readme"] = True
            files_to_add.append("docs/readme.md")
        except OSError as e:
            logger.warning(f"Не удалось скопировать readme.md: {e}")

    # 4. git add
    add = _run_git("add", *files_to_add)
    if add.returncode != 0:
        result["reason"] = f"git add: {add.stderr.strip()}"
        logger.error(result["reason"])
        return result

    # 5. Есть ли что коммитить
    diff = _run_git("diff", "--cached", "--quiet", "--", *files_to_add)
    if diff.returncode == 0:
        result["reason"] = "Изменений нет — коммит не нужен"
        logger.info(result["reason"])
        return result

    # 6. commit
    commit = _run_git("commit", "-m", COMMIT_MESSAGE, "--", *files_to_add)
    if commit.returncode != 0:
        result["reason"] = f"git commit: {commit.stderr.strip()}"
        logger.error(result["reason"])
        return result
    result["committed"] = True

    # 7. push
    push = _run_git("push")
    if push.returncode != 0:
        result["reason"] = f"git push: {push.stderr.strip()}"
        logger.error(result["reason"])
        return result
    result["pushed"] = True

    logger.info("web-данные обновлены и запушены")
    return result


async def publish_web() -> dict:
    return await asyncio.to_thread(publish_web_sync)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )
    res = publish_web_sync()
    print(res)