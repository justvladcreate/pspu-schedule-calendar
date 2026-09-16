"""
Публикация web-версии расписания на GitHub Pages (ветка gh-pages).

Собирает содержимое ветки gh-pages из:
  • web/                                 → index.html, style.css, app.js, readme.md,
                                            .nojekyll, favicons — копируется целиком как есть
  • data/latest/groups_info_parsed.json  → data.json
  • data/old/groups_info_parsed.json     → old_data.json  (если есть)

Файл readme.md в web/ — редактируется вручную и публикуется как есть.
Файл README.md в корне — это readme для GitHub, он в публикацию не попадает.

Запись идёт в git worktree, привязанный к ветке gh-pages.
Если worktree ещё не создан — скрипт его создаст.

Запуск:
  • Как часть пайплайна — вызывается из parser/process.py
  • Вручную — python -m utils.publish_web
"""
import asyncio
import json
import logging
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

BASE_DIR        = Path(__file__).resolve().parent.parent
WEB_SRC_DIR     = BASE_DIR / "web"
WORKTREE_DIR    = BASE_DIR / ".worktree-gh-pages"

PARSED_JSON     = BASE_DIR / "data" / "latest" / "groups_info_parsed.json"
OLD_PARSED_JSON = BASE_DIR / "data" / "old"    / "groups_info_parsed.json"

GH_PAGES_BRANCH = "gh-pages"
COMMIT_MESSAGE  = "chore: publish web"

# Файлы внутри web/, которые НЕ должны копироваться как есть:
# они либо генерируются из data/, либо являются устаревшими именами.
GENERATED_IN_WEB = {"data.json", "old_data.json", "about.md"}


# ---------------------------------------------------------------- git helpers

def _run_git(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd or BASE_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _branch_exists(name: str) -> bool:
    return _run_git("rev-parse", "--verify", name).returncode == 0


def _ensure_worktree() -> None:
    """Создаёт worktree для gh-pages, если его ещё нет."""
    if WORKTREE_DIR.exists():
        return

    if _branch_exists(GH_PAGES_BRANCH):
        r = _run_git("worktree", "add", str(WORKTREE_DIR), GH_PAGES_BRANCH)
    else:
        r = _run_git(
            "worktree", "add", "--orphan",
            "-b", GH_PAGES_BRANCH, str(WORKTREE_DIR),
        )

    if r.returncode != 0:
        raise RuntimeError(f"git worktree add: {r.stderr.strip()}")


# ---------------------------------------------------------------- сборка

def _clear_worktree_content() -> None:
    """Удаляет всё содержимое worktree, кроме .git."""
    for child in WORKTREE_DIR.iterdir():
        if child.name == ".git":
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def _write_old_data_with_generated_at(target: Path) -> None:
    """old_data.json с гарантированным generated_at (из mtime файла)."""
    raw = OLD_PARSED_JSON.read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        shutil.copyfile(OLD_PARSED_JSON, target)
        return

    if not data.get("generated_at"):
        mtime = OLD_PARSED_JSON.stat().st_mtime
        dt = datetime.fromtimestamp(mtime, tz=timezone.utc)
        data["generated_at"] = dt.isoformat(timespec="seconds")

    target.write_text(
        json.dumps(data, ensure_ascii=False, indent=4),
        encoding="utf-8",
    )


def _build_gh_pages_content() -> None:
    """Заполняет worktree: web/ + сгенерированные файлы."""
    _clear_worktree_content()

    # 1. Всё содержимое web/ — как есть (включая ручной readme.md)
    for src in WEB_SRC_DIR.iterdir():
        if src.name in GENERATED_IN_WEB:
            continue
        if src.is_dir():
            shutil.copytree(src, WORKTREE_DIR / src.name, dirs_exist_ok=True)
        else:
            shutil.copyfile(src, WORKTREE_DIR / src.name)

    # 2. data.json (текущая версия)
    shutil.copyfile(PARSED_JSON, WORKTREE_DIR / "data.json")

    # 3. old_data.json (прошлая версия)
    if OLD_PARSED_JSON.exists():
        _write_old_data_with_generated_at(WORKTREE_DIR / "old_data.json")


# ---------------------------------------------------------------- публикация

def publish_web_sync() -> dict:
    result = {
        "copied_current": False,
        "copied_old":     False,
        "committed":      False,
        "pushed":         False,
        "reason":         "",
    }

    if not PARSED_JSON.exists():
        result["reason"] = f"Нет исходного файла: {PARSED_JSON}"
        logger.error(result["reason"])
        return result

    if not WEB_SRC_DIR.exists():
        result["reason"] = f"Нет папки web/: {WEB_SRC_DIR}"
        logger.error(result["reason"])
        return result

    try:
        _ensure_worktree()
    except RuntimeError as e:
        result["reason"] = str(e)
        logger.error(result["reason"])
        return result

    try:
        _build_gh_pages_content()
        result["copied_current"] = True
        result["copied_old"]     = OLD_PARSED_JSON.exists()
    except OSError as e:
        result["reason"] = f"Ошибка копирования: {e}"
        logger.error(result["reason"])
        return result

    add = _run_git("add", "-A", cwd=WORKTREE_DIR)
    if add.returncode != 0:
        result["reason"] = f"git add: {add.stderr.strip()}"
        logger.error(result["reason"])
        return result

    diff = _run_git("diff", "--cached", "--quiet", cwd=WORKTREE_DIR)
    if diff.returncode == 0:
        result["reason"] = "Изменений нет — коммит не нужен"
        logger.info(result["reason"])
        return result

    commit = _run_git("commit", "-m", COMMIT_MESSAGE, cwd=WORKTREE_DIR)
    if commit.returncode != 0:
        result["reason"] = f"git commit: {commit.stderr.strip()}"
        logger.error(result["reason"])
        return result
    result["committed"] = True

    # push: gh-pages — синтетическая ветка, её содержимое полностью
    # определяется этим скриптом, поэтому перезаписываем remote.
    # --force-with-lease защищает от перезаписи, если между fetch'ем
    # и push'ем кто-то (или GitHub UI) успел что-то дописать.
    _run_git("fetch", "origin", GH_PAGES_BRANCH, cwd=WORKTREE_DIR)

    push = _run_git(
        "push", "--force-with-lease", "-u", "origin", GH_PAGES_BRANCH,
        cwd=WORKTREE_DIR,
    )
    if push.returncode != 0:
        result["reason"] = f"git push: {push.stderr.strip()}"
        logger.error(result["reason"])
        return result
    result["pushed"] = True

    logger.info("web опубликован в gh-pages")
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