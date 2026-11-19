"""Парсер экзаменов и ГИА: строки с датой."""
from datetime import datetime

import pandas as pd

from parser.faculties.common.exams import parse_exams_sheet
from parser.sources.base import SheetData


def _sheet(rows, name="111"):
    return SheetData(name=name, df=pd.DataFrame(rows))


def test_parses_datetime_dates_and_sections():
    rows = [
        ["УТВЕРЖДАЮ"],
        ["Дата", "Время", "Дисциплина", "Должность/Ф.И.О.", "Аудитория"],
        ["Зачеты"],
        [datetime(2026, 5, 28), "9.45", "Алгебра", "доц. Иванов И.И.", "А-101"],
        ["Экзамены"],
        [datetime(2026, 6, 1), "14:00:00", "Геометрия", "Петров П.П.", "А-102"],
    ]
    events = parse_exams_sheet(_sheet(rows), "oo_exams", year=2026)["111"]["events"]

    assert len(events) == 2
    assert events[0]["dates"] == "28.05.2026"
    assert events[0]["weekday"] == "ЧТ"
    assert events[0]["time_start"] == "09:45"
    assert events[0]["teachers"] == "Иванов И.И."
    assert events[0]["type"] == "зачет"
    assert events[1]["type"] == "экзамен"
    assert events[1]["time_start"] == "14:00"


def test_parses_russian_month_and_numeric_date():
    rows = [
        ["Дата", "Время", "Наименование аттестационного испытания", "ФИО", "Аудитория"],
        ["26 мая 2026", "13.30", "Защита ВКР", "Комиссия", "А-1"],
        ["01.06.2026", "9-00", "Консультация", "Иванов И.И.", "А-2"],
    ]
    events = parse_exams_sheet(_sheet(rows, "152"), "oo_exams", year=2026)["152"]["events"]

    assert [event["dates"] for event in events] == ["26.05.2026", "01.06.2026"]
    assert events[0]["weekday"] == "ВТ"


def test_year_bounds_filter():
    from datetime import date

    rows = [
        ["Дата", "Время", "Дисциплина", "ФИО", "Аудитория"],
        [datetime(2026, 5, 28), "9.45", "Алгебра", "Иванов И.И.", "А-101"],
        [datetime(2026, 12, 28), "9.45", "Геометрия", "Петров П.П.", "А-102"],
    ]
    events = parse_exams_sheet(
        _sheet(rows), "oo_exams", year=2026,
        bounds=(date(2026, 9, 1), date(2027, 8, 31)),
    )["111"]["events"]

    assert [event["dates"] for event in events] == ["28.12.2026"]


def test_skips_sheet_without_header():
    assert parse_exams_sheet(_sheet([["Просто текст"]]), "oo_exams") == {}
