"""Публикация данных по факультетам: index.json + faculties/<id>.json."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from parser.model import Faculty

SCHEMA_VERSION = 2


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(path)


def _rotate(path: Path) -> None:
    if not path.exists():
        return
    old = path.parent / "old" / path.name
    old.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, old)


def publish_faculty_data(
    output_dir: Path,
    faculties: list[Faculty],
    events_by_faculty: dict[str, list[dict]],
    generated_at: str,
) -> Path:
    """
    Пишет:
      output_dir/index.json
      output_dir/faculties/<id>.json
      output_dir/faculties/old/<id>.json
    """
    output_dir = Path(output_dir)
    faculties_dir = output_dir / "faculties"
    faculties_dir.mkdir(parents=True, exist_ok=True)

    index_faculties = []
    for faculty in faculties:
        events = list(events_by_faculty.get(faculty.id, []))
        for event in events:
            event.setdefault("faculty_id", faculty.id)
            event.setdefault("faculty_name", faculty.name)

        groups = sorted({
            str(event.get("group"))
            for event in events
            if event.get("group") is not None
        })
        relative = f"faculties/{faculty.id}.json"
        payload = {
            "schema_version": SCHEMA_VERSION,
            "faculty": {
                "id": faculty.id,
                "name": faculty.name,
                "short": faculty.short,
            },
            "generated_at": generated_at,
            "groups": groups,
            "events": events,
        }

        target = faculties_dir / f"{faculty.id}.json"
        _rotate(target)
        _write_json(target, payload)

        index_faculties.append({
            "id": faculty.id,
            "name": faculty.name,
            "short": faculty.short,
            "file": relative,
            "groups": groups,
            "events": len(events),
        })

    index = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "faculties": index_faculties,
    }
    index_path = output_dir / "index.json"
    _rotate(index_path)
    _write_json(index_path, index)
    return index_path
