"""Общие утилиты для адаптеров факультетских таблиц.

Адаптер ничего не «додумывает»: он разбирает ячейку на составные части
(дисциплина, вид работы, подгруппа, преподаватель, даты) и оценивает
свою уверенность. Всё, что разобрать не удалось, помечается в
``RawBranch.issues`` и уходит на проверку LLM.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Iterable

import pandas as pd

from parser.dates import expand_date_text
from parser.model import AcademicPeriod, Faculty, RawBranch
from parser.preprocess import clean, normalize_time
from parser.sources.base import SheetData

WEEKDAYS = {
    "пн": "ПН", "понедельник": "ПН", "monday": "ПН",
    "вт": "ВТ", "вторник": "ВТ", "tuesday": "ВТ",
    "ср": "СР", "среда": "СР", "wednesday": "СР",
    "чт": "ЧТ", "четверг": "ЧТ", "thursday": "ЧТ",
    "пт": "ПТ", "пятница": "ПТ", "friday": "ПТ",
    "сб": "СБ", "суббота": "СБ", "saturday": "СБ",
    "вс": "ВС", "воскресенье": "ВС", "sunday": "ВС",
}
WEEKDAY_ORDER = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"]
WEEKDAY_INDEX = {day: index for index, day in enumerate(WEEKDAY_ORDER)}

_TIME_RE = re.compile(r"\b(\d{1,2})\s*[.:\-]\s*(\d{2})\b")
_GROUP_IN_HEADER_RE = re.compile(
    r"групп[аы]?\s*[№:]?\s*([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9/\-]*)",
    re.I,
)

_TEACHER_INITIALS_FIRST = re.compile(
    r"(?:[А-ЯЁ]\.\s*){1,2}\s*[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?"
)
_TEACHER_SURNAME_FIRST = re.compile(
    r"[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+(?:[А-ЯЁ]\.\s*){1,2}"
)
_TEACHER_TITLES = re.compile(
    r"\b(?:д\.\s*[а-яё]+\.?\s*н\.|к\.\s*[а-яё]+\.?\s*н\.|"
    r"профессор|доцент|доц\.?|проф\.?|ст\.\s*пр\.?|"
    r"старший\s+преподаватель|ассистент|ассист\.?|преподаватель|преп\.?|пр\.)"
    r"(?![а-яё])",
    re.I,
)
_TYPE_RE = re.compile(
    r"\b(лекции|лекция|практические\s+занятия|практическое\s+занятие|"
    r"практика|практикум|практ\.?|пр\.?\s*з\.?|"
    r"лабораторные\s+занятия|лабораторная\s+работа|лаб\.?\s*з\.?|"
    r"семинар(?:ы|ское\s+занятие)?|семинар\.?|"
    r"консультация|конс\.?|экзамен|зачет|зачёт|курсовая\s+работа)\b",
    re.I,
)
_SHORT_TYPE_RE = re.compile(
    r"\(\s*(лек|лекц|пр|прак|лаб|л|п|с|сем)(?:\s*\.?\s*з)?\s*\.?\s*\)",
    re.I,
)
_SHORT_TYPE_MAP = {
    "лек": "лек.", "лекц": "лек.", "л": "лек.",
    "пр": "прак.", "прак": "прак.", "п": "прак.",
    "лаб": "лаб.", "с": "семинар", "сем": "семинар",
}
_SLASH_TYPE_RE = re.compile(
    r"(?:^|/)\s*(лекции|лекция|практические\s+занятия|практическое\s+занятие|"
    r"лабораторные\s+занятия|лабораторная\s+работа|семинар(?:ы|ское\s+занятие)?|"
    r"практик[аи]|практикум|консультация|экзамен|зач[её]т)"
    r"\s*(?:\(\s*\d+\s*\))?\s*(?=/|,|$)",
    re.I,
)
_COMMA_TYPE_RE = re.compile(
    r",\s*(практики|практика|лекции|семинары|лаб\.?|практ\.?|пр\.?\s*з\.?)"
    r"\s*(?=,|/|$)",
    re.I,
)
_DATE_TYPE_RE = re.compile(
    r"\b(лекции|лекция|практ\.?|лаб\.?|семинар)(?![а-яё])\s*"
    r"(?=(?:(?:поток|с)\s+)?\d{1,2}\.\d{2})",
    re.I,
)
_TYPE_MAP = {
    "лек": "лек.", "лекция": "лек.", "лекции": "лек.", "лекц": "лек.",
    "практ": "прак.", "практика": "прак.", "практики": "прак.",
    "практикум": "прак.",
    "пр": "прак.", "пр.з": "прак.", "п": "прак.",
    "лаб": "лаб.", "лаб.з": "лаб.",
    "семинар": "семинар", "сем": "семинар", "с": "семинар",
    "консультация": "конс.", "конс": "конс.",
    "экзамен": "экзамен", "зачет": "зачет", "зачёт": "зачет",
}
_TYPE_PHRASES = {
    "лекции": "лек.", "лекция": "лек.",
    "практические занятия": "прак.", "практическое занятие": "прак.",
    "практика": "прак.", "практики": "прак.", "практикум": "прак.",
    "лабораторные занятия": "лаб.", "лабораторная работа": "лаб.",
    "семинары": "семинар", "семинарское занятие": "семинар", "семинар": "семинар",
    "консультация": "конс.", "экзамен": "экзамен", "зачет": "зачет", "зачёт": "зачет",
}
_URL_RE = re.compile(r"^(?:https?:|www\.|max\.ru|max\.|zoom\.|eios|дистанционно$)", re.I)
_SUBGROUP_RE = re.compile(
    r"(?:п\s*[/\\]\s*г|пг|подгруппа|подгр\.?|п\.?г\.?)\s*[.:№-]?\s*(\d+)"
    r"|(\d+)\s*(?:-?я\s*)?(?:подгруппа|подгр)",
    re.I,
)
_TRAILING_SLASHES = re.compile(r"[\s/\\|]+$")


# ------------------------------------------------------------------ cells
def cell_text(value: Any) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    if isinstance(value, (date,)):
        return value.strftime("%d.%m.%Y")
    try:
        if isinstance(value, pd.Timestamp):
            return value.strftime("%d.%m.%Y")
    except AttributeError:
        pass
    return str(value).replace("\xa0", " ").strip()


def split_lines(value: Any) -> list[str]:
    """Разбивает ячейку на логические строки.

    Разделители: перевод строки и ``//`` (используется в 06/13 как
    граница между параллельными потоками).
    """
    text = cell_text(value)
    if not text:
        return []
    parts = re.split(r"\r?\n|(?<!:)//", text)
    return [part.strip(" \t;,|") for part in parts if part.strip(" \t;,|")]


def dedupe_adjacent(values: Iterable[str]) -> list[str]:
    """Убирает повторы подряд: в 02/06 одна дисциплина растянута на колонки."""
    result: list[str] = []
    seen: list[str] = []
    for value in values:
        if not value:
            continue
        normalized = re.sub(r"\s+", " ", value).strip().lower()
        if seen and seen[-1] == normalized:
            continue
        seen.append(normalized)
        result.append(value)
    return result


# ------------------------------------------------------------------ day/time
def normalize_day(value: Any) -> str:
    if isinstance(value, date):
        return WEEKDAY_ORDER[value.weekday()]
    text = cell_text(value).lower()
    if not text:
        return ""
    parsed = re.fullmatch(r"\s*(\d{1,2})\.(\d{2})\.(\d{4})\s*", text)
    if parsed:
        day, month, year = (int(part) for part in parsed.groups())
        try:
            return WEEKDAY_ORDER[date(year, month, day).weekday()]
        except ValueError:
            return ""
    for key, day in WEEKDAYS.items():
        if re.search(rf"(?<![а-яёa-z]){re.escape(key)}(?![а-яёa-z])", text):
            return day
    return ""


def parse_time(value: Any) -> tuple[str, str]:
    """Возвращает (начало, конец) по ячейке времени.

    Поддерживает ``8.00``, ``08.00-9.30``, ``09:45 - 11:15``, ``11-30``.
    Если конца нет — прибавляет 90 минут.
    """
    text = cell_text(value)
    if not text or re.search(r"\d{1,2}\.\d{2}\.\d{4}", text):
        return "", ""
    matches = _TIME_RE.findall(text)
    valid = [
        (int(hour), int(minute))
        for hour, minute in matches
        if 0 <= int(hour) <= 23 and 0 <= int(minute) <= 59
    ]
    if not valid:
        return "", ""
    hour, minute = valid[0]
    start = f"{hour:02d}:{minute:02d}"
    if len(valid) > 1:
        end_hour, end_minute = valid[1]
    else:
        total = hour * 60 + minute + 90
        end_hour, end_minute = (total // 60) % 24, total % 60
    return normalize_time(start), normalize_time(f"{end_hour:02d}:{end_minute:02d}")


PAIR_TIMES = {
    1: ("08:00", "09:30"),
    2: ("09:45", "11:15"),
    3: ("11:30", "13:00"),
    4: ("13:30", "15:00"),
    5: ("15:15", "16:45"),
    6: ("17:00", "18:30"),
    7: ("18:45", "20:15"),
    8: ("20:15", "21:45"),
}


def pair_to_time(pair: int | None) -> tuple[str, str]:
    return PAIR_TIMES.get(pair or 0, ("", ""))


def parse_pair(value: Any) -> int | None:
    text = cell_text(value)
    match = re.search(r"\b([1-8])\b", text)
    return int(match.group(1)) if match else None


# ------------------------------------------------------------------ text
def extract_teachers(text: str) -> tuple[list[str], str]:
    """Вытаскивает ФИО из строки и возвращает остаток текста.

    Понимает оба порядка: «Ивинских Н.П.» и «Н.П. Ивинских», а также
    служебные приставки вроде «доц.», «ст.пр.», «профессор».
    """
    found: list[str] = []

    def add(surname: str, initials: str) -> None:
        initials = initials.replace(" ", "")
        if not initials.endswith("."):
            initials += "."
        value = f"{surname} {initials}"
        if value not in found:
            found.append(value)

    def initials_first(match: re.Match) -> str:
        raw = match.group(0)
        parts = re.findall(r"[А-ЯЁ]\.", raw)
        surname = raw[match.group(0).rfind(" ") + 1:] if " " in raw else raw
        # фамилия — последнее слово без инициалов
        tail = re.sub(r"^(?:[А-ЯЁ]\.\s*)+", "", raw).strip()
        if tail:
            add(tail, "".join(parts[:2]))
        return " "

    def surname_first(match: re.Match) -> str:
        raw = match.group(0)
        parts = re.findall(r"[А-ЯЁ]\.", raw)
        surname = raw.split()[0]
        if parts:
            add(surname, "".join(parts[:2]))
        return " "

    cleaned = _TEACHER_SURNAME_FIRST.sub(surname_first, text)
    cleaned = _TEACHER_INITIALS_FIRST.sub(initials_first, cleaned)
    cleaned = _TEACHER_TITLES.sub(" ", cleaned)
    return found, cleaned


def extract_subgroup(text: str) -> tuple[str, str]:
    match = _SUBGROUP_RE.search(text)
    if not match:
        return "", text
    number = match.group(1) or match.group(2) or ""
    return f"п/г {number}".strip(), (text[:match.start()] + " " + text[match.end():])


def extract_type(text: str) -> tuple[str, str]:
    """Вид занятия. Ищем только явные маркеры, чтобы не съесть «Теория и практика»."""
    match = _SHORT_TYPE_RE.search(text)
    if match:
        key = match.group(1).lower()
        return (
            _SHORT_TYPE_MAP.get(key, ""),
            text[:match.start()] + " " + text[match.end():],
        )

    match = _SLASH_TYPE_RE.search(text)
    if match:
        phrase = re.sub(r"\s+", " ", match.group(1).lower()).strip()
        type_ = _TYPE_PHRASES.get(phrase, "")
        return type_, text[:match.start()] + " " + text[match.end():]

    match = _COMMA_TYPE_RE.search(text)
    if match:
        key = match.group(1).lower().rstrip(".")
        return (
            _TYPE_MAP.get(key, ""),
            text[:match.start()] + " " + text[match.end():],
        )

    match = _DATE_TYPE_RE.search(text)
    if match:
        key = match.group(1).lower().rstrip(".")
        return (
            _TYPE_MAP.get(key, ""),
            text[:match.start()] + " " + text[match.end():],
        )

    return "", text


def strip_dates(text: str) -> str:
    text = re.sub(r"\bс\s+(?=\d)", " ", text, flags=re.I)
    text = re.sub(r"\bпо\s+(?=\d)", " ", text, flags=re.I)
    text = re.sub(r"\bдо\s+(?=\d)", " ", text, flags=re.I)
    text = re.sub(r"\(\s*кроме[^)]*\)", " ", text, flags=re.I)
    text = re.sub(r"\b\d{1,2}\.\d{2}(?:\.\d{2,4})?\b", " ", text)
    text = re.sub(r"\s*[-–—/]\s*(?=\s*[-–—/]|$)", " ", text)
    return text


def clean_discipline(text: str) -> str:
    text = clean(text)
    text = re.sub(r"\(\s*\d+\s*\)", " ", text)  # «(13)» — часы, не часть названия
    text = re.sub(r"\(\s*\)", " ", text)
    text = re.sub(r"^[\s/\\|,;:.-]+", "", text)
    text = re.sub(r"[\s/\\|,;:.-]+$", "", text)
    text = re.sub(r"\s+/\s*$", "", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip(" ,.;:-")


def parse_cell_blocks(text: str) -> list[dict]:
    """Разбирает содержимое ячейки дисциплины на отдельные занятия.

    Строки без собственной дисциплины (только даты и ФИО) считаются
    продолжением предыдущей строки — так устроены 06 и 13.
    """
    lines = split_lines(text)
    merged: list[str] = []
    for line in lines:
        if _URL_RE.match(line):
            continue
        type_, rest = extract_type(line)
        subgroup, rest = extract_subgroup(rest)
        teachers, rest = extract_teachers(rest)
        candidate = clean_discipline(strip_dates(rest))
        has_subject = len(candidate) >= 3 and any(ch.isalpha() for ch in candidate)
        if merged and not has_subject:
            merged[-1] = f"{merged[-1]} {line}".strip()
        else:
            merged.append(line)

    blocks: list[dict] = []
    for line in merged:
        type_, rest = extract_type(line)
        subgroup, rest = extract_subgroup(rest)
        teachers, rest = extract_teachers(rest)
        discipline = clean_discipline(strip_dates(rest))
        if not discipline and not teachers:
            continue
        blocks.append({
            "discipline": discipline,
            "type": type_,
            "subgroup": subgroup,
            "teachers": teachers,
            "raw": line,
        })
    return blocks


def infer_group(
    sheet: SheetData,
    df: pd.DataFrame,
    header_row: int,
    faculty: Faculty,
) -> tuple[str, float]:
    """Номер группы: имя листа важнее шапки, шапка — запасной вариант."""
    name = sheet.name.strip()
    match = re.fullmatch(r"[A-Za-zА-Яа-яЁё]?\d{3,4}[A-Za-zА-Яа-яЁё0-9/]*", name)
    if match:
        return name, 1.0

    for row in range(0, min(header_row, len(df))):
        text = " ".join(cell_text(v) for v in df.iloc[row] if cell_text(v))
        found = _GROUP_IN_HEADER_RE.search(text)
        if found:
            value = found.group(1).strip(" ,.;")
            return value, 0.8

    return "", 0.0


def find_header_row(df: pd.DataFrame, max_rows: int = 40) -> int | None:
    for row in range(min(max_rows, len(df))):
        values = [cell_text(v).lower() for v in df.iloc[row]]
        joined = " ".join(values)
        if "день" not in joined and not any(v in WEEKDAYS for v in values):
            continue
        if "дисциплин" in joined or "предмет" in joined:
            return row
        if ("начало" in joined or "время" in joined) and "№" in values:
            return row
    return None


def detect_columns(df: pd.DataFrame, header_row: int) -> dict:
    header = [cell_text(v).lower() for v in df.iloc[header_row]]
    columns: dict = {
        "day": None,
        "pair": None,
        "time": None,
        "subject": [],
        "teacher": [],
        "room": [],
        "dates": [],
    }

    for index, value in enumerate(header):
        if columns["day"] is None and value.startswith("день"):
            columns["day"] = index
        if columns["pair"] is None and value.strip() == "№":
            columns["pair"] = index
        if columns["time"] is None and ("начало" in value or "время" in value):
            columns["time"] = index
        if "дисциплин" in value or "предмет" in value:
            columns["subject"].append(index)
        elif "преподавател" in value or "фио" in value:
            columns["teacher"].append(index)
        if (
            "аудитор" in value
            or "корпус" in value
            or "место" in value
            or "форма обучения" in value
        ):
            columns["room"].append(index)
        if "дат" in value and "день" not in value:
            columns["dates"].append(index)

    if not columns["subject"]:
        excluded = {columns["day"], columns["pair"], columns["time"]}
        excluded.update(columns["room"])
        excluded.update(columns["teacher"])
        excluded.update(columns["dates"])
        excluded.discard(None)
        columns["subject"] = [
            index
            for index in range(len(header))
            if index not in excluded and header[index]
        ]

    return columns


# ------------------------------------------------------------------ dates
def dates_for_weekday(day: str, period: AcademicPeriod) -> list[str]:
    if not period.semester_start or not period.semester_end:
        return []
    if day not in WEEKDAY_INDEX:
        return []
    current = period.semester_start + timedelta(
        days=(WEEKDAY_INDEX[day] - period.semester_start.weekday()) % 7
    )
    result: list[str] = []
    while current <= period.semester_end:
        result.append(current.strftime("%d.%m.%Y"))
        current += timedelta(days=7)
    return result


# ------------------------------------------------------------------ branch
def build_branch(
    *,
    faculty: Faculty,
    group: str,
    day: str,
    time_start: str,
    time_end: str,
    discipline: str,
    type_: str,
    subgroup: str,
    teachers: list[str],
    dates: list[str],
    rooms: str,
    period: AcademicPeriod,
    source_ref: dict,
    comments: list[str] | None = None,
    source_text: str = "",
) -> RawBranch | None:
    issues: list[str] = []
    confidence = 1.0

    if not day:
        issues.append("no_weekday")
        confidence -= 0.5
    if not time_start:
        issues.append("no_time")
        confidence -= 0.5
    if not discipline:
        issues.append("no_discipline")
        confidence -= 0.3
    if not group:
        issues.append("no_group")
        confidence -= 0.3

    if not dates:
        # Правило проекта: занятие без дат повторяется каждую неделю.
        dates = dates_for_weekday(day, period)
        if dates:
            confidence -= 0.05
            issues.append("weekly_dates")
        else:
            issues.append("no_dates")
            confidence -= 0.2

    if not teachers:
        confidence -= 0.05
        issues.append("no_teachers")
    if not rooms:
        confidence -= 0.05
        issues.append("no_rooms")

    if day and not time_start:
        return None
    if not discipline and not teachers:
        return None

    return RawBranch(
        faculty_id=faculty.id,
        faculty_name=faculty.name,
        group=group,
        weekday=day,
        time_start=time_start,
        time_end=time_end,
        dates=dates,
        discipline=discipline,
        type=type_,
        subgroup=subgroup,
        teachers=teachers,
        rooms=rooms,
        comment=" ".join(comments or []),
        source_ref=source_ref,
        source_text=source_text,
        confidence=round(max(min(confidence, 1.0), 0.0), 2),
        issues=issues,
    )
