"""Публикация данных по факультетам: index.json + faculties/<id>.json."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from parser.model import Faculty

SCHEMA_VERSION = 2


def _json_text(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_with_rotation(path: Path, text: str) -> bool:
    """Пишет файл, если содержимое изменилось. Прошлую версию — в old/."""
    path.parent.mkdir(parents=True, exist_ok=True)
    previous = _read_text(path)
    if previous == text:
        return False
    if previous:
        old = path.parent / "old" / path.name
        old.parent.mkdir(parents=True, exist_ok=True)
        old.write_text(previous, encoding="utf-8")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return True


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

    Исходные XLSX в репозиторий не кладём: их скачивает CI
    (`tools/fetch-faculty-xlsx.mjs`) уже в артефакт GitHub Pages.
    В index.json остаётся ссылка на облако и путь, по которому файл
    будет доступен на сайте.
    """
    output_dir = Path(output_dir)
    faculties_dir = output_dir / "faculties"
    faculties_dir.mkdir(parents=True, exist_ok=True)

    index_path = output_dir / "index.json"
    previous_index = _read_json(index_path)

    prepared: list[tuple[Faculty, list[str], dict, bool]] = []
    changed = False

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

        original = {"type": faculty.source.type}
        if faculty.source.type == "google_sheets":
            original["spreadsheet_id"] = faculty.source.spreadsheet_id
            original["url"] = faculty.source.url
        else:
            original["url"] = faculty.source.url
            # Файл появится на сайте после шага CI; фронтенд при 404
            # предложит открыть ссылку на облако.
            original["file"] = f"faculties/{faculty.id}.xlsx"

        target = faculties_dir / f"{faculty.id}.json"
        previous = _read_json(target)
        payload = {
            "schema_version": SCHEMA_VERSION,
            "faculty": {
                "id": faculty.id,
                "name": faculty.name,
                "short": faculty.short,
            },
            "generated_at": previous.get("generated_at", ""),
            "groups": groups,
            "events": events,
        }
        if _json_text(payload) != _read_text(target):
            faculty_changed = True
            changed = True
        else:
            faculty_changed = False

        prepared.append((faculty, groups, {"payload": payload, "original": original}, faculty_changed))

    stamp = generated_at
    if not stamp or (changed and stamp == previous_index.get("generated_at")):
        # ИНЭК не менялся, но другой факультет обновился — нужна новая версия.
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    index_faculties = []
    for faculty, groups, data, faculty_changed in prepared:
        payload = data["payload"]
        if faculty_changed:
            payload["generated_at"] = stamp
        target = faculties_dir / f"{faculty.id}.json"
        _write_with_rotation(target, _json_text(payload))

        index_faculties.append({
            "id": faculty.id,
            "name": faculty.name,
            "short": faculty.short,
            "file": f"faculties/{faculty.id}.json",
            "groups": groups,
            "events": len(payload["events"]),
            "generated_at": payload["generated_at"],
            "original": data["original"],
        })

    index = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": stamp,
        "faculties": index_faculties,
    }
    _write_with_rotation(index_path, _json_text(index))
    return index_path
