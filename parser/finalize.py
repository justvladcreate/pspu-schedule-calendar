import itertools
from typing import Dict, List, Optional, Any
from datetime import time, date, timedelta

from parser.postprocess import remove_academic_titles

# Карта соответствия времени начала пары номеру пары
PAIR_INTERVALS = [
    (time(8, 0),  time(9, 45)),  # 1-я пара
    (time(9, 45), time(11, 30)), # 2-я пара
    (time(11, 30), time(13, 30)),# 3-я пара
    (time(13, 30), time(15, 15)),# 4-я пара
    (time(15, 15), time(17, 0)), # 5-я пара
    (time(17, 0),  time(18, 45)),# 6-я пара
    (time(18, 45), time(20, 15)) # 7-я пара
]


def parse_event_string(event_str: str) -> Dict[str, str]:
    """Разбирает строку события на словарь параметров."""
    params = {}
    # Разделяем по '; ' (точка с запятой и пробел)
    parts = [p.strip() for p in event_str.split("; ")]
    for part in parts:
        if ": " in part:
            key, value = part.split(": ", 1)
            params[key] = value
        elif part.endswith(":"):
            # Пустое значение (например, "type: ;" превращается в "type:")
            key = part[:-1]
            params[key] = ""
    return params

def get_pair_number(time_str: str) -> Optional[int]:
    """Возвращает номер пары (1-7) для времени в формате HH:MM или None."""
    try:
        h, m = map(int, time_str.strip().split(':'))
        t = time(h, m)
        # Проверяем все интервалы
        for i, (start, end) in enumerate(PAIR_INTERVALS, start=1):
            if start <= t < end:
                return i
        # Особая проверка на точное время окончания 7-й пары (20:15)
        if t == time(20, 15):
            return 7
    except (ValueError, AttributeError):
        pass
    return None

def extract_weekday_and_time(time_str: str) -> tuple[str, str]:
    """Извлекает день недели и время из строки вида 'ПН 09:45'."""
    parts = time_str.split()
    weekday = parts[0]  # "ПН", "ВТ" и т.д.
    time = parts[1] if len(parts) > 1 else ""
    return weekday, time

async def normalize_teachers(teacher_str: str) -> List[str]:
    return [remove_academic_titles(t.strip()) for t in teacher_str.split(",") if remove_academic_titles(t.strip())]


async def expand_dates(s: str, current_year: int | None = None) -> list[str]:
    """Async-обёртка. Логика синхронная, event loop не разгружает."""
    if current_year is None:
        current_year = date.today().year

    def parse(t: str) -> tuple[int, int, int | None]:
        parts = t.split(".")
        day, month = int(parts[0]), int(parts[1])
        year = int(parts[2]) if len(parts) == 3 else None
        return day, month, year

    result: list[str] = []
    for item in s.split(","):
        item = item.strip()
        if not item:
            continue

        for sep in (" - ", " – ", " — ", "-", "–", "—"):
            if sep in item:
                a, b = item.split(sep, 1)
                d1, m1, y1 = parse(a.strip())
                d2, m2, y2 = parse(b.strip())

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

                cur = date(start_year, m1, d1)
                end = date(end_year, m2, d2)
                if end < cur:
                    break

                while cur <= end:
                    result.append(cur.strftime("%d.%m.%Y"))
                    cur += timedelta(days=7)
                break
        else:
            d, m, y = parse(item)
            result.append(date(y or current_year, m, d).strftime("%d.%m.%Y"))

    return result

async def transform_schedule(raw_data: Dict[str, Any]) -> Dict[str, List[Dict]]:
    temp_events = []  # события без event_id и position

    for group, group_data in raw_data.items():
        event_strings = group_data.get("events", [])
        for event_str in event_strings:
            params = parse_event_string(event_str)

            time_raw = params.get("time", "")
            if not time_raw:
                continue
            weekday, time_val = extract_weekday_and_time(time_raw)
            pair_number = get_pair_number(time_val)
            if pair_number is None:
                continue

            teachers = await normalize_teachers(params.get("teachers", ""))

            dates = await expand_dates(params.get("dates", ""), date.today().year)

            temp_events.append({
                "group": group,
                "weekday": weekday,
                "time": time_val,
                "pair_number": pair_number,
                "discipline": params.get("discipline", ""),
                "type": params.get("type", ""),
                "subgroup": params.get("subgroup", ""),
                "teachers": teachers,
                "dates": dates,
                "rooms": params.get("rooms", ""),
                # "comment": params.get("comment", ""),
                "comment": ""
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

    return {"events": final_events}

