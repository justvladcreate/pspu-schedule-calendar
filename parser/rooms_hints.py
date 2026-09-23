# parser/rooms_hints.py
"""
Разбор строки аудиторий из Excel на элементы с «подсказками».

Некоторые элементы строки rooms содержат указание, к каким именно
ветками они относятся:

    "IV к. А204\\nпрак. - IV к. А304"
        → IV к. А204 — база (для всех)
        → IV к. А304 — только для веток с типом "прак."

    "IV к. А-305\\n28.09 - IV к. А-304"
        → IV к. А305 — база
        → IV к. А304 — только для веток, у которых среди дат есть 28.09

    "прак. - 28.09 - IV к. А304"
        → IV к. А304 — только если и тип "прак.", и дата "28.09"

Поддерживаемые форматы date-hint (см. _DATE_HINT_RE):
    28.09 - X
    28.09.2026 - X
    13.10-20.10 - X
    17.09 и 25.09 - X
    с 17.09 по 29.10 - X
    с 5.11-12.11; 3.12-24.12 - X

Type-hint и date-hint можно комбинировать:
    прак. - 28.09 - X
    прак. - с 5.11 по 12.11 - X

Модуль НЕ встроен в пайплайн — это заготовка на будущее.
Интеграция в merge_ai_line — отдельный шаг.
"""
import re
from typing import Optional


# ========================================================================
# TYPE-HINT
# ========================================================================
# Порядок альтернатив — от длинных к коротким,
# чтобы "прак.лаб." не распарсилось как "прак." + ".лаб. - X".
_TYPE_HINT_RE = re.compile(
    r'^\s*(прак\.лаб\.|лек\.прак\.|прак\.|лек\.|лаб\.|семинар|практика)'
    r'\s*[-–—]\s*(.+)$',
    re.IGNORECASE,
)


# ========================================================================
# DATE-HINT
# ========================================================================
# Грамматика:
#   DATE_TOKEN   = DD.MM | DD.MM.YYYY
#   DATE_PAIR    = DATE_TOKEN [ ("-" | "–" | "—" | "и" | "по") DATE_TOKEN ]
#   DATE_GROUP   = [ "с" ] DATE_PAIR
#   DATE_PREFIX  = DATE_GROUP ( ["," | ";"] DATE_GROUP )*
#   HINT         = DATE_PREFIX " - " ROOM
#
# "с" может быть кириллической или латинской — отсюда [сc] + IGNORECASE.

_DATE_TOKEN  = r'\d{1,2}\.\d{2}(?:\.\d{4})?'
_DATE_PAIR   = rf'{_DATE_TOKEN}(?:\s*(?:[-–—]|и|по)\s*{_DATE_TOKEN})?'
_DATE_GROUP  = rf'(?:[сc]\s+)?{_DATE_PAIR}'
_DATE_PREFIX = rf'{_DATE_GROUP}(?:\s*[,;]\s*{_DATE_GROUP})*'

_DATE_HINT_RE = re.compile(
    rf'^\s*({_DATE_PREFIX})\s*[-–—]\s*(.+)$',
    re.IGNORECASE,
)


# Отдельные DD.MM-точки — используются в _parse_dates_hint
_DATE_MD_RE = re.compile(r'\b(\d{1,2})\.(\d{2})\b')


# ========================================================================
# РАЗВОРАЧИВАНИЕ ДИАПАЗОНОВ
# ========================================================================
def _expand_range(start_md: str, end_md: str) -> set[str]:
    """
    '10-13' и '10-20' → {'10-13', '10-20'} (2 недели)

    Разворачивает диапазон с шагом 7 дней от старта до конца включительно.
    Нужно для сравнения hint_dates с branch_dates, где ветка может быть
    задана как "с 15.09 - 29.09" — тогда hint "22.09" попадёт в развёрнутый
    набор (09-15, 09-22, 09-29).
    """
    sm, sd = map(int, start_md.split('-'))
    em, ed = map(int, end_md.split('-'))

    from datetime import date, timedelta
    start = date(2026, sm, sd)
    end = date(2026, em, ed)
    if end < start:
        end = date(2027, em, ed)

    result: set[str] = set()
    cur = start
    while cur <= end:
        result.add(f"{cur.month:02d}-{cur.day:02d}")
        cur += timedelta(days=7)
    return result


def _to_md(text: str) -> Optional[str]:
    """'13.10' или '13.10.2026' → '10-13'"""
    m = re.match(r'^(\d{1,2})\.(\d{2})', text)
    if not m:
        return None
    d, mo = int(m.group(1)), int(m.group(2))
    if not (1 <= d <= 31 and 1 <= mo <= 12):
        return None
    return f"{mo:02d}-{d:02d}"


