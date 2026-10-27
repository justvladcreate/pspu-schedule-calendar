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
import subprocess
from pathlib import Path

from parser.faculties import get_parser_class
from parser.faculties.base import PARSED_NAME, read_json, rotate, write_json
from parser.core.registry import load_registry
from parser.core.finalize import transform_schedule
from parser.core.model import Faculty
from parser.core.overrides import apply_overrides, load_overrides
from parser.core.publish import publish

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = PROJECT_ROOT / "web"
WEB_DATA_DIR = WEB_DIR / "data"
OVERRIDES_PATH = PROJECT_ROOT / "overrides.yaml"


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
    source_path = getattr(parser, "paths", None)
    if source_path is not None:
        try:
            from parser.core.original import publish_original
            from parser.faculties.base import SOURCE_NAME

            await asyncio.to_thread(
                publish_original,
                WEB_DATA_DIR,
                faculty.id,
                source_path.latest_file(SOURCE_NAME),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Факультет %s: «Оригинал» не отрендерен: %s", faculty.id, exc)

    parsed = await transform_schedule(groups, faculty_id=faculty.id)
    parsed["events"] = await apply_overrides(parsed.get("events", []), rules)

    latest_path = parser.paths.latest_file(PARSED_NAME)
    previous = read_json(latest_path)
    previous_events = previous.get("events", []) if isinstance(previous, dict) else []
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

def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _sync_commit_and_push() -> bool:
    add = _git("add", "web/data")
    if add.returncode != 0:
        logger.error("git add: %s", add.stderr.strip())
        return False

    if _git("diff", "--cached", "--quiet").returncode == 0:
        logger.info("Нет изменений для коммита")
        return False

    commit = _git("commit", "-m", "chore: update schedule")
    if commit.returncode != 0:
        logger.error("git commit: %s", commit.stderr.strip())
        return False

    push = _git("push")
    if push.returncode != 0:
        logger.error("git push: %s", push.stderr.strip())
        return False

    logger.info("Расписание закоммичено и запушено")
    return True


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
