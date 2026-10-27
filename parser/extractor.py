# parser/extractor.py
from __future__ import annotations

import logging
import time
from pathlib import Path

import pandas as pd

from parser.preprocess import (
    add_year, clean, normalize_rooms, normalize_time,
    english_to_russian_lookalike, normalize_date_ranges,
    remove_invalid_dates, extract_first_date,
    remove_spaces_between_initials, normalize_subgroup,
)
from parser.rooms_hints import parse_rooms_with_hints
from parser.sources.base import ScheduleSource
import re

logger = logging.getLogger(__name__)

pd.set_option("display.max_rows", None)
pd.set_option("display.max_columns", None)
pd.set_option("display.width", None)


def delete_old_file(latest_path: Path, old_path: Path, max_time: float = 0) -> None:
    if not latest_path.exists():
        return
    if time.time() - latest_path.stat().st_mtime > max_time:
        if old_path.exists():
            old_path.unlink()
        latest_path.rename(old_path)


# ---------------------------------------------------------------- core
class DataExtractor:
    """
    Обходит SheetData-и от источника и превращает их в groups_info.

    Не знает, откуда именно пришли данные — Google Sheets, xlsx с диска
    или что-то ещё. Источник передаётся через конструктор.
    """

    def __init__(self, source: ScheduleSource):
        self.source = source

    async def extract(self) -> dict:
        sheets = await self.source.load()

        # Первый ВИДИМЫЙ лист — сводный ("ГРУППЫ"), не парсим.
        visible = [s for s in sheets if not s.hidden]

        groups_info: dict = {}

        for idx, sheet in enumerate(visible):
            if idx == 0:
                continue

            group_info = extraction(sheet.df, sheet.sheet_id, sheet.links, sheet.colors)
            if not group_info:
                continue

            # Не затираем уже собранные группы сводными листами.
            for grp, data in group_info.items():
                if grp in groups_info and groups_info[grp].get("events"):
                    continue
                groups_info[grp] = data

        return groups_info


# ---------------------------------------------------------------- helpers
def clean_group_name(group_name: str) -> str:
    bracket_index = group_name.find(" (")
    comma_index = group_name.find(", ") + 2
    if bracket_index != -1:
        return group_name[comma_index:bracket_index].strip()
    return group_name.strip()


# Даты в заголовке: «01.09.2026», «23.01.2027».
_HEADER_DATE_RE = re.compile(r'\b(\d{1,2})\.(\d{2})\.(\d{4})\b')
# Учебный год в заголовке: «2025/2026».
_HEADER_ACADEMIC_YEAR_RE = re.compile(r'\b(\d{4})\s*/\s*(\d{4})\b')
# Содержимое круглых скобок.
_HEADER_PARENS_RE = re.compile(r'\(([^)]*)\)')


def semester_start_year_from_header(semester: str | None) -> int | None:
    """
    Определяет год начала учебного года (сентябрь) по строке семестра.

    Приоритет — даты в круглых скобках:
        «10 семестр 2025/2026 учебного года (01.09.2026 – 23.01.2027)»
    В этом примере 2025/2026 — устаревшая/неверная шапка, а реальные
    даты семестра начинаются в 2026 году, поэтому результатом будет 2026.

    Для весеннего семестра, например «(09.02.2026 – 30.06.2026)»,
    результатом будет 2025 — год начала учебного года, к которому
    относится весна 2026.

    Если дат в скобках нет, используются даты из всей строки, затем —
    старый вариант «2025/2026».
    """
    text = str(semester or "")

    def start_year_from_dates(value: str) -> int | None:
        dates = _HEADER_DATE_RE.findall(value)
        if not dates:
            return None

        # Берём самую раннюю дату диапазона — это начало семестра.
        year, month, _day = min(
            (int(y), int(m), int(d)) for d, m, y in dates
        )
        return year if month >= 9 else year - 1

    # 1. Даты внутри круглых скобок.
    for group in _HEADER_PARENS_RE.findall(text):
        year = start_year_from_dates(group)
        if year is not None:
            return year

    # 2. Даты где-то ещё в строке семестра.
    year = start_year_from_dates(text)
    if year is not None:
        return year

    # 3. Старый fallback — учебный год «2025/2026».
    m = _HEADER_ACADEMIC_YEAR_RE.search(text)
    if m:
        return int(m.group(1))

    return None


