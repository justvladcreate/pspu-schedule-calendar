"""Адаптер таблиц, где подгруппы разложены по колонкам.

Так устроен 07 (иняз): слева день/№/время, дальше для каждой подгруппы
своя тройка колонок — дисциплина, её дубль (объединённая ячейка) и
«ауд.». В шапке подписано «Группа 711/1», «Группа 711/2» и т.д.
"""
from __future__ import annotations

import re

from parser.adapters.base import (
    build_branch,
    cell_text,
    normalize_day,
    parse_cell_blocks,
    parse_pair,
    parse_time,
)
from parser.dates import expand_date_text
from parser.model import AcademicPeriod, Faculty, RawBranch
from parser.sources.base import SheetData
from parser.adapters.vertical import VerticalAdapter as _VerticalAdapter

_GROUP_RE = re.compile(r"групп[аы]?\s*([A-Za-zА-Яа-яЁё0-9/]+)", re.I)
_SKIP_SHEETS = ("qr", "приложение", "повтор", "график", "лист1")


def _blocks(df, header_row: int) -> list[dict]:
    header = [cell_text(value) for value in df.iloc[header_row]]
    blocks: list[dict] = []
    current: dict | None = None

    for index, value in enumerate(header):
        lowered = value.lower()
        found = _GROUP_RE.search(value)
        if found:
            code = found.group(1)
            if current is not None and current["code"] == code:
                # объединённая шапка: вторая колонка той же подгруппы
                current["subject"].append(index)
                continue
            current = {
                "code": code,
                "subgroup": code.split("/")[-1] if "/" in code else "",
                "subject": [index],
                "room": None,
            }
            blocks.append(current)
            continue

        if current is None:
            continue

        if lowered.startswith("ауд"):
            current["room"] = index
        elif "дисциплин" in lowered or "предмет" in lowered:
            current["subject"].append(index)
        elif value and not lowered.startswith(("день", "№", "время", "начало")):
            current["subject"].append(index)

    return blocks


class SubgroupColumnsAdapter:
    def parse(
        self,
        sheets: list[SheetData],
        faculty: Faculty,
        period: AcademicPeriod,
    ) -> list[RawBranch]:
        subgroup_sheets: list[SheetData] = []
        plain_sheets: list[SheetData] = []

        for sheet in sheets:
            header_row = self._header_row(sheet)
            if header_row is not None and _blocks(sheet.df, header_row):
                subgroup_sheets.append(sheet)
            else:
                plain_sheets.append(sheet)

        result: list[RawBranch] = []
        for sheet in subgroup_sheets:
            result.extend(self._parse_sheet(sheet, faculty, period))
        if plain_sheets:
            # Остальные листы — обычная вертикальная раскладка.
            result.extend(_VerticalAdapter().parse(plain_sheets, faculty, period))
        return result

    @staticmethod
    def _header_row(sheet: SheetData) -> int | None:
        df = sheet.df
        for row in range(min(30, len(df))):
            values = [cell_text(v).lower() for v in df.iloc[row]]
            joined = " ".join(values)
            if "день" in joined and ("время" in joined or "начало" in joined):
                return row
        return None

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

        header_row = self._header_row(sheet)
        if header_row is None:
            return []

        blocks = _blocks(df, header_row)
        if not blocks:
            return []

        # Группа — общая часть кодов подгрупп («711» из «711/1»).
        base_group = ""
        for block in blocks:
            code = block["code"]
            if "/" in code:
                base_group = code.split("/")[0]
                break
        if not base_group:
            name = sheet.name.strip()
            match = re.match(r"[A-Za-zА-Яа-яЁё]?\d{3,4}", name)
            base_group = match.group(0) if match else name

        header = [cell_text(v).lower() for v in df.iloc[header_row]]
        day_col = next((i for i, v in enumerate(header) if v.startswith("день")), None)
        pair_col = next((i for i, v in enumerate(header) if v.strip() == "№"), None)
        time_col = next(
            (i for i, v in enumerate(header) if "время" in v or "начало" in v),
            None,
        )
        if time_col is None:
            return []

        semester_year = period.semester_start.year if period.semester_start else None
        result: list[RawBranch] = []
        current_day = ""

        for row_index in range(header_row + 1, len(df)):
            row = df.iloc[row_index]

            def value(index: int | None) -> str:
                if index is None or index >= len(row):
                    return ""
                return cell_text(row.iloc[index])

            day = normalize_day(value(day_col))
            if day:
                current_day = day
            day = day or current_day

            time_start, time_end = parse_time(value(time_col))
            if not time_start:
                continue

            for block in blocks:
                subjects = [
                    value(index) for index in block["subject"] if value(index)
                ]
                subjects = _dedupe(subjects)
                if not subjects:
                    continue

                for text in subjects:
                    for piece in parse_cell_blocks(text):
                        dates = expand_date_text(piece["raw"], semester_year)
                        branch = build_branch(
                            faculty=faculty,
                            group=base_group,
                            day=day,
                            time_start=time_start,
                            time_end=time_end,
                            discipline=piece["discipline"],
                            type_=piece["type"],
                            subgroup=piece["subgroup"] or (
                                f"п/г {block['subgroup']}" if block["subgroup"] else ""
                            ),
                            teachers=piece["teachers"],
                            dates=dates,
                            rooms=value(block["room"]),
                            period=period,
                            source_text=piece["raw"],
                            source_ref={
                                "sheet": sheet.name,
                                "row": row_index + 1,
                                "pair": parse_pair(value(pair_col)),
                            },
                        )
                        if branch is not None:
                            result.append(branch)

        return result


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: list[str] = []
    for value in values:
        key = re.sub(r"\s+", " ", value).strip().lower()
        if seen and seen[-1] == key:
            continue
        seen.append(key)
        result.append(value)
    return result
