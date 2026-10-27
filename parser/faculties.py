"""Загрузка реестра факультетов из faculties.yaml."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

import yaml

from parser.model import AcademicPeriod, Faculty, FacultySource

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "faculties.yaml"


def _parse_date(value: str | None):
    if not value:
        return None
    return datetime.strptime(str(value), "%d.%m.%Y").date()


def load_registry(path: Path | str = DEFAULT_PATH) -> tuple[AcademicPeriod, list[Faculty]]:
    path = Path(path)
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    academic_raw = raw.get("academic") or {}
    academic = AcademicPeriod(
        year=str(academic_raw.get("year") or ""),
        semester_start=_parse_date(academic_raw.get("semester_start")),
        semester_end=_parse_date(academic_raw.get("semester_end")),
    )

    faculties: list[Faculty] = []
    seen: set[str] = set()
    for item in raw.get("faculties") or []:
        faculty_id = str(item.get("id") or "").strip()
        if not faculty_id or faculty_id in seen:
            continue
        seen.add(faculty_id)

        source_raw = item.get("source") or {}
        source_type = str(source_raw.get("type") or "").strip()
        if source_type not in {"google_sheets", "cloud_mail"}:
            raise ValueError(f"Неизвестный source.type у факультета {faculty_id}: {source_type!r}")

        faculties.append(Faculty(
            id=faculty_id,
            name=str(item.get("name") or faculty_id),
            short=str(item.get("short") or item.get("name") or faculty_id),
            source=FacultySource(
                type=source_type,
                url=source_raw.get("url"),
                spreadsheet_id=source_raw.get("spreadsheet_id"),
            ),
            adapter=str(item.get("adapter") or "vertical"),
            prompt=str(item.get("prompt") or "default"),
            enabled=bool(item.get("enabled", True)),
        ))

    return academic, faculties


def get_faculty(faculties: list[Faculty], faculty_id: str) -> Faculty | None:
    return next((item for item in faculties if item.id == str(faculty_id)), None)
