"""Общая очистка текста и времени — без привязки к факультету."""
from __future__ import annotations

import re
from typing import Union

CLEAN_REPLACEMENTS = {
    "\\": "", "\"": "", "“": "", "”": "", "«": "", "»": "",
    ";": " ",                                   # запрещаем разделитель AI
    "+": " ",                                   # мусорный префикс дисциплины
    "—": "-", "–": "-", "−": "-", "‐": "-", "‑": "-",
    "`": "'", "´": "'",
    "„": "", "‚": "",
    "…": "...", "•": "*", "⋅": "*", "◦": "*",
}

_MULTIPLE_SPACES_RE = re.compile(r"\s+")
_MULTIPLE_DOTS_RE = re.compile(r"\.{2,}")
_MULTIPLE_DASHES_RE = re.compile(r"-{2,}")
_MULTIPLE_COMMAS_RE = re.compile(r",{2,}")
_CLEAN_PUNCTUATION_RE = re.compile(r"([!?])\1+")


def clean(text: Union[str, None]) -> str:
    """Убирает мусорные символы и лишние пробелы."""
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)

    text = _replace_chars(text)
    text = _clean_with_regex(text)
    text = _normalize_spaces(text)
    return text.strip()


def _replace_chars(text: str) -> str:
    return text.translate(str.maketrans(CLEAN_REPLACEMENTS))


def _clean_with_regex(text: str) -> str:
    text = text.replace("*", "•")
    text = _MULTIPLE_SPACES_RE.sub(" ", text)
    text = _MULTIPLE_DOTS_RE.sub(".", text)
    text = _MULTIPLE_DASHES_RE.sub("-", text)
    text = _MULTIPLE_COMMAS_RE.sub(",", text)
    text = _CLEAN_PUNCTUATION_RE.sub(r"\1", text)
    return text.strip()


def _normalize_spaces(text: str) -> str:
    """Пробелы вокруг знаков препинания, даты ДД.ММ не трогаем."""
    date_pattern = r'\d{1,2}\.\d{2}(?:\.\d{4})?'
    text = re.sub(date_pattern, lambda m: m.group(0).replace('.', '\x00'), text)

    text = re.sub(r'([,!?;])(\S)', r'\1 \2', text)
    text = re.sub(r'\s+([.,!?;:])', r'\1', text)
    text = re.sub(r'\.([А-Яа-яA-Za-z])', r'. \1', text)

    return text.replace('\x00', '.')


def normalize_time(time_str: str) -> str:
    """H-M, H:M, H.M, H M → HH:MM (берётся начало диапазона)."""
    if not isinstance(time_str, str):
        return str(time_str)

    time_str = re.sub(
        r'(\d{1,2}[.:]\d{2})\s*[-–—]\s*\d{1,2}[.:]\d{2}',
        r'\1',
        time_str,
    )
    time_str = time_str.strip()

    match = re.search(r'(\d{1,2})\D+(\d{1,2})', time_str)
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"
    return time_str
