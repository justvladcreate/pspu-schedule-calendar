"""Smoke-тесты источников: интерфейс и контракт."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from parser.sources import GoogleSheetsSource, SheetData, XlsxFileSource
from parser.sources.google_sheets import _apply_merges, _build_df, _cell_links


# ---------------------------------------------------------------- базовые
def test_sheetdata_is_dataclass():
    s = SheetData(name="1221", df=pd.DataFrame())
    assert s.name == "1221"
    assert s.links == {}
    assert s.hidden is False
    assert s.sheet_id is None


# ---------------------------------------------------------------- helpers
def test_cell_links_cell_level_only():
    cell = {"hyperlink": "https://a.example/x"}
    assert _cell_links(cell) == ["https://a.example/x"]


def test_cell_links_runs_and_cell_level():
    cell = {
        "hyperlink": "https://a.example/x",
        "textFormatRuns": [
            {"format": {"link": {"uri": "https://a.example/x"}}},
            {"format": {"link": {"uri": "https://b.example/y"}}},
            {"format": {}},
        ],
    }
    assert _cell_links(cell) == ["https://a.example/x", "https://b.example/y"]


def test_cell_links_ignores_non_http():
    cell = {
        "hyperlink": "mailto:x@example.com",
        "textFormatRuns": [
            {"format": {"link": {"uri": "ftp://ftp.example"}}},
            {"format": {"link": {"uri": "https://ok.example/z"}}},
        ],
    }
    assert _cell_links(cell) == ["https://ok.example/z"]


def test_apply_merges_fills_top_left():
    # В Excel/Sheets значение объединённой ячейки лежит в ЛЕВОЙ ВЕРХНЕЙ.
    # endRowIndex и endColumnIndex — ЭКСКЛЮЗИВНЫЕ (как в Sheets API,
    # как в Python-слайсах). endColumnIndex=2 → столбцы 0..1.
    df = pd.DataFrame([["X", None, None]], dtype=object)
    merges = [{"startRowIndex": 0, "endRowIndex": 1,
               "startColumnIndex": 0, "endColumnIndex": 2}]
    _apply_merges(df, merges)

    assert df.iat[0, 0] == "X"        # top-left
    assert df.iat[0, 1] == "X"        # внутри merge
    assert pd.isna(df.iat[0, 2])      # СНАРУЖИ merge — не тронуто


def test_build_df_pads_and_trims():
    row_data = [
        {"values": [{"formattedValue": "A"}]},
        {"values": [{"formattedValue": "B"}, {"formattedValue": "C"}]},
        {},                                # пустая строка внутри
        {"values": [{"formattedValue": "D"}]},
        {}, {}, {},                        # хвостовые пустые — должны отрезаться
    ]
    df = _build_df(row_data, n_cols=3, n_rows=10)
    # остались 4 строки, все по 3 колонки
    assert df.shape == (4, 3)
    assert df.iat[0, 0] == "A"
    assert df.iat[1, 1] == "C"
    assert pd.isna(df.iat[2, 0])


# ---------------------------------------------------------------- Google mock
def _make_fake_service(sheets_payload: dict):
    svc = MagicMock()
    (svc.spreadsheets.return_value
     .get.return_value
     .execute.return_value) = sheets_payload
    return svc


@pytest.mark.asyncio
async def test_google_source_basic():
    payload = {
        "sheets": [{
            "properties": {
                "title": "1221",
                "sheetId": 42,
                "hidden": False,
                "gridProperties": {"rowCount": 5, "columnCount": 3},
            },
            "merges": [{
                "startRowIndex": 0, "endRowIndex": 1,
                "startColumnIndex": 0, "endColumnIndex": 2,
            }],
            "data": [{"rowData": [
                {"values": [
                    {"formattedValue": "A",
                     "textFormatRuns": [
                         {"format": {"link": {"uri": "https://one"}}},
                         {"format": {"link": {"uri": "https://two"}}},
                     ]},
                    {}, {},
                ]},
                {"values": [
                    {"formattedValue": "B"}, {}, {},
                ]},
            ]}],
        }],
    }
    src = GoogleSheetsSource("fake-id", _make_fake_service(payload))
    sheets = await src.load()

    assert len(sheets) == 1
    s = sheets[0]
    assert s.name == "1221"
    assert s.sheet_id == 42
    assert s.hidden is False

    # merge применился
    assert s.df.iat[0, 0] == "A"
    assert s.df.iat[0, 1] == "A"

    # обе rich-text-ссылки в одной ячейке
    assert s.links[(0, 0)] == ["https://one", "https://two"]


# ---------------------------------------------------------------- xlsx
def test_xlsx_source_requires_file(tmp_path):
    src = XlsxFileSource(tmp_path / "missing.xlsx")
    with pytest.raises(FileNotFoundError):
        import asyncio
        asyncio.run(src.load())