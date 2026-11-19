"""Цвет текста: общий разбор для источников (Google Sheets, XLSX).

Источники отдают список фрагментов ``{"text": ..., "color": "#rrggbb"}``
для одной ячейки. Здесь — сопоставление фрагмента с конкретным занятием
и определение «серый = прошедшее».
"""
from __future__ import annotations

import re

_DATE_RE = re.compile(r"\d{1,2}\.\d{2}")

# Служебные слова, которые не помогают отличить одну строку от другой.
_STOP_WORDS = {
    "лек", "прак", "лаб", "лекция", "практика", "семинар", "час", "часов",
    "доц", "проф", "преп", "ст", "ауд", "корп", "и", "в", "на", "по", "с",
}


def apply_tint(hex_color: str, tint: float) -> str:
    """Осветление/затемнение цвета как в Excel.

    Excel хранит «серый текст» как чёрный с tint ≈ 0.5, а не отдельным
    цветом. Без учёта tint такой текст выглядит чёрным.
    """
    if not tint or not hex_color or not hex_color.startswith("#") or len(hex_color) != 7:
        return hex_color
    try:
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)
    except ValueError:
        return hex_color

    if tint < 0:
        factor = 1 + tint
        r, g, b = (int(round(v * factor)) for v in (r, g, b))
    else:
        r, g, b = (int(round(v + (255 - v) * tint)) for v in (r, g, b))

    return f"#{max(0, min(255, r)):02x}{max(0, min(255, g)):02x}{max(0, min(255, b)):02x}"


def is_grey(hex_color: str) -> bool:
    """Серый оттенок: R, G и B близки друг к другу."""
    if not hex_color or not hex_color.startswith("#") or len(hex_color) != 7:
        return False
    try:
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)
    except ValueError:
        return False
    return abs(r - g) <= 25 and abs(g - b) <= 25


def _norm_date(value: str) -> str:
    parts = str(value).split(".")
    if len(parts) >= 2:
        try:
            return f"{int(parts[0]):02d}.{parts[1]}"
        except ValueError:
            return str(value)
    return str(value)


def _date_set(value) -> set[str]:
    if isinstance(value, (list, tuple)):
        text = ", ".join(str(item) for item in value)
    else:
        text = str(value or "")
    return {_norm_date(item) for item in _DATE_RE.findall(text)}


def _words(text: str) -> set[str]:
    return {
        word for word in re.findall(r"[а-яёa-z]{4,}", str(text or "").lower())
        if word not in _STOP_WORDS
    }


def match_color(chunks: list[dict] | None, dates=None, discipline: str = "") -> str | None:
    """Цвет фрагмента, который относится к этому занятию.

    Приоритет — совпадение дат; если дат нет, сравниваем слова
    названия дисциплины. Фрагменты без дат и без общих слов
    (например, цвет названия аудитории) не учитываются.
    """
    if not chunks:
        return None

    wanted_dates = _date_set(dates)
    wanted_words = _words(discipline)

    for chunk in chunks:
        color = (chunk or {}).get("color")
        text = (chunk or {}).get("text") or ""
        if not color:
            continue

        found_dates = _date_set(text)
        if wanted_dates and found_dates:
            if found_dates & wanted_dates:
                return color
            continue

        if wanted_words:
            common = wanted_words & _words(text)
            if len(common) >= min(2, len(wanted_words)):
                return color

    return None
