"""Проверка спорных ячеек расписания через LLM.

Детерминированный адаптер разбирает таблицу и оценивает уверенность.
Всё, что разобрано плохо (нет дисциплины, несколько параллельных
потоков без подгрупп, аудитории не по порядку), уходит модели — но
модель не может придумать данные: её ответ сверяется с исходным
текстом ячейки и с границами учебного года.
"""
from __future__ import annotations

import json
import hashlib
import logging
import re
from datetime import datetime
from pathlib import Path

from parser.ai import ask_ai
from parser.dates import expand_date_text
from parser.model import AcademicPeriod, Faculty, RawBranch
from parser.postprocess import remove_academic_titles

logger = logging.getLogger(__name__)

BATCH_SIZE = 15
MAX_DISCIPLINE = 200

SYSTEM_PROMPT = """Ты разбираешь ячейки расписания ПГГПУ ({faculty}).
Каждая строка — одно занятие, как его видит студент.

Верни СТРОГО по одной JSON-строке на каждое занятие, без пояснений:
{{"i": 3, "discipline": "История России", "type": "прак.", "subgroup": "п/г 1",
 "teachers": ["Габриель Н.Л."], "dates": ["26.10.2026"], "rooms": "406, 2к."}}

Правила:
1. Не придумывай данные. Если чего-то нет в исходной строке — оставь пусто.
2. type — только лек., прак., лаб., семинар, конс., экзамен, зачет или "".
3. subgroup — "п/г N" или "".
4. teachers — только те ФИО, что есть в строке, в виде "Фамилия И.О.".
5. dates — даты формата ДД.ММ.ГГГГ. Если дат нет, верни [].
6. rooms — аудитория как в строке; если её нет — "".
7. Учебный год: {start} — {end}.
"""

REPAIRABLE_ISSUES = {
    "no_discipline",
    "no_teachers",
    "ambiguous_rooms",
    "parallel_without_subgroup",
    "no_weekday",
    "no_time",
    "no_dates",
}


def needs_repair(branch: RawBranch, threshold: float) -> bool:
    if branch.confidence >= threshold:
        return False
    return bool(set(branch.issues) & REPAIRABLE_ISSUES)


def _batch(items: list[RawBranch], size: int) -> list[list[RawBranch]]:
    return [items[index:index + size] for index in range(0, len(items), size)]


def _cache_key(branch: RawBranch) -> str:
    raw = "|".join([
        branch.faculty_id,
        branch.group,
        branch.weekday,
        branch.time_start,
        branch.source_text or branch.discipline,
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _load_cache(path: Path | None) -> dict:
    if not path or not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_cache(path: Path | None, cache: dict) -> None:
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        logger.debug("Не удалось сохранить кэш LLM-проверок: %s", exc)


def build_prompt(
    branches: list[RawBranch],
    faculty: Faculty,
    period: AcademicPeriod,
) -> str:
    start = period.semester_start.isoformat() if period.semester_start else "?"
    end = period.semester_end.isoformat() if period.semester_end else "?"
    header = SYSTEM_PROMPT.format(
        faculty=faculty.name, start=start, end=end
    )

    lines = []
    for index, branch in enumerate(branches, start=1):
        text = branch.source_text or branch.discipline
        lines.append(
            json.dumps({
                "i": index,
                "group": branch.group,
                "weekday": branch.weekday,
                "time": branch.time_start,
                "text": text,
                "guess": {
                    "discipline": branch.discipline,
                    "type": branch.type,
                    "subgroup": branch.subgroup,
                    "teachers": branch.teachers,
                    "dates": branch.dates,
                    "rooms": branch.rooms,
                },
            }, ensure_ascii=False)
        )
    return header + "\nВходные строки:\n" + "\n".join(lines)


def parse_response(lines: list[str]) -> dict[int, dict]:
    result: dict[int, dict] = {}
    for line in lines or []:
        text = line.strip().strip("`")
        if not text.startswith("{"):
            match = re.search(r"\{.*\}", text)
            if not match:
                continue
            text = match.group(0)
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        index = payload.get("i")
        if isinstance(index, int):
            result[index] = payload
    return result


def _normalize_teacher(value: str) -> str:
    cleaned = remove_academic_titles(value) or value
    return cleaned.strip()


def _teacher_in_source(teacher: str, source: str) -> bool:
    if not teacher or not source:
        return False
    parts = [part for part in re.split(r"[\s.,]+", teacher) if part]
    if not parts:
        return False
    surname = parts[0]
    initials = "".join(parts[1:])
    if surname not in source:
        return False
    if not initials:
        return True
    compact = re.sub(r"[\s.]", "", source)
    return initials in compact or initials in re.sub(r"[\s.]", "", teacher)


def apply_payload(
    branch: RawBranch,
    payload: dict,
    period: AcademicPeriod,
) -> RawBranch:
    source = branch.source_text or ""

    discipline = str(payload.get("discipline") or "").strip()
    if discipline and len(discipline) <= MAX_DISCIPLINE:
        branch.discipline = discipline

    type_ = str(payload.get("type") or "").strip()
    if type_ in {"лек.", "прак.", "лаб.", "семинар", "конс.", "экзамен", "зачет", ""}:
        branch.type = type_

    subgroup = str(payload.get("subgroup") or "").strip()
    if re.fullmatch(r"п/г\s*\d+", subgroup) or subgroup == "":
        branch.subgroup = subgroup

    teachers = payload.get("teachers")
    if isinstance(teachers, list):
        cleaned = [
            _normalize_teacher(str(item))
            for item in teachers
            if _teacher_in_source(str(item), source)
        ]
        if cleaned:
            branch.teachers = cleaned

    dates = payload.get("dates")
    if isinstance(dates, list):
        bounds = period.academic_bounds()
        confirmed: list[str] = []
        for item in dates:
            for value in expand_date_text(str(item), period.semester_start.year if period.semester_start else None):
                if not bounds:
                    confirmed.append(value)
                    continue
                try:
                    parsed = datetime.strptime(value, "%d.%m.%Y").date()
                except ValueError:
                    continue
                if bounds[0] <= parsed <= bounds[1]:
                    confirmed.append(value)
        if confirmed:
            branch.dates = confirmed

    rooms = str(payload.get("rooms") or "").strip()
    if rooms and (rooms in source or not source):
        branch.rooms = rooms

    branch.issues = [
        issue for issue in branch.issues
        if issue in {"weekly_dates"}
    ]
    branch.confidence = 0.95
    return branch


async def repair_branches(
    branches: list[RawBranch],
    faculty: Faculty,
    period: AcademicPeriod,
    *,
    threshold: float = 0.9,
    ask=None,
    cache_path: Path | None = None,
) -> list[RawBranch]:
    targets = [branch for branch in branches if needs_repair(branch, threshold)]
    if not targets:
        return branches

    cache = _load_cache(cache_path)
    index_of = {id(branch): position for position, branch in enumerate(branches)}

    pending: list[tuple[str, RawBranch]] = []
    for branch in targets:
        key = _cache_key(branch)
        if key in cache:
            branches[index_of[id(branch)]] = apply_payload(
                branch, cache[key], period
            )
        else:
            pending.append((key, branch))

    if not pending:
        return branches

    ask = ask or ask_ai

    for group in _batch([item[1] for item in pending], BATCH_SIZE):
        prompt = build_prompt(group, faculty, period)
        try:
            lines = await ask(prompt)
        except Exception as exc:  # noqa: BLE001 - без LLM оставляем детерминированный разбор
            logger.warning(
                "LLM-проверка факультета %s недоступна: %s", faculty.id, exc
            )
            return branches

        payloads = parse_response(lines)
        for local_index, branch in enumerate(group, start=1):
            payload = payloads.get(local_index)
            if not payload:
                continue
            updated = apply_payload(branch, payload, period)
            branches[index_of[id(branch)]] = updated
            cache[_cache_key(branch)] = payload

    _save_cache(cache_path, cache)
    return branches
