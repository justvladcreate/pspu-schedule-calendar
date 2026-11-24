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


# ------------------------------------------------------------------ rooms
_ROOM_JUNK = {
    "-", "—", "–", "нет", "n/a", "н/д", "н д", "nan",
}
_MAX_ROOM_RE = re.compile(r"\b(?:max|мах|макс|максимум)\b", re.I)
_ROOM_TEACHER_RE = re.compile(
    r"(?:[А-ЯЁ]\.\s*){1,2}\s*[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?"
    r"|[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+(?:[А-ЯЁ]\.\s*){1,2}"
)


def clean_room(line: str) -> tuple[str, str]:
    """Строка колонки аудиторий → (аудитория, пометка).

    «Max»/«мах»/«макс» — дистанционка, а не номер аудитории.
    «Видеолекции» — пометка, а не аудитория.
    Даты, ссылки и ФИО из поля аудитории вычищаем.
    """
    text = str(line or "").strip()
    if not text or text.lower() in _ROOM_JUNK:
        return "", ""

    text = text.replace("\\", "/")
    text = re.sub(r"\s+", " ", text).strip()
    low = text.lower()

    if _MAX_ROOM_RE.search(low) or "joincall" in low or "http" in low:
        return "дистанционно онлайн", ""
    if "видеолекц" in low:
        return "", "Видеолекции"

    # Даты перед аудиторией: «23.09-В-103», «IV / 26.10-А-323».
    text = re.sub(r"\b\d{1,2}\.\d{2}(?:\.\d{4})?\s*[-–—]\s*", "", text)
    # Даты в скобках/после «до»: «IV / 206 (26.10)», «А-304 (до 28.10».
    text = re.sub(
        r"\(\s*(?:до|с|по)?\s*\d{1,2}\.\d{2}(?:\.\d{4})?\s*\)?",
        "",
        text,
        flags=re.I,
    )
    # ФИО в скобках и без них — к аудитории не относятся.
    text = re.sub(r"\s*\([^()]*[А-ЯЁ]\.\s*[А-ЯЁ]?\.[^()]*\)", "", text)
    text = _ROOM_TEACHER_RE.sub("", text)

    # «гл. корп / 15», «гл. корп15» → «гл. корп. 15».
    text = re.sub(
        r"гл\.?\s*корп\.?\s*[/\\]?\s*",
        "гл. корп. ",
        text,
        flags=re.I,
    )
    text = re.sub(r"\s*/\s*", " / ", text)
    text = re.sub(r"\s+", " ", text).strip(" ,;:.)")
    if text.lower() in {"гл. корп", "гл.корп"}:
        text = "гл. корп."
    if text.lower() in _ROOM_JUNK:
        return "", ""
    return text, ""
