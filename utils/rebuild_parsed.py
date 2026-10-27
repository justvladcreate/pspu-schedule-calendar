"""Пересборка финального JSON из after_ai.json без Excel, Google и AI.

Идёт по папкам факультетов:

    data/faculties/<id>/latest/after_ai.json  →  parsed.json
    web/data/faculties/<id>/data.json          (публикация)

Полезно, когда надо переиграть только финализацию или overrides.

    python -m utils.rebuild_parsed
    python -m utils.rebuild_parsed --faculty 12
"""
from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path

import config  # noqa: F401  — загружает .env и настраивает логирование

from parser.faculties import paths_for
from parser.faculties.base import AFTER_AI_NAME, PARSED_NAME, read_json, rotate, write_json
from parser.finalize import transform_schedule
from parser.overrides import apply_overrides, load_overrides
from parser.publish import publish
from parser.registry import load_registry

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DATA_DIR = BASE_DIR / "web" / "data"
OVERRIDES_PATH = BASE_DIR / "overrides.yaml"


async def rebuild(faculty_ids: set[str] | None = None) -> dict[str, int]:
    period, faculties = load_registry()
    rules = load_overrides(OVERRIDES_PATH)

    rebuilt: dict[str, int] = {}
    events_by_faculty: dict[str, list[dict]] = {}
    published = []

    for faculty in faculties:
        if faculty_ids and faculty.id not in faculty_ids:
            continue

        paths = paths_for(faculty.id)
        after_ai = read_json(paths.latest_file(AFTER_AI_NAME))
        if not after_ai:
            logger.warning(
                "Нет %s — факультет %s пропущен",
                paths.latest_file(AFTER_AI_NAME), faculty.id,
            )
            continue

        parsed = await transform_schedule(after_ai, faculty_id=faculty.id)
        parsed["events"] = await apply_overrides(parsed.get("events", []), rules)

        parsed_path = paths.latest_file(PARSED_NAME)
        rotate(parsed_path)
        write_json(parsed_path, parsed)

        rebuilt[faculty.id] = len(parsed["events"])
        events_by_faculty[faculty.id] = parsed["events"]
        published.append(faculty)

    if published:
        stamp = max(
            (read_json(paths_for(f.id).latest_file(PARSED_NAME)).get("generated_at", "")
             for f in published),
            default="",
        )
        publish(WEB_DATA_DIR, published, events_by_faculty, stamp)

    return rebuilt


async def main() -> None:
    arg_parser = argparse.ArgumentParser(description=__doc__)
    arg_parser.add_argument("--faculty", action="append", default=[])
    args = arg_parser.parse_args()

    result = await rebuild(set(args.faculty) or None)
    for faculty_id, count in result.items():
        print(f"{faculty_id}: {count} событий")
    if not result:
        print("Нечего пересобирать — нет after_ai.json")


if __name__ == "__main__":
    asyncio.run(main())
