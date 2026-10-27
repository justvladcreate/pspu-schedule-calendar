"""Общая логика разбора дат и учебного года.

Модуль вынесен из preprocess/finalize, чтобы одинаковые правила
(граница учебного года, диапазоны, год из шапки) жили в одном месте.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

DATE_RE = r'\d{1,2}\.\d{2}(?:\.\d{4})?'
DATE_PLAIN_RE = r'\d{1,2}\.\d{2}'
DATE_TRIM = " \t.,;:()[]{}–—-"

_HEADER_DATE_RE = re.compile(r'\b(\d{1,2})\.(\d{2})\.(\d{4})\b')
_HEADER_ACADEMIC_YEAR_RE = re.compile(r'\b(\d{4})\s*/\s*(\d{4})\b')
_HEADER_PARENS_RE = re.compile(r'\(([^)]*)\)')


def parse_date_token(value: str, *, validate: bool = False) -> tuple[int, int, int | None] | None:
    """'13.10' -> (13, 10, None); '13.10.2026' -> (13, 10, 2026)."""
    parts = str(value).strip().split(".")
    if len(parts) < 2:
        return None

    try:
        day = int(parts[0])
        month = int(parts[1])
    except ValueError:
        return None

    year: int | None = None
    if len(parts) >= 3:
        try:
            year = int(parts[2])
        except ValueError:
            year = None

    if validate and not is_valid_date(day, month, year):
        return None
    return day, month, year


def is_valid_date(day: int, month: int, year: int | None = None) -> bool:
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return False
    if month in (4, 6, 9, 11) and day > 30:
        return False
    if month == 2 and day > 29:
        return False
    if year and month == 2 and day == 29:
        if not (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)):
            return False
    return True


def resolve_year(month: int, semester_start_year: int) -> int:
    """Сентябрь-декабрь — год начала семестра, январь-август — следующий."""
    return semester_start_year if month >= 9 else semester_start_year + 1


def semester_start_year_from_text(text: str, fallback_year: int) -> int:
    """Год начала учебного года по явным датам с годом в тексте."""
    best: int | None = None
    for match in re.finditer(rf'\b({DATE_RE})\b', text or ""):
        parts = match.group(1).split(".")
        if len(parts) != 3:
            continue
        try:
            month, year = int(parts[1]), int(parts[2])
        except ValueError:
            continue
        candidate = year if month >= 9 else year - 1
        if best is None or candidate > best:
            best = candidate

    if best is not None:
        return best

    today = date.today()
    return fallback_year if today.month >= 9 else fallback_year - 1


def semester_start_year_from_header(semester: str | None) -> int | None:
    """Год начала учебного года из строки семестра.

    Приоритет — даты в круглых скобках:
        «10 семестр 2025/2026 учебного года (01.09.2026 – 23.01.2027)»
    В примере 2025/2026 — устаревшая шапка, реальный семестр начинается
    в 2026 году, поэтому результатом будет 2026.
    """
    text = str(semester or "")

    def start_year_from_dates(value: str) -> int | None:
        dates = _HEADER_DATE_RE.findall(value)
        if not dates:
            return None
        year, month, _day = min(
            (int(y), int(m), int(d)) for d, m, y in dates
        )
        return year if month >= 9 else year - 1

    for group in _HEADER_PARENS_RE.findall(text):
        year = start_year_from_dates(group)
        if year is not None:
            return year

    year = start_year_from_dates(text)
    if year is not None:
        return year

    match = _HEADER_ACADEMIC_YEAR_RE.search(text)
    return int(match.group(1)) if match else None


def expand_dates(
    value: str,
    current_year: int | None = None,
    semester_start_year: int | None = None,
) -> list[str]:
    """Разворачивает строку дат в список 'DD.MM.YYYY'.

    Учитывает переход учебного года: сентябрь-декабрь — год начала,
    январь-август — следующий год. Устойчиво к неполным данным LLM.
    """
    if current_year is None:
        current_year = date.today().year

    if semester_start_year is None:
        semester_start_year = semester_start_year_from_text(value, current_year)

    result: list[str] = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue

        parsed_range = False
        for separator in (" - ", " – ", " — ", "-", "–", "—"):
            if separator not in item:
                continue

            left, right = item.split(separator, 1)
            pa = parse_date_token(left.strip(DATE_TRIM), validate=True)
            pb = parse_date_token(right.strip(DATE_TRIM), validate=True)
            if pa is None or pb is None:
                continue

            d1, m1, y1 = pa
            d2, m2, y2 = pb

            if y1 is not None:
                start_year = y1
            elif y2 is not None:
                start_year = y2 if (m1, d1) <= (m2, d2) else y2 - 1
            else:
                start_year = resolve_year(m1, semester_start_year)

            if y2 is not None:
                end_year = y2
            elif (m2, d2) < (m1, d1):
                end_year = start_year + 1
            elif m1 >= 9 and m2 < 9:
                end_year = start_year + 1
            else:
                end_year = start_year

            try:
                cur = date(start_year, m1, d1)
                end = date(end_year, m2, d2)
            except ValueError:
                break

            if end < cur:
                break

            while cur <= end:
                result.append(cur.strftime("%d.%m.%Y"))
                cur += timedelta(days=7)

            parsed_range = True
            break

        if parsed_range:
            continue

        parsed = parse_date_token(item.strip(DATE_TRIM), validate=True)
        if parsed is None:
            continue
        day, month, year = parsed
        try:
            result.append(
                date(year if year is not None else resolve_year(month, semester_start_year), month, day)
                .strftime("%d.%m.%Y")
            )
        except ValueError:
            pass

    return result


def add_year(
    text: str,
    current_year: int | None = None,
    semester_start_year: int | None = None,
) -> str:
    """Проставляет год к каждой дате, учитывая границу учебного года."""
    if current_year is None:
        current_year = date.today().year

    if semester_start_year is None:
        semester_start_year = semester_start_year_from_text(text, current_year)

    def range_repl(match: re.Match) -> str:
        a, b = match.group(1), match.group(2)
        d1, m1, y1 = parse_date_token(a) or (0, 0, None)
        d2, m2, y2 = parse_date_token(b) or (0, 0, None)

        year1 = y1 if y1 is not None else resolve_year(m1, semester_start_year)

        if y2 is not None:
            year2 = y2
        elif (m2, d2) < (m1, d1):
            year2 = year1 + 1
        elif m1 >= 9 and m2 < 9:
            year2 = year1 + 1
        else:
            year2 = year1

        return f"{d1:02d}.{m1:02d}.{year1} - {d2:02d}.{m2:02d}.{year2}"

    text = re.sub(rf'({DATE_RE})\s*[-–—]\s*({DATE_RE})', range_repl, text)

    def single_repl(match: re.Match) -> str:
        full = match.group(0)
        parts = full.split(".")
        if len(parts) == 3:
            return full
        day, month = int(parts[0]), int(parts[1])
        return f"{day:02d}.{month:02d}.{resolve_year(month, semester_start_year)}"

    return re.sub(rf'\b{DATE_RE}\b', single_repl, text)


_DATE_TOKEN = r"\b\d{1,2}\.\d{2}(?:\.\d{4})?\b"
_DATE_TOKEN_RE = re.compile(_DATE_TOKEN)
_DATE_RANGE_RE = re.compile(rf"({_DATE_TOKEN})\s*[-–—]\s*({_DATE_TOKEN})")
_EXCLUDE_RE = re.compile(r"кроме\s*([^)\n;]*)", re.I)


def _normalize_date_separators(text: str) -> str:
    text = text.replace("–", "-").replace("—", "-").replace("−", "-")
    text = re.sub(r"\bпо\b", "-", text, flags=re.I)
    text = re.sub(r"\bдо\b", "-", text, flags=re.I)
    return text


def _expand_two_digit_years(text: str) -> str:
    """'18.03.24' -> '18.03.2024'. Годы до 60 считаем двухтысячными."""
    def repl(match: re.Match) -> str:
        tail = int(match.group(2))
        year = 2000 + tail if tail < 60 else 1900 + tail
        return f"{match.group(1)}.{year}"

    return re.sub(r"\b(\d{1,2}\.\d{2})\.(\d{2})\b", repl, text)


def expand_date_text(
    value: str,
    semester_start_year: int | None = None,
) -> list[str]:
    """Все даты из свободного текста ячейки — с диапазонами и исключениями.

    Понимает «с 14.09 по 28.09» (еженедельно), «15.12, 29.12, 12.01»,
    «18.03.24 - 15.04.24» и «с 15.09 (кроме 22.09) - 03.11».
    """
    text = str(value or "")
    if not text:
        return []

    if semester_start_year is None:
        today = date.today()
        semester_start_year = today.year if today.month >= 9 else today.year - 1

    text = _normalize_date_separators(_expand_two_digit_years(text))

    excluded: set[str] = set()
    for match in _EXCLUDE_RE.finditer(text):
        for token in _DATE_TOKEN_RE.findall(match.group(1)):
            excluded.update(
                expand_dates(token, semester_start_year=semester_start_year)
            )
    text = _EXCLUDE_RE.sub(" ", text)

    result: list[str] = []
    for match in _DATE_RANGE_RE.finditer(text):
        result.extend(
            expand_dates(
                f"{match.group(1)}-{match.group(2)}",
                semester_start_year=semester_start_year,
            )
        )
    rest = _DATE_RANGE_RE.sub(" ", text)
    for token in _DATE_TOKEN_RE.findall(rest):
        result.extend(
            expand_dates(token, semester_start_year=semester_start_year)
        )

    seen: set[str] = set()
    ordered: list[str] = []
    for value in result:
        if value in excluded or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def extract_first_date(text: str) -> str:
    """Первая дата ДД.ММ (или ДД.ММ.ГГГГ) из строки, без года."""
    match = re.search(rf'\b({DATE_PLAIN_RE})(?:\.\d{{4}})?\b', str(text or ""))
    return match.group(1) if match else ""
