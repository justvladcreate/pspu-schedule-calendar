# parser/overrides.py
"""
Ручные правки расписания после парсинга.

Работает с событиями в формате finalize:
  group, weekday, time_start, time_end, pair_number,
  discipline, type, subgroup, teachers, dates, rooms,
  comment, position, event_id

Схема правила в private/overrides.yaml:

    semester:                     # необязательно
      start: "01.09.2026"
      end:   "30.12.2026"

    overrides:
      - match:                    # AND по всем ключам
          group: "1247"
          weekday: ["ПН", "ВТ"]   # значение может быть списком
          discipline_contains: "Иностранный"
          time_start: "11:30"
          not:                    # вложенные отрицания
            subgroup: "п/г 1"
        drop: true                # ИЛИ любые из операций ниже

        dates: "1.09 - 30.12"     # строка → expand_dates
        fill_semester: true       # все даты семестра по weekday
        time_start: "13:30"
        time_end:   "15:00"
        rooms: "IV к. А305"
        teachers: ["Иванов И.И."]
        type: "прак."
        subgroup: "п/г 2"
        discipline: "Новое название"
        comment: "..."
"""
import logging
from datetime import date, datetime, timedelta
from pathlib import Path

import yaml

from parser.finalize import expand_dates

logger = logging.getLogger(__name__)

WEEKDAYS_RU = {"ПН": 0, "ВТ": 1, "СР": 2, "ЧТ": 3, "ПТ": 4, "СБ": 5, "ВС": 6}

# Ключи, по которым можно матчить события (в дополнение к спец-ключам
# discipline_contains / teacher / teacher_contains и блоку not).
MATCH_KEYS = {
    "group", "weekday", "pair_number",
    "time_start", "time_end",
    "discipline", "type", "subgroup",
    "dates", "rooms", "comment",
    "event_id",
}

# Поля, которые правило может перезаписать «в лоб».
OVERRIDE_KEYS = (
    "time_start", "time_end",
    "discipline", "type", "subgroup",
    "rooms", "teachers", "comment",
)


# ---------------------------------------------------------------- загрузка

def load_overrides(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        logger.error(f"Ошибка чтения {path}: {e}")
        return {}


# ---------------------------------------------------------------- матчинг

def _matches_single(ev: dict, key: str, value) -> bool:
    """Проверяет одно условие. Возвращает True, если совпало."""
    if key == "discipline_contains":
        return str(value).lower() in (ev.get("discipline") or "").lower()

    if key == "teacher":
        teachers = [str(t) for t in (ev.get("teachers") or [])]
        return str(value) in teachers

    if key == "teacher_contains":
        needle = str(value).lower()
        teachers = [str(t).lower() for t in (ev.get("teachers") or [])]
        return any(needle in t for t in teachers)

    if key not in MATCH_KEYS:
        logger.warning(f"overrides: неизвестный ключ match: {key!r}")
        return False

    ev_val = ev.get(key)

    # dates в events — список; сравниваем построчно
    if key == "dates":
        if isinstance(ev_val, list):
            return str(value) in [str(v) for v in ev_val]
        return str(ev_val) == str(value)

    if isinstance(value, list):
        return str(ev_val) in [str(v) for v in value]

    return str(ev_val) == str(value)


def _matches(ev: dict, match: dict) -> bool:
    """
    Все условия в match должны совпасть (AND).
    Блок not — вложенный словарь, условия которого должны НЕ совпасть.
    """
    for key, value in match.items():
        if key == "not":
            if not isinstance(value, dict):
                continue
            for nk, nv in value.items():
                if _matches_single(ev, nk, nv):
                    return False
            continue

        if not _matches_single(ev, key, value):
            return False

    return True


# ---------------------------------------------------------------- семестр

def _semester_bounds(events: list[dict], explicit: dict | None) -> tuple[date, date] | None:
    """Границы семестра: из YAML (semester: {start, end}), либо min/max по датам."""
    if explicit and "start" in explicit and "end" in explicit:
        return (
            datetime.strptime(str(explicit["start"]), "%d.%m.%Y").date(),
            datetime.strptime(str(explicit["end"]),   "%d.%m.%Y").date(),
        )
    all_dates = [
        datetime.strptime(d, "%d.%m.%Y").date()
        for ev in events for d in ev.get("dates", [])
    ]
    return (min(all_dates), max(all_dates)) if all_dates else None


def _fill_semester(ev: dict, semester: tuple[date, date]) -> list[str]:
    """Все даты семестра, попадающие на weekday события."""
    target = WEEKDAYS_RU.get(ev.get("weekday", ""))
    if target is None:
        return []
    start, end = semester
    cur = start + timedelta(days=(target - start.weekday()) % 7)
    dates: list[str] = []
    while cur <= end:
        dates.append(cur.strftime("%d.%m.%Y"))
        cur += timedelta(days=7)
    return dates


# ---------------------------------------------------------------- вход

async def apply_overrides(events: list[dict], rules: dict) -> list[dict]:
    """
    Применяет overrides к списку финальных событий.

    Асинхронная, потому что внутри await expand_dates.
    Вызов: `parsed["events"] = await apply_overrides(parsed["events"], rules)`.
    """
    items = rules.get("overrides", [])
    if not items:
        return events

    semester = _semester_bounds(events, rules.get("semester"))

    result: list[dict] = []
    for ev in events:
        drop = False
        for rule in items:
            if not _matches(ev, rule.get("match", {})):
                continue

            if rule.get("drop"):
                drop = True
                break

            # dates и fill_semester взаимоисключающие;
            # если указаны оба — fill_semester перекрывает dates.
            if "dates" in rule:
                ev["dates"] = expand_dates(rule["dates"])
            if rule.get("fill_semester") and semester:
                ev["dates"] = _fill_semester(ev, semester)

            for key in OVERRIDE_KEYS:
                if key in rule:
                    ev[key] = rule[key]

        if drop:
            logger.info(f"Override: drop {ev.get('event_id')} ({ev.get('discipline')})")
        else:
            result.append(ev)

    return result