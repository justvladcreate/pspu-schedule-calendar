from __future__ import annotations

import logging
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pandas as pd
from openpyxl import load_workbook

from parser.core.colors import apply_tint
from parser.sources.base import ScheduleSource, SheetData

logger = logging.getLogger(__name__)

_XLSX_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel":  "http://schemas.openxmlformats.org/package/2006/relationships",
}
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

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

def _sheet_paths_from_zip(path: str | Path) -> dict[str, str]:
    with zipfile.ZipFile(path) as zf:
        wb   = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))

    rid_to_target = {
        r.get("Id"): r.get("Target")
        for r in rels.findall("rel:Relationship", _XLSX_NS)
    }

    result: dict[str, str] = {}
    for sh in wb.findall(".//main:sheet", _XLSX_NS):
        name = sh.get("name")
        rid = sh.get(f"{{{_R_NS}}}id")
        target = rid_to_target.get(rid)
        if not name or not target:
            continue
        target = target.lstrip("/")
        if not target.startswith("xl/"):
            target = f"xl/{target}"
        result[name] = target
    return result

def _extract_color_hex(hex_str: str | None) -> str | None:
    if not hex_str:
        return None
    hex_str = hex_str.upper()
    if hex_str.startswith('FF') and len(hex_str) == 8:
        hex_str = hex_str[2:]
    if len(hex_str) != 6:
        return None
    # Игнорируем черный цвет (активные мероприятия)
    if hex_str == '000000':
        return None
    return f"#{hex_str}"


# Индексы Excel (64/65 — системные фон/текст).
_INDEXED = {
    0: "#000000", 1: "#FFFFFF", 2: "#FF0000", 3: "#00FF00", 4: "#0000FF",
    5: "#FFFF00", 6: "#FF00FF", 7: "#00FFFF", 8: "#000000", 9: "#FFFFFF",
    10: "#FF0000", 11: "#00FF00", 12: "#0000FF", 13: "#FFFF00",
    14: "#FF00FF", 15: "#00FFFF", 16: "#800000", 17: "#008000",
    18: "#000080", 19: "#808000", 20: "#800080", 21: "#008080",
    22: "#C0C0C0", 23: "#808080", 24: "#9999FF", 25: "#993366",
    26: "#FFFFCC", 27: "#CCFFFF", 28: "#660066", 29: "#FF8080",
    30: "#0066CC", 31: "#CCCCFF", 32: "#000080", 33: "#FF00FF",
    34: "#FFFF00", 35: "#00FFFF", 36: "#800080", 37: "#800000",
    38: "#008080", 39: "#0000FF", 40: "#00CCFF", 41: "#CCFFFF",
    42: "#CCFFCC", 43: "#FFFF99", 44: "#99CCFF", 45: "#FF99CC",
    46: "#CC99FF", 47: "#FFCC99", 48: "#3366FF", 49: "#33CCCC",
    50: "#99CC00", 51: "#FFCC00", 52: "#FF9900", 53: "#FF6600",
    54: "#666699", 55: "#969696", 56: "#003366", 57: "#339966",
    58: "#003300", 59: "#333300", 60: "#993300", 61: "#993366",
    62: "#333399", 63: "#333333",
    64: "#000000", 65: "#FFFFFF",
}

# Стандартная тема Office, если из файла не удалось прочитать свою.
_DEFAULT_THEME = [
    "#FFFFFF", "#000000", "#E7E6E6", "#44546A", "#4472C4", "#ED7D31",
    "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#0563C1", "#954F72",
]


def _theme_palette(workbook) -> list[str]:
    """Цвета темы в порядке индексов Excel: lt1, dk1, lt2, dk2, accent1…

    В XML порядок другой (dk1, lt1, …), поэтому переставляем: иначе
    «белый с затемнением» (серый текст) читается как чёрный.
    """
    try:
        xml = workbook.loaded_theme
        if isinstance(xml, str):
            xml = xml.encode("utf-8")
        if not xml:
            return _DEFAULT_THEME
        root = ET.fromstring(xml)
    except Exception:  # noqa: BLE001
        return _DEFAULT_THEME

    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    scheme = root.find(".//a:clrScheme", ns)
    if scheme is None:
        return _DEFAULT_THEME

    def read_color(tag: str) -> str | None:
        node = scheme.find(f"a:{tag}", ns)
        if node is None:
            return None
        srgb = node.find("a:srgbClr", ns)
        if srgb is not None:
            value = srgb.get("val")
        else:
            sys_color = node.find("a:sysClr", ns)
            value = sys_color.get("lastClr") if sys_color is not None else None
        if value and len(value) == 6:
            return f"#{value.upper()}"
        return None

    order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3",
             "accent4", "accent5", "accent6", "hlink", "folHlink"]
    colors = [read_color(tag) for tag in order]
    if any(color is None for color in colors):
        return _DEFAULT_THEME
    return colors


