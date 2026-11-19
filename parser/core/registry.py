"""Загрузка реестра факультетов из faculties.yaml."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

import yaml

from parser.core.model import AcademicPeriod, Faculty, FacultySource

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "faculties.yaml"


def _parse_date(value: str | None):
    if not value:
        return None
    return datetime.strptime(str(value), "%d.%m.%Y").date()


def _parse_source(raw: dict, faculty_id: str) -> FacultySource:
    source_type = str(raw.get("type") or "").strip()
    if source_type not in {"google_sheets", "cloud_mail", "cloud_mail_folder"}:
        raise ValueError(
            f"Неизвестный source.type у факультета {faculty_id}: {source_type!r}"
        )
    kinds = raw.get("kinds") or ()
    if isinstance(kinds, str):
        kinds = [kinds]
    return FacultySource(
        type=source_type,
        url=raw.get("url"),
        spreadsheet_id=raw.get("spreadsheet_id"),
        kind=str(raw.get("kind") or "").strip(),
        kinds=tuple(str(kind).strip() for kind in kinds if str(kind).strip()),
    )


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

        raw_sources = item.get("sources")
        if raw_sources:
            sources = tuple(_parse_source(source, faculty_id) for source in raw_sources)
            source = sources[0]
        else:
            source = _parse_source(item.get("source") or {}, faculty_id)
            sources = (source,)

        faculties.append(Faculty(
            id=faculty_id,
            name=str(item.get("name") or faculty_id),
            short=str(item.get("short") or item.get("name") or faculty_id),
            source=source,
            prompt=str(item.get("prompt") or faculty_id),
            enabled=bool(item.get("enabled", True)),
            sources=sources,
        ))

    return academic, faculties


def get_faculty(faculties: list[Faculty], faculty_id: str) -> Faculty | None:
    return next((item for item in faculties if item.id == str(faculty_id)), None)
