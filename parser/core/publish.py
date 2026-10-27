"""Публикация расписания по факультетам.

Раскладка на фронте:

    web/data/index.json
    web/data/faculties/<id>/data.json
    web/data/faculties/<id>/old_data.json
    web/data/faculties/<id>/source.xlsx    (кладёт CI)

Версия факультета (``generated_at``) меняется только когда меняются его
события — по ней фронтенд и push-воркер понимают, что обновилось.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from parser.core.model import Faculty

SCHEMA_VERSION = 2


def _text(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write(path: Path, text: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if _read(path) == text:
        return False
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return True


def faculty_original(faculty: Faculty) -> dict:
    original: dict = {"type": faculty.source.type, "url": faculty.source.url}
    if faculty.source.type == "google_sheets":
        original["spreadsheet_id"] = faculty.source.spreadsheet_id
    else:
        original["file"] = "source.xlsx"
    return original


def publish_faculty(
    web_data_dir: Path,
    faculty: Faculty,
    events: list[dict],
    generated_at: str,
) -> bool:
    """Пишет data.json (+ old_data.json) факультета. True — если изменилось."""
    web_data_dir = Path(web_data_dir)
    folder = web_data_dir / "faculties" / faculty.id
    folder.mkdir(parents=True, exist_ok=True)

    events = [dict(event) for event in events]
    for event in events:
        event.setdefault("faculty_id", faculty.id)
        event.setdefault("faculty_name", faculty.name)

    groups = sorted({
        str(event.get("group"))
        for event in events
        if event.get("group") is not None
    })

    data_path = folder / "data.json"
    prepared = {
        "schema_version": SCHEMA_VERSION,
        "faculty": {
            "id": faculty.id,
            "name": faculty.name,
            "short": faculty.short,
        },
        "generated_at": _read_json(data_path).get("generated_at", ""),
        "groups": groups,
        "events": events,
    }

    if _text(prepared) == _read(data_path):
        return False

    # Предыдущую версию — в old_data.json
    previous = _read(data_path)
    if previous:
        old_path = folder / "old_data.json"
        old_path.write_text(previous, encoding="utf-8")

    prepared["generated_at"] = generated_at
    _write(data_path, _text(prepared))
    return True


def publish(
    web_data_dir: Path,
    faculties: list[Faculty],
    events_by_faculty: dict[str, list[dict]],
    generated_at: str,
    *,
    drop_ids: set[str] | None = None,
) -> Path:
    """Публикует факультеты и обновляет index.json.

    Факультеты, которых нет в этом прогоне, остаются в индексе как были —
    так частичный прогон (`--faculty 01`) не стирает остальных.
    ``drop_ids`` — факультеты, которые прогон отработал и оставил пустыми.
    """
    web_data_dir = Path(web_data_dir)
    index_path = web_data_dir / "index.json"
    previous_index = _read_json(index_path)
    drop_ids = set(drop_ids or ())

    stamp = generated_at or datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Сохраняем порядок прошлого индекса, убираем выбывшие.
    ordered_ids: list[str] = [
        entry["id"]
        for entry in previous_index.get("faculties", [])
        if entry.get("id") and entry["id"] not in drop_ids
    ]
    entries: dict[str, dict] = {
        entry["id"]: entry
        for entry in previous_index.get("faculties", [])
        if entry.get("id") and entry["id"] not in drop_ids
    }

    changed_any = False

    for faculty in faculties:
        events = events_by_faculty.get(faculty.id) or []
        if not events:
            continue

        changed = publish_faculty(web_data_dir, faculty, events, stamp)
        changed_any = changed_any or changed

        data_path = web_data_dir / "faculties" / faculty.id / "data.json"
        payload = _read_json(data_path)
        entries[faculty.id] = {
            "id": faculty.id,
            "name": faculty.name,
            "short": faculty.short,
            "folder": f"faculties/{faculty.id}",
            "groups": payload.get("groups", []),
            "events": len(payload.get("events", [])),
            "generated_at": payload.get("generated_at", ""),
            "original": faculty_original(faculty),
        }
        if faculty.id not in ordered_ids:
            ordered_ids.append(faculty.id)

    for faculty_id in drop_ids:
        if faculty_id in entries:
            entries.pop(faculty_id, None)

    if changed_any and previous_index.get("generated_at") == stamp:
        # ИНЭК не менялся, но другой факультет обновился.
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    index = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": stamp,
        "faculties": [entries[fid] for fid in ordered_ids if fid in entries],
    }
    _write(index_path, _text(index))
    return index_path
