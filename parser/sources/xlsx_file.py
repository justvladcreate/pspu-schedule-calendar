from __future__ import annotations

import logging
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pandas as pd
from openpyxl import load_workbook

from parser.sources.base import ScheduleSource, SheetData

logger = logging.getLogger(__name__)

_XLSX_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel":  "http://schemas.openxmlformats.org/package/2006/relationships",
}
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


# ---------------------------------------------------------------- helpers
def _col_idx(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def _parse_ref(ref: str):
    m = re.match(r"^([A-Z]+)(\d+)$", ref)
    if not m:
        return None
    return int(m.group(2)) - 1, _col_idx(m.group(1))


def _parse_range(ref: str):
    m = re.match(r"^([A-Z]+)(\d+):([A-Z]+)(\d+)$", ref)
    if not m:
        return None
    return (
        int(m.group(2)) - 1, _col_idx(m.group(1)),
        int(m.group(4)) - 1, _col_idx(m.group(3)),
    )


def _find_sheet_path(zf: zipfile.ZipFile, sheet_name):
    wb   = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))

    rid_to_target = {
        r.get("Id"): r.get("Target")
        for r in rels.findall("rel:Relationship", _XLSX_NS)
    }

    sheets = wb.findall(".//main:sheet", _XLSX_NS)

    if isinstance(sheet_name, int):
        sh = sheets[sheet_name] if 0 <= sheet_name < len(sheets) else None
    else:
        sh = next((s for s in sheets if s.get("name") == sheet_name), None)

    if sh is None:
        return None

    rid = sh.get(f"{{{_R_NS}}}id")
    target = rid_to_target.get(rid)
    if not target:
        return None

    target = target.lstrip("/")
    if not target.startswith("xl/"):
        target = f"xl/{target}"
    return target


def fill_merged_cells_safe(file_path, sheet_name) -> pd.DataFrame:
    """Читает xlsx и заполняет только ячейки из merged-диапазонов."""
    df = pd.read_excel(file_path, sheet_name=sheet_name, header=None)
    df = df.astype(object)

    wb = load_workbook(file_path, data_only=True)
    ws = wb.worksheets[sheet_name] if isinstance(sheet_name, int) else wb[sheet_name]

    for merged_range in ws.merged_cells.ranges:
        top_left_value = ws.cell(merged_range.min_row, merged_range.min_col).value
        start_row = merged_range.min_row - 1
        end_row   = merged_range.max_row - 1
        start_col = merged_range.min_col - 1
        end_col   = merged_range.max_col - 1

        if start_row < 0 or end_row >= len(df) or start_col < 0 or end_col >= len(df.columns):
            continue

        for i in range(start_row, end_row + 1):
            for j in range(start_col, end_col + 1):
                df.iat[i, j] = top_left_value

    wb.close()
    return df


def load_hyperlinks(file_path, sheet_name) -> dict[tuple[int, int], list[str]]:
    """{(row, col): [url, ...]} — 0-based, как в pandas."""
    links: dict[tuple[int, int], list[str]] = {}

    with zipfile.ZipFile(file_path) as zf:
        sheet_path = _find_sheet_path(zf, sheet_name)
        if sheet_path is None:
            return links

        d, f = sheet_path.rsplit("/", 1)
        rels_path = f"{d}/_rels/{f}.rels"

        rid_to_url: dict[str, str] = {}
        try:
            rels = ET.fromstring(zf.read(rels_path))
            for rel in rels.findall("rel:Relationship", _XLSX_NS):
                rid = rel.get("Id")
                url = rel.get("Target")
                typ = rel.get("Type") or ""
                if rid and url and typ.endswith("/hyperlink"):
                    rid_to_url[rid] = url
        except KeyError:
            pass

        sheet = ET.fromstring(zf.read(sheet_path))

        for h in sheet.findall(".//main:hyperlink", _XLSX_NS):
            ref = h.get("ref")
            if not ref:
                continue
            rid = h.get(f"{{{_R_NS}}}id")
            url = rid_to_url.get(rid) if rid else None
            if not url or not url.lower().startswith(("http://", "https://")):
                continue

            pos = _parse_ref(ref)
            if pos is not None:
                links.setdefault(pos, [])
                if url not in links[pos]:
                    links[pos].append(url)
                continue

            rng = _parse_range(ref)
            if rng is None:
                continue
            min_r, min_c, max_r, max_c = rng
            for r in range(min_r, max_r + 1):
                for c in range(min_c, max_c + 1):
                    links.setdefault((r, c), [])
                    if url not in links[(r, c)]:
                        links[(r, c)].append(url)

        # распространение по merged-диапазонам
        for mc in sheet.findall(".//main:mergeCell", _XLSX_NS):
            rng = _parse_range(mc.get("ref") or "")
            if not rng:
                continue
            min_r, min_c, max_r, max_c = rng
            src = (min_r, min_c)
            if src not in links:
                continue
            for r in range(min_r, max_r + 1):
                for c in range(min_c, max_c + 1):
                    if (r, c) == src:
                        continue
                    links.setdefault((r, c), [])
                    for u in links[src]:
                        if u not in links[(r, c)]:
                            links[(r, c)].append(u)

    return links


# ---------------------------------------------------------------- source
class XlsxFileSource(ScheduleSource):
    """
    Источник данных — xlsx-файл на диске.

    ВАЖНО: Google Sheets → xlsx теряет вторую rich-text-ссылку в ячейке.
    Если файл получен экспортом из Sheets и в нём есть ячейки с
    несколькими ссылками, часть ссылок потеряется ещё до парсера.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)

    async def load(self) -> list[SheetData]:
        if not self.path.exists():
            raise FileNotFoundError(f"Нет файла: {self.path}")

        sheet_names = pd.ExcelFile(self.path).sheet_names

        wb = load_workbook(self.path, read_only=True, data_only=True)
        try:
            hidden = {
                ws.title for ws in wb.worksheets if ws.sheet_state != "visible"
            }
        finally:
            wb.close()

        result: list[SheetData] = []
        for name in sheet_names:
            df    = fill_merged_cells_safe(self.path, name)
            links = load_hyperlinks(self.path, name)
            result.append(SheetData(
                name=name,
                df=df,
                links=links,
                hidden=(name in hidden),
                sheet_id=None,
            ))
        return result