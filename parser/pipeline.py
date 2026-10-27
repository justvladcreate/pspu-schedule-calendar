"""Пайплайн разбора одного факультета.

Google Sheets (ИНЭК) идёт прежним путём через ``process.py``. Здесь —
детерминированный разбор XLSX-факультетов с возможностью отдать
спорные ячейки на проверку LLM.
"""
from __future__ import annotations

import logging
from pathlib import Path

from parser.adapters import get_adapter
from parser.faculties import load_registry
from parser.finalize import transform_schedule
from parser.model import AcademicPeriod, Faculty, ParseResult, RawBranch
from parser.sources.base import ScheduleSource
from parser.sources.cloud_mail import CloudMailFileSource
from parser.sources.google_sheets import GoogleSheetsSource

logger = logging.getLogger(__name__)

REPAIR_THRESHOLD = 0.9
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "faculties"


def build_source(faculty: Faculty) -> ScheduleSource:
    if faculty.source.type == "google_sheets":
        if not faculty.source.spreadsheet_id:
            raise ValueError(f"У факультета {faculty.id} нет spreadsheet_id")
        return GoogleSheetsSource(faculty.source.spreadsheet_id)
    if faculty.source.type == "cloud_mail":
        if not faculty.source.url:
            raise ValueError(f"У факультета {faculty.id} нет ссылки cloud.mail")
        return CloudMailFileSource(
            faculty.source.url,
            CACHE_DIR / f"{faculty.id}.xlsx",
        )
    raise ValueError(f"Неизвестный источник: {faculty.source.type}")


async def parse_faculty(
    faculty: Faculty,
    period: AcademicPeriod,
    *,
    repair: bool = True,
) -> ParseResult:
    adapter_cls = get_adapter(faculty.adapter)
    if adapter_cls is None:
        raise ValueError(
            f"Для факультета {faculty.id} не найден адаптер {faculty.adapter!r}"
        )

    sheets = await build_source(faculty).load()
    branches = adapter_cls().parse(sheets, faculty, period)

    result = ParseResult(faculty=faculty, branches=branches)
    if repair:
        from parser.repair import repair_branches

        result.branches = await repair_branches(
            branches, faculty, period, threshold=REPAIR_THRESHOLD
        )
    _recompute_confidence(result)
    return result


def _recompute_confidence(result: ParseResult) -> None:
    if not result.branches:
        result.confidence = 0.0
        result.issues = ["no_branches"]
        return
    result.confidence = round(
        sum(branch.confidence for branch in result.branches) / len(result.branches), 3
    )
    seen: list[str] = []
    for branch in result.branches:
        for issue in branch.issues:
            if issue not in seen:
                seen.append(issue)
    result.issues = seen


def branches_to_groups_info(
    branches: list[RawBranch],
    period: AcademicPeriod,
) -> dict:
    """Приводит ветки к формату, который понимает ``transform_schedule``."""
    semester_year = period.semester_start.year if period.semester_start else None
    groups: dict[str, dict] = {}
    for branch in branches:
        if not branch.group or not branch.weekday or not branch.time_start:
            continue
        group = groups.setdefault(
            branch.group,
            {"events": [], "semester_start_year": semester_year},
        )
        group["events"].append({
            "weekday": branch.weekday,
            "time_start": branch.time_start,
            "time_end": branch.time_end,
            "dates": ", ".join(branch.dates),
            "discipline": branch.discipline,
            "type": branch.type,
            "subgroup": branch.subgroup,
            "teachers": ", ".join(branch.teachers),
            "rooms": branch.rooms,
            "comment": branch.comment,
            "color": branch.color,
            "is_past": False,
        })
    return groups


async def faculty_events(
    faculty: Faculty,
    branches: list[RawBranch],
    period: AcademicPeriod,
) -> list[dict]:
    raw = branches_to_groups_info(branches, period)
    transformed = await transform_schedule(raw, faculty_id=faculty.id)
    events = []
    for event in transformed.get("events", []):
        event["faculty_id"] = faculty.id
        event["faculty_name"] = faculty.name
        events.append(event)
    return events


async def parse_all(
    *,
    period: AcademicPeriod | None = None,
    faculties: list[Faculty] | None = None,
    repair: bool = True,
) -> dict[str, list[dict]]:
    if period is None or faculties is None:
        period, faculties = load_registry()

    events_by_faculty: dict[str, list[dict]] = {}
    for faculty in faculties:
        if not faculty.enabled:
            continue
        if faculty.adapter == "inec_legacy":
            # ИНЭК идёт своим путём через process.py, чтобы не менять эталон.
            continue
        try:
            result = await parse_faculty(faculty, period, repair=repair)
            events_by_faculty[faculty.id] = await faculty_events(
                faculty, result.branches, period
            )
            logger.info(
                "Факультет %s: %d занятий, уверенность %.2f",
                faculty.id,
                len(events_by_faculty[faculty.id]),
                result.confidence,
            )
        except Exception as exc:  # noqa: BLE001 - один факультет не должен ронять остальные
            logger.exception("Факультет %s не разобран: %s", faculty.id, exc)
    return events_by_faculty