def _parse_dates_hint(text: str, expand_ranges: bool = False) -> set[str]:
    """
    Извлекает все DD.MM из текста → {'MM-DD'}.

    expand_ranges=False (по умолчанию): возвращает только те точки,
        которые реально встречаются в тексте. Для hint_dates это
        правильное поведение — "17.09 и 25.09" → {09-17, 09-25}.
    expand_ranges=True: если в тексте есть "DD.MM - DD.MM", разворачивает
        диапазон с шагом 7 дней. Для branch_dates из ветки — "с 15.09
        по 29.09" → {09-15, 09-22, 09-29}.
    """
    result: set[str] = set()

    if expand_ranges:
        # Ищем диапазоны вида "DD.MM - DD.MM"
        # (только через дефис — "и" и "по" в ветках не встречаются)
        range_re = re.compile(
            r'\b(\d{1,2}\.\d{2}(?:\.\d{4})?)'
            r'\s*[-–—]\s*'
            r'(\d{1,2}\.\d{2}(?:\.\d{4})?)'
        )
        found_ranges: list[tuple[str, str]] = []
        for m in range_re.finditer(text):
            a = _to_md(m.group(1))
            b = _to_md(m.group(2))
            if a and b:
                found_ranges.append((a, b))
        for a, b in found_ranges:
            result |= _expand_range(a, b)

    # Плюс всегда добавляем отдельные точки — они могут быть вне диапазонов.
    for m in _DATE_MD_RE.finditer(text):
        d, mo = int(m.group(1)), int(m.group(2))
        if 1 <= d <= 31 and 1 <= mo <= 12:
            result.add(f"{mo:02d}-{d:02d}")

    return result

def _date_sort_key(md: str) -> tuple[int, int]:
    """
    Ключ сортировки MM-DD с учётом учебного года.
    Сентябрь-декабрь → 9-12, январь-август → 13-20.
    Так «28.09» идёт раньше, чем «05.01».
    """
    mo, dd = md.split("-")
    m, d = int(mo), int(dd)
    if m < 9:
        m += 12
    return (m, d)

# ========================================================================
# НОРМАЛИЗАЦИЯ КОМНАТЫ
# ========================================================================
def _clean_room(room: str) -> str:
    room = room.replace('\\', ' ').replace('/', ' ')
    room = re.sub(r'\s+', ' ', room).strip()
    if not room:
        return ""

    low = room.lower()

    # JUNK-фильтр
    if low in {"-", "—", "–", "нет", "n/a", "n a", "н/д", "н д"}:
        return ""

    # Дистанционные варианты → унифицированный вид
    if low.startswith("дистанционно"):
        return "дистанционно онлайн"

    room = re.sub(r'\b([IVX]+)\s*к\.\s*', r'\1 к. ', room)
    room = re.sub(r'(?<=[А-Я])-(?=\d)', '', room, flags=re.IGNORECASE)
    return room.strip()


