"""Скрейпер папки cloud.mail: типы файлов и выбор свежего."""
from parser.sources.cloud_mail_folder import (
    FolderFile,
    classify,
    pick_latest,
    sheet_kind,
)


def test_classify_real_names():
    assert classify("01_РАСПИСАНИЕ ОЧНОГО ОТДЕЛЕНИЯ (Б).xlsx") == "oo"
    assert classify("12_РАСПИСАНИЕ ЗАОЧНОГО ОТДЕЛЕНИЯ (Б).xlsx") == "zo"
    assert classify(
        "02_РАСПИСАНИЕ УЧЕБНО-ЭКЗАМЕНАЦИОННОЙ СЕССИИ ЗАОЧНОГО ОТДЕЛЕНИЯ.xlsx"
    ) == "zo"
    assert classify("01_ЗАЧЕТЫ и ЭКЗАМЕНЫ ОЧНОГО ОТДЕЛЕНИЯ.xlsx") == "oo_exams"
    assert classify("01_РАСПИСАНИЕ ГИА.xlsx") == "gia"
    assert classify("16_РАСПИСАНИЕ.xlsx") == "oo"


def test_classify_skips_other_formats():
    assert classify("12_РАСПИСАНИЕ.pdf") is None
    assert classify("Расписание_УЭС_ЗО.7z") is None


def test_pick_latest_per_kind():
    files = [
        FolderFile("old.xlsx", "w/old.xlsx", 1, 100, "oo"),
        FolderFile("new.xlsx", "w/new.xlsx", 1, 200, "oo"),
        FolderFile("zo.xlsx", "w/zo.xlsx", 1, 150, "zo"),
        FolderFile("skip.pdf", "w/skip.pdf", 1, 300, ""),
    ]
    latest = pick_latest(files)
    assert latest["oo"].name == "new.xlsx"
    assert latest["zo"].name == "zo.xlsx"
    assert "" not in latest


def test_sheet_kind_splits_gia_by_group():
    assert sheet_kind("gia", "251") == "oo_exams"
    assert sheet_kind("gia", "Z261") == "zo_exams"
    assert sheet_kind("gia", "ZM231") == "zo_exams"
    assert sheet_kind("oo", "1211") == "oo"
    assert sheet_kind("zo", "Z1223") == "zo"
