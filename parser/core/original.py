"""Предрендер исходной таблицы в HTML — для кнопки «Оригинал».

Браузерный SheetJS не умеет шрифты, выравнивание и границы (это Pro),
поэтому исходный XLSX рендерим на бэкенде через openpyxl: получаем
тот же вид, что в Excel — объединённые ячейки, ширины колонок, шрифты,
цвета и рамки.

Результат публикуется рядом с данными факультета:

    web/data/faculties/<id>/sheets.json
    web/data/faculties/<id>/sheets/sheet-1.html
"""
from __future__ import annotations

import html
import json
import logging
import re
from datetime import date, datetime, time
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

logger = logging.getLogger(__name__)

SHEETS_INDEX = "sheets.json"
SHEETS_DIR = "sheets"

# Индексы цветов Excel (64/65 — системные фон/текст)
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
    64: "#000000",  # system foreground
    65: "#FFFFFF",  # system background
}

# Стандартная тема Office (theme index → цвет)
_THEME = {
    0: "#FFFFFF", 1: "#000000", 2: "#E7E6E6", 3: "#44546A",
    4: "#4472C4", 5: "#ED7D31", 6: "#A5A5A5", 7: "#FFC000",
    8: "#5B9BD5", 9: "#70AD47",
}

_BORDER_STYLES = {
    "thin": "1px solid",
    "medium": "2px solid",
    "thick": "3px solid",
    "double": "3px double",
    "dashed": "1px dashed",
    "dotted": "1px dotted",
    "hair": "1px dotted",
    "mediumDashed": "2px dashed",
    "dashDot": "1px dashed",
    "mediumDashDot": "2px dashed",
    "dashDotDot": "1px dashed",
    "mediumDashDotDot": "2px dashed",
    "slantDashDot": "2px dashed",
}


# ------------------------------------------------------------------ helpers
def _norm_color(color) -> str | None:
    """openpyxl Color → '#RRGGBB' (или None)."""
    if color is None:
        return None
    if getattr(color, "type", None) == "rgb" and isinstance(color.rgb, str):
        rgb = color.rgb
        if len(rgb) == 8:  # AARRGGBB
            rgb = rgb[2:]
        if len(rgb) == 6 and rgb.upper() != "000000":
            return f"#{rgb.upper()}"
        if len(rgb) == 6:
            return f"#{rgb.upper()}"
    if getattr(color, "type", None) == "indexed" and isinstance(color.indexed, int):
        return _INDEXED.get(color.indexed)
    if getattr(color, "type", None) == "theme" and isinstance(color.theme, int):
        return _THEME.get(color.theme)
    return None


def _cell_style(cell) -> str:
    parts: list[str] = []

    font = cell.font
    if font is not None:
        if font.name:
            family = str(font.name).replace("'", "").replace('"', "")
            parts.append(f"font-family:{family}, Arial, sans-serif")
        if font.sz:
            parts.append(f"font-size:{float(font.sz):g}pt")
        if font.b:
            parts.append("font-weight:700")
        if font.i:
            parts.append("font-style:italic")
        if font.u:
            parts.append("text-decoration:underline")
        color = _norm_color(font.color)
        if color:
            parts.append(f"color:{color}")

    alignment = cell.alignment
    horizontal = getattr(alignment, "horizontal", None)
    vertical = getattr(alignment, "vertical", None)
    if horizontal in {"left", "center", "right", "justify"}:
        parts.append(f"text-align:{horizontal}")
    if vertical in {"top", "center", "bottom"}:
        parts.append(f"vertical-align:{vertical}")

    fill = cell.fill
    if fill is not None and getattr(fill, "patternType", None) == "solid":
        background = _norm_color(fill.fgColor)
        if background and background.upper() != "#FFFFFF":
            parts.append(f"background:{background}")

    border = cell.border
    if border is not None:
        for side_name in ("top", "right", "bottom", "left"):
            side = getattr(border, side_name, None)
            style = getattr(side, "style", None) if side else None
            if not style:
                continue
            css = _BORDER_STYLES.get(style, "1px solid")
            color = _norm_color(getattr(side, "color", None)) or "#000000"
            parts.append(f"border-{side_name}:{css} {color}")

    return ";".join(parts)


def _cell_value(cell) -> str:
    value = cell.value
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.time() == time(0, 0):
            return value.strftime("%d.%m.%Y")
        return value.strftime("%d.%m.%Y %H:%M")
    if isinstance(value, date):
        return value.strftime("%d.%m.%Y")
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _escape(text: str) -> str:
    text = html.escape(text, quote=False)
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")


def _used_bounds(ws) -> tuple[int, int, int, int]:
    """Реальные границы: последняя строка/колонка с непустым значением."""
    last_row = 1
    last_col = 1
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is None:
                continue
            if isinstance(cell.value, str) and not cell.value.strip():
                continue
            last_row = max(last_row, cell.row)
            last_col = max(last_col, cell.column)
    return 1, 1, last_row, last_col


