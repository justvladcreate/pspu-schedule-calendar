import json
import os
import time

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from parser.core.original import publish_original, render_sheet_html


def _workbook():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "131"

    sheet["A1"] = "РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ"
    sheet["A1"].font = Font(name="Times New Roman", size=14, bold=True)
    sheet["A1"].alignment = Alignment(horizontal="center")
    sheet.merge_cells("A1:F1")

    sheet["A3"] = "Дисциплина\nвторая строка"
    sheet["A3"].border = Border(
        left=Side(style="thin"),
        right=Side(style="thin"),
        top=Side(style="thin"),
        bottom=Side(style="thin"),
    )

    sheet["B3"] = "практика"
    sheet["B3"].font = Font(color="0000FF", italic=True, bold=True)
    sheet["B3"].fill = PatternFill("solid", fgColor="FFFF00")

    sheet.column_dimensions["A"].width = 20
    sheet.row_dimensions[1].height = 30
    return workbook


def test_render_sheet_html_keeps_merges_and_styles():
    html = render_sheet_html(_workbook().active)

    assert "colspan=\"6\"" in html
    assert "font-family:Times New Roman" in html
    assert "font-weight:700" in html
    assert "text-align:center" in html
    assert "border-top:1px solid #000000" in html
    assert "color:#0000FF" in html
    assert "background:#FFFF00" in html
    assert "font-style:italic" in html
    assert "Дисциплина<br>вторая строка" in html
    assert "height:40px" in html  # 30pt → 40px


def test_render_skips_hidden_sheets(tmp_path):
    workbook = _workbook()
    hidden = workbook.create_sheet("служебный")
    hidden["A1"] = "не показывать"
    hidden.sheet_state = "hidden"

    source = tmp_path / "source.xlsx"
    workbook.save(source)

    entries = publish_original(tmp_path / "web", "01", source)

    assert [entry["name"] for entry in entries] == ["131"]
    folder = tmp_path / "web" / "faculties" / "01"
    index = json.loads((folder / "sheets.json").read_text(encoding="utf-8"))
    assert index["sheets"][0]["file"].startswith("sheets/")
    assert (folder / index["sheets"][0]["file"]).exists()


def test_publish_original_without_file(tmp_path):
    assert publish_original(tmp_path, "01", tmp_path / "missing.xlsx") is None


def _save(workbook, path):
    workbook.save(path)
    return path


def test_publish_original_merges_all_sources(tmp_path):
    """Очное, заочное и сессия сводятся в один список листов."""
    oo = _workbook()
    oo.create_sheet("152")["A1"] = "очное"
    source_oo = _save(oo, tmp_path / "source.xlsx")

    zo = Workbook()
    zo.active.title = "Z152"
    zo.active["A1"] = "заочное"
    source_zo = _save(zo, tmp_path / "source_zo.xlsx")

    exams = Workbook()
    exams.active.title = "152"
    exams.active["A1"] = "сессия"
    source_exams = _save(exams, tmp_path / "source_oo_exams.xlsx")

    entries = publish_original(
        tmp_path / "web",
        "01",
        [("oo", source_oo), ("zo", source_zo), ("oo_exams", source_exams)],
    )

    assert [entry["id"] for entry in entries] == [
        "oo:131", "oo:152", "zo:Z152", "oo_exams:152",
    ]
    assert [entry["kind"] for entry in entries] == [
        "oo", "oo", "zo", "oo_exams",
    ]
    assert [entry["source"] for entry in entries] == [
        "oo", "oo", "zo", "oo_exams",
    ]
    # одинаковые имена из разных файлов не конфликтуют во вкладках
    assert len({entry["id"] for entry in entries}) == 4


def test_publish_original_changes_url_on_content_change(tmp_path):
    """Имя файла листа зависит от содержимого — кэш браузера не залипнет."""
    source = _save(_workbook(), tmp_path / "source.xlsx")
    folder = tmp_path / "web" / "faculties" / "01"

    first = publish_original(tmp_path / "web", "01", source)
    first_file = first[0]["file"]

    workbook = _workbook()
    workbook.active["A1"] = "НОВОЕ РАСПИСАНИЕ"
    workbook.save(source)
    # гарантируем, что файл новее sheets.json
    os.utime(source, (time.time() + 5, time.time() + 5))

    second = publish_original(tmp_path / "web", "01", source)

    assert second[0]["file"] != first_file
    assert (folder / second[0]["file"]).exists()
    # старый лист удалён — в репозитории не копится мусор
    assert not (folder / first_file).exists()

