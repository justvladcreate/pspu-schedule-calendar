"""Цвета текста в Google Sheets: тема таблицы и явный rgb."""
from parser.sources.google_sheets import _extract_colored_texts, _theme_map


def _rgb(red=0, green=0, blue=0):
    return {"red": red, "green": green, "blue": blue}


def test_theme_map_builds_palette():
    theme = _theme_map({
        "colorScheme": [
            {"colorType": "ACCENT1", "color": {"rgbColor": _rgb(1, 0, 0)}},
            {"colorType": "TEXT", "color": {"rgbColor": _rgb(0, 0, 0)}},
        ]
    })
    assert theme == {"ACCENT1": "#ff0000"}


def test_run_with_theme_color():
    cell = {
        "formattedValue": "02.11 Лекция",
        "textFormatRuns": [
            {"startIndex": 0, "format": {"foregroundColorStyle": {"themeColor": "ACCENT1"}}},
        ],
    }
    chunks = _extract_colored_texts(cell, {"ACCENT1": "#ff0000"})
    assert chunks == [{"text": "02.11 Лекция", "color": "#ff0000"}]


def test_run_with_rgb_color_still_wins():
    cell = {
        "formattedValue": "строка",
        "textFormatRuns": [
            {"startIndex": 0, "format": {"foregroundColorStyle": {"rgbColor": _rgb(0, 1, 0)}}},
        ],
    }
    chunks = _extract_colored_texts(cell, {"ACCENT1": "#ff0000"})
    assert chunks == [{"text": "строка", "color": "#00ff00"}]


def test_cell_base_theme_color():
    cell = {
        "formattedValue": "серая строка",
        "effectiveFormat": {
            "textFormat": {"foregroundColorStyle": {"themeColor": "BACKGROUND2"}},
        },
    }
    chunks = _extract_colored_texts(cell, {"BACKGROUND2": "#e7e6e6"})
    assert chunks == [{"text": "серая строка", "color": "#e7e6e6"}]


def test_black_is_skipped():
    cell = {
        "formattedValue": "обычный текст",
        "effectiveFormat": {"textFormat": {"foregroundColor": _rgb(0, 0, 0)}},
    }
    assert _extract_colored_texts(cell) == []
