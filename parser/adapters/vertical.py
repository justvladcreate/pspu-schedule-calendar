"""Универсальный адаптер «вертикальных» таблиц.

Формат: строки — занятия, столбцы — день / № / начало / дисциплина /
даты / аудитория. Встречается у 02, 03, 04, 05, 06, 08, 10, 13, 16
и близких факультетов.

В одном листе может быть несколько блоков колонок рядом (по блоку на
группу) — каждый разбирается отдельно, иначе перепутаются аудитории
и преподаватели.
"""
from __future__ import annotations

import re
from dataclasses import replace

from parser.adapters.base import (
    block_has_data,
    build_branch,
    cell_text,
    dedupe_adjacent,
    detect_blocks,
    extract_group_codes,
    find_header_row,
    infer_block_group,
    normalize_day,
    pair_to_time,
    parse_cell_blocks,
    parse_pair,
    parse_time,
    split_lines,
)
from parser.dates import expand_date_text
from parser.model import AcademicPeriod, Faculty, RawBranch
from parser.sources.base import SheetData

_SKIP_SHEETS = ("qr", "приложение", "повтор", "график", "подфак", "лист1")
_SERVICE_WORDS = ("перерыв", "обед", "кураторский час", "дистанционно")
_HEADER_NOISE_RE = re.compile(
    r"семестр|учебн\w*\s*год|курс\s*,?\s*групп|направление подготовки",
    re.I,
)


def _pair_rooms(rooms: list[str], count: int) -> tuple[list[str], bool]:
    if count <= 0:
        return [], False
    if not rooms:
        return [""] * count, False
    if len(rooms) == count:
        return rooms, False
    if len(rooms) == 1:
        return [rooms[0]] * count, False
    joined = ", ".join(rooms)
    return [joined] * count, True


class VerticalAdapter:
    """Разбор построчных таблиц расписания."""

    def parse(
        self,
        sheets: list[SheetData],
        faculty: Faculty,
        period: AcademicPeriod,
    ) -> list[RawBranch]:
        result: list[RawBranch] = []
        for sheet in sheets:
            result.extend(self._parse_sheet(sheet, faculty, period))
        return self._fill_weekly_gaps(result, period)

    # ---------------------------------------------------------- sheet
    def _parse_sheet(
        self,
        sheet: SheetData,
        faculty: Faculty,
        period: AcademicPeriod,
    ) -> list[RawBranch]:
        if sheet.hidden:
            return []
        if any(token in sheet.name.lower() for token in _SKIP_SHEETS):
            return []

        df = sheet.df
        if df.empty:
            return []
        header_row = find_header_row(df)
        if header_row is None:
            return []

        blocks = detect_blocks(df, header_row)
        if not blocks:
            return []

        result: list[RawBranch] = []
        semester_year = period.semester_start.year if period.semester_start else None

        for block_index, columns in enumerate(blocks):
            if not block_has_data(df, header_row, columns):
                continue

            group, group_confidence = infer_block_group(
                df, header_row, columns, sheet.name, block_index, len(blocks)
            )
            if not group:
                continue
            if len(blocks) > 1 and group_confidence < 0.9:
                group = f"{group}-{block_index + 1}" if group == sheet.name.strip() else group

            block_branches = self._parse_block(
                df=df,
                sheet=sheet,
                columns=columns,
                header_row=header_row,
                group=group,
                group_confidence=group_confidence,
                faculty=faculty,
                period=period,
                semester_year=semester_year,
                multi_block=len(blocks) > 1,
            )
            result.extend(block_branches)

            # Лист может покрывать несколько групп («731, 732»):
            # расписание у них общее, поэтому дублируем события.
            codes = extract_group_codes(sheet.name)
            if group == sheet.name.strip() and len(codes) > 1:
                for extra in codes[1:]:
                    for branch in block_branches:
                        result.append(replace(branch, group=extra))

        return self._drop_stale(result, period)

    def _parse_block(
        self,
        *,
        df,
        sheet: SheetData,
        columns: dict,
        header_row: int,
        group: str,
        group_confidence: float,
        faculty: Faculty,
        period: AcademicPeriod,
        semester_year: int | None,
        multi_block: bool,
    ) -> list[RawBranch]:
        result: list[RawBranch] = []
        current_day = ""

        for row_index in range(header_row + 1, len(df)):
            row = df.iloc[row_index]

            def value(index: int | None) -> str:
                if index is None or index >= len(row):
                    return ""
                return cell_text(row.iloc[index])

            pair_text = value(columns["pair"]).lower()
            if any(word in pair_text for word in _SERVICE_WORDS):
                continue

            row_text = " ".join(
                cell_text(row.iloc[index])
                for index in range(columns.get("start", 0), min(columns.get("end", len(row)), len(row)))
            )
            if _HEADER_NOISE_RE.search(row_text):
                continue

            day = normalize_day(value(columns["day"]))
            if day:
                current_day = day
            day = day or current_day

            time_start, time_end = parse_time(value(columns["time"]))
            pair = None
            if columns["pair"] is not None:
                pair = parse_pair(value(columns["pair"]))
            if not time_start and pair is not None:
                time_start, time_end = pair_to_time(pair)
            if not time_start:
                continue

            subject_cells = dedupe_adjacent(
                [value(index) for index in columns["subject"]]
            )
            if not subject_cells:
                continue

            blocks: list[dict] = []
            for cell in subject_cells:
                for block in parse_cell_blocks(cell):
                    if any(word in block["raw"].lower() for word in _SERVICE_WORDS):
                        continue
                    blocks.append(block)
            if not blocks:
                continue

            date_text = ", ".join(
                value(index) for index in columns["dates"] if value(index)
            )
            room_values = [value(index) for index in columns["room"] if value(index)]
            remote_rooms = [
                item for item in room_values
                if item.lower().startswith(("http", "www.", "max.ru"))
                or "join" in item.lower()
            ]
            room_text = ", ".join(
                item for item in room_values if item not in remote_rooms
            )
            comments = ["дистанционно"] if remote_rooms else []

            date_from_day_cell = value(columns["day"])
            if not date_text and expand_date_text(date_from_day_cell, semester_year):
                date_text = date_from_day_cell

            rooms, rooms_ambiguous = _pair_rooms(split_lines(room_text), len(blocks))

            block_dates: list[list[str]] = []
            for block in blocks:
                dates = expand_date_text(date_text, semester_year) if date_text else []
                if not dates:
                    dates = expand_date_text(block["raw"], semester_year)
                block_dates.append(dates)

            overlapping = _has_overlapping_dates(block_dates)

            for index, block in enumerate(blocks):
                branch = build_branch(
                    faculty=faculty,
                    group=group,
                    day=day,
                    time_start=time_start,
                    time_end=time_end,
                    discipline=block["discipline"],
                    type_=block["type"],
                    subgroup=block["subgroup"],
                    teachers=block["teachers"],
                    dates=block_dates[index],
                    rooms=rooms[index] if index < len(rooms) else "",
                    period=period,
                    comments=comments,
                    source_text=block["raw"],
                    source_ref={
                        "sheet": sheet.name,
                        "row": row_index + 1,
                    },
                )
                if branch is None:
                    continue

                if group_confidence < 1.0:
                    branch.confidence = round(max(branch.confidence - 0.1, 0.0), 2)
                    branch.issues.append(
                        "multi_block_shared_group" if multi_block else "group_from_header"
                    )
                if rooms_ambiguous:
                    branch.confidence = round(max(branch.confidence - 0.15, 0.0), 2)
                    branch.issues.append("ambiguous_rooms")
                if len(blocks) > 1 and not block["subgroup"] and overlapping:
                    branch.confidence = round(max(branch.confidence - 0.15, 0.0), 2)
                    branch.issues.append("parallel_without_subgroup")
                result.append(branch)

        return result

    # ---------------------------------------------------------- post
    def _drop_stale(
        self,
        branches: list[RawBranch],
        period: AcademicPeriod,
    ) -> list[RawBranch]:
        """Отсекает занятия из прошлых учебных годов.

        Маркер — сами даты: если все даты занятия лежат вне текущего
        учебного года, занятие относится к устаревшей версии файла.
        """
        bounds = period.academic_bounds()
        if bounds is None:
            return branches
        low, high = bounds

        result: list[RawBranch] = []
        for branch in branches:
            if "weekly_dates" in branch.issues or not branch.dates:
                result.append(branch)
                continue
            inside = [
                value for value in branch.dates
                if low <= self._to_date(value) <= high
            ]
            if inside:
                branch.dates = inside
                result.append(branch)
        return result

    @staticmethod
    def _to_date(value: str):
        from datetime import date, datetime

        try:
            return datetime.strptime(value, "%d.%m.%Y").date()
        except (ValueError, TypeError):
            return date.min

    def _fill_weekly_gaps(
        self,
        branches: list[RawBranch],
        period: AcademicPeriod,
    ) -> list[RawBranch]:
        """Недельные занятия не должны пересекаться с уже занятыми датами.

        Занятие без дат повторяется каждую неделю, но только в те дни,
        где у группы ещё нет другой пары на этом же времени.
        """
        occupied: dict[tuple[str, str, str], set[str]] = {}
        for branch in branches:
            if "weekly_dates" in branch.issues:
                continue
            key = (branch.group, branch.weekday, branch.time_start)
            occupied.setdefault(key, set()).update(branch.dates)

        for branch in branches:
            if "weekly_dates" not in branch.issues:
                continue
            key = (branch.group, branch.weekday, branch.time_start)
            busy = occupied.setdefault(key, set())
            free = [value for value in branch.dates if value not in busy]
            branch.dates = free
            busy.update(free)

        return [branch for branch in branches if branch.dates]


def _has_overlapping_dates(blocks_dates: list[list[str]]) -> bool:
    """Пересекаются ли даты занятий внутри одной ячейки.

    Если нет — это последовательность разных дисциплин, а не
    параллельные подгруппы, и пугаться нечего.
    """
    seen: set[str] = set()
    for dates in blocks_dates:
        if not dates:
            return True  # без дат — неопределённость
        current = set(dates)
        if current & seen:
            return True
        seen |= current
    return False
