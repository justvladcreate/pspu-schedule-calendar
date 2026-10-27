"""Математический факультет (id 01).

Формат листа (по одному листу на группу):

    Дата | Дата | № | Время | Дисциплина/ФИО преподавателя |
    Форма обучения // Аудитории | примечание | подгруппы…

В ячейке дисциплины сначала идут даты («14.09-28.09», «с 17.09»,
«22.09, 29.09, 06.10»), затем название, форма работы, подгруппа и ФИО.

LLM пока не используется — разбор полностью детерминированный.
"""
from __future__ import annotations

import logging
import re

from parser.core.dates import expand_date_text, semester_start_year_from_header
from parser.faculties.base import (
    SOURCE_NAME,
    FacultyParser,
    paths_for,
)
from parser.core.model import AcademicPeriod, Faculty
from parser.core.text import clean, normalize_time
from parser.sources.base import ScheduleSource, SheetData
from parser.sources.cloud_mail import CloudMailFileSource

logger = logging.getLogger(__name__)

_DAY_WORDS = {
    "понедельник": "ПН", "вторник": "ВТ", "среда": "СР", "четверг": "ЧТ",
    "пятница": "ПТ", "суббота": "СБ", "воскресенье": "ВС",
    "пн": "ПН", "вт": "ВТ", "ср": "СР", "чт": "ЧТ", "пт": "ПТ", "сб": "СБ", "вс": "ВС",
}
_TIME_RE = re.compile(r"\b(\d{1,2})\s*[.:\-]\s*(\d{2})\b")
_LEADING_DATES_RE = re.compile(
    r"^\s*((?:с\s+)?\d{1,2}\.\d{2}(?:\.\d{4})?(?:\s*[-–—]\s*\d{1,2}\.\d{2}(?:\.\d{4})?)?"
    r"(?:\s*,\s*(?:с\s+)?\d{1,2}\.\d{2}(?:\.\d{4})?(?:\s*[-–—]\s*\d{1,2}\.\d{2}(?:\.\d{4})?)?)*)",
    re.I,
)
_TYPE_RE = re.compile(
    r"\(\s*(л|лек|пр|прак|лаб|с|сем)\s*\.?\s*\)|"
    r"\b(лекции|лекция|практические\s+занятия|лабораторные\s+занятия|семинар)\b",
    re.I,
)
_TYPE_MAP = {
    "л": "лек.", "лек": "лек.", "лекции": "лек.", "лекция": "лек.",
    "пр": "прак.", "прак": "прак.", "практические занятия": "прак.",
    "лаб": "лаб.", "лабораторные занятия": "лаб.",
    "с": "семинар", "сем": "семинар", "семинар": "семинар",
}
_SUBGROUP_RE = re.compile(r"\bп\s*г\.?\s*(\d+(?:\.\d+)?)", re.I)
_TEACHER_RE = re.compile(
    r"(?:[А-ЯЁ]\.\s*){1,2}\s*[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?"
    r"|[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+(?:[А-ЯЁ]\.\s*){1,2}"
)


def _normalize_day(value: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    for word, code in _DAY_WORDS.items():
        if text.startswith(word):
            return code
    match = re.match(r"(\d{1,2})\.(\d{2})\.(\d{4})", text)
    if match:
        from datetime import date

        day, month, year = (int(part) for part in match.groups())
        try:
            return ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"][
                date(year, month, day).weekday()
            ]
        except ValueError:
            return ""
    return ""