def _font_color_hex(color, palette: list[str]) -> str | None:
    """openpyxl color → hex (rgb / theme / indexed) с учётом tint."""
    if color is None:
        return None
    hex_color = None
    try:
        if color.type == "rgb":
            hex_color = _extract_color_hex(color.rgb)
        elif color.type == "theme" and color.theme is not None and color.theme < len(palette):
            hex_color = _extract_color_hex(palette[color.theme].lstrip("#"))
        elif color.type == "indexed" and color.indexed is not None:
            if color.indexed in (64, 9):
                return None
            hex_color = _extract_color_hex(_INDEXED.get(color.indexed, "").lstrip("#"))
    except Exception:  # noqa: BLE001
        return None

    if hex_color:
        hex_color = apply_tint(hex_color, getattr(color, "tint", 0) or 0)
        if hex_color.lower() == "#000000":
            return None
    return hex_color


def _cell_color_chunks(cell, palette: list[str]) -> list[dict]:
    """Цветные фрагменты ячейки: rich text по кускам или один цвет ячейки."""
    value = cell.value
    if value is None or value == "":
        return []

    chunks: list[dict] = []

    # openpyxl отдаёт CellRichText, если книга открыта с rich_text=True.
    parts = list(value) if hasattr(value, "__iter__") and not isinstance(value, str) else None
    if parts:
        for part in parts:
            text = part if isinstance(part, str) else getattr(part, "text", "")
            if not text:
                continue
            color = _font_color_hex(
                getattr(getattr(part, "font", None), "color", None),
                palette,
            )
            if not color:
                continue
            if chunks and chunks[-1]["color"] == color:
                chunks[-1]["text"] += text
            else:
                chunks.append({"text": text, "color": color})
        if chunks:
            return chunks

    color = _font_color_hex(getattr(cell.font, "color", None), palette)
    if color:
        return [{"text": str(value), "color": color}]
    return []

def _read_sheet_df(
    excel_file: pd.ExcelFile,
    worksheet,
    theme_palette: list[str] | None = None,
) -> tuple[pd.DataFrame, dict[tuple[int, int], list[dict]]]:
    theme_palette = theme_palette or _DEFAULT_THEME
    df = excel_file.parse(worksheet.title, header=None)
    df = df.astype(object)

    for merged_range in worksheet.merged_cells.ranges:
        top_left_value = worksheet.cell(merged_range.min_row, merged_range.min_col).value
        start_row = merged_range.min_row - 1
        end_row   = merged_range.max_row - 1
        start_col = merged_range.min_col - 1
        end_col   = merged_range.max_col - 1

        if start_row < 0 or end_row >= len(df) or start_col < 0 or end_col >= len(df.columns):
            continue

        for i in range(start_row, end_row + 1):
            for j in range(start_col, end_col + 1):
                df.iat[i, j] = top_left_value

    colors = {}
    for row in worksheet.iter_rows():
        for cell in row:
            chunks = _cell_color_chunks(cell, theme_palette)
            if chunks:
                colors[(cell.row - 1, cell.column - 1)] = chunks

    return df, colors

def _load_hyperlinks(zf: zipfile.ZipFile, sheet_path: str) -> dict[tuple[int, int], list[str]]:
    links: dict[tuple[int, int], list[str]] = {}
    if not sheet_path:
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


class XlsxFileSource(ScheduleSource):
    def __init__(self, path: str | Path):
        self.path = Path(path)

    async def load(self) -> list[SheetData]:
        if not self.path.exists():
            raise FileNotFoundError(f"Нет файла: {self.path}")

        wb = load_workbook(self.path, data_only=True, rich_text=True)
        excel_file = pd.ExcelFile(self.path)
        palette = _theme_palette(wb)

        try:
            hidden = {
                ws.title for ws in wb.worksheets if ws.sheet_state != "visible"
            }
            sheet_paths = _sheet_paths_from_zip(self.path)

            result: list[SheetData] = []
            with zipfile.ZipFile(self.path) as zf:
                for name in wb.sheetnames:
                    df, colors = _read_sheet_df(excel_file, wb[name], palette)
                    links = _load_hyperlinks(zf, sheet_paths.get(name))
                    result.append(SheetData(
                        name=name,
                        df=df,
                        links=links,
                        colors=colors,
                        hidden=(name in hidden),
                        sheet_id=None,
                    ))
            return result
        finally:
            wb.close()
            excel_file.close()