from __future__ import annotations

import asyncio
import logging
from typing import Any

import pandas as pd

from parser.sources.base import ScheduleSource, SheetData

logger = logging.getLogger(__name__)


_FIELDS = (
    "sheets("
    "properties(title,sheetId,hidden,gridProperties),"
    "merges,"
    "data(rowData(values("
    "formattedValue,"
    "hyperlink,"
    "effectiveFormat.textFormat.foregroundColorStyle,"
    "effectiveFormat.textFormat.foregroundColor,"
    "textFormatRuns(startIndex,format(link(uri),foregroundColorStyle,foregroundColor))"
    ")))"
    ")"
)


def _col_letter(n: int) -> str:
    """0-based индекс → буквы Excel: 0→A, 25→Z, 26→AA."""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell_value(cell: dict) -> Any:
    if not cell:
        return None
    v = cell.get("formattedValue")
    if v is None or v == "":
        return None
    return v


def _cell_links(cell: dict) -> list[str]:
    """Все ссылки ячейки в порядке появления."""
    urls: list[str] = []

    hl = cell.get("hyperlink")
    if hl and hl.lower().startswith(("http://", "https://")):
        urls.append(hl)

    for run in cell.get("textFormatRuns") or []:
        uri = (((run.get("format") or {}).get("link") or {}).get("uri"))
        if uri and uri.lower().startswith(("http://", "https://")):
            if uri not in urls:
                urls.append(uri)

    return urls


def _rgb_to_hex(color_obj: dict | None) -> str | None:
    if not color_obj: return None

    # Поддержка нового формата foregroundColorStyle
    if 'rgbColor' in color_obj:
        color_obj = color_obj['rgbColor']

    # Если после распаковки объект пустой или в нем нет ключа 'red'
    if not color_obj or 'red' not in color_obj:
        return None

    r = int(color_obj.get('red', 0) * 255)
    g = int(color_obj.get('green', 0) * 255)
    b = int(color_obj.get('blue', 0) * 255)

    # Игнорируем только абсолютно черный цвет
    if r == 0 and g == 0 and b == 0:
        return None

    return f"#{r:02x}{g:02x}{b:02x}"


def _extract_colored_texts(cell: dict) -> list[dict]:
    if not cell: return []
    val = cell.get("formattedValue") or ""
    if not val: return []

    text_format = (cell.get("effectiveFormat") or {}).get("textFormat") or {}

    # Базовый цвет ячейки. Отдельные куски текста (textFormatRuns) могут
    # его переопределять — тогда effectiveFormat врёт про весь текст.
    style = text_format.get("foregroundColorStyle") or {}
    base_fg = style.get("rgbColor") or text_format.get("foregroundColor")
    base_color = _rgb_to_hex(base_fg)

    runs = cell.get("textFormatRuns") or []
    if not runs:
        return [{"text": val, "color": base_color}] if base_color else []

    chunks: list[dict] = []

    def add_chunk(text: str, color: str | None) -> None:
        if not text or not color:
            return
        if chunks and chunks[-1]["color"] == color:
            chunks[-1]["text"] += text
        else:
            chunks.append({"text": text, "color": color})

    # Текст до первого run наследует цвет ячейки.
    first_start = runs[0].get("startIndex", 0)
    if first_start > 0:
        add_chunk(val[:first_start], base_color)

    for i, run in enumerate(runs):
        start = run.get("startIndex", 0)
        end = runs[i + 1].get("startIndex", len(val)) if i + 1 < len(runs) else len(val)
        chunk = val[start:end]
        if not chunk:
            continue

        fmt = run.get("format") or {}
        run_style = fmt.get("foregroundColorStyle") or {}
        run_fg = run_style.get("rgbColor") or fmt.get("foregroundColor")

        # Нет явного цвета у run — наследуем цвет ячейки. Если цвет
        # задан явно (в том числе чёрный) — используем именно его.
        color = _rgb_to_hex(run_fg) if run_fg else base_color
        add_chunk(chunk, color)

    return chunks


