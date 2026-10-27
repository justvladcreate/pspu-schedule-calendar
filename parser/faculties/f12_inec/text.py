"""Очистка, специфичная для таблиц ИНЭК.

Аудитории с корпусами, «похожие» латинские буквы, диапазоны дат,
инициалы и подгруппы — всё это встречается в формате ИНЭК.
"""
from __future__ import annotations

import re
from typing import List

from parser.core.dates import (
    DATE_RE as _DATE,
    is_valid_date as _is_valid,
    parse_date_token as _parse,
)

_JUNK_ROOMS = {
    "-", "—", "–",
    "нет",
    "n/a", "n a",
    "н/д", "н д",
    "n\\a",
}


def clean_room(room: str) -> str:
    """Очистка одной записи аудитории. Возвращает "" для мусора."""
    if not room:
        return ""

    room = str(room).replace('\\', ' ').replace('/', ' ')
    room = re.sub(r'\s+', ' ', room).strip()
    if not room:
        return ""

    low = room.lower()
    if low in _JUNK_ROOMS:
        return ""
    if low.startswith("дистанционно"):
        return "дистанционно онлайн"

    room = re.sub(r'\b([IVX]+)\s*к\.\s*', r'\1 к. ', room)
    room = re.sub(r'(?<=[А-Я])-(?=\d)', '', room, flags=re.IGNORECASE)
    return room.strip()


def normalize_rooms(line: str, url: str | None = None) -> List[str]:
    """Разбивает строку на части по \\n и , и чистит каждую через clean_room."""
    if line is None:
        return []

    text = str(line)
    if not text.strip():
        return []

    for ch in ('"', '«', '»', '“', '”'):
        text = text.replace(ch, ' ')

    raw_parts = re.split(r'[\n\r,]+', text)

    rooms_clean: List[str] = []
    seen: set = set()
    for part in raw_parts:
        room = clean_room(part)
        if room and room not in seen:
            seen.add(room)
            rooms_clean.append(room)

    if url:
        for i, r in enumerate(rooms_clean):
            if r.startswith("дистанционно"):
                rooms_clean[i] = f"[{r}]({url})"
                break

    return rooms_clean


def english_to_russian_lookalike(text: str) -> str:
    """Одиночные латинские буквы → похожие русские (слова не трогаем)."""
    mapping = {
        'A': 'А', 'B': 'В', 'C': 'С', 'E': 'Е', 'H': 'Н',
        'I': 'І', 'J': 'Ј', 'K': 'К', 'M': 'М', 'O': 'О',
        'P': 'Р', 'T': 'Т', 'W': 'Ш', 'X': 'Х', 'Y': 'У',
        'a': 'а', 'b': 'ь', 'c': 'с', 'e': 'е', 'i': 'і',
        'j': 'ј', 'k': 'к', 'm': 'м', 'o': 'о', 'p': 'р',
        'w': 'ш', 'x': 'х', 'y': 'у',
    }

    pattern = re.compile(r'[A-Za-z]+')

    def replacer(match: re.Match) -> str:
        word = match.group(0)
        return mapping.get(word, word) if len(word) == 1 else word

    return pattern.sub(replacer, text)


def normalize_date_ranges(text: str, default_end_date: str = None) -> str:
    text = re.sub(rf'({_DATE})\s*[-–—]\s*({_DATE})', r'\1 - \2', text)
    text = re.sub(rf'({_DATE})\.(?=\s|$|[,–—\-])', r'\1', text)
    text = re.sub(
        rf'\b[сc]\s+({_DATE})\s*[-–—]\s*({_DATE})',
        r'\1 - \2', text, flags=re.I,
    )
    if default_end_date:
        text = re.sub(
            rf'\b(?:[сc]\s+)?({_DATE})\s*[-–—](?!\s*[\dA-Za-zА-Яа-яЁё])',
            rf'\1 - {default_end_date}',
            text, flags=re.I,
        )
        text = re.sub(
            rf'\b[сc]\s+({_DATE})(?!\s*[-–—]\s*\d)',
            rf'\1 - {default_end_date}', text, flags=re.I,
        )
    else:
        text = re.sub(rf'\b[сc]\s+({_DATE})', r'\1', text, flags=re.I)
    text = re.sub(rf'({_DATE})\s*[-–—]\s*(?![0-9])', r'\1', text)
    text = re.sub(rf'({_DATE})\s+({_DATE})', r'\1 - \2', text)
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'(\d{1,2}\.\d{2})([А-Яа-я])', r'\1 \2', text)
    return text


def remove_invalid_dates(text: str) -> str:
    """Убирает невалидные даты (31.02 и т.п.), переход через год — валиден."""
    def range_repl(m: re.Match) -> str:
        a, b = m.group(1), m.group(2)
        d1, m1, y1 = _parse(a)
        d2, m2, y2 = _parse(b)
        return f"{a} - {b}" if _is_valid(d1, m1, y1) and _is_valid(d2, m2, y2) else ""

    text = re.sub(rf'({_DATE})\s*[-–—]\s*({_DATE})', range_repl, text)

    def single_repl(m: re.Match) -> str:
        d, mo, y = _parse(m.group(1))
        return m.group(1) if _is_valid(d, mo, y) else ""

    text = re.sub(rf'\b({_DATE})\b(?!\s*[-–—])', single_repl, text)

    text = re.sub(r'\b[сc]\s+', '', text, flags=re.I)
    text = re.sub(r',\s*,', ',', text)
    text = re.sub(r',\s*$', '', text)
    text = re.sub(r'^\s*,', '', text)
    text = re.sub(r'\s*,\s*', ', ', text)
    return re.sub(r'\s+', ' ', text).strip()


def remove_spaces_between_initials(text: str) -> str:
    """"И. О." → "И.О."; даты и сокращения не трогаем."""
    date_pattern = r'\b\d{1,2}\.\d{2}(?:\.\d{4})?\b'
    protected = {}

    def replacer(match):
        placeholder = f'__DATE_{len(protected)}__'
        protected[placeholder] = match.group(0)
        return placeholder

    text = re.sub(date_pattern, replacer, text)
    text = re.sub(r'([A-ZА-ЯЁ])\.\s+([A-ZА-ЯЁ])\.', r'\1.\2.', text)

    for placeholder, original in protected.items():
        text = text.replace(placeholder, original)
    return text


def normalize_subgroup(text: str) -> str:
    """п/г1, пг 2, п\\\\г 2 → «п/г N»."""
    pattern = r'\bп\s*[\/\\]?\s*г\s*(\d+)\b'
    return re.sub(pattern, r'п/г \1', text)
