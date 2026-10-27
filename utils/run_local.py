"""Локальный прогон парсера по всем факультетам.

Запускает у каждого факультета его собственный модуль
(`parser/faculties/<id>_*/parser.py`), обновляет `web/data/`, но по
умолчанию **не** делает git commit/push.

Примеры:

    python -m utils.run_local
    python -m utils.run_local --faculty 01 --faculty 12
    python -m utils.run_local --no-publish          # только data/faculties/
    python -m utils.run_local --git-push            # обновить сайт и запушить
    python -m utils.run_local --source xlsx         # ИНЭК брать из XLSX Drive
    python -m utils.run_local --list                # показать факультеты

Из кода:

    from utils.run_local import run
    await run(faculty_ids={"01"}, publish=False)
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

import config  # noqa: F401  — загружает .env и настраивает логирование

from parser.core.registry import load_registry
from parser.faculties import available_faculties
from parser.runner import process_schedule

logger = logging.getLogger(__name__)


async def run(
    *,
    faculty_ids: set[str] | None = None,
    publish: bool = True,
    git_push: bool = False,
    source: str | None = None,
) -> dict[str, int]:
    """Прогоняет факультеты. Возвращает {id: количество событий}."""
    if source:
        os.environ["SCHEDULE_SOURCE"] = source

    logger.info(
        "Локальный прогон: факультеты=%s, publish=%s, git_push=%s",
        ", ".join(sorted(faculty_ids)) if faculty_ids else "все",
        publish,
        git_push,
    )

    result = await process_schedule(
        faculty_ids=faculty_ids,
        publish_web=publish,
        git_push=git_push,
    )
    if result is None:
        logger.error("Пайплайн не вернул результат — смотри логи выше")
        return {}

    counts = {
        faculty_id: len(parsed.get("events", []))
        for faculty_id, parsed in result["faculties"].items()
    }

    for faculty_id, count in sorted(counts.items()):
        logger.info("Факультет %s: %d событий", faculty_id, count)
    logger.info("Всего событий: %d", result["events"])

    if publish:
        logger.info("Опубликовано в web/data/ (git push: %s)", "да" if git_push else "нет")
    else:
        logger.info("Публикация отключена — обновлены только data/faculties/")

    return counts


def _print_faculties() -> None:
    _, faculties = load_registry()
    print("Факультеты из faculties.yaml:")
    for faculty in faculties:
        state = "вкл" if faculty.enabled else "выкл"
        parser = "есть" if faculty.id in available_faculties() else "НЕТ МОДУЛЯ"
        print(
            f"  {faculty.id}  {faculty.short:<24} "
            f"{faculty.source.type:<14} {state:<4} парсер: {parser}"
        )


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Локальный прогон парсера расписания по факультетам",
    )
    parser.add_argument(
        "--faculty", "-f", action="append", default=[], metavar="ID",
        help="id факультета; можно несколько раз (по умолчанию — все)",
    )
    parser.add_argument(
        "--no-publish", action="store_true",
        help="не обновлять web/data/ (только data/faculties/)",
    )
    parser.add_argument(
        "--git-push", action="store_true",
        help="закоммитить и запушить изменения web/data/",
    )
    parser.add_argument(
        "--source", choices=["google", "xlsx"], default=None,
        help="источник ИНЭК: Google Sheets API или экспорт XLSX",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="показать факультеты и выйти",
    )
    return parser.parse_args(argv)


def _setup_console_logging() -> None:
    """Добавляет вывод в консоль, если config оставил только файл."""
    root = logging.getLogger()
    has_console = any(
        isinstance(handler, logging.StreamHandler)
        and not isinstance(handler, logging.FileHandler)
        for handler in root.handlers
    )
    if not has_console:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")
        )
        root.addHandler(handler)
    root.setLevel(logging.INFO)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    if args.list:
        _print_faculties()
        return 0

    _setup_console_logging()

    faculty_ids = set(args.faculty) or None
    if faculty_ids:
        _, faculties = load_registry()
        known = {faculty.id for faculty in faculties}
        unknown = faculty_ids - known
        if unknown:
            print(
                f"Неизвестные факультеты: {', '.join(sorted(unknown))}. "
                f"Доступны: {', '.join(sorted(known))}",
                file=sys.stderr,
            )
            return 2

    try:
        counts = asyncio.run(run(
            faculty_ids=faculty_ids,
            publish=not args.no_publish,
            git_push=args.git_push,
            source=args.source,
        ))
    except KeyboardInterrupt:
        logger.info("Прервано по Ctrl+C")
        return 130

    return 0 if counts else 1


if __name__ == "__main__":
    raise SystemExit(main())