def _build_df(row_data: list[dict], n_cols: int, n_rows: int) -> pd.DataFrame:
    rows: list[list[Any]] = []
    for row in row_data or []:
        cells = [_cell_value(v) for v in (row.get("values") or [])]
        if len(cells) < n_cols:
            cells.extend([None] * (n_cols - len(cells)))
        else:
            cells = cells[:n_cols]
        rows.append(cells)

    while len(rows) < n_rows:
        rows.append([None] * n_cols)

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows, dtype=object)

    last = -1
    for i in range(len(df) - 1, -1, -1):
        if df.iloc[i].notna().any():
            last = i
            break
    if last < 0:
        return pd.DataFrame()
    return df.iloc[:last + 1].reset_index(drop=True)


def _apply_merges(df: pd.DataFrame, merges: list[dict]) -> pd.DataFrame:
    if df.empty or not merges:
        return df

    n_rows, n_cols = df.shape

    for m in merges:
        r0 = m.get("startRowIndex", 0)
        r1 = m.get("endRowIndex", 0)
        c0 = m.get("startColumnIndex", 0)
        c1 = m.get("endColumnIndex", 0)

        if r0 >= n_rows or c0 >= n_cols:
            continue

        top_left = df.iat[min(r0, n_rows - 1), min(c0, n_cols - 1)]

        for r in range(r0, min(r1, n_rows)):
            for c in range(c0, min(c1, n_cols)):
                df.iat[r, c] = top_left

    return df

def _propagate_links_by_merges(
        links: dict[tuple[int, int], list[str]],
        merges: list[dict],
) -> None:
    for m in merges or []:
        r0 = m.get("startRowIndex", 0)
        r1 = m.get("endRowIndex", 0)
        c0 = m.get("startColumnIndex", 0)
        c1 = m.get("endColumnIndex", 0)

        src = (r0, c0)
        if src not in links:
            continue

        for r in range(r0, r1):
            for c in range(c0, c1):
                if (r, c) == src:
                    continue
                links.setdefault((r, c), [])
                for u in links[src]:
                    if u not in links[(r, c)]:
                        links[(r, c)].append(u)


class GoogleSheetsSource(ScheduleSource):
    def __init__(self, spreadsheet_id: str, sheets_service):
        self.spreadsheet_id = spreadsheet_id
        self.service = sheets_service

    async def load(self) -> list[SheetData]:
        resp = await asyncio.to_thread(self._fetch)
        result: list[SheetData] = []

        for sheet in resp.get("sheets", []):
            props = sheet.get("properties") or {}
            name = props.get("title")
            if not name:
                continue

            grid = props.get("gridProperties") or {}
            n_rows = int(grid.get("rowCount", 0)) or 200
            n_cols = int(grid.get("columnCount", 0)) or 26

            datas = sheet.get("data") or []
            row_data = (datas[0].get("rowData") if datas else None) or []

            df = _build_df(row_data, n_cols=n_cols, n_rows=n_rows)
            df = _apply_merges(df, sheet.get("merges") or [])

            links: dict[tuple[int, int], list[str]] = {}
            colors: dict[tuple[int, int], list[str]] = {}

            for r_idx, row in enumerate(row_data):
                for c_idx, cell in enumerate(row.get("values") or []):
                    urls = _cell_links(cell)
                    if urls:
                        links[(r_idx, c_idx)] = urls

                    colored_texts = _extract_colored_texts(cell)
                    if colored_texts:
                        colors[(r_idx, c_idx)] = colored_texts

            _propagate_links_by_merges(links, sheet.get("merges") or [])

            result.append(SheetData(
                name=name,
                df=df,
                links=links,
                colors=colors,
                hidden=bool(props.get("hidden", False)),
                sheet_id=props.get("sheetId"),
            ))

        return result

    def _fetch(self) -> dict:
        return self.service.spreadsheets().get(
            spreadsheetId=self.spreadsheet_id,
            includeGridData=True,
            fields=_FIELDS,
        ).execute()