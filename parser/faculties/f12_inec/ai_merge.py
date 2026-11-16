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

from parser.core.ai import ask_ai, ask_ai_json
from parser.core.text import normalize_time
from parser.faculties.f12_inec.rooms_hints import split_branch_by_rooms

logger = logging.getLogger(__name__)

_LINK_RE = re.compile(r'\[([^\]]+)\]\((https?://[^\s)]+)\)')

# Structured output: Gemini сам собирает JSON по этой схеме.
F12_AI_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "events": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "enumerator": {"type": "INTEGER"},
                    "day_of_week": {"type": "STRING"},
                    "time_start": {"type": "STRING"},
                    "time_end": {"type": "STRING"},
                    "dates": {"type": "STRING"},
                    "discipline": {"type": "STRING"},
                    "type": {"type": "STRING"},
                    "subgroup": {"type": "STRING"},
                    "teachers": {"type": "STRING"},
                    "rooms": {"type": "STRING"},
                },
                "required": [
                    "enumerator", "day_of_week", "time_start", "time_end",
                    "dates", "discipline", "type", "subgroup",
                    "teachers", "rooms",
                ],
            },
        },
    },
    "required": ["events"],
}

JSON_OUTPUT_SUFFIX = """

Return the result strictly as JSON matching the schema: an object with
an "events" array. Each event has the same meaning as one line above:
enumerator (integer), day_of_week, time_start, time_end, dates,
discipline, type, subgroup, teachers, rooms (strings). Use "" for a
missing value. Do not output the semicolon-separated lines.
"""


def format_ai_input(sources: list[dict]) -> str:
    """Собирает текст для AI: [1] subj1\\n\\n[2] subj2 ..."""
    return "\n\n".join(f"[{i}] {s['subject']}" for i, s in enumerate(sources, start=1))


def chunk_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def events_to_lines(payload: dict) -> list[str]:
    """Превращает JSON от Gemini в привычные строки из 10 полей."""
    events = payload.get("events") if isinstance(payload, dict) else None
    if not isinstance(events, list):
        return []

    lines: list[str] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        try:
            enumerator = int(event.get("enumerator"))
        except (TypeError, ValueError):
            continue

        def cell(name: str) -> str:
            value = event.get(name)
            text = "" if value is None else str(value).strip()
            # точка с запятой внутри значения сломала бы разбор строки
            text = text.replace(";", ",")
            return text or "-"

        lines.append(";".join([
            f"[{enumerator}]",
            cell("day_of_week"),
            cell("time_start"),
            cell("time_end"),
            cell("dates"),
            cell("discipline"),
            cell("type"),
            cell("subgroup"),
            cell("teachers"),
            cell("rooms"),
        ]))

    return lines


async def ask_ai_with_retry(prompt: str, max_attempts: int = 4) -> list[str]:
    delay = 1.0
    last_exc: Exception | None = None

    for attempt in range(max_attempts):
        try:
            payload = await ask_ai_json(
                prompt + JSON_OUTPUT_SUFFIX,
                F12_AI_SCHEMA,
            )
            lines = events_to_lines(payload)
            if not lines:
                raise RuntimeError("Gemini вернула пустой список событий")
            return lines
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

    # Последний шанс — старый текстовый формат (если JSON почему-то
    # не поддержался моделью).
    logger.warning(
        "AI: structured output не удался (%s), пробую текстовый формат",
        last_exc,
    )
    return await ask_ai(prompt=prompt)


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


def _source_link(src: dict) -> str:
    """Первая http-ссылка из исходной ячейки аудиторий."""
    candidates: list[str] = [str(src.get("rooms") or "")]
    for hint in src.get("rooms_hints") or []:
        candidates.append(str(hint.get("room") or ""))
    for candidate in candidates:
        m = _LINK_RE.search(candidate)
        if m:
            return m.group(2)
    return ""


def _clean_ai_room(raw: str) -> str:
    """Мягкая чистка комнаты из ответа LLM: без нормализации корпусов."""
    text = str(raw or "").replace('\\', ' ').replace('/', ' ')
    text = re.sub(r'\s+', ' ', text).strip().strip(' ;,')
    if not text:
        return ""
    low = text.lower()
    if low in {"-", "—", "–", "нет", "n/a", "н/д", "онлайн", "online"}:
        return "дистанционно онлайн" if low in {"онлайн", "online"} else ""
    if re.fullmatch(r'\d{1,2}\.\d{2}(?:\.\d{4})?', text):
        return ""
    if re.fullmatch(r'(?:кроме|до|после|с)\s+\d{1,2}\.\d{2}(?:\.\d{4})?', text, re.IGNORECASE):
        return ""
    if low.startswith("дистанционно"):
        return "дистанционно онлайн"
    return text


