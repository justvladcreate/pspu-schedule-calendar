"""Парсер экзаменов и ГИА: строки с явной датой.

Форматы (01/02/09):
    ГИА:          Дата | Время | Испытание | ФИО | Кол-во | Форма/аудитория
    Зачёты/экзамены: Дата | Время | Дисциплина | ФИО | Форма/аудитория
Даты текстом («26 мая 2026») или числом («26.05.2026»).
"""
from __future__ import annotations

import logging
import re
from datetime import date as date_cls, datetime

from parser.core.colors import is_grey, match_color
from parser.sources.base import SheetData

logger = logging.getLogger(__name__)

WEEKDAYS = ("ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС")

_MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4,
    "мая": 5, "июня": 6, "июля": 7, "августа": 8,
    "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}
_RU_DATE_RE = re.compile(r"(\d{1,2})\s+([а-яё]+)\s*(\d{4})?", re.IGNORECASE)
_NUM_DATE_RE = re.compile(r"(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?")
_TIME_RE = re.compile(r"^\s*(\d{1,2})[\s.:\-](\d{2})\s*$")
_SECTION_RE = re.compile(r"^(зачеты|зачёты|экзамены|консультации)\b", re.IGNORECASE)


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value != value:  # NaN
        return ""
    if type(value).__name__ == "NaTType":  # pandas NaT
        return ""
    return str(value).replace("\n", " ").strip()


def _as_date(value, default_year: int) -> date_cls | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date_cls):
        return value
    return parse_date(_text(value), default_year)


def _as_time(value) -> str:
    if isinstance(value, datetime):
        return f"{value.hour:02d}:{value.minute:02d}"
    try:
        from datetime import time as time_cls

        if isinstance(value, time_cls):
            return f"{value.hour:02d}:{value.minute:02d}"
    except ImportError:  # pragma: no cover
        pass

    text = _text(value)
    direct = _norm_time(text)
    if direct:
        return direct
    match = re.search(r"(\d{1,2})[.:\-](\d{2})", text)
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"
    return ""


def _norm_time(value: str) -> str:
    match = _TIME_RE.match(value or "")
    if not match:
        return ""
    hour, minute = int(match.group(1)), int(match.group(2))
    if 0 <= hour <= 23 and 0 <= minute <= 59:
        return f"{hour:02d}:{minute:02d}"
    return ""


def parse_date(value: str, default_year: int) -> date_cls | None:
    low = (value or "").lower()

    match = _RU_DATE_RE.search(low)
    if match and match.group(2) in _MONTHS:
        day = int(match.group(1))
        month = _MONTHS[match.group(2)]
        year = int(match.group(3)) if match.group(3) else default_year
        try:
            return date_cls(year, month, day)
        except ValueError:
            return None

    match = _NUM_DATE_RE.search(low)
    if match:
        day, month = int(match.group(1)), int(match.group(2))
        raw_year = match.group(3)
        year = int(raw_year) if raw_year else default_year
        if year < 100:
            year += 2000
        try:
            return date_cls(year, month, day)
        except ValueError:
            return None
    return None


def _header_columns(row: list[str]) -> dict[str, int] | None:
    columns: dict[str, int] = {}
    for index, cell in enumerate(row):
        low = cell.lower()
        if not low:
            continue
        if "дата" in low:
            columns.setdefault("date", index)
        elif "время" in low:
            columns.setdefault("time", index)
        elif "дисциплин" in low or "наименован" in low or "испытан" in low:
            columns.setdefault("discipline", index)
        elif "фио" in low or "преподават" in low or "должность" in low:
            columns.setdefault("teachers", index)
        elif "форма" in low or "аудитор" in low or "место" in low:
            columns.setdefault("room", index)
    if "date" in columns and "time" in columns and "discipline" in columns:
        return columns
    return None


def parse_exams_sheet(
    sheet: SheetData,
    kind: str,
    year: int | None = None,
    bounds: tuple[date_cls, date_cls] | None = None,
) -> dict:
    """Возвращает {группа: {"events": [...], "kind": kind}}."""
    group = sheet.name.strip()
    rows = [list(row) for row in sheet.df.values.tolist()]

    header_index = -1
    columns: dict[str, int] = {}
    for index, row in enumerate(rows):
        found = _header_columns([_text(value) for value in row])
        if found:
            header_index = index
            columns = found
            break
    if header_index < 0:
        logger.warning("Экзамены %s: не найдена шапка", group)
        return {}

    year = year or datetime.now().year
    events: list[dict] = []
    section = ""

    for row_index in range(header_index + 1, len(rows)):
        row = rows[row_index]
        filled = [_text(value) for value in row if _text(value)]
        if not filled:
            continue
        if len(filled) == 1 and _SECTION_RE.match(filled[0]):
            section = filled[0].lower()
            continue

        date_value = row[columns["date"]] if columns["date"] < len(row) else ""
        parsed = _as_date(date_value, year)
        if parsed is None:
            continue
        if bounds and not (bounds[0] <= parsed <= bounds[1]):
            continue

        time_value = row[columns["time"]] if columns["time"] < len(row) else ""
        time_start = _as_time(time_value)
        if not time_start:
            continue

        disc_col = columns["discipline"]
        discipline = _text(row[disc_col]) if disc_col < len(row) else ""
        if not discipline:
            continue

        teachers = ""
        if "teachers" in columns and columns["teachers"] < len(row):
            teachers = re.sub(
                r"^(доц\.|проф\.|ст\.\s*преп\.|преп\.|асс\.)\s*",
                "",
                _text(row[columns["teachers"]]),
                flags=re.I,
            )
        teachers = re.sub(r"^Председатель:\s*", "", teachers, flags=re.I)

        rooms = ""
        if "room" in columns and columns["room"] < len(row):
            rooms = _text(row[columns["room"]])

        type_ = "зачет" if section.startswith("зач") else (
            "экзамен" if section.startswith("экзам") else ""
        )

        color = match_color(
            sheet.colors.get((row_index, disc_col)), [], discipline
        )
        events.append({
            "weekday": WEEKDAYS[parsed.weekday()],
            "time_start": time_start,
            "time_end": "",
            "dates": parsed.strftime("%d.%m.%Y"),
            "discipline": discipline,
            "type": type_,
            "subgroup": "",
            "teachers": teachers,
            "rooms": rooms,
            "kind": kind,
            "is_past": is_grey(color) if color else False,
            "color": color or "",
        })

    logger.info("Экзамены %s (%s): событий %d", group, kind, len(events))
    return {group: {"events": events, "kind": kind}}
