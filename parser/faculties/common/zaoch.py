"""Парсер заочного расписания (сессия): строки с датой.

Форматы у факультетов различаются порядком колонок, поэтому шапка
ищется по словам, а колонки сопоставляются по её тексту.

Пример (ИНЭК, лист Z1223):
    День | № | Начало занятий | Дисциплина / ФИО | Форма/аудитория
    понедельник 14.09.2026 | 5 | 15-15 | Практикум… / Иванов И.И. | А-112

Пример (02):
    № | Начало занятий | Дисциплина…
    05.10.2026 г., понедельник | 1 | 08-00 | …
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime

from parser.core.colors import is_grey, match_color
from parser.sources.base import SheetData

logger = logging.getLogger(__name__)

WEEKDAYS = ("ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС")

_DATE_RE = re.compile(r"(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?")
_TIME_RE = re.compile(r"^\s*(\d{1,2})[\s.:\-](\d{2})\s*$")
_TEACHER_RE = re.compile(r"[А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z]\.\s*[А-ЯЁA-Z]\.?)")

_SKIP_RE = re.compile(
    r"^(декан|специалист|утверждаю|проректор|министерство|факультет|"
    r"направление|профил|курс|сессия|практик|написание|волонтер|"
    r"учебная|установочная|зачеты|экзамены)\b",
    re.IGNORECASE,
)
_GROUP_RE = re.compile(r"^Z?\s*M?\s*\d{3,4}$", re.IGNORECASE)


def looks_like_group(name: str) -> bool:
    """Лист похож на группу: Z1233, ZM1213, 1211."""
    return bool(_GROUP_RE.match(str(name or "").strip()))


def _text(value) -> str:
    if value is None:
        return ""
    return str(value).replace("\n", " ").strip()


def _norm_time(value: str) -> str:
    match = _TIME_RE.match(value or "")
    if not match:
        return ""
    hour, minute = int(match.group(1)), int(match.group(2))
    if 0 <= hour <= 23 and 0 <= minute <= 59:
        return f"{hour:02d}:{minute:02d}"
    return ""


def _parse_date(value: str, year: int) -> tuple[str, str, "date"] | None:
    """«понедельник 14.09.2026» → ('ЧТ', '14.09.2026', date)."""
    match = _DATE_RE.search(value or "")
    if not match:
        return None
    day, month = int(match.group(1)), int(match.group(2))
    raw_year = match.group(3)
    if raw_year:
        resolved = int(raw_year)
        if resolved < 100:
            resolved += 2000
    else:
        resolved = year
        if month <= 8:
            resolved += 1
    try:
        date = datetime(resolved, month, day).date()
    except ValueError:
        return None
    return WEEKDAYS[date.weekday()], date.strftime("%d.%m.%Y"), date


def _looks_like_room(value: str) -> bool:
    low = value.lower()
    if low.startswith("http"):
        return True
    if any(word in low for word in ("корп", "ауд", "зал", "холл", "онлайн", "дистанц")):
        return True
    return bool(re.fullmatch(r"[АAВВСC]?-?\s*\d{2,3}[а-я]?", value.strip(), re.IGNORECASE))


def _has_date(value: str, year: int) -> bool:
    """В ячейке есть именно дата (не «08-00» и не время)."""
    return _parse_date(value, year) is not None


def _split_teacher(discipline: str) -> tuple[str, str]:
    """«Практикум / Иванов И.И.» → (дисциплина, преподаватель)."""
    text = discipline.strip()
    parts = re.split(r"\s*/\s*", text)
    if len(parts) < 2:
        return text, ""
    tail = parts[-1]
    if _TEACHER_RE.search(tail) or re.search(r"[А-ЯЁ]\.\s*[А-ЯЁ]\.", tail):
        return "/".join(parts[:-1]).strip(" /"), tail.strip()
    return text, ""


def _header_columns(row: list[str]) -> dict[str, int] | None:
    columns: dict[str, int] = {}
    for index, cell in enumerate(row):
        low = cell.lower()
        if not low:
            continue
        if "дисциплин" in low or "предмет" in low:
            columns.setdefault("discipline", index)
        elif "начало" in low or "время" in low:
            columns.setdefault("time", index)
        elif "день" in low or "дата" in low:
            columns.setdefault("date", index)
        elif low.startswith("№") or "номер" in low:
            columns.setdefault("number", index)
        elif "аудитор" in low or "форма" in low or "место" in low:
            columns.setdefault("room", index)
    if "discipline" not in columns or "time" not in columns:
        return None
    return columns


def parse_zaoch_sheet(sheet: SheetData, year: int | None = None, bounds=None) -> dict:
    """Возвращает {группа: {"events": [...], "kind": "zo"}}."""
    group = sheet.name.strip()
    if not looks_like_group(group):
        logger.info("Заочка: лист %r не похож на группу, пропускаю", group)
        return {}

    rows = [
        [_text(value) for value in row]
        for row in sheet.df.values.tolist()
    ]

    header_index = -1
    columns: dict[str, int] = {}
    for index, row in enumerate(rows):
        found = _header_columns(row)
        if found:
            header_index = index
            columns = found
            break

    if header_index < 0:
        logger.warning("Заочка %s: не найдена шапка таблицы", group)
        return {group: {"events": [], "kind": "zo"}}

    year = year or datetime.now().year
    events: list[dict] = []
    current: tuple[str, str] | None = None

    for row_index in range(header_index + 1, len(rows)):
        row = rows[row_index]
        if not any(row):
            continue

        date_col = columns.get("date")
        date_value = row[date_col] if date_col is not None and date_col < len(row) else ""
        parsed = _parse_date(date_value, year)
        if parsed is None and date_value:
            parsed = None
        if parsed is None:
            # дата может лежать в любой другой ячейке строки
            for value in row:
                parsed = _parse_date(value, year)
                if parsed:
                    break
        if parsed is not None:
            if bounds and not (bounds[0] <= parsed[2] <= bounds[1]):
                current = None
                continue
            current = parsed
        if current is None:
            continue

        time_col = columns["time"]
        time_value = row[time_col] if time_col < len(row) else ""
        time_start = _norm_time(time_value)
        if not time_start:
            for value in row:
                if _has_date(value, year):
                    continue
                time_start = _norm_time(value)
                if time_start:
                    break

        disc_col = columns["discipline"]
        discipline_raw = row[disc_col] if disc_col < len(row) else ""
        if _norm_time(discipline_raw) or _has_date(discipline_raw, year):
            discipline_raw = ""
        if not discipline_raw:
            # колонки в строках могут съезжать — берём самый длинный текст
            candidates = [
                (len(value), index, value)
                for index, value in enumerate(row)
                if value
                and index not in {columns.get("date"), columns.get("number"), time_col}
                and not _norm_time(value)
                and not _has_date(value, year)
                and not value.lower().startswith("http")
            ]
            if candidates:
                discipline_raw = max(candidates)[2]

        discipline, teacher = _split_teacher(discipline_raw)
        if not discipline or _SKIP_RE.match(discipline):
            continue
        if not time_start:
            continue

        rooms = ""
        room_col = columns.get("room")
        candidates = []
        if room_col is not None and room_col < len(row):
            candidates.append(row[room_col])
        candidates.extend(row)
        for value in candidates:
            if not value or value == discipline_raw or value == discipline:
                continue
            if _looks_like_room(value):
                rooms = value
                break

        color = match_color(
            sheet.colors.get((row_index, disc_col)), [], discipline
        )
        weekday, iso, _ = current
        events.append({
            "weekday": weekday,
            "time_start": time_start,
            "time_end": "",
            "dates": iso,
            "discipline": discipline,
            "type": "",
            "subgroup": "",
            "teachers": teacher,
            "rooms": rooms,
            "kind": "zo",
            "is_past": is_grey(color) if color else False,
            "color": color or "",
        })

    logger.info("Заочка %s: событий %d", group, len(events))
    return {group: {"events": events, "kind": "zo"}}