def _column_widths(ws, last_col: int) -> list[int]:
    widths = []
    for column in range(1, last_col + 1):
        letter = get_column_letter(column)
        dimension = ws.column_dimensions.get(letter)
        width = getattr(dimension, "width", None) or 8.43
        widths.append(max(24, min(int(round(width * 7 + 5)), 900)))
    return widths


def _row_height(ws, row: int) -> int | None:
    dimension = ws.row_dimensions.get(row)
    height = getattr(dimension, "height", None)
    if not height:
        return None
    return max(15, int(round(height * 4 / 3)))


# ------------------------------------------------------------------ render
def render_sheet_html(ws) -> str:
    first_row, first_col, last_row, last_col = _used_bounds(ws)
    widths = _column_widths(ws, last_col)

    spans: dict[tuple[int, int], tuple[int, int]] = {}
    covered: set[tuple[int, int]] = set()
    for merge in ws.merged_cells.ranges:
        spans[(merge.min_row, merge.min_col)] = (
            merge.max_row - merge.min_row + 1,
            merge.max_col - merge.min_col + 1,
        )
        for row in range(merge.min_row, merge.max_row + 1):
            for col in range(merge.min_col, merge.max_col + 1):
                if (row, col) != (merge.min_row, merge.min_col):
                    covered.add((row, col))

    total_width = sum(widths)
    parts: list[str] = [
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>",
        "html,body{margin:0;padding:0;background:#fff;}",
        "body{font:12pt Arial,sans-serif;color:#000;}",
        "table{border-collapse:collapse;table-layout:fixed;background:#fff;}",
        "td{padding:1px 3px;vertical-align:top;overflow:hidden;"
        "white-space:pre-wrap;word-wrap:break-word;}",
        "</style></head><body>",
        f"<table style=\"width:{total_width}px\">",
        "<colgroup>",
    ]
    parts.extend(f"<col style=\"width:{width}px\">" for width in widths)
    parts.append("</colgroup>")

    for row in range(first_row, last_row + 1):
        height = _row_height(ws, row)
        style = f" style=\"height:{height}px\"" if height else ""
        parts.append(f"<tr{style}>")
        for column in range(first_col, last_col + 1):
            if (row, column) in covered:
                continue
            cell = ws.cell(row=row, column=column)
            rowspan, colspan = spans.get((row, column), (1, 1))
            attributes = []
            if rowspan > 1:
                attributes.append(f"rowspan=\"{rowspan}\"")
            if colspan > 1:
                attributes.append(f"colspan=\"{colspan}\"")
            css = _cell_style(cell)
            if css:
                attributes.append(f"style=\"{css}\"")
            text = _escape(_cell_value(cell))
            parts.append(f"<td {' '.join(attributes)}>{text}</td>")
        parts.append("</tr>")

    parts.append("</table></body></html>")
    return "".join(parts)


def _sheet_file(index: int) -> str:
    return f"{SHEETS_DIR}/sheet-{index}.html"


def publish_original(
    web_data_dir: Path,
    faculty_id: str,
    xlsx_path: Path,
) -> list[dict] | None:
    """Рендерит видимые листы XLSX в web/data/faculties/<id>/sheets/."""
    xlsx_path = Path(xlsx_path)
    if not xlsx_path.exists():
        return None

    folder = Path(web_data_dir) / "faculties" / faculty_id
    folder.mkdir(parents=True, exist_ok=True)
    sheets_dir = folder / SHEETS_DIR
    sheets_dir.mkdir(parents=True, exist_ok=True)

    index_path = folder / SHEETS_INDEX
    if index_path.exists() and index_path.stat().st_mtime >= xlsx_path.stat().st_mtime:
        try:
            cached = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = None
        if cached and cached.get("sheets"):
            return cached["sheets"]

    try:
        workbook = load_workbook(xlsx_path, data_only=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Не удалось открыть %s для «Оригинала»: %s", xlsx_path, exc)
        return None

    entries: list[dict] = []
    for index, name in enumerate(workbook.sheetnames, start=1):
        worksheet = workbook[name]
        if worksheet.sheet_state != "visible":
            continue
        try:
            page = render_sheet_html(worksheet)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Лист %s не отрендерен: %s", name, exc)
            continue

        relative = _sheet_file(index)
        target = folder / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page, encoding="utf-8")
        entries.append({"name": name, "file": relative})

    if not entries:
        return None

    index_path.write_text(
        json.dumps({"sheets": entries}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    logger.info(
        "Оригинал %s: %d листов (%s)",
        faculty_id, len(entries), ", ".join(entry["name"] for entry in entries),
    )
    return entries