# ---------------------------------------------------------------- extraction
def _ffill_weekday_column(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.iloc[:, 0] = df.iloc[:, 0].ffill()
    return df


def extraction(df, sheet_id, hyperlinks: dict | None = None, colors: dict | None = None):
    if hyperlinks is None:
        hyperlinks = {}
    if colors is None:
        colors = {}

    df = _ffill_weekday_column(df)

    start_cells = []
    for i, row in df.iterrows():
        for j, cell in enumerate(row):
            if "Начало" in str(cell).strip():
                start_cells.append((i, j))

    end_row = None
    for i, row in df.iterrows():
        if any("Декан" in str(cell).strip() for cell in row):
            end_row = i
            break

    end_cells = []
    for i, row in df.iterrows():
        for j, cell in enumerate(row):
            if "форма обучения /" in str(cell).strip().lower():
                end_cells.append((end_row, j))

    headers = []
    for i, row in df.iterrows():
        row_set = set()
        for j, cell in enumerate(row):
            if "семестр" in str(cell).strip().lower() and cell not in row_set:
                headers.append((i, j))
                row_set.add(cell)

    group_info = {}
    min_count = min(len(start_cells), len(end_cells), len(headers))
    if min_count == 0:
        return group_info

    for i in range(min_count):

        start_cell = start_cells[i]
        end_cell = end_cells[i]
        header_cell = headers[i]

        try:
            # Разбираем заголовок
            header = df.iloc[header_cell[0], header_cell[1]]

            group_name = ""
            semester = None
            additional_info = ""
            session = ""
            vacation = ""
            session_end_date = None

            semester_start_year = None
            if "семестр" in str(header).lower():
                lines = [line.strip() for line in str(header).split("\n") if line.strip()]

                if len(lines) >= 2:
                    group_name = lines[0]
                    group_name = clean_group_name(group_name)
                    semester = lines[1]

                    semester_start_year = semester_start_year_from_header(semester)

                    try:
                        session_index = next(i for i, line in enumerate(lines) if "Экзаменационная сессия" in line)
                        vacation_index = next(i for i, line in enumerate(lines) if "Каникулы" in line)

                        additional_info = "\n".join(lines[2:session_index])
                        session = lines[session_index]
                        session_end_date = extract_first_date(session)
                        vacation = lines[vacation_index]
                    except StopIteration:
                        print("Не найдены сессия или каникулы в заголовке")
                else:
                    print(f"Недостаточно строк в заголовке: {len(lines)}")
        except Exception as e:
            print(f"Ошибка при обработке заголовка: {e}")
            continue

        if not group_name:
            print("Не удалось определить номер группы, пропускаем")
            continue

        try:
            subset = df.iloc[start_cell[0]:end_cell[0] + 1, start_cell[1]:end_cell[1] + 1]
        except Exception as e:
            print(f"Ошибка при создании subset: {e}")
            continue

        events = []

        for row in range(1, subset.shape[0]):
            abs_row = start_cell[0] + row

            try:
                time_val_exception = df.iloc[abs_row, start_cells[0][1]]
                room_val_exception = df.iloc[abs_row, end_cells[-1][1]]

                time_val = subset.iloc[row, 0]
                room_val = subset.iloc[row, -1]
                subject_val = subset.iloc[row, 1:-1]

                if pd.isna(time_val) or str(time_val).strip() == "":
                    continue
                if pd.isna(room_val) or str(room_val).strip() == "" or room_val is None:
                    room_val = ""

                seen_parts: set = set()
                ordered_parts: list[str] = []
                for x in subject_val:
                    if pd.isna(x):
                        continue
                    s = str(x).strip()
                    if s and s not in seen_parts:
                        seen_parts.add(s)
                        ordered_parts.append(s)
                subject_val = " ".join(ordered_parts)

                if not subject_val:
                    continue

                time_str = str(time_val) if time_val is not None else ""
                room_str = str(room_val) if room_val is not None else ""
                time_in_subject = bool(time_str) and (time_str in subject_val)
                room_in_subject = bool(room_str) and (room_str in subject_val)

                if time_in_subject or room_in_subject:
                    if time_in_subject:
                        time_val = time_val_exception
                    if room_in_subject:
                        room_val = room_val_exception

                # собираем все URL-ы в этой строке — может быть несколько
                # merged-ячеек с разными ссылками (дистанционные технологии)
                row_urls: list[str] = []
                for c in range(start_cell[1], end_cell[1] + 3):
                    for u in (hyperlinks.get((abs_row, c)) or []):
                        if u not in row_urls:
                            row_urls.append(u)

                room_raw = str(room_val)
                # logger.info(
                #     f"[EXTRACT] group={group_name} row={abs_row} "
                #     f"row_urls={row_urls} raw_repr={room_raw!r}"
                # )
                rooms_hints = parse_rooms_with_hints(room_raw, urls=row_urls)

                if rooms_hints:
                    room_val = [r["room"] for r in rooms_hints]
                else:
                    room_val = normalize_rooms(
                        room_raw, url=row_urls[0] if row_urls else None
                    )

                subject_val = clean(text=subject_val)
                subject_val = english_to_russian_lookalike(text=subject_val)
                subject_val = normalize_date_ranges(text=subject_val, default_end_date=session_end_date)
                subject_val = remove_invalid_dates(text=subject_val)
                subject_val = add_year(text=subject_val, semester_start_year=semester_start_year)

                subject_val = remove_spaces_between_initials(text=subject_val)
                subject_val = normalize_subgroup(text=subject_val)

                day_of_week = ""
                left_col_val = df.iloc[abs_row, 0]
                if pd.notna(left_col_val) and str(left_col_val).strip():
                    day_of_week = str(left_col_val).strip().upper()

                    time_vals = time_val.split("\n")

                    merged_times = []
                    i = 0
                    while i < len(time_vals):
                        cur = time_vals[i].strip()
                        if cur.endswith(("-", "–", "—")) and i + 1 < len(time_vals):
                            nxt = time_vals[i + 1].strip()
                            merged_times.append(cur + nxt)
                            i += 2
                        else:
                            merged_times.append(cur)
                            i += 1

                    all_colors = []
                    for c in range(start_cell[1], end_cell[1] + 1):
                        all_colors.extend(colors.get((abs_row, c), []))

                    for time_value in merged_times:
                        time_val = normalize_time(time_value)
                        # НОВЫЙ ФОРМАТ: dict вместо строки-обёртки
                        events.append({
                            "day_of_week": day_of_week,
                            "time_start": time_val,
                            "rooms": ", ".join(room_val),
                            "rooms_hints": rooms_hints,
                            "subject": subject_val,
                            "text_colors": all_colors,                        })

            except Exception as e:
                print(f"Ошибка при обработке строки {row} {group_name}: {e}")

        if events:
            group_info[group_name] = {
                "events": events,
                "semester_start_year": semester_start_year,
            }

    return group_info