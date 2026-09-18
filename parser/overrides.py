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

    if isinstance(value, list):
        return str(ev.get(key)) in [str(v) for v in value]

    return str(ev.get(key)) == str(value)


def _matches(ev: dict, match: dict) -> bool:
    """
    Все условия в match должны совпасть (AND).

    Поддерживается блок `not` — вложенный словарь с теми же ключами,
    но условия внутри него должны НЕ совпасть.

    Схема:
        match:
          group: "1247"            # ev.group == "1247"
          discipline_contains: "…" # "…" в ev.discipline
          not:
            time: "11:30"          # ev.time != "11:30"
            subgroup: "п/г 1"      # ev.subgroup != "п/г 1"
    """
    for key, value in match.items():
        # Блок отрицаний — все условия внутри должны НЕ совпасть
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