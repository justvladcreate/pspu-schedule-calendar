"""Оркестрация парсера: обходит факультеты и публикует результат.

Сам разбор живёт в ``parser/faculties/<id>/parser.py`` — у каждого
факультета свой процессор, экстрактор и промпт. Здесь только общий
цикл: загрузить → разобрать → финализировать → опубликовать → закоммитить.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from parser.faculties import get_parser_class
from parser.faculties.base import PARSED_NAME, read_json, rotate, write_json
from parser.core.registry import load_registry
from parser.core.finalize import (
    fill_missing_dates,
    stamp_updated_at,
    transform_schedule,
)
from parser.core.model import Faculty
from parser.core.overrides import apply_overrides, load_overrides
from parser.core.publish import publish

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = PROJECT_ROOT / "web"
WEB_DATA_DIR = WEB_DIR / "data"
OVERRIDES_PATH = PROJECT_ROOT / "overrides.yaml"

# Данные живут отдельно от кода: ветка data и рабочее дерево для неё.
# Так коммиты парсера не мешают правкам кода и не ломают git pull.
DATA_BRANCH = "data"
DATA_WORKTREE = PROJECT_ROOT / ".data-branch"


# ================================================================
# один факультет
# ================================================================

async def process_faculty(
    faculty: Faculty,
    period,
    rules: list[dict],
) -> dict | None:
    parser_class = get_parser_class(faculty.id)
    if parser_class is None:
        logger.error(
            "Для факультета %s нет модуля парсера "
            "(parser/faculties/%s_*/parser.py)", faculty.id, faculty.id,
        )
        return None

    parser = parser_class(faculty)

    try:
        sheets = await parser.load()
    except Exception as exc:  # noqa: BLE001
        logger.exception("Факультет %s: не удалось загрузить таблицу: %s", faculty.id, exc)
        return None

    try:
        groups = await parser.parse(sheets, period)
        if parser.uses_llm and not os.environ.get("PSPU_DISABLE_LLM"):
            groups = await parser.refine(groups, period)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Факультет %s: ошибка разбора: %s", faculty.id, exc)
        return None

    # Исходную таблицу рендерим в HTML для кнопки «Оригинал» —
    # со шрифтами, цветами, рамками и объединёнными ячейками.
    # У факультета может быть несколько файлов: очное, заочное,
    # экзамены, ГИА — показываем листы всех. У гугл-факультета
    # очное берётся из Google, а сюда попадает только заочка.
    source_path = getattr(parser, "paths", None)
    if source_path is not None:
        try:
            from parser.core.original import publish_original
            from parser.sources.loader import cached_sources

            files = cached_sources(source_path.latest)
            if files:
                await asyncio.to_thread(
                    publish_original, WEB_DATA_DIR, faculty.id, files,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Факультет %s: «Оригинал» не отрендерен: %s", faculty.id, exc)

    parsed = await transform_schedule(groups, faculty_id=faculty.id)
    parsed["events"] = await apply_overrides(parsed.get("events", []), rules)
    fill_missing_dates(parsed["events"])

    latest_path = parser.paths.latest_file(PARSED_NAME)
    previous = read_json(latest_path)
    previous_events = previous.get("events", []) if isinstance(previous, dict) else []

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stamp_updated_at(
        parsed["events"],
        previous_events,
        now_iso=now_iso,
        fallback_iso=previous.get("generated_at") if isinstance(previous, dict) else None,
    )

    changed = not events_equal(previous_events, parsed["events"])

    if changed:
        logger.info(
            "Факультет %s: событий %d (было %d) — обновляю",
            faculty.id, len(parsed["events"]), len(previous_events),
        )
        rotate(latest_path)
        write_json(latest_path, parsed)
    else:
        if previous.get("generated_at"):
            parsed["generated_at"] = previous["generated_at"]
        logger.info(
            "Факультет %s: без изменений (%d событий)",
            faculty.id, len(parsed["events"]),
        )

    return parsed


def events_equal(a: list, b: list) -> bool:
    """Сравнивает события без учёта порядка и generated_at."""
    if not isinstance(a, list) or not isinstance(b, list):
        return False
    if len(a) != len(b):
        return False

    def key(event):
        return (
            str(event.get("event_id", "")),
            str(event.get("group", "")),
            str(event.get("weekday", "")),
            int(event.get("pair_number", 0) or 0),
        )

    return sorted(a, key=key) == sorted(b, key=key)


# ================================================================
# все факультеты
# ================================================================

async def process_all(
    *,
    faculty_ids: set[str] | None = None,
    publish_web: bool = True,
    git_push: bool = True,
) -> dict[str, dict]:
    """Прогоняет факультеты через их собственные модули.

    faculty_ids — ограничить набор (например, {"01"}); None = все из
    faculties.yaml.
    """
    period, faculties = load_registry()
    rules = load_overrides(OVERRIDES_PATH)

    if faculty_ids:
        faculties = [f for f in faculties if f.id in faculty_ids]

    results: dict[str, dict] = {}
    for faculty in faculties:
        if not faculty.enabled:
            logger.info("Факультет %s выключен в faculties.yaml — пропуск", faculty.id)
            continue
        parsed = await process_faculty(faculty, period, rules)
        if parsed is None:
            # Не удалось разобрать — не выбрасываем факультет с сайта,
            # оставляем последнюю опубликованную версию.
            fallback = _published(faculty.id)
            if fallback:
                logger.warning(
                    "Факультет %s: оставляю прошлую версию (%d событий)",
                    faculty.id, len(fallback.get("events", [])),
                )
                results[faculty.id] = fallback
            continue
        results[faculty.id] = parsed

    if publish_web and results:
        events_by_faculty = {
            faculty_id: parsed.get("events", [])
            for faculty_id, parsed in results.items()
        }
        published = [faculty for faculty in faculties if faculty.id in results]
        # Факультет отработал, но событий нет (например, файл прошлого
        # года) — убираем его из индекса.
        drop_ids = {
            faculty_id
            for faculty_id, parsed in results.items()
            if not parsed.get("events")
        }
        publish(
            WEB_DATA_DIR,
            published,
            events_by_faculty,
            _stamp(results),
            drop_ids=drop_ids,
        )

        if git_push:
            await commit_and_push()

    return results


def _published(faculty_id: str) -> dict:
    path = WEB_DATA_DIR / "faculties" / faculty_id / "data.json"
    return read_json(path)


def _stamp(results: dict[str, dict]) -> str:
    """Версия публикации: самая свежая из версий факультетов."""
    stamps = [
        parsed.get("generated_at", "")
        for parsed in results.values()
        if parsed.get("generated_at")
    ]
    return max(stamps) if stamps else ""


# ================================================================
# git
# ================================================================

def _git(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd or PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _sync_pull() -> bool:
    """Подтягивает origin перед прогоном.

    Без этого копия репозитория может быть старой: парсер опубликует
    устаревшие данные, а пуш либо отклонится, либо создаст merge,
    который вернёт расписание назад.
    """
    pull = _git("pull", "--ff-only")
    if pull.returncode != 0:
        logger.warning(
            "git pull --ff-only не удался: %s",
            (pull.stderr or pull.stdout).strip(),
        )
        return False
    logger.info("Репозиторий обновлён из origin")
    return True


# ------------------------------------------------------------------ data-ветка

def _clear_dir(path: Path) -> None:
    """Удаляет содержимое каталога, не трогая .git рабочего дерева."""
    for entry in path.iterdir():
        if entry.name == ".git":
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)


def _copy_tree(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for entry in src.iterdir():
        target = dst / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, target)


def _data_worktree() -> Path | None:
    """Рабочее дерево ветки ``data`` (создаётся при первом прогоне).

    Каталог ``.data-branch`` лежит рядом с кодом, но это отдельное
    рабочее дерево git: коммиты данных не касаются ``main``.
    """
    if (DATA_WORKTREE / ".git").exists():
        _git("fetch", "--quiet", "origin", DATA_BRANCH)
        if _git("rev-parse", "--verify", f"origin/{DATA_BRANCH}").returncode == 0:
            _git("reset", "--hard", f"origin/{DATA_BRANCH}", cwd=DATA_WORKTREE)
        return DATA_WORKTREE

    if DATA_WORKTREE.exists():
        shutil.rmtree(DATA_WORKTREE, ignore_errors=True)

    _git("fetch", "--quiet", "origin", DATA_BRANCH)
    has_remote = (
        _git("rev-parse", "--verify", f"origin/{DATA_BRANCH}").returncode == 0
    )

    if has_remote:
        add = _git(
            "worktree", "add", "--force", "-B", DATA_BRANCH,
            str(DATA_WORKTREE), f"origin/{DATA_BRANCH}",
        )
    else:
        # Первый прогон: ветки ещё нет. Делаем осиротевшую ветку,
        # чтобы в ней не было истории кода.
        add = _git("worktree", "add", "--detach", str(DATA_WORKTREE))
        if add.returncode == 0:
            _git("checkout", "--orphan", DATA_BRANCH, cwd=DATA_WORKTREE)
            _git("rm", "-rf", "--cached", ".", cwd=DATA_WORKTREE)
            _git("rm", "-rf", ".", cwd=DATA_WORKTREE)

    if add.returncode != 0:
        logger.error(
            "Не удалось создать рабочее дерево ветки %s: %s",
            DATA_BRANCH, (add.stderr or add.stdout).strip(),
        )
        return None

    return DATA_WORKTREE


def _write_data_commit(worktree: Path) -> bool:
    """Копирует web/data в ветку data и коммитит. True — если был коммит."""
    _clear_dir(worktree)
    _copy_tree(WEB_DATA_DIR, worktree / "web" / "data")

    # GitHub запускает воркфлоу только из той ветки, куда пришёл push.
    # В ветке data нет кода, поэтому кладём туда диспетчер: он запускает
    # сборку страниц на main (деплой с data запрещён политикой окружения).
    workflow = PROJECT_ROOT / ".github" / "workflows" / "dispatch-pages.yml"
    if workflow.exists():
        target = worktree / ".github" / "workflows" / "dispatch-pages.yml"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(workflow, target)

    _git("add", "-A", cwd=worktree)
    if _git("diff", "--cached", "--quiet", cwd=worktree).returncode == 0:
        return False

    commit = _git("commit", "-m", "data: update schedule", cwd=worktree)
    if commit.returncode != 0:
        logger.error("git commit (data): %s", commit.stderr.strip())
        return False
    return True


def _push_data(worktree: Path) -> bool:
    """Пушит ветку data с повторами.

    Сеть на сервере бывает нестабильной (DNS/туннель). Пуш не должен
    терять уже собранные данные: до трёх попыток с паузой, а между
    ними — перечитывание ветки на случай, если её обогнали.
    """
    for attempt in range(1, 4):
        push = _git("push", "origin", f"HEAD:{DATA_BRANCH}", cwd=worktree)
        if push.returncode == 0:
            logger.info("Расписание опубликовано в ветку %s", DATA_BRANCH)
            return True

        logger.warning(
            "git push (data), попытка %d из 3: %s",
            attempt, (push.stderr or push.stdout).strip()[:300],
        )

        fetch = _git("fetch", "--quiet", "origin", DATA_BRANCH, cwd=worktree)
        if fetch.returncode == 0:
            _git("reset", "--hard", f"origin/{DATA_BRANCH}", cwd=worktree)
            _write_data_commit(worktree)

        if attempt < 3:
            time.sleep(5 * attempt)

    logger.error(
        "git push (data): не удалось за 3 попытки, данные останутся "
        "в .data-branch до следующего прогона"
    )
    return False


def _restore_data_snapshot() -> None:
    """Подкладывает последние опубликованные данные в ``web/data``.

    После ``git pull`` (или на свежем клоне) рабочее дерево пустое,
    а ``publish()`` опирается на прошлый ``index.json``: без него
    факультет, который в этом прогоне не разобрался, исчез бы с сайта
    вместе со своими событиями. Источник — ветка ``data``.
    """
    worktree = _data_worktree()
    if worktree is None:
        return

    source = worktree / "web" / "data"
    if not source.exists():
        return

    if WEB_DATA_DIR.exists():
        _clear_dir(WEB_DATA_DIR)
    _copy_tree(source, WEB_DATA_DIR)
    logger.info("Данные из ветки %s подложены в web/data", DATA_BRANCH)


def _up_to_date(worktree: Path) -> bool:
    """Совпадает ли HEAD рабочего дерева с origin/data."""
    head = _git("rev-parse", "HEAD", cwd=worktree)
    remote = _git("rev-parse", f"origin/{DATA_BRANCH}", cwd=worktree)
    if head.returncode != 0:
        return True
    if remote.returncode != 0:
        # Ветки на origin ещё нет — пушить точно надо.
        return False
    return head.stdout.strip() == remote.stdout.strip()


def _sync_commit_and_push() -> bool:
    worktree = _data_worktree()
    if worktree is None:
        return False

    changed = _write_data_commit(worktree)

    # Коммита нет, но прошлый пуш мог не дойти (сеть) — тогда ветка
    # на origin отстаёт, и её нужно дослать.
    if not changed and _up_to_date(worktree):
        logger.info("Нет изменений для коммита")
        return False

    return _push_data(worktree)


async def commit_and_push() -> bool:
    return await asyncio.to_thread(_sync_commit_and_push)


async def process_schedule(
    faculty_ids: set[str] | None = None,
    publish_web: bool = True,
    git_push: bool = True,
) -> dict | None:
    """Точка входа: обходит факультеты и возвращает сводку."""
    logger.info(
        "Обработка расписания (факультеты=%s, publish_web=%s, git_push=%s)",
        ", ".join(sorted(faculty_ids)) if faculty_ids else "все",
        publish_web,
        git_push,
    )

    # Автопубликация: сначала синхронизируемся с origin, иначе старая
    # копия может опубликовать устаревшее расписание.
    if git_push:
        await asyncio.to_thread(_sync_pull)
        # Рабочее дерево после pull может быть пустым — подкладываем
        # прошлый снимок, иначе выпавший факультет исчезнет с сайта.
        await asyncio.to_thread(_restore_data_snapshot)

    results = await process_all(
        faculty_ids=faculty_ids,
        publish_web=publish_web,
        git_push=git_push,
    )
    if not results:
        logger.error("Не удалось разобрать ни один факультет")
        return None

    total = sum(len(parsed.get("events", [])) for parsed in results.values())
    logger.info("Готово: факультетов %d, событий %d", len(results), total)
    return {"faculties": results, "events": total}