# ========================================================================
# ПУБЛИЧНЫЙ API
# ========================================================================
def parse_rooms_with_hints(
        line: str,
        urls: list[str] | str | None = None,
) -> list[dict]:
    """
    Парсит строку rooms на элементы с подсказками.

    urls — один URL или список URL. Список раздаётся по дистанционным
    записям ПО ПОРЯДКУ их появления в тексте (markdown-ссылки).
    Если URL-ов больше, чем дистанционных записей — лишние игнорируются.
    """
    if urls is None:
        urls = []
    elif isinstance(urls, str):
        urls = [urls]

    if line is None:
        return []
    text = str(line)
    if not text.strip():
        return []

    for ch in ('"', '«', '»', '“', '”'):
        text = text.replace(ch, ' ')

    raw_parts = re.split(r'[\n\r,]+', text)

    result: list[dict] = []

    for part in raw_parts:
        part = re.sub(r'\s+', ' ', part).strip()
        if not part:
            continue

        item: dict | None = None

        # 1. type-hint
        m_type = _TYPE_HINT_RE.match(part)
        if m_type:
            hint_type = m_type.group(1).lower()
            remainder = m_type.group(2).strip()

            m_date = _DATE_HINT_RE.match(remainder)
            if m_date:
                dates_text = m_date.group(1)
                room       = m_date.group(2)
                item = {
                    "room": _clean_room(room),
                    "hint_type": hint_type,
                    "hint_dates": _parse_dates_hint(dates_text) or None,
                }
            else:
                item = {
                    "room": _clean_room(remainder),
                    "hint_type": hint_type,
                    "hint_dates": None,
                }

        # 2. date-hint
        if item is None:
            m_date = _DATE_HINT_RE.match(part)
            if m_date:
                dates_text = m_date.group(1)
                room       = m_date.group(2)
                item = {
                    "room": _clean_room(room),
                    "hint_type": None,
                    "hint_dates": _parse_dates_hint(dates_text) or None,
                }

        # 3. base
        if item is None:
            item = {
                "room": _clean_room(part),
                "hint_type": None,
                "hint_dates": None,
            }

        # пустая комната после чистки — пропускаем
        if not item["room"]:
            continue

        result.append(item)

    # markdown-ссылка → первой дистанционной записи
    # раздать URL-ы по дистанционным записям по порядку
    di = 0
    for item in result:
        if item["room"].startswith("дистанционно") and di < len(urls):
            item["room"] = f"[{item['room']}]({urls[di]})"
            di += 1

    # set → sorted list (для JSON-сериализации)
    for item in result:
        if item["hint_dates"]:
            item["hint_dates"] = sorted(item["hint_dates"])

    # дедупликация ПОСЛЕ раздачи URL: две дистанционные с разными URL
    # остаются как две разные записи (url входит в ключ),
    # а одинаковые текстовые дубли без URL схлопываются
    deduped: list[dict] = []
    seen: set[tuple] = set()
    for item in result:
        key = (
            item["room"],
            item["hint_type"],
            tuple(item["hint_dates"]) if item["hint_dates"] else (),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    return deduped


def _matches(room_hint: dict, branch_type: str, branch_dates_set: set[str]) -> bool:
    """
    Проверяет, подходит ли room_hint к ветке.
    hint_type — подстрока branch_type (регистронезависимо).
    hint_dates — множество/список/кортеж; пересекается с branch_dates_set.

    hint_dates может быть set (в памяти) или list (после JSON round-trip),
    поэтому приводим к set на входе.
    """
    hint_type  = (room_hint["hint_type"] or "").lower()
    hint_dates = room_hint["hint_dates"]

    if hint_type and hint_type not in branch_type:
        return False

    if hint_dates:
        if not isinstance(hint_dates, (set, frozenset)):
            hint_dates = set(hint_dates)
        if not (hint_dates & branch_dates_set):
            return False

    return True


def pick_rooms_for_branch(
        parsed: list[dict],
        branch_type: str = "",
        branch_dates: str = "",
) -> str:
    """
    Возвращает строку rooms для одной ветки.

    Логика:
      base       = элементы без hint_type и hint_dates
      overrides  = элементы с hint_type и/или hint_dates
      applicable = overrides, чей hint матчится с веткой

      if applicable: ", ".join(r.room for r in applicable)
      elif base:     ", ".join(r.room for r in base)
      else:          ""
    """
    if not parsed:
        return ""

    base = [r for r in parsed if not r["hint_type"] and not r["hint_dates"]]
    overrides = [r for r in parsed if r["hint_type"] or r["hint_dates"]]

    branch_type_l     = (branch_type or "").lower()
    branch_dates_set  = _parse_dates_hint(branch_dates or "", expand_ranges=True)

    applicable = [
        r for r in overrides
        if _matches(r, branch_type_l, branch_dates_set)
    ]

    if applicable:
        return ", ".join(r["room"] for r in applicable)
    if base:
        return ", ".join(r["room"] for r in base)
    return ""

def split_branch_by_rooms(
        parsed: list[dict],
        branch_type: str,
        branch_dates: str,
) -> list[tuple[str, str]]:
    """
    Разбивает одну ветку на подгруппы по комнатам.

    Возвращает список (dates_str, room_str), сохраняя хронологический
    порядок дат. Если разбивать не нужно — одна пара со всеми датами.

    Пример:
        parsed         = [{"room": "дистанционно онлайн", ...},
                          {"room": "IV к. В103", "hint_dates": {"09-28"}}]
        branch_type    = "лек."
        branch_dates   = "14.09, 21.09, 28.09"
        → [
            ("14.09, 21.09", "дистанционно онлайн"),
            ("28.09",        "IV к. В103"),
          ]
    """
    if not parsed:
        return []

    date_set = _parse_dates_hint(branch_dates or "", expand_ranges=True)

    # если даты не распарсились — не разбиваем, отдаём одну комнату
    if not date_set:
        room = pick_rooms_for_branch(parsed, branch_type, branch_dates)
        return [(branch_dates or "", room)]

    base      = [r for r in parsed if not r["hint_type"] and not r["hint_dates"]]
    overrides = [r for r in parsed if r["hint_type"] or r["hint_dates"]]
    branch_type_l = (branch_type or "").lower()

    # для каждой даты — своя комната
    date_to_room: dict[str, str] = {}
    for d in sorted(date_set, key=_date_sort_key):
        matched: list[str] = []
        for ov in overrides:
            if _matches(ov, branch_type_l, {d}):
                matched.append(ov["room"])
        if matched:
            date_to_room[d] = ", ".join(matched)
        elif base:
            date_to_room[d] = ", ".join(r["room"] for r in base)
        else:
            date_to_room[d] = ""

    # группируем соседние даты с одинаковой комнатой
    groups: list[tuple[str, list[str]]] = []
    for d in sorted(date_set, key=_date_sort_key):
        room = date_to_room[d]
        if groups and groups[-1][0] == room:
            groups[-1][1].append(d)
        else:
            groups.append((room, [d]))

    def fmt(md: str) -> str:
        mo, dd = md.split("-")
        return f"{dd}.{mo}"

    return [
        (", ".join(fmt(d) for d in dates), room)
        for room, dates in groups
    ]