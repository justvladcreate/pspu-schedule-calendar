"""Математический факультет (id 01).

Особенность файла: **даты внутри ячеек без года**, а шапка листа часто
осталась от прошлого учебного года. Поэтому год берём не из подписи
«2 семестр 2025 - 2026», а ищем на листах строку с реальным диапазоном
занятий (`01.09.2026-16.01.2027`) — она обновляется. Достаточно одного
листа с правильными годами, чтобы считать файл актуальным.

Разбор строки:

    14.09-28.09 Русский язык и культура речи (л) / Бакланова И.И.
    с 12.10  Иностранный язык пг. 1.2 Некрасова И.М.
    07.09 Тестирование (...) (пг.1)

Всё, что разобрано неуверенно, помечается в ``RawBranch.issues`` и
уходит в LLM (только такие строки, пакетами, с кэшем).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import asdict
from datetime import date, datetime, timedelta

from parser.core.dates import expand_date_text
from parser.core.model import AcademicPeriod, Faculty, RawBranch
from parser.core.text import normalize_time
from parser.faculties.base import (
    AFTER_AI_NAME,
    EXTRACTED_NAME,
    SOURCE_NAME,
    FacultyParser,
    read_json,
    rotate,
    write_json,
)
from parser.faculties.f01_math.prompt import USER_PROMPT
from parser.sources.base import ScheduleSource, SheetData
from parser.sources.cloud_mail import CloudMailFileSource

logger = logging.getLogger(__name__)

CONFIDENCE_THRESHOLD = 0.9
LLM_BATCH_SIZE = 8
LLM_CACHE_NAME = "llm_cache.json"

# Через LLM имеет смысл уточнять только то, что он реально может исправить
# по исходной строке. Отсутствие подгруппы или аудитории он не выдумает.
REPAIRABLE_ISSUES = {
    "dates_unparsed",
    "teacher_unparsed",
    "no_discipline",
    "parallel_without_subgroup",
}

_DAYS = {
    "понедельник": "ПН", "вторник": "ВТ", "среда": "СР", "четверг": "ЧТ",
    "пятница": "ПТ", "суббота": "СБ", "воскресенье": "ВС",
    "пн": "ПН", "вт": "ВТ", "ср": "СР", "чт": "ЧТ", "пт": "ПТ", "сб": "СБ", "вс": "ВС",
}
_TIME_RE = re.compile(r"\b(\d{1,2})\s*[.:\-]\s*(\d{2})\b")

# Даты в начале строки: «14.09-28.09», «с 12.10», «15.09, с 13.10-27.10»,
# «07.09.2026», «12.10, 19.10, 23.11».
_DATE = r"\d{1,2}\.\d{2}(?:\.\d{4})?"
_DATE_TOKEN_RE = re.compile(r"\b\d{1,2}\.\d{2}(?:\.\d{4})?\b")
_LEADING_DATES_RE = re.compile(
    rf"^\s*(?:(?:с|до|по)\s+)?{_DATE}"
    rf"(?:\s*[-–—]\s*{_DATE})?"
    rf"(?:\s*,\s*(?:(?:с|до|по)\s+)?{_DATE}(?:\s*[-–—]\s*{_DATE})?)*",
    re.I,
)
_YEAR_RANGE_RE = re.compile(r"\b(\d{4})\s*[-–—/]\s*(\d{4})\b")
_FULL_DATE_RE = re.compile(r"\b(\d{1,2})\.(\d{2})\.(\d{4})\b")
_DATE_RANGE_FULL_RE = re.compile(
    r"\b(\d{1,2})\.(\d{2})\.(\d{4})\s*[-–—]\s*(\d{1,2})\.(\d{2})\.(\d{4})\b"
)

_SUBGROUP_RE = re.compile(r"\bп\s*г\.?\s*(\d+(?:\.\d+)?)", re.I)
_TYPE_RE = re.compile(
    r"\(\s*(л|лек|пр|прак|лаб|с|сем)\b[^)]*\)|"
    r"\b(лекции|лекция|практические\s+занятия|лабораторные\s+занятия|семинар)\b",
    re.I,
)
_TYPE_MAP = {
    "л": "лек.", "лек": "лек.", "лекции": "лек.", "лекция": "лек.",
    "пр": "прак.", "прак": "прак.", "практические занятия": "прак.",
    "лаб": "лаб.", "лабораторные занятия": "лаб.",
    "с": "семинар", "сем": "семинар", "семинар": "семинар",
}
_TEACHER_RE = re.compile(
    r"(?:[А-ЯЁ]\.\s*){1,2}\s*[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?"
    r"|[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+(?:[А-ЯЁ]\.\s*){1,2}"
)
_SERVICE_RE = re.compile(r"^(перерыв|обед)\b", re.I)
_NOISE_RE = re.compile(
    r"семестр|учебн\w*\s*год|расписание|направление\s+подготовки|"
    r"профил[ьи]|форма\s+обучения|курс\s*,\s*групп",
    re.I,
)
_LEADING_TIME_RANGE_RE = re.compile(
    r"^\s*с\s*(\d{1,2})\s*([.:])\s*(\d{2})\s*(до|[-–—])\s*"
    r"(\d{1,2})\s*([.:])\s*(\d{2})\s*",
    re.I,
)


# ------------------------------------------------------------------ helpers
def _day_code(value: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    for word, code in _DAYS.items():
        if text.startswith(word):
            return code
    match = _FULL_DATE_RE.match(text)
    if match:
        day, month, year = (int(part) for part in match.groups())
        try:
            return ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"][
                datetime(year, month, day).weekday()
            ]
        except ValueError:
            return ""
    return ""


def _parse_time(value: str) -> tuple[str, str]:
    matches = _TIME_RE.findall(str(value or ""))
    if not matches:
        return "", ""
    hour, minute = int(matches[0][0]), int(matches[0][1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return "", ""
    start = normalize_time(f"{hour:02d}:{minute:02d}")
    if len(matches) > 1:
        end = normalize_time(f"{int(matches[1][0]):02d}:{int(matches[1][1]):02d}")
    else:
        total = hour * 60 + minute + 90
        end = f"{(total // 60) % 24:02d}:{total % 60:02d}"
    return start, end


def _strip_leading_time_range(text: str) -> str:
    """Убирает «с 9.00 до 12.30» в начале строки.

    Важно не спутать с датами: «с 14.10-25.11» — это диапазон дат,
    а не время. Поэтому:
      • вариант с «до» считаем временем;
      • вариант с двоеточием (9:00-12:30) считаем временем;
      • «07.10-02.12» и «14.10-25.11» оставляем датами.
    """
    match = _LEADING_TIME_RANGE_RE.match(text)
    if not match:
        return text

    hour1, sep1, minute1, connector, hour2, sep2, minute2 = match.groups()
    if str(connector).lower() != "до" and ":" not in (sep1, sep2):
        return text

    try:
        values = (int(hour1), int(minute1), int(hour2), int(minute2))
    except (TypeError, ValueError):
        return text
    if not (
        0 <= values[0] <= 23 and 0 <= values[1] <= 59
        and 0 <= values[2] <= 23 and 0 <= values[3] <= 59
    ):
        return text
    return text[match.end():]


def _normalize_teacher(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip(" ,;/")
    text = re.sub(r"([А-ЯЁ])\.\s+([А-ЯЁ])\.", r"\1.\2.", text)
    return text


def _academic_start_from_range(text: str) -> int | None:
    """01.09.2026-16.01.2027 → 2026; 02.02.2026-25.06.2026 → 2025."""
    match = _DATE_RANGE_FULL_RE.search(text)
    if match:
        day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
        return year if month >= 9 else year - 1
    match = _FULL_DATE_RE.search(text)
    if match:
        month, year = int(match.group(2)), int(match.group(3))
        return year if month >= 9 else year - 1
    return None


def _academic_start_from_label(text: str) -> int | None:
    """«2 семестр 2025 - 2026» → 2025."""
    if "семестр" not in text.lower():
        return None
    match = _YEAR_RANGE_RE.search(text)
    return int(match.group(1)) if match else None


# ------------------------------------------------------------------ parsing
def _split_teachers(rest: str) -> tuple[str, list[str]]:
    """Отделяет ФИО от дисциплины. Возвращает (остаток, преподаватели)."""
    teachers: list[str] = []
    text = rest

    if " / " in text:
        text, tail = text.rsplit(" / ", 1)
        for chunk in re.split(r"[,;]", tail):
            found = _TEACHER_RE.search(chunk)
            if found:
                name = _normalize_teacher(found.group(0))
                if name not in teachers:
                    teachers.append(name)
        return text.strip(" /"), teachers

    # ФИО в конце строки без «/»: «… пг. 1.2 Некрасова И.М.»
    found = list(_TEACHER_RE.finditer(text))
    if found:
        tail = found[-1]
        after = text[tail.end():].strip(" ,;")
        if not after:
            name = _normalize_teacher(tail.group(0))
            if name not in teachers:
                teachers.append(name)
            text = text[:tail.start()].strip(" ,;/")
    return text, teachers


def _parse_line(line: str, year: int | None) -> dict:
    """Разбирает одну строку ячейки дисциплины."""
    raw = line.strip().lstrip(" ,;:/–—-").strip()
    dates_text = ""
    match = _LEADING_DATES_RE.match(raw)
    if match:
        dates_text = match.group(0)
        raw = raw[match.end():]
        # после дат может идти время мероприятия: «с 9.00 до 12.30 …»
        raw = _strip_leading_time_range(raw)

    dates = expand_date_text(dates_text, year) if dates_text else []

    rest, teachers = _split_teachers(raw)

    subgroup = ""
    sub_match = _SUBGROUP_RE.search(rest)
    if sub_match:
        subgroup = f"п/г {sub_match.group(1)}"
        rest = rest[:sub_match.start()] + " " + rest[sub_match.end():]

    type_ = ""
    type_match = _TYPE_RE.search(rest)
    if type_match:
        key = (type_match.group(1) or type_match.group(2) or "").lower().strip(".")
        type_ = _TYPE_MAP.get(key, "")
        rest = rest[:type_match.start()] + " " + rest[type_match.end():]

    # Прочие скобки — пояснения, не часть названия.
    notes = re.findall(r"\(([^()]*)\)", rest)
    rest = re.sub(r"\([^()]*\)", " ", rest)

    if not teachers:
        for note in notes:
            found = _TEACHER_RE.search(note)
            if found:
                name = _normalize_teacher(found.group(0))
                if name not in teachers:
                    teachers.append(name)
                notes = [item for item in notes if item != note]

    discipline = re.sub(r"\s{2,}", " ", rest).strip(" ,.;:/-")
    note_text = "; ".join(note.strip() for note in notes if note.strip())

    return {
        "discipline": discipline,
        "type": type_,
        "subgroup": subgroup,
        "teachers": teachers,
        "dates": sorted(dates, key=lambda item: (item[6:], item[3:5], item[:2])),
        "note": note_text,
        "raw": line.strip(),
    }


_ROOM_JUNK = {
    "-", "—", "–", "нет", "n/a", "н/д", "н д", "nan",
}
_MAX_ROOM_RE = re.compile(r"\b(?:max|мах|макс|максимум)\b", re.I)


def _clean_room_line(line: str) -> tuple[str, str]:
    """Одна строка колонки аудиторий → (аудитория, пометка).

    «Max»/«мах»/«макс» — дистанционка, а не номер аудитории.
    «Видеолекции» — пометка, а не аудитория.
    Даты, ссылки и ФИО из поля аудитории вычищаем.
    """
    text = str(line or "").strip()
    if not text or text.lower() in _ROOM_JUNK:
        return "", ""

    text = text.replace("\\", "/")
    text = re.sub(r"\s+", " ", text).strip()
    low = text.lower()

    if _MAX_ROOM_RE.search(low) or "joincall" in low or "http" in low:
        return "дистанционно онлайн", ""
    if "видеолекц" in low:
        return "", "Видеолекции"

    # Даты перед аудиторией: «23.09-В-103», «IV / 26.10-А-323».
    text = re.sub(r"\b\d{1,2}\.\d{2}(?:\.\d{4})?\s*[-–—]\s*", "", text)
    # Даты в скобках/после «до»: «IV / 206 (26.10)», «А-304 (до 28.10».
    text = re.sub(
        r"\(\s*(?:до|с|по)?\s*\d{1,2}\.\d{2}(?:\.\d{4})?\s*\)?",
        "",
        text,
        flags=re.I,
    )
    # ФИО в скобках и без них — к аудитории не относятся.
    text = re.sub(r"\s*\([^()]*[А-ЯЁ]\.\s*[А-ЯЁ]?\.[^()]*\)", "", text)
    text = _TEACHER_RE.sub("", text)

    # «гл. корп / 15», «гл. корп15» → «гл. корп. 15».
    text = re.sub(
        r"гл\.?\s*корп\.?\s*[/\\]?\s*",
        "гл. корп. ",
        text,
        flags=re.I,
    )
    text = re.sub(r"\s*/\s*", " / ", text)
    text = re.sub(r"\s+", " ", text).strip(" ,;:.)")
    if text.lower() in {"гл. корп", "гл.корп"}:
        text = "гл. корп."
    if text.lower() in _ROOM_JUNK:
        return "", ""
    return text, ""


def _room_entries(value: str) -> list[tuple[str, str]]:
    """Колонка аудиторий → [(аудитория, пометка)] по строкам.

    Пустые строки сохраняем: они держат соответствие с занятиями
    (в ячейке дисциплин столько же строк).
    """
    raw = str(value or "")
    if not raw or raw.strip().lower() == "nan":
        return []

    lines = re.split(r"\r?\n", raw)
    while lines and not lines[-1].strip():
        lines.pop()

    return [_clean_room_line(line) for line in lines]


def _pair_rooms(
    entries: list[tuple[str, str]],
    count: int,
) -> tuple[list[tuple[str, str]], str]:
    """Сопоставляет аудитории занятиям по порядку.

    Возвращает (аудитории, статус), где статус:
      ""        — всё сошлось;
      "partial" — аудиторий меньше, чем занятий (часть осталась без);
      "more"    — аудиторий больше, чем занятий (привязка сомнительна).
    """
    if count <= 0:
        return [], ""
    if not entries:
        return [("", "")] * count, ""
    if len(entries) == count:
        return entries, ""
    if len(entries) == 1:
        return [entries[0]] * count, ""
    if len(entries) > count:
        return entries[:count], "more"
    return entries + [("", "")] * (count - len(entries)), "partial"


def _looks_like_source(value: str, source: str) -> bool:
    """Защита от выдуманных названий: начало дисциплины есть в исходнике."""
    if not value or not source:
        return False
    head = re.sub(r"[^0-9a-zа-яё]", "", value.lower())[:8]
    if not head:
        return False
    return head in re.sub(r"[^0-9a-zа-яё]", "", source.lower())


def _teacher_in_source(teacher: str, source: str) -> bool:
    parts = [part for part in re.split(r"[\s.]+", teacher) if part]
    if not parts:
        return False
    surname = parts[0]
    if surname not in source:
        return False
    initials = "".join(parts[1:])
    if not initials:
        return True
    return initials in re.sub(r"[\s.]", "", source)


# ------------------------------------------------------------------ parser
class MathParser(FacultyParser):
    id = "01"
    uses_llm = True

    def __init__(self, faculty: Faculty, paths=None, ask=None):
        super().__init__(faculty, paths, ask)
        self._branches: list[RawBranch] = []
        self._period: AcademicPeriod | None = None

    # ---------------------------------------------------------- source
    def source(self) -> ScheduleSource:
        if not self.faculty.source.url:
            raise ValueError("У факультета 01 нет ссылки на таблицу")
        return CloudMailFileSource(
            self.faculty.source.url,
            self.paths.latest_file(SOURCE_NAME),
        )

    # ---------------------------------------------------------- parse
    async def parse(
        self,
        sheets: list[SheetData],
        period: AcademicPeriod,
    ) -> dict:
        self._period = period
        self._branches = []

        anchor = self._actual_year(sheets, period)
        if anchor is None:
            logger.info(
                "Файл 01: ни на одном листе нет текущего учебного года — пропуск"
            )
            self._branches = []
            return {}

        window = self._semester_window(sheets, period, anchor)
        logger.info(
            "Файл 01: учебный год %s/%s, окно %s — %s",
            anchor, anchor + 1, window[0], window[1],
        )

        for sheet in sheets:
            self._branches.extend(self._parse_sheet(sheet, period, anchor))

        self._branches = self._fill_weekly(self._branches, period)
        self._branches = self._filter_window(self._branches, window)

        extracted_path = self.paths.latest_file(EXTRACTED_NAME)
        rotate(extracted_path)
        write_json(extracted_path, [asdict(branch) for branch in self._branches])

        groups = self._to_groups(self._branches, anchor)
        after_ai_path = self.paths.latest_file(AFTER_AI_NAME)
        rotate(after_ai_path)
        write_json(after_ai_path, groups)
        return groups

    def _parse_sheet(
        self,
        sheet: SheetData,
        period: AcademicPeriod,
        year: int,
    ) -> list[RawBranch]:
        if sheet.hidden:
            return []

        df = sheet.df
        if df.empty:
            return []

        header_row = self._header_row(df)
        if header_row is None:
            return []

        group = self._sheet_group(df, header_row) or sheet.name.strip()
        if not group:
            return []

        branches: list[RawBranch] = []
        current_day = ""

        for row_index in range(header_row + 1, len(df)):
            row = df.iloc[row_index]

            def value(index: int) -> str:
                if index >= len(row):
                    return ""
                text = str(row.iloc[index]).replace("\xa0", " ").strip()
                return "" if text in ("nan", "None") else text

            if _SERVICE_RE.match(value(0)):
                continue

            day = _day_code(value(0))
            if day:
                current_day = day
            day = day or current_day
            if not day:
                continue

            time_start, time_end = _parse_time(value(3))
            if not time_start:
                continue

            subject_text = value(4)
            if not subject_text:
                continue
            if _NOISE_RE.search(subject_text):
                continue

            subject_text = "\n".join(
                _strip_leading_time_range(line)
                for line in re.split(r"\r?\n", subject_text)
            )

            lines = [line.strip() for line in re.split(r"\r?\n", subject_text) if line.strip()]
            parsed = [_parse_line(line, year) for line in lines]
            parsed = [item for item in parsed if item["discipline"] or item["teachers"]]
            if not parsed:
                continue

            rooms, rooms_status = _pair_rooms(_room_entries(value(5)), len(parsed))
            parallel_ambiguous = self._parallel_ambiguous(parsed)

            for index, item in enumerate(parsed):
                rooms_text, room_note = rooms[index] if index < len(rooms) else ("", "")

                notes = [item["note"]] if item["note"] else []
                if room_note:
                    notes.append(room_note)

                branch = RawBranch(
                    group=group,
                    weekday=day,
                    time_start=time_start,
                    time_end=time_end,
                    dates=item["dates"],
                    discipline=item["discipline"],
                    type=item["type"],
                    subgroup=item["subgroup"],
                    teachers=item["teachers"],
                    rooms=rooms_text,
                    comment="; ".join(notes),
                    source_text=item["raw"],
                    room_source=value(5),
                    source_ref={"sheet": sheet.name, "row": row_index + 1},
                )
                self._score(branch, parallel_ambiguous, rooms_status)
                branches.append(branch)

        return branches

    # ---------------------------------------------------------- confidence
    @staticmethod
    def _parallel_ambiguous(parsed: list[dict]) -> bool:
        """Несколько занятий в ячейке без подгрупп и с пересечением дат."""
        if len(parsed) < 2:
            return False
        if any(item["subgroup"] for item in parsed):
            return False

        seen: set[str] = set()
        for item in parsed:
            dates = item["dates"]
            if not dates:
                return True
            current = set(dates)
            if current & seen:
                return True
            seen |= current
        return False

    @staticmethod
    def _score(
        branch: RawBranch,
        parallel_ambiguous: bool,
        rooms_status: str,
    ) -> None:
        score = 1.0
        issues: list[str] = []
        source = branch.source_text

        has_date_tokens = bool(_DATE_TOKEN_RE.search(source))
        has_teacher_token = bool(_TEACHER_RE.search(source))

        if not branch.dates:
            if has_date_tokens:
                score -= 0.35
                issues.append("dates_unparsed")
            else:
                issues.append("weekly_no_dates")
        if not branch.discipline:
            score -= 0.30
            issues.append("no_discipline")
        if not branch.teachers:
            if has_teacher_token:
                score -= 0.15
                issues.append("teacher_unparsed")
            else:
                score -= 0.02
                issues.append("no_teachers")
        if not branch.rooms and not branch.comment:
            score -= 0.05
            issues.append("no_rooms")
        if rooms_status == "more":
            score -= 0.15
            issues.append("rooms_mismatch")
        elif rooms_status == "partial":
            score -= 0.05
            issues.append("rooms_partial")
        if parallel_ambiguous:
            score -= 0.15
            issues.append("parallel_without_subgroup")

        branch.confidence = round(max(score, 0.0), 2)
        branch.issues = issues

    # ---------------------------------------------------------- LLM
    async def refine(self, groups: dict, period: AcademicPeriod) -> dict:
        if not self._branches:
            return groups

        targets = [
            branch for branch in self._branches
            if branch.confidence < CONFIDENCE_THRESHOLD
            and REPAIRABLE_ISSUES.intersection(branch.issues)
        ]
        if not targets:
            logger.info(
                "Факультет 01: строк для LLM нет "
                "(%d разобраны уверенно или требуют ручной проверки)",
                len(self._branches),
            )
            return groups

        cache_path = self.paths.latest_file(LLM_CACHE_NAME)
        cache = read_json(cache_path)
        ask = self.ask

        if ask is None:
            from parser.core.ai import ask_ai
            ask = ask_ai

        pending: list[RawBranch] = []
        for branch in targets:
            key = self._cache_key(branch)
            if key in cache:
                self._apply_payload(branch, cache[key])
            else:
                pending.append(branch)

        if not pending:
            logger.info(
                "Факультет 01: %d сомнительных строк, все уже в кэше LLM",
                len(targets),
            )
        else:
            logger.info(
                "Факультет 01: уточняю через LLM %d строк (из %d сомнительных)",
                len(pending), len(targets),
            )

        if pending:
            for start in range(0, len(pending), LLM_BATCH_SIZE):
                batch = pending[start:start + LLM_BATCH_SIZE]
                prompt = self._build_prompt(batch, period)
                try:
                    lines = await ask(prompt)
                except Exception as exc:  # noqa: BLE001 - без LLM оставляем как есть
                    logger.warning("Факультет 01: LLM недоступна: %s", exc)
                    break

                payloads = self._parse_response(lines)
                for index, branch in enumerate(batch, start=1):
                    payload = payloads.get(index)
                    if not payload:
                        continue
                    self._apply_payload(branch, payload)
                    cache[self._cache_key(branch)] = payload

            write_json(cache_path, cache)

        # Пересобираем группы с учётом правок
        rebuilt = self._to_groups(
            self._branches,
            period.semester_start.year if period.semester_start else None,
        )
        after_ai_path = self.paths.latest_file(AFTER_AI_NAME)
        write_json(after_ai_path, rebuilt)
        return rebuilt

    @staticmethod
    def _cache_key(branch: RawBranch) -> str:
        raw = "|".join([
            branch.group, branch.weekday, branch.time_start,
            branch.source_text or branch.discipline,
        ])
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def _build_prompt(self, batch: list[RawBranch], period: AcademicPeriod) -> str:
        start = period.semester_start.isoformat() if period.semester_start else "?"
        end = period.semester_end.isoformat() if period.semester_end else "?"
        lines = []
        for index, branch in enumerate(batch, start=1):
            lines.append(json.dumps({
                "i": index,
                "group": branch.group,
                "weekday": branch.weekday,
                "time": branch.time_start,
                "source": branch.source_text,
                "room_cell": branch.room_source,
                "guess": {
                    "discipline": branch.discipline,
                    "type": branch.type,
                    "subgroup": branch.subgroup,
                    "teachers": branch.teachers,
                    "dates": branch.dates,
                    "rooms": branch.rooms,
                },
            }, ensure_ascii=False))
        return USER_PROMPT.format(start=start, end=end, data="\n".join(lines))

    @staticmethod
    def _parse_response(lines: list[str]) -> dict[int, dict]:
        result: dict[int, dict] = {}
        for line in lines or []:
            text = str(line).strip().strip("`")
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

    def _apply_payload(self, branch: RawBranch, payload: dict) -> None:
        source = branch.source_text

        discipline = str(payload.get("discipline") or "").strip()
        if discipline and len(discipline) <= 200 and _looks_like_source(discipline, source):
            branch.discipline = discipline

        type_ = str(payload.get("type") or "").strip()
        if type_ in {"лек.", "прак.", "лаб.", "семинар", ""}:
            branch.type = type_

        subgroup = str(payload.get("subgroup") or "").strip()
        if re.fullmatch(r"п/г\s*\d+(?:\.\d+)?", subgroup) or subgroup == "":
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
            confirmed = list(branch.dates)
            for item in dates:
                for value in expand_date_text(str(item), self._anchor_year()):
                    # Добавляем только то, что действительно есть в строке,
                    # и никогда не выбрасываем уже найденные даты.
                    token = value[:5]
                    if token in source and value not in confirmed:
                        confirmed.append(value)
            if confirmed:
                branch.dates = sorted(
                    confirmed,
                    key=lambda item: (item[6:], item[3:5], item[:2]),
                )

        # Аудитории LLM не трогает: при merged-ячейках она угадывает
        # соседние кабинеты. Раскладку делает детерминированный парсер.

        if branch.discipline and branch.dates:
            branch.confidence = max(branch.confidence, 0.95)

    def _anchor_year(self) -> int | None:
        if self._period and self._period.semester_start:
            return self._period.semester_start.year
        return None

    # ---------------------------------------------------------- year
    @staticmethod
    def _target_year(period: AcademicPeriod) -> int | None:
        if not period.semester_start:
            return None
        start = period.semester_start
        return start.year if start.month >= 9 else start.year - 1

    def _actual_year(
        self,
        sheets: list[SheetData],
        period: AcademicPeriod,
    ) -> int | None:
        """Ищет хотя бы один лист с текущим учебным годом."""
        target = self._target_year(period)
        if target is None:
            return None

        for sheet in sheets:
            if sheet.hidden or sheet.df.empty:
                continue
            header_row = self._header_row(sheet.df)
            if header_row is None:
                continue
            for row in range(header_row + 1):
                text = " ".join(
                    str(value) for value in sheet.df.iloc[row]
                    if str(value).strip() not in ("nan", "None", "")
                )
                if not text:
                    continue
                candidates = {
                    _academic_start_from_range(text),
                    _academic_start_from_label(text),
                }
                if target in candidates:
                    return target
        return None

    def _semester_window(
        self,
        sheets: list[SheetData],
        period: AcademicPeriod,
        year: int,
    ) -> tuple[datetime.date, datetime.date]:
        """Реальный диапазон занятий: ищем строку вида ДД.ММ.ГГГГ-ДД.ММ.ГГГГ."""
        for sheet in sheets:
            if sheet.hidden or sheet.df.empty:
                continue
            header_row = self._header_row(sheet.df)
            if header_row is None:
                continue
            for row in range(header_row + 1):
                text = " ".join(
                    str(value) for value in sheet.df.iloc[row]
                    if str(value).strip() not in ("nan", "None", "")
                )
                match = _DATE_RANGE_FULL_RE.search(text)
                if not match:
                    continue
                # Берём только диапазон текущего учебного года:
                # 01.09.2026-16.01.2027 → 2026, 02.02.2026-25.06.2026 → 2025.
                if _academic_start_from_range(text) != year:
                    continue
                start = datetime(
                    int(match.group(3)), int(match.group(2)), int(match.group(1))
                ).date()
                end = datetime(
                    int(match.group(6)), int(match.group(5)), int(match.group(4))
                ).date()
                if end >= start:
                    # Расширяем окно до границ семестра из реестра:
                    # в файле встречаются занятия позже последней даты
                    # в шапке (например, 18.01 при конце 16.01).
                    if period.semester_start:
                        start = min(start, period.semester_start)
                    if period.semester_end:
                        end = max(end, period.semester_end)
                    return start, end

        if period.semester_start and period.semester_end:
            return period.semester_start, period.semester_end

        return (
            datetime(year, 9, 1).date(),
            datetime(year + 1, 8, 31).date(),
        )

    # ---------------------------------------------------------- post
    @staticmethod
    def _fill_weekly(
        branches: list[RawBranch],
        period: AcademicPeriod,
    ) -> list[RawBranch]:
        """Без дат — каждую неделю, но не поверх уже занятых слотов."""
        if not period.semester_start or not period.semester_end:
            return branches

        occupied: dict[tuple[str, str, str], set[str]] = {}
        for branch in branches:
            if not branch.dates:
                continue
            occupied.setdefault(
                (branch.group, branch.weekday, branch.time_start), set()
            ).update(branch.dates)

        order = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"]
        result: list[RawBranch] = []

        for branch in branches:
            if branch.dates:
                result.append(branch)
                continue
            if branch.weekday not in order:
                continue

            start = period.semester_start
            offset = (order.index(branch.weekday) - start.weekday()) % 7
            current = start + timedelta(days=offset)

            busy = occupied.setdefault(
                (branch.group, branch.weekday, branch.time_start), set()
            )
            weekly: list[str] = []
            while current <= period.semester_end:
                value = current.strftime("%d.%m.%Y")
                if value not in busy:
                    weekly.append(value)
                current += timedelta(days=7)

            if weekly:
                branch.dates = weekly
                branch.issues.append("weekly_dates")
                result.append(branch)

        return result

    @staticmethod
    def _filter_window(
        branches: list[RawBranch],
        window: tuple[date, date],
    ) -> list[RawBranch]:
        low, high = window
        result: list[RawBranch] = []
        for branch in branches:
            kept = []
            for value in branch.dates:
                try:
                    parsed = datetime.strptime(value, "%d.%m.%Y").date()
                except ValueError:
                    continue
                if low <= parsed <= high:
                    kept.append(value)
            if kept:
                branch.dates = kept
                result.append(branch)
        return result

    @staticmethod
    def _to_groups(branches: list[RawBranch], year: int | None) -> dict:
        groups: dict[str, dict] = {}
        for branch in branches:
            if not branch.group or not branch.weekday or not branch.time_start:
                continue
            group = groups.setdefault(
                branch.group,
                {"events": [], "semester_start_year": year},
            )
            group["events"].append({
                "weekday": branch.weekday,
                "time_start": branch.time_start,
                "time_end": branch.time_end,
                "dates": ", ".join(branch.dates),
                "discipline": branch.discipline,
                "type": branch.type,
                "subgroup": branch.subgroup,
                "teachers": ", ".join(branch.teachers),
                "rooms": branch.rooms,
                "comment": branch.comment,
                "color": branch.color,
                "is_past": branch.is_past,
            })
        return groups

    # ---------------------------------------------------------- header
    @staticmethod
    def _header_row(df) -> int | None:
        for row in range(min(30, len(df))):
            values = [str(value).lower() for value in df.iloc[row]]
            joined = " ".join(values)
            if "дисциплин" in joined and ("время" in joined or "№" in values):
                return row
        return None

    @staticmethod
    def _sheet_group(df, header_row: int) -> str:
        for row in range(0, header_row):
            for value in df.iloc[row]:
                text = str(value).strip()
                match = re.search(
                    r"групп[аы]?\s*[№:]?\s*([A-Za-zА-Яа-яЁё]?\d{3,4})",
                    text,
                    re.I,
                )
                if match:
                    return match.group(1).upper().replace(" ", "")
        return ""
