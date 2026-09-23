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

            group_info = extraction(sheet.df, sheet.sheet_id, sheet.links)
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


# ---------------------------------------------------------------- extraction
def extraction(df, sheet_id, hyperlinks: dict | None = None):
    if hyperlinks is None:
        hyperlinks = {}
    # print(df)
    # Указываем стартовые клетки
    start_cells = []
    for i, row in df.iterrows():
        # row = set(row)
        for j, cell in enumerate(row):
            if "Начало" in str(cell).strip():
                start_cells.append((i, j))
    # Указываем конечную высоту поиска
    end_row = None
    for i, row in df.iterrows():
        row = set(row)
        for j, cell in enumerate(row):
            if "Декан" in str(cell).strip():
                end_row = i
                break
        if end_row:
            break
    # Указываем конечные клетки
    end_cells = []
    for i, row in df.iterrows():
        # row = set(row)
        for j, cell in enumerate(row):
            if "форма обучения /" in str(cell).strip().lower():
                end_cells.append((end_row, j))
    # Ищем заголовки
    headers = []
    for i, row in df.iterrows():
        row_set = set()
        for j, cell in enumerate(row):
            if "семестр" in str(cell).strip().lower() and not (cell in row_set):
                headers.append((i, j))
                row_set.add(cell)

    group_info = {}

    min_count = min(len(start_cells), len(end_cells), len(headers))

    if min_count == 0:
        return group_info

    # Проходим по всем блокам по каждой клетке внутри блока
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

            if "семестр" in str(header).lower():
                lines = [line.strip() for line in str(header).split("\n") if line.strip()]

                if len(lines) >= 2:
                    group_name = lines[0]
                    group_name = clean_group_name(group_name)
                    semester = lines[1]

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

        # Разбираем строчки на пары
        for row in range(1, subset.shape[0] - 1):
            if row >= subset.shape[0]:
                break

            abs_row = start_cell[0] + row

            try:
                # extra
                time_val_exception = df.iloc[abs_row, start_cells[0][1]]
                room_val_exception = df.iloc[abs_row, end_cells[-1][1]]

                time_val = subset.iloc[row, 0]
                room_val = subset.iloc[row, -1]
                subject_val = subset.iloc[row, 1:-1]

                if pd.isna(time_val) or str(time_val).strip() == "":
                    continue
                if pd.isna(room_val) or str(room_val).strip() == "" or room_val is None:
                    room_val = ""

                subject_val = set(subject_val)
                subject_val = " ".join([str(x).strip() for x in subject_val if pd.notna(x)]).strip()
                if not subject_val:
                    continue

                if (time_val in subject_val) or (room_val in subject_val) and (room_val != "" and subject_val != ""):
                    if time_val in subject_val:
                        time_val = time_val_exception
                    if room_val in subject_val:
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
                subject_val = add_year(text=subject_val)

                subject_val = remove_spaces_between_initials(text=subject_val)
                subject_val = normalize_subgroup(text=subject_val)

                # Добавляем день недели
                day_of_week = ""
                df.iloc[:, 0] = df.iloc[:, 0].ffill()
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

                    for time_value in merged_times:
                        time_val = normalize_time(time_value)
                        # НОВЫЙ ФОРМАТ: dict вместо строки-обёртки
                        events.append({
                            "day_of_week": day_of_week,
                            "time_start": time_val,
                            "rooms": ", ".join(room_val),
                            "rooms_hints": rooms_hints,
                            "subject": subject_val,
                        })

            except Exception as e:
                print(f"Ошибка при обработке строки {row} {group_name}: {e}")

        if events:
            group_info[group_name] = {
                "events": events,
            }

    return group_info