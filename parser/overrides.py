# parser/overrides.py
"""
Ручные правки расписания после парсинга.

Позволяет:
  • удалить конкретное событие (даже если оно есть в Excel)
  • задать ему даты вручную
  • развернуть его на весь семестр по дню недели
  • поправить время / аудиторию / преподавателей

Правила лежат в private/overrides.yaml.
"""
import logging
from datetime import date, datetime, timedelta
from pathlib import Path

import yaml

from parser.finalize import expand_dates

logger = logging.getLogger(__name__)

WEEKDAYS_RU = {"ПН": 0, "ВТ": 1, "СР": 2, "ЧТ": 3, "ПТ": 4, "СБ": 5, "ВС": 6}


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

def _matches(ev: dict, match: dict) -> bool:
    """Все условия в match должны совпасть (AND)."""
    for key, value in match.items():
        if key == "discipline_contains":
            if str(value).lower() not in (ev.get("discipline") or "").lower():
                return False

        elif key == "teacher":
            # точное совпадение с одним из преподавателей
            teachers = [str(t) for t in (ev.get("teachers") or [])]
            if str(value) not in teachers:
                return False

        elif key == "teacher_contains":
            # подстрока (регистронезависимо) хотя бы в одном преподавателе
            needle = str(value).lower()
            teachers = [str(t).lower() for t in (ev.get("teachers") or [])]
            if not any(needle in t for t in teachers):
                return False

        elif isinstance(value, list):
            if str(ev.get(key)) not in [str(v) for v in value]:
                return False

        else:
            if str(ev.get(key)) != str(value):
                return False
    return True


# ---------------------------------------------------------------- операции

def _semester_bounds(events: list[dict], explicit: dict | None) -> tuple[date, date] | None:
    """Границы семестра: из YAML, либо min/max по датам всех событий."""
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

def apply_overrides(events: list[dict], rules: dict) -> list[dict]:
    """
    Применяет overrides к списку финальных событий.

    Схема правила:
        match:                условия выбора события (AND по всем полям)
        drop: true            убрать событие
        dates: "..."          заменить dates (строка → expand_dates)
        fill_semester: true   заполнить dates всеми датами семестра по weekday
        time: "..."           заменить time
        rooms: "..."          заменить rooms
        teachers: [...]       заменить teachers
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

            if "dates" in rule:
                ev["dates"] = expand_dates(rule["dates"])
            if rule.get("fill_semester") and semester:
                ev["dates"] = _fill_semester(ev, semester)
            if "time" in rule:
                ev["time"] = rule["time"]
            if "rooms" in rule:
                ev["rooms"] = rule["rooms"]
            if "teachers" in rule:
                ev["teachers"] = rule["teachers"]

        if drop:
            logger.info(f"Override: drop {ev.get('event_id')} ({ev.get('discipline')})")
        else:
            result.append(ev)

    return result