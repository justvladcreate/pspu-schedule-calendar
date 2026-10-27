"""Адаптер таблиц с блоками по 5 колонок на группу (психология)."""
from __future__ import annotations

import re
from datetime import datetime

from parser.adapters.base import (
    build_branch,
    cell_text,
    extract_teachers,
    normalize_day,
    parse_cell_blocks,
    parse_time,
)
from parser.dates import expand_date_text
from parser.model import AcademicPeriod, Faculty, RawBranch
from parser.sources.base import SheetData


def _block_starts(df) -> list[tuple[int, str]]:
    if len(df) == 0:
        return []
    row = df.iloc[0]
    result = []
    for col in range(len(row) - 1):
        group_text = cell_text(row.iloc[col])
        next_text = cell_text(row.iloc[col + 1]).lower()
        if not group_text or "дата" not in group_text.lower() or next_text != "время":
            continue
        match = re.search(r"[A-Za-zА-Яа-яЁё]?\d{3,4}[A-Za-zА-Яа-яЁё0-9/]*", group_text)
        if match:
            result.append((col, match.group(0)))
    return result


def _date_and_day(text: str) -> tuple[str, str]:
    parts = [part.strip() for part in text.split("|", 1)]
    date_text = parts[0] if parts else ""
    match = re.search(r"\b(\d{1,2})\.(\d{2})\.(\d{4})\b", date_text)
    if not match:
        return "", ""
    day, month, year = map(int, match.groups())
    try:
        weekday = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"][datetime(year, month, day).weekday()]
    except ValueError:
        weekday = ""
    return f"{day:02d}.{month:02d}.{year}", weekday or normalize_day(parts[1] if len(parts) > 1 else "")


class PairedColumnsAdapter:
    def parse(
        self,
        sheets: list[SheetData],
        faculty: Faculty,
        period: AcademicPeriod,
    ) -> list[RawBranch]:
        result: list[RawBranch] = []
        seen: set[tuple] = set()
        for sheet in sheets:
            if sheet.hidden:
                continue
            df = sheet.df
            if df.empty:
                continue
            # Сводные листы («Расписание очники») содержат блоки всех
            # групп сразу — их разбирают отдельные листы.
            if len(df.columns) > 12:
                continue

            starts = _block_starts(df)
            if not starts:
                continue

            for start, group in starts:
                current_date = ""
                current_day = ""
                for row_idx in range(1, len(df)):
                    row = df.iloc[row_idx]
                    if start + 4 >= len(row):
                        continue

                    date_cell = cell_text(row.iloc[start])
                    if date_cell:
                        date_value, day_value = _date_and_day(date_cell)
                        if date_value:
                            current_date = date_value
                            current_day = day_value or current_day

                    time_start, time_end = parse_time(row.iloc[start + 1])
                    if not time_start:
                        continue

                    subject = cell_text(row.iloc[start + 2])
                    if not subject:
                        continue

                    blocks = parse_cell_blocks(subject)
                    if not blocks:
                        continue
                    block = blocks[0]

                    branch = build_branch(
                        faculty=faculty,
                        group=group,
                        day=current_day,
                        time_start=time_start,
                        time_end=time_end,
                        discipline=block["discipline"],
                        type_=block["type"],
                        subgroup=block["subgroup"],
                        teachers=block["teachers"] or extract_teachers(
                            cell_text(row.iloc[start + 3])
                        )[0],
                        dates=expand_date_text(current_date, period.semester_start.year if period.semester_start else None),
                        rooms=cell_text(row.iloc[start + 4]),
                        period=period,
                        source_text=subject,
                        source_ref={
                            "sheet": sheet.name,
                            "row": row_idx + 1,
                            "col": start + 1,
                        },
                    )
                    if branch is not None:
                        key = (
                            branch.group, branch.weekday, branch.time_start,
                            branch.discipline, branch.subgroup, branch.rooms,
                        )
                        if key not in seen:
                            seen.add(key)
                            result.append(branch)

        return result