def _parse_time(value: str) -> tuple[str, str]:
    matches = _TIME_RE.findall(str(value or ""))
    if not matches:
        return "", ""
    hour, minute = int(matches[0][0]), int(matches[0][1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return "", ""
    start = normalize_time(f"{hour:02d}:{minute:02d}")
    if len(matches) > 1:
        end = normalize_time(f"{int(matches[1][0]):02d}:{int(matches[1][1]):02d}")
    else:
        total = hour * 60 + minute + 90
        end = f"{(total // 60) % 24:02d}:{total % 60:02d}"
    return start, end


def _take_leading_dates(line: str) -> tuple[str, str]:
    match = _LEADING_DATES_RE.match(line)
    if not match:
        return "", line
    return match.group(1), line[match.end():].strip(" /,;")


def _extract_type_and_subgroup(line: str) -> tuple[str, str, str]:
    """Возвращает (type, subgroup, остаток строки)."""
    type_ = ""
    subgroup = ""

    # Хвостовые скобки: «(л)», «(пр пг 1)», «(ДНК, Кванториум)».
    tail = re.search(r"\(([^()]*)\)\s*$", line)
    if tail:
        inner = tail.group(1).strip()
        inner_lower = inner.lower()
        token = re.match(r"^(л|лек|пр|прак|лаб|с|сем)\b", inner_lower)
        has_subgroup = re.search(r"п\s*г\.?\s*(\d+(?:\.\d+)?)", inner_lower)
        if token or has_subgroup:
            if token:
                type_ = _TYPE_MAP.get(token.group(1).rstrip("."), "")
            if has_subgroup:
                subgroup = f"п/г {has_subgroup.group(1)}"
            line = line[:tail.start()]

    sub_match = _SUBGROUP_RE.search(line)
    if sub_match and not subgroup:
        subgroup = f"п/г {sub_match.group(1)}"
        line = line[:sub_match.start()] + " " + line[sub_match.end():]

    if not type_:
        type_match = _TYPE_RE.search(line)
        if type_match:
            key = (type_match.group(1) or type_match.group(2) or "").lower().strip(".")
            type_ = _TYPE_MAP.get(key, "")
            line = line[:type_match.start()] + " " + line[type_match.end():]

    return type_, subgroup, line


def _parse_teachers(text: str) -> list[str]:
    teachers: list[str] = []
    for chunk in re.split(r",|;", str(text or "")):
        chunk = chunk.strip(" /")
        if not chunk:
            continue
        found = _TEACHER_RE.search(chunk)
        if not found:
            continue
        normalized = _normalize_teacher(found.group(0))
        if normalized not in teachers:
            teachers.append(normalized)
    return teachers


def _split_subject(text: str, year: int | None) -> list[dict]:
    """Разбивает ячейку дисциплины на занятия.

    В ячейке 01 каждое занятие — отдельная строка вида
    ``14.09-28.09 Русский язык (л) / Бакланова И.И.``.
    """
    raw = str(text or "")
    if not raw or raw.strip().lower() == "nan":
        return []

    result: list[dict] = []
    for source_line in re.split(r"\r?\n", raw):
        line = source_line.strip()
        if not line or line.lower() == "nan":
            continue

        dates_text, rest = _take_leading_dates(line)
        dates = expand_date_text(dates_text, year) if dates_text else []

        teacher_text = ""
        if " / " in rest:
            rest, teacher_text = rest.rsplit(" / ", 1)

        type_, subgroup, rest = _extract_type_and_subgroup(clean(rest))
        discipline = re.sub(r"\s{2,}", " ", rest).strip(" ,.;:/-")
        if not discipline:
            continue

        result.append({
            "discipline": discipline,
            "type": type_,
            "subgroup": subgroup,
            "teachers": _parse_teachers(teacher_text),
            "dates": dates,
            "raw": line,
        })

    return result


def _normalize_teacher(value: str) -> str:
    """«Бакланова И. И.» → «Бакланова И.И.»."""
    text = re.sub(r"\s+", " ", value).strip()
    return re.sub(r"([А-ЯЁ])\.\s+([А-ЯЁ])\.", r"\1.\2.", text)


def _parse_rooms(value: str) -> list[tuple[str, str]]:
    """«Max / IV / А-224» → [("IV / А-224", "дистанционно")] по строкам."""
    raw = str(value or "")
    if not raw or raw.strip().lower() == "nan":
        return []

    entries: list[tuple[str, str]] = []
    for line in re.split(r"\r?\n", raw):
        line = line.strip()
        if not line or line.lower() == "nan":
            continue
        parts = [part.strip() for part in line.split("/") if part.strip()]
        remote = [p for p in parts if p.lower().startswith("max")]
        local = [p for p in parts if p not in remote]
        entries.append((" / ".join(local), "дистанционно" if remote else ""))
    return entries


def _filter_period(events: list[dict], period: AcademicPeriod) -> list[dict]:
    """Оставляет только занятия текущего учебного года.

    Если у занятия остались даты внутри года — публикуем его с этими
    датами, иначе выбрасываем (прошлый год не показываем).
    """
    from datetime import datetime

    bounds = period.academic_bounds()
    if bounds is None:
        return [event for event in events if event.get("dates")]

    low, high = bounds
    result: list[dict] = []
    for event in events:
        kept: list[str] = []
        for value in str(event.get("dates") or "").split(","):
            value = value.strip()
            if not value:
                continue
            try:
                parsed = datetime.strptime(value, "%d.%m.%Y").date()
            except ValueError:
                continue
            if low <= parsed <= high:
                kept.append(value)
        if kept:
            event = dict(event, dates=", ".join(kept))
            result.append(event)
    return result


class MathParser(FacultyParser):
    id = "01"
    uses_llm = False

    def source(self) -> ScheduleSource:
        if not self.faculty.source.url:
            raise ValueError("У факультета 01 нет ссылки на таблицу")
        return CloudMailFileSource(
            self.faculty.source.url,
            self.paths.latest_file(SOURCE_NAME),
        )

    async def parse(
        self,
        sheets: list[SheetData],
        period: AcademicPeriod,
    ) -> dict:
        current_year = period.semester_start.year if period.semester_start else None
        file_year = self._file_year(sheets)

        if file_year and current_year and file_year != current_year:
            logger.info(
                "Файл 01 относится к %s учебному году, текущий %s — пропуск",
                file_year, current_year,
            )
            return {}

        groups: dict = {}

        for sheet in sheets:
            if sheet.hidden:
                continue
            df = sheet.df
            if df.empty:
                continue

            header_row = self._header_row(df)
            if header_row is None:
                continue

            group = sheet.name.strip()
            if not group:
                continue

            year = file_year or self._semester_year(df, header_row) or current_year

            events: list[dict] = []
            current_day = ""

            for row_index in range(header_row + 1, len(df)):
                row = df.iloc[row_index]

                def value(index: int) -> str:
                    if index >= len(row):
                        return ""
                    return str(row.iloc[index]).replace("\xa0", " ").strip()

                if value(0).lower() == "nan":
                    continue

                day = _normalize_day(value(0)) or _normalize_day(value(1))
                if day:
                    current_day = day
                day = day or current_day

                time_start, time_end = _parse_time(value(3))
                if not time_start:
                    continue

                subject_text = value(4)
                if not subject_text or subject_text.lower() == "nan":
                    continue

                pieces = _split_subject(subject_text, year)
                if not pieces:
                    continue

                room_entries = _parse_rooms(value(5))
                if len(room_entries) == len(pieces):
                    pairings = room_entries
                elif room_entries:
                    combined = "; ".join(
                        f"{rooms}{' (' + comment + ')' if comment else ''}"
                        for rooms, comment in room_entries
                    )
                    pairings = [(combined, "")] * len(pieces)
                else:
                    pairings = [("", "")] * len(pieces)

                for index, piece in enumerate(pieces):
                    rooms, comment = pairings[index]
                    events.append({
                        "weekday": day,
                        "time_start": time_start,
                        "time_end": time_end,
                        "dates": ", ".join(piece["dates"]),
                        "discipline": piece["discipline"],
                        "type": piece["type"],
                        "subgroup": piece["subgroup"],
                        "teachers": ", ".join(piece["teachers"]),
                        "rooms": rooms,
                        "comment": comment,
                        "color": "",
                        "is_past": False,
                    })

            if events:
                events = _filter_period(events, period)
            if events:
                groups[group] = {
                    "events": events,
                    "semester_start_year": year,
                }

        return groups

    # ---------------------------------------------------------- helpers
    @staticmethod
    def _header_row(df) -> int | None:
        for row in range(min(30, len(df))):
            values = [str(v).lower() for v in df.iloc[row]]
            joined = " ".join(values)
            if "дисциплин" in joined and ("время" in joined or "№" in values):
                return row
        return None

    @staticmethod
    def _semester_year(df, header_row: int) -> int | None:
        for row in range(0, min(header_row, len(df))):
            text = " ".join(str(v) for v in df.iloc[row] if str(v) != "nan")
            if "семестр" in text.lower():
                year = semester_start_year_from_header(text)
                if year is not None:
                    return year
        return None

    @classmethod
    def _file_year(cls, sheets: list[SheetData]) -> int | None:
        """Учебный год файла — по шапке любого листа."""
        for sheet in sheets:
            if sheet.hidden or sheet.df.empty:
                continue
            header_row = cls._header_row(sheet.df)
            if header_row is None:
                continue
            year = cls._semester_year(sheet.df, header_row)
            if year is not None:
                return year
        return None
