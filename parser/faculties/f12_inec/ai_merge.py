"""Склейка ответа LLM с исходными ячейками (ИНЭК).

Перенесено из старого parser/process.py без изменения поведения:
промпт возвращает строки «[n];день;время;...», а здесь они
превращаются в события с комнатами, цветами и признаком is_past.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re

from parser.core.ai import ask_ai
from parser.core.text import normalize_time
from parser.faculties.f12_inec.rooms_hints import split_branch_by_rooms

logger = logging.getLogger(__name__)


def format_ai_input(sources: list[dict]) -> str:
    """Собирает текст для AI: [1] subj1\\n\\n[2] subj2 ..."""
    return "\n\n".join(f"[{i}] {s['subject']}" for i, s in enumerate(sources, start=1))


def chunk_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def ask_ai_with_retry(prompt: str, max_attempts: int = 4) -> list[str]:
    delay = 1.0
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return await ask_ai(prompt=prompt)
        except Exception as e:
            last_exc = e
            if attempt == max_attempts - 1:
                break
            logger.warning(
                f"AI: попытка {attempt + 1}/{max_attempts} не удалась: {e}; "
                f"пауза {delay:.1f}с"
            )
            await asyncio.sleep(delay)
            delay *= 2
    raise last_exc


def add_90_minutes(time_start: str) -> str:
    """time_start + 1.5ч в формате HH:MM. Пусто, если не распарсилось."""
    if not time_start:
        return ""
    t = normalize_time(time_start)
    try:
        h, m = map(int, t.split(":"))
    except (ValueError, AttributeError):
        return ""
    total = h * 60 + m + 90
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


def assign_rooms(rooms_str: str, branch_index: int, branch_total: int) -> str:
    """Распределяет комнаты по ветвям одной ячейки."""
    if not rooms_str:
        return ""

    rooms_list = [r.strip() for r in rooms_str.split(",") if r.strip()]
    if not rooms_list:
        return ""

    if len(rooms_list) == 1:
        return rooms_list[0]

    if 1 < branch_total == len(rooms_list):
        return rooms_list[branch_index]

    return ", ".join(rooms_list)


def _is_grey_color(hex_color: str) -> bool:
    """Проверяет, является ли цвет оттенком серого."""
    if not hex_color or len(hex_color) != 7 or not hex_color.startswith('#'):
        return False
    try:
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)
        return abs(r - g) <= 25 and abs(g - b) <= 25
    except ValueError:
        return False


def _get_event_color(text_colors: list, b_dates: str) -> str | None:
    """Возвращает hex-код цвета, если все даты ветки найдены в цветном тексте."""
    if not text_colors or not b_dates:
        return None

    def _norm_date(d: str) -> str:
        parts = d.split('.')
        if len(parts) >= 2:
            return f"{int(parts[0]):02d}.{parts[1]}"
        return d

    branch_dates = {_norm_date(x) for x in re.findall(r'\d{1,2}\.\d{2}', b_dates)}
    if not branch_dates:
        return None

    for item in text_colors:
        found = {_norm_date(x) for x in re.findall(r'\d{1,2}\.\d{2}', item["text"])}
        # Цветной кусок без дат (например, цвет названия аудитории)
        # не должен определять цвет события.
        if not found:
            continue
        if item["color"] and (found <= branch_dates or branch_dates <= found):
            return item["color"]

    return None


def merge_ai_line(
        line: str,
        offset: int,
        sources: list[dict],
        branch_index: int = 0,
        branch_total: int = 1,
) -> list[dict]:
    parts = [p.strip() for p in line.split(";")]
    parts = ["" if p == "-" else p for p in parts]

    if len(parts) not in (9, 10):
        logger.warning(f"AI: ожидалось 9/10 полей, получено {len(parts)}: {line!r}")
        return []

    try:
        local_n = int(parts[0].strip("[]").strip())
    except ValueError:
        logger.warning(f"AI: не удалось разобрать enumerator: {parts[0]!r}")
        return []

    global_idx = offset + local_n - 1
    if not (0 <= global_idx < len(sources)):
        logger.warning(
            f"AI: enumerator {local_n} вне диапазона "
            f"(offset={offset}, total={len(sources)})"
        )
        return []

    src = sources[global_idx]

    weekday    = parts[1] or src.get("day_of_week", "")
    time_start = parts[2] or src.get("time_start", "")
    time_end   = parts[3] or add_90_minutes(time_start)
    dates      = parts[4]
    discipline = parts[5]
    type_      = parts[6]
    subgroup   = parts[7]
    teachers   = parts[8]
    rooms_ai   = parts[9] if len(parts) == 10 else ""

    time_start = normalize_time(time_start) if time_start else ""
    time_end   = normalize_time(time_end) if time_end else ""

    text_colors = src.get("text_colors") or []

    if not rooms_ai:
        hints = src.get("rooms_hints") or []
        has_overrides = any(r["hint_type"] or r["hint_dates"] for r in hints)

        if not has_overrides:
            rooms = assign_rooms(
                src.get("rooms", ""),
                branch_index=branch_index,
                branch_total=branch_total,
            )
            color = _get_event_color(text_colors, dates)
            is_past = _is_grey_color(color)
            return [{
                "weekday":    weekday,
                "time_start": time_start,
                "time_end":   time_end,
                "dates":      dates,
                "discipline": discipline,
                "type":       type_,
                "subgroup":   subgroup,
                "teachers":   teachers,
                "rooms":      rooms,
                "color":      color or "",
                "is_past":    is_past,
            }]

        groups = split_branch_by_rooms(hints, type_, dates)
        res = []
        for g_dates, g_rooms in groups:
            color = _get_event_color(text_colors, g_dates)
            is_past_g = _is_grey_color(color)
            res.append({
                "weekday":    weekday,
                "time_start": time_start,
                "time_end":   time_end,
                "dates":      g_dates,
                "discipline": discipline,
                "type":       type_,
                "subgroup":   subgroup,
                "teachers":   teachers,
                "rooms":      g_rooms,
                "color":      color or "",
                "is_past":    is_past_g,
            })
        return res

    color = _get_event_color(text_colors, dates)
    is_past = _is_grey_color(color)
    return [{
        "weekday":    weekday,
        "time_start": time_start,
        "time_end":   time_end,
        "dates":      dates,
        "discipline": discipline,
        "type":       type_,
        "subgroup":   subgroup,
        "teachers":   teachers,
        "rooms":      rooms_ai,
        "color":      color or "",
        "is_past":    is_past,
    }]
