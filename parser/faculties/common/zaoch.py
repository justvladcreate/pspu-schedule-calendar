"""Парсер заочного расписания (учебно-экзаменационная сессия).

В файлах факультетов встречаются две раскладки:

1. Строка = занятие, день и дата в первой колонке (ИНЭК):

       День | № | Начало занятий | Дисциплина / ФИО | Форма
       понедельник 14.09.2026 | 5 | 15-15 | Практикум / Кузаев А.Ф. | А-112

2. Сетка «день / пара»: дата стоит отдельной строкой, обычно во второй
   паре дня (матфак):

       День | № | Начало занятий | Дисциплина… | Форма
       Понедельник | 1 | 08.00 |              |
       28.09.2026  | 2 | 09.45 |              |
                   | 3 | 11.30 | Математический анализ. Черемных Е.Л. | IV корп А 235

   Дата относится ко всем парам ниже, до следующего дня недели.

День недели и номер пары берём из самой даты и времени, а не из колонок:
в файлах ИНЭКа номер пары иногда пустой, а в шапке «День» стоит только
название дня без числа.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta

from parser.core.colors import is_grey, match_color
from parser.core.text import clean_room, normalize_time
from parser.sources.base import SheetData

logger = logging.getLogger(__name__)

WEEKDAYS = ("ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС")

# Пара длится 90 минут: 08:00–09:30, 09:45–11:15, 11:30–13:00, …
PAIR_MINUTES = 90

_WEEKDAY_WORDS = {
    "понедельник": 0, "пн": 0,
    "вторник": 1, "вт": 1,
    "среда": 2, "ср": 2,
    "четверг": 3, "чт": 3,
    "пятница": 4, "пт": 4,
    "суббота": 5, "сб": 5,
    "воскресенье": 6, "вс": 6,
}

_GROUP_RE = re.compile(r"^Z?M?\d{3,4}$")
_GROUP_IN_TEXT_RE = re.compile(
    r"групп[аы]?\s*[№:]?\s*([A-Za-zА-Яа-яЁё]?\s*\d{3,4})", re.IGNORECASE
)
_GROUP_TOKEN_RE = re.compile(
    r"\b(Z\s*[MМ]?\s*\d{3,4}|[МM]\s*\d{3,4}|\d{3})\b", re.IGNORECASE
)

_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_DATE_RE = re.compile(r"\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b")
_LEADING_DATE_RE = re.compile(
    r"^\s*(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\s*г?\.?\s*",
    re.IGNORECASE,
)

_TYPE_WORD_RE = re.compile(r"\b(ЗАЧ[ЕЁ]Т|ЭКЗАМЕН|КОНСУЛЬТАЦИЯ)\b", re.IGNORECASE)
_TYPE_MAP = {
    "зачет": "зачёт", "зачёт": "зачёт",
    "экзамен": "экзамен",
    "консультация": "консультация",
}

_NAME = r"[А-ЯЁ][а-яё\-]+(?:\.[а-яё]+)?\.?\s+[А-ЯЁ]\.(?:\s*[А-ЯЁ]\.?)?"
_NAME_RE = re.compile(_NAME)
_TEACHER_TAIL_RE = re.compile(rf"({_NAME}(?:\s*,\s*{_NAME})*)\s*$")
_TITLE_RE = re.compile(
    r"(?:ст\.\s*преп\.?|доц\.?|преп\.?|проф\.?|асс\.?|рук-ль\.?|отв\.?)\s*$",
    re.IGNORECASE,
)

_HEADER_DISCIPLINE_WORDS = ("дисциплин", "предмет")
_HEADER_TIME_WORDS = ("начало", "время")
_HEADER_DAY_WORDS = ("день", "дата")
_HEADER_NUMBER_WORDS = ("№", "номер")
_HEADER_ROOM_WORDS = ("аудитор", "форма", "место")


# ------------------------------------------------------------------ helpers
def _normalize_group(value: str) -> str:
    """«ZМ111» (кириллическая М) → «ZM111», как в данных."""
    text = re.sub(r"\s+", "", str(value or "")).upper()
    return text.replace("М", "M").replace("З", "Z")


def looks_like_group(name: str) -> bool:
    """Лист похож на группу: Z1233, ZM1213, 1211."""
    return bool(_GROUP_RE.match(_normalize_group(name)))


def _detect_group(rows: list[list], fallback: str) -> str:
    """Группа из шапки листа («5 курс, Z152»), иначе имя листа."""
    for row in rows[:20]:
        for value in row:
            match = _GROUP_IN_TEXT_RE.search(_text(value))
            if match and looks_like_group(match.group(1)):
                return _normalize_group(match.group(1))

    for row in rows[:20]:
        text = " ".join(_text(cell) for cell in row if _text(cell))
        if not re.search(r"курс|групп", text, re.IGNORECASE):
            continue
        for match in _GROUP_TOKEN_RE.finditer(text):
            if looks_like_group(match.group(1)):
                return _normalize_group(match.group(1))

    return _normalize_group(fallback)


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value != value:  # NaN
        return ""
    if type(value).__name__ == "NaTType":  # pandas NaT
        return ""
    text = str(value).replace("\n", " ").strip()
    if text.lower() in ("nan", "none"):
        return ""
    return re.sub(r"\s+", " ", text)


def _cell(row: list, index: int | None):
    if index is None or index < 0 or index >= len(row):
        return None
    return row[index]


def _year_for(month: int, year: int | None) -> int | None:
    if year is None:
        return None
    # Сентябрь–декабрь — год начала учебного года, январь–август — следующий.
    return year if month >= 9 else year + 1


def _date_from_match(match: re.Match, year: int | None) -> date | None:
    day, month = int(match.group(1)), int(match.group(2))
    raw_year = match.group(3) if match.re.groups >= 3 else None
    if raw_year:
        value = int(raw_year)
        resolved = value + 2000 if value < 100 else value
    else:
        resolved = _year_for(month, year)
        if resolved is None:
            return None
    try:
        return date(resolved, month, day)
    except ValueError:
        return None


def _as_date(value, year: int | None) -> date | None:
    """Дата из ячейки: datetime, date или текст «14.09.2026», «2026-09-14»."""
    if isinstance(value, datetime):
        parsed = value.date()
        return parsed if parsed.year >= 2000 else None
    if isinstance(value, date):
        return value if value.year >= 2000 else None
    text = _text(value)
    if not text:
        return None
    iso = _ISO_DATE_RE.search(text)
    if iso:
        try:
            parsed = date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        except ValueError:
            return None
        return parsed if parsed.year >= 2000 else None
    match = _DATE_RE.search(text)
    parsed = _date_from_match(match, year) if match else None
    # 1900-01-01 — заглушка Excel вместо настоящей даты.
    return parsed if parsed and parsed.year >= 2000 else None


def _weekday_index(value) -> int | None:
    text = _text(value).lower()
    if not text:
        return None
    for word, index in _WEEKDAY_WORDS.items():
        if text.startswith(word):
            return index
    return None


def _norm_time(value) -> str:
    text = _text(value)
    if not text or not re.search(r"\d", text):
        return ""
    # Не дата: «11.30» — время, «11.30.2026» — дата.
    if _as_date(text, None) is not None:
        return ""
    result = normalize_time(text)
    return result if re.fullmatch(r"\d{2}:\d{2}", result) else ""


def _end_time(start: str) -> str:
    try:
        hour, minute = (int(part) for part in start.split(":"))
    except ValueError:
        return ""
    end = datetime(2000, 1, 1, hour, minute) + timedelta(minutes=PAIR_MINUTES)
    return end.strftime("%H:%M")


def _first_column(texts: list[str], words: tuple[str, ...], skip: set[int] | None = None) -> int | None:
    for index, text in enumerate(texts):
        if skip and index in skip:
            continue
        if not text:
            continue
        if any(word in text for word in words):
            return index
    return None


def _header_map(row: list) -> dict[str, int] | None:
    texts = [_text(cell).lower() for cell in row]

    discipline_columns = [
        index for index, text in enumerate(texts)
        if text and any(word in text for word in _HEADER_DISCIPLINE_WORDS)
    ]
    if not discipline_columns:
        return None

    time_column = _first_column(texts, _HEADER_TIME_WORDS)
    if time_column is None:
        return None

    columns = {
        "discipline": discipline_columns[0],
        "time": time_column,
    }

    day_column = _first_column(texts, _HEADER_DAY_WORDS)
    if day_column is not None:
        columns["day"] = day_column

    number_column = _first_column(texts, _HEADER_NUMBER_WORDS)
    if number_column is not None:
        columns["number"] = number_column

    # Аудитория всегда правее объединённой колонки дисциплины: в её
    # заголовке тоже бывает слово «форма» («Дисциплина /форма…»).
    after_discipline = set(range(0, max(discipline_columns) + 1))
    room_column = _first_column(texts, _HEADER_ROOM_WORDS, after_discipline)
    if room_column is not None:
        columns["room"] = room_column

    return columns


def _find_header(rows: list[list]) -> tuple[int, dict[str, int]]:
    for index, row in enumerate(rows[:40]):
        columns = _header_map(row)
        if columns:
            return index, columns
    return -1, {}


def _split_type(text: str) -> tuple[str, str]:
    """«ЗАЧЕТ Алгебра» → («зачёт», «Алгебра»)."""
    match = _TYPE_WORD_RE.search(text)
    if not match:
        return "", text
    kind = _TYPE_MAP.get(match.group(1).lower(), "")
    cleaned = text[: match.start()] + " " + text[match.end():]
    cleaned = re.sub(r"\(\s*\)", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,:;-")
    return kind, cleaned


def _split_teacher(text: str) -> tuple[str, str]:
    """Дисциплина и преподаватель.

    ИНЭК пишет через слэш: «Практикум / Кузаев А.Ф.».
    Матфак — в конце строки через точку: «Математический анализ. Черемных Е.Л.».
    """
    raw = text.strip()
    if not raw:
        return "", ""

    if "/" in raw:
        head, tail = raw.rsplit("/", 1)
        head = head.strip(" .,:;-/")
        if head and _NAME_RE.search(tail):
            return head, tail.strip(" ,:;-")

    match = _TEACHER_TAIL_RE.search(raw)
    if not match:
        return raw.strip(" /"), ""

    teacher = match.group(1).strip(" ,;:-")
    discipline = raw[: match.start()].strip(" .,:;-/")

    title = _TITLE_RE.search(discipline)
    if title:
        teacher = f"{discipline[title.start():].strip()} {teacher}".strip()
        discipline = discipline[: title.start()].strip(" .,:;-")

    return discipline, teacher


def _describe_cell(value, year: int | None) -> tuple[date | None, int | None]:
    """Ячейка «День» → (дата, день недели)."""
    parsed = _as_date(value, year)
    if parsed is not None:
        return parsed, parsed.weekday()
    return None, _weekday_index(value)


def _is_section_row(row: list, day_col: int, disc_col: int) -> bool:
    """Строка-заголовок раздела: одно и то же значение во всех колонках.

    «Установочная сессия, 8 семестр 2026/2027 учебного года» объединена
    сразу по всем столбцам — это не занятие.
    """
    values = {_text(value) for value in row if _text(value)}
    if len(values) != 1:
        return False
    day_text = _text(_cell(row, day_col))
    return bool(day_text) and day_text == _text(_cell(row, disc_col))


def _event_signature(event: dict) -> tuple:
    return (
        event.get("weekday"),
        event.get("time_start"),
        event.get("discipline"),
        event.get("type"),
        event.get("teachers"),
        event.get("rooms"),
        event.get("dates"),
    )


def merge_zaoch_groups(target: dict, incoming: dict) -> None:
    """Слить листы заочки в ``groups`` без дублей.

    У одной группы бывает два листа («Z1233» и «Z1233 (копия)»): первый
    может быть устаревшим, второй — пустым. Пустым листом не затираем
    уже разобранное, а совпадающие занятия не дублируем.
    """
    for group, payload in incoming.items():
        current = target.get(group)
        if not current or not current.get("events"):
            target[group] = payload
            continue

        known = {_event_signature(event) for event in current["events"]}
        for event in payload.get("events") or []:
            signature = _event_signature(event)
            if signature in known:
                continue
            known.add(signature)
            current["events"].append(event)


def parse_zaoch_sheet(sheet: SheetData, year: int | None = None, bounds=None) -> dict:
    """Возвращает {группа: {"events": [...], "kind": "zo"}}."""
    df = getattr(sheet, "df", None)
    rows = df.values.tolist() if df is not None and not df.empty else []

    group = _detect_group(rows, sheet.name)
    if not looks_like_group(group):
        logger.info("Заочка: лист %r не похож на группу, пропускаю", sheet.name)
        return {}

    header_index, columns = _find_header(rows)
    if header_index < 0:
        logger.warning("Заочка %s: не найдена шапка таблицы", group)
        return {group: {"events": [], "kind": "zo"}}

    year = year or datetime.now().year
    day_col = columns.get("day", 0)
    disc_col = columns["discipline"]
    time_col = columns["time"]
    room_col = columns.get("room")

    buckets: dict[tuple, dict] = {}
    current_date: date | None = None

    def add_event(row_index: int, row: list, event_date: date) -> None:
        disc_cell = _text(_cell(row, disc_col))
        if not disc_cell:
            return

        time_start = _norm_time(_cell(row, time_col))
        if not time_start:
            return

        kind, raw_discipline = _split_type(disc_cell)
        # «ЗАЧЕТ 20.10.2026г. …» — дата прямо в тексте.
        explicit_date = None
        leading = _LEADING_DATE_RE.match(raw_discipline)
        if leading:
            explicit_date = _date_from_match(leading, year)
            if explicit_date is not None:
                raw_discipline = raw_discipline[leading.end():].strip(" ,:;-")

        discipline, teacher = _split_teacher(raw_discipline)
        if not discipline:
            return

        # Дисциплина в этих таблицах часто объединена вместе с колонкой
        # аудитории — тогда в «аудитории» лежит её же текст.
        room_text = _text(_cell(row, room_col))
        if room_text and room_text == disc_cell:
            room_text = ""
        room, _note = clean_room(room_text)

        color = match_color(
            sheet.colors.get((row_index, disc_col)), [], discipline
        )

        for day in ([explicit_date] if explicit_date else [event_date]):
            key = (
                WEEKDAYS[day.weekday()],
                time_start,
                discipline,
                kind,
                teacher,
                room,
            )
            bucket = buckets.get(key)
            if bucket is None:
                bucket = buckets[key] = {
                    "weekday": WEEKDAYS[day.weekday()],
                    "time_start": time_start,
                    "time_end": _end_time(time_start),
                    "discipline": discipline,
                    "type": kind,
                    "subgroup": "",
                    "teachers": teacher,
                    "rooms": room,
                    "kind": "zo",
                    "color": color or "",
                    "is_past": is_grey(color) if color else False,
                    "_dates": [],
                }
            if day not in bucket["_dates"]:
                bucket["_dates"].append(day)

    # Строки дня, который ещё не получил дату: в сетке матфака занятия
    # первой пары стоят в строке с названием дня, а дата — строкой ниже.
    pending: list[tuple[int, list]] = []

    for row_index in range(header_index + 1, len(rows)):
        row = rows[row_index]
        if not any(_text(value) for value in row):
            continue

        # Новая таблица на том же листе — начинается с шапки.
        if _header_map(row) or _is_section_row(row, day_col, disc_col):
            current_date = None
            pending = []
            continue

        parsed_date, weekday = _describe_cell(_cell(row, day_col), year)
        if parsed_date is not None:
            current_date = parsed_date
            pending_rows, pending = pending, []
            for pending_index, pending_row in pending_rows:
                add_event(pending_index, pending_row, current_date)
        elif weekday is not None:
            # День без числа: дата придёт следующей строкой.
            current_date = None
            pending = [(row_index, row)]
            continue
        elif current_date is None:
            if pending:
                pending.append((row_index, row))
            continue

        add_event(row_index, row, current_date)

    events = list(buckets.values())

    # Прошлые учебные годы не публикуем: на листе может лежать прошлогодняя
    # сессия, которую забыли убрать.
    if bounds and events:
        kept = []
        for event in events:
            dates = [
                day for day in event["_dates"]
                if bounds[0] <= day <= bounds[1]
            ]
            if dates:
                event["_dates"] = dates
                kept.append(event)
        if not kept:
            logger.warning(
                "Заочка %s: все даты вне учебного года %s — %s, пропускаю",
                group, bounds[0].strftime("%d.%m.%Y"), bounds[1].strftime("%d.%m.%Y"),
            )
        events = kept

    for event in events:
        days = sorted(event.pop("_dates"))
        event["dates"] = ", ".join(day.strftime("%d.%m.%Y") for day in days)

    events.sort(key=lambda e: (WEEKDAYS.index(e["weekday"]), e["time_start"]))

    logger.info("Заочка %s: событий %d", group, len(events))
    return {group: {"events": events, "kind": "zo"}}
