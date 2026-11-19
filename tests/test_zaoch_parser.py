"""Парсер заочной сессии: строки с датой."""
import pandas as pd

from parser.faculties.common.zaoch import parse_zaoch_sheet
from parser.sources.base import SheetData


def _sheet(rows, name="Z1223"):
    return SheetData(name=name, df=pd.DataFrame(rows))


def test_parses_rows_and_carries_date():
    rows = [
        ["УТВЕРЖДАЮ", ""],
        ["День", "№", "Начало занятий", "Дисциплина / ФИО преподавателя", "Форма"],
        ["понедельник 14.09.2026", "5", "15-15", "Практикум: технологии / Кузаев А.Ф.", "А-112"],
        ["", "6", "17-00", "Практикум: технологии / Кузаев А.Ф.", "А-112"],
        ["Декан факультета", "", "", "", ""],
    ]
    events = parse_zaoch_sheet(_sheet(rows), year=2026)["Z1223"]["events"]

    assert len(events) == 2
    assert events[0]["weekday"] == "ПН"
    assert events[0]["dates"] == "14.09.2026"
    assert events[0]["time_start"] == "15:15"
    assert events[0]["discipline"] == "Практикум: технологии"
    assert events[0]["teachers"] == "Кузаев А.Ф."
    assert events[1]["time_start"] == "17:00"


def test_parses_date_inside_first_cell():
    rows = [
        ["№", "Начало занятий", "Дисциплина преподаватель", "Аудитория"],
        ["05.10.2026 г., понедельник", "1", "08-00", "Алгебра / Иванов И.И.", "А-101"],
    ]
    events = parse_zaoch_sheet(_sheet(rows, "Z211"), year=2026)["Z211"]["events"]

    assert len(events) == 1
    assert events[0]["dates"] == "05.10.2026"
    assert events[0]["weekday"] == "ПН"


def test_skips_header_without_table():
    events = parse_zaoch_sheet(_sheet([["Только заголовок"]]), year=2026)
    assert list(events.values())[0]["events"] == []