def _rooms_ai_has_date(rooms: str) -> bool:
    """В комнатах из ответа LLM есть отдельная дата («11.11»)."""
    for raw in re.split(r'[,\n\r]+', str(rooms or '')):
        if re.fullmatch(r'\d{1,2}\.\d{2}(?:\.\d{4})?', raw.strip()):
            return True
    return False


def finalize_rooms(rooms: str, src: dict | None = None) -> str:
    """Чистит аудитории, пришедшие из ответа LLM.

    Модель иногда теряет ссылку и оставляет в комнатах дату («11.11»),
    поэтому приводим строку к тому же виду, что и детерминированный
    разбор: даты выбрасываем, «онлайн» превращаем в «дистанционно
    онлайн» и возвращаем ссылку из исходной ячейки.
    """
    text = str(rooms or "")

    parts: list[str] = []
    seen: set[str] = set()
    for raw in re.split(r'[,\n\r]+', text):
        raw = raw.strip()
        if not raw:
            continue

        m = _LINK_RE.fullmatch(raw)
        name = _clean_ai_room(m.group(1)) if m else _clean_ai_room(raw)
        if not name:
            continue

        if "](http" not in name:
            key = name
        else:
            key = _LINK_RE.sub(r'\1', name)

        if key in seen:
            continue
        seen.add(key)
        parts.append(name)

    url = _source_link(src or {})
    if url:
        for i, name in enumerate(parts):
            if name.startswith("дистанционно") and "](http" not in name:
                parts[i] = f"[{name}]({url})"
                break

    return ", ".join(parts)


def _text_matches_discipline(text: str, discipline: str) -> bool:
    """Есть ли в цветном куске текста название той же дисциплины.

    Нужен, когда в одной ячейке несколько предметов: серый цвет одной
    строки не должен перекрашивать соседнюю. Сравниваем по значимым
    словам, потому что LLM может слегка переписать название.
    """
    if not discipline:
        return True

    def words(value: str) -> set[str]:
        return {
            word
            for word in re.findall(r'[А-Яа-яЁёA-Za-z]{3,}', str(value).lower())
        }

    chunk_words = words(text)
    disc_words = words(discipline)
    if not chunk_words or not disc_words:
        return True

    common = chunk_words & disc_words
    need = min(2, len(disc_words))
    return len(common) >= need and len(common) / len(disc_words) >= 0.5


def _get_event_color(
        text_colors: list,
        b_dates: str,
        discipline: str = "",
) -> str | None:
    """Возвращает hex-код, если цветной текст относится к этой ветке.

    Совпадать должны и даты, и (когда известно) название дисциплины:
    иначе серый цвет строки «Методы проектной…» красит соседнюю
    «Возрастную психологию» только потому, что у них общая дата.
    """
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
        if not item["color"]:
            continue
        if not _text_matches_discipline(item["text"], discipline):
            continue
        if found <= branch_dates or branch_dates <= found:
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

    # Некоторые модели (например, gemini-3.1-flash-lite) иногда добавляют
    # лишнее пустое поле после subgroup. Восстанавливаем формат 10 полей,
    # иначе строка целиком отбрасывается и теряется занятие.
    if len(parts) == 11:
        if parts[8] == "":
            parts.pop(8)
        elif parts[10] == "":
            parts.pop(10)
        else:
            for index in range(6, 10):
                if parts[index] == "":
                    parts.pop(index)
                    break
            else:
                parts.pop()

        logger.warning(
            "AI: лишнее поле в строке, восстановил 10 полей: %r", line,
        )

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

    # Если в исходной ячейке есть комнаты, привязанные к датам
    # («7.12, 14.12 - IV к. спорт. зал»), детерминированный разбор
    # точнее ответа LLM: он сохраняет, к каким датам относится комната.
    hints = src.get("rooms_hints") or []
    has_date_overrides = any(r.get("hint_dates") for r in hints)

    if rooms_ai and (has_date_overrides or _rooms_ai_has_date(rooms_ai)):
        rooms_ai = ""

    if not rooms_ai:
        hints = src.get("rooms_hints") or []
        has_overrides = any(r["hint_type"] or r["hint_dates"] for r in hints)

        if not has_overrides:
            rooms = assign_rooms(
                src.get("rooms", ""),
                branch_index=branch_index,
                branch_total=branch_total,
            )
            color = _get_event_color(text_colors, dates, discipline)
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
            color = _get_event_color(text_colors, g_dates, discipline)
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

    color = _get_event_color(text_colors, dates, discipline)
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
        "rooms":      finalize_rooms(rooms_ai, src),
        "color":      color or "",
        "is_past":    is_past,
    }]
