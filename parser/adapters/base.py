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
    r"(?<![А-Яа-яЁё])групп[аы]?\s*[№:]?\s*"
    # в номере группы обязана быть хотя бы одна цифра — иначе регулярка
    # цепляет последнюю букву слова «группа»
    r"((?=[A-Za-zА-Яа-яЁё0-9/\-]*\d)[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9/\-]{0,29})",
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
    # «05. 10» — встречается в 02; без нормализации дата не удаляется
    text = re.sub(r"\b(\d{1,2})\.\s+(\d{2})\b", r"\1.\2", text)
    text = re.sub(r"\bс\s+(?=\d)", " ", text, flags=re.I)
    text = re.sub(r"\bпо\s+(?=\d)", " ", text, flags=re.I)
    text = re.sub(r"\bдо\s+(?=\d)", " ", text, flags=re.I)
    text = re.sub(r"\(\s*кроме[^)]*\)", " ", text, flags=re.I)
    text = re.sub(r"\b\d{1,2}\.\d{2}(?:\.\d{2,4})?\b", " ", text)
    text = re.sub(r"\(\s*[,;:]?\s*\)", " ", text)
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


_GROUP_CODE_RE = re.compile(
    r"(?<![А-Яа-яЁёA-Za-z0-9])([A-Za-zА-Яа-яЁё]?\d{3,4})(?:/\d+)?(?![0-9])"
)


def extract_group_codes(name: str) -> list[str]:
    """Номера групп из имени листа: «731, 732 (5 семестр)» → ['731', '732']."""
    codes: list[str] = []
    for match in _GROUP_CODE_RE.finditer(str(name or "")):
        code = match.group(1)
        if code not in codes:
            codes.append(code)
    return codes


def infer_group(
    sheet: SheetData,
    df: pd.DataFrame,
    header_row: int,
    faculty: Faculty,
) -> tuple[str, float]:
    """Номер группы: имя листа важнее шапки, шапка — запасной вариант."""
    codes = extract_group_codes(sheet.name)
    if len(codes) == 1:
        return codes[0], 1.0

    for row in range(0, min(header_row, len(df))):
        text = " ".join(cell_text(v) for v in df.iloc[row] if cell_text(v))
        found = _GROUP_IN_HEADER_RE.search(text)
        if found:
            value = found.group(1).strip(" ,.;")
            return value, 0.8

    return "", 0.0


_GROUP_TOKEN_RE = re.compile(
    r"[A-Za-zА-Яа-яЁё]?\d{3,4}[A-Za-zА-Яа-яЁё0-9/]*"
)


def infer_block_group(
    df: pd.DataFrame,
    header_row: int,
    columns: dict,
    sheet_name: str,
    block_index: int,
    block_count: int,
) -> tuple[str, float]:
    """Группа конкретного блока колонок.

    Сначала ищем подпись «Группа …» или отдельный номер группы в шапке
    над блоком. Если её нет, а блоков несколько — доверять имени листа
    нельзя, помечаем это низкой уверенностью.
    """
    start = columns.get("start", 0)
    end = columns.get("end", 0)
    for row in range(0, min(header_row, len(df))):
        for col in range(start, end):
            text = cell_text(df.iat[row, col])
            if not text:
                continue
            found = _GROUP_IN_HEADER_RE.search(text)
            if found:
                return found.group(1).strip(" ,.;"), 1.0

    name = sheet_name.strip()
    codes = extract_group_codes(name)
    if len(codes) == 1:
        return codes[0], 1.0
    if block_count <= 1:
        return name, 1.0
    return name, 0.6


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


def detect_columns(
    df: pd.DataFrame,
    header_row: int,
    start: int = 0,
    end: int | None = None,
) -> dict:
    """Колонки одного блока. Блок — это свой набор «день/время/…»."""
    header = [cell_text(v).lower() for v in df.iloc[header_row]]
    if end is None:
        end = len(header)

    columns: dict = {
        "day": None,
        "pair": None,
        "time": None,
        "subject": [],
        "teacher": [],
        "room": [],
        "dates": [],
    }

    for index in range(start, end):
        value = header[index]
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
            for index in range(start, end)
            if index not in excluded and header[index]
        ]

    columns["start"] = start
    columns["end"] = end
    return columns


def detect_blocks(df: pd.DataFrame, header_row: int) -> list[dict]:
    """Делит строку заголовка на независимые блоки.

    В одном листе бывает несколько наборов колонок рядом — по блоку на
    группу или на направление. Склеивать их нельзя: перепутаются
    аудитории и преподаватели.
    """
    header = [cell_text(v).lower() for v in df.iloc[header_row]]
    starts = [index for index, value in enumerate(header) if value.startswith("день")]
    if not starts:
        return []

    blocks: list[dict] = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(header)
        columns = detect_columns(df, header_row, start, end)
        if columns["time"] is None and columns["pair"] is None:
            continue
        blocks.append(columns)
    return blocks


def block_has_data(df: pd.DataFrame, header_row: int, columns: dict) -> bool:
    """Есть ли в блоке хотя бы одна строка с днём и временем."""
    for row_index in range(header_row + 1, min(len(df), header_row + 400)):
        row = df.iloc[row_index]
        day_index = columns.get("day")
        day = cell_text(row.iloc[day_index]) if day_index is not None else ""
        if not day:
            continue
        if not (normalize_day(day) or re.match(r"\d{1,2}\.\d{2}", day)):
            continue

        time_index = columns.get("time")
        if time_index is not None and parse_time(row.iloc[time_index])[0]:
            return True
        pair_index = columns.get("pair")
        if pair_index is not None and parse_pair(row.iloc[pair_index]) is not None:
            return True
    return False


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
