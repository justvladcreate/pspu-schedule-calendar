import itertools
from typing import Dict, List, Optional, Any
from datetime import time, date, timedelta, datetime, timezone

from parser.postprocess import remove_academic_titles


# Карта соответствия времени начала пары номеру пары
PAIR_INTERVALS = [
    (time(8, 0),  time(9, 45)),   # 1-я пара
    (time(9, 45), time(11, 30)),  # 2-я пара
    (time(11, 30), time(13, 30)), # 3-я пара
    (time(13, 30), time(15, 15)), # 4-я пара
    (time(15, 15), time(17, 0)),  # 5-я пара
    (time(17, 0),  time(18, 45)), # 6-я пара
    (time(18, 45), time(20, 15)), # 7-я пара
]


def get_pair_number(time_str: str) -> Optional[int]:
    """Возвращает номер пары (1-7) для времени в формате HH:MM или None."""
    try:
        h, m = map(int, time_str.strip().split(':'))
        t = time(h, m)
        for i, (start, end) in enumerate(PAIR_INTERVALS, start=1):
            if start <= t < end:
                return i
        # Особая проверка на точное время окончания 7-й пары (20:15)
        if t == time(20, 15):
            return 7
    except (ValueError, AttributeError):
        pass
    return None


async def normalize_teachers(teacher_str: str) -> List[str]:
    return [
        remove_academic_titles(t.strip())
        for t in teacher_str.split(",")
        if remove_academic_titles(t.strip())
    ]


# Символы-обёртки, которые не являются частью даты.
# Нужны, чтобы отрезать висячие дефисы/точки/скобки по краям.
_DATE_TRIM = " \t.,;:()[]{}–—-"


def expand_dates(s: str, current_year: int | None = None) -> list[str]:
    """Разворачивает строку дат в список 'DD.MM.YYYY'.

    Устойчиво к неполным данным от LLM:
      "13.10-"        → ["13.10.2026"]         (висячий дефис — это одиночная дата)
      "13.10 - "      → ["13.10.2026"]
      "13.10-15"      → ["13.10.2026"]         (правая часть не дата)
      "13.10 - 20.10" → ["13.10.2026", "20.10.2026"]
      "13.10.2026"    → ["13.10.2026"]
      "-"             → []                     (плейсхолдер пустого поля)
    """
    if current_year is None:
        current_year = date.today().year

    def parse(t: str) -> tuple[int, int, int | None] | None:
        """'13.10' → (13, 10, None); '13.10.2026' → (13, 10, 2026).
        None — если строка не похожа на дату."""
        parts = t.strip().split(".")
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

        if not (1 <= day <= 31 and 1 <= month <= 12):
            return None
        return day, month, year

    result: list[str] = []
    for item in s.split(","):
        item = item.strip()
        if not item:
            continue

        parsed_range = False
        for sep in (" - ", " – ", " — ", "-", "–", "—"):
            if sep not in item:
                continue

            a, b = item.split(sep, 1)
            pa = parse(a.strip(_DATE_TRIM))
            pb = parse(b.strip(_DATE_TRIM))

            # Обе части должны быть валидными датами.
            # Если правая не парсится — это не диапазон, а висячий дефис
            # или дефис внутри слова. Пробуем следующий разделитель.
            if pa is None or pb is None:
                continue

            d1, m1, y1 = pa
            d2, m2, y2 = pb

            if y1 is not None:
                start_year = y1
            elif y2 is not None:
                start_year = y2 if (m1, d1) <= (m2, d2) else y2 - 1
            else:
                start_year = current_year

            if y2 is not None:
                end_year = y2
            elif (m2, d2) < (m1, d1):
                end_year = start_year + 1
            else:
                end_year = start_year

            try:
                cur = date(start_year, m1, d1)
                end = date(end_year, m2, d2)
            except ValueError:
                # невалидная дата (например, 30.02)
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

        # Одиночная дата (в т.ч. с висячим дефисом/точкой по краям).
        p = parse(item.strip(_DATE_TRIM))
        if p is None:
            continue
        d, m, y = p
        try:
            result.append(date(y or current_year, m, d).strftime("%d.%m.%Y"))
        except ValueError:
            # 30.02 или подобное — молча пропускаем
            pass

    return result


async def transform_schedule(raw_data: Dict[str, Any]) -> Dict[str, List[Dict]]:
    """
    raw_data: {group: {"events": [
        {weekday, time_start, time_end, dates, discipline, type,
         subgroup, teachers, rooms}, ...]}}

    Возвращает финальную структуру с event_id / position.
    """
    temp_events: list[dict] = []

    for group, group_data in raw_data.items():
        event_dicts = group_data.get("events", [])
        for event in event_dicts:
            weekday  = (event.get("weekday")    or "").strip()
            time_val = (event.get("time_start") or "").strip()
            if not weekday or not time_val:
                continue

            pair_number = get_pair_number(time_val)
            if pair_number is None:
                continue

            teachers = await normalize_teachers(event.get("teachers", "") or "")
            dates    = expand_dates(event.get("dates", "") or "", date.today().year)

            temp_events.append({
                "group":        group,
                "weekday":      weekday,
                "time_start":   time_val,
                "time_end":     event.get("time_end", "") or "",
                "pair_number":  pair_number,
                "discipline":   event.get("discipline", "") or "",
                "type":         event.get("type", "") or "",
                "subgroup":     event.get("subgroup", "") or "",
                "teachers":     teachers,
                "dates":        dates,
                "rooms":        event.get("rooms", "") or "",
                "comment":      "",
            })

    # Группируем по group, weekday, pair_number
    temp_events.sort(key=lambda e: (e["group"], e["weekday"], e["pair_number"]))
    final_events = []
    for (group, weekday, pair_number), slot_events_it in itertools.groupby(
            temp_events, key=lambda e: (e["group"], e["weekday"], e["pair_number"])
    ):
        slot_events = list(slot_events_it)
        # Сортировка внутри слота
        slot_events.sort(key=lambda e: (e["discipline"], e["type"], e["subgroup"]))
        for idx, ev in enumerate(slot_events, start=1):
            ev["position"] = idx
            ev["event_id"] = f"{group}_{weekday}_{pair_number}_{idx}"
            final_events.append(ev)

    return {
        "events": final_events,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }