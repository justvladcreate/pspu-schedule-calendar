import itertools
from datetime import date, datetime, time, timezone
from typing import Any, Dict, List, Optional

from parser.dates import expand_dates
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
    (time(20, 15), time(21, 45)), # 8-я пара
]


def get_pair_number(time_str: str) -> Optional[int]:
    """Возвращает номер пары (1-8) для времени в формате HH:MM или None."""
    try:
        h, m = map(int, time_str.strip().split(':'))
        t = time(h, m)
        for i, (start, end) in enumerate(PAIR_INTERVALS, start=1):
            if start <= t < end:
                return i
    except (ValueError, AttributeError):
        pass
    return None


async def normalize_teachers(teacher_str: str) -> List[str]:
    cleaned = remove_academic_titles(teacher_str)   # уже возвращает "ФИО1, ФИО2, ..."
    if not cleaned:
        return []
    return [t.strip() for t in cleaned.split(",") if t.strip()]


async def transform_schedule(raw_data: Dict[str, Any]) -> Dict[str, List[Dict]]:
    """
    raw_data: {group: {"events": [
        {weekday, time_start, time_end, dates, discipline, type,
         subgroup, teachers, rooms}, ...]}}

    Возвращает финальную структуру с event_id / position.
    """
    temp_events: list[dict] = []

    for group, group_data in raw_data.items():
        sem_start_year = group_data.get("semester_start_year")
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
            dates    = expand_dates(event.get("dates", "") or "", date.today().year, semester_start_year=sem_start_year)

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
                "is_past":      event.get("is_past", False),
                "color":        event.get("color", "") or "",
            })

    # Группируем по group, weekday, pair_number
    temp_events.sort(key=lambda e: (e["group"], e["weekday"], e["pair_number"]))
    final_events = []
    for (group, weekday, pair_number), slot_events_it in itertools.groupby(
            temp_events, key=lambda e: (e["group"], e["weekday"], e["pair_number"])
    ):
        slot_events = list(slot_events_it)
        for idx, ev in enumerate(slot_events, start=1):
            ev["position"] = idx
            ev["event_id"] = f"{group}_{weekday}_{pair_number}_{idx}"
            final_events.append(ev)

    return {
        "events": final_events,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }