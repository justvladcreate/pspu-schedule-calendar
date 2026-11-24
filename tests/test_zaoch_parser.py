"""Парсер заочной сессии: строка-занятие и сетка «день / пара»."""
from datetime import date

import pandas as pd

from parser.faculties.common.zaoch import merge_zaoch_groups, parse_zaoch_sheet
from parser.sources.base import SheetData

BOUNDS = (date(2026, 9, 1), date(2027, 8, 31))


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
    assert events[0]["time_end"] == "16:45"
    assert events[0]["discipline"] == "Практикум: технологии"
    assert events[0]["teachers"] == "Кузаев А.Ф."
    assert events[1]["time_start"] == "17:00"


def test_parses_grid_with_separate_date_row():
    """Матфак: день в одной строке, дата — в следующей."""
    rows = [
        ["День", "№", "Начало занятий", "Дисциплина /форма/ ФИО", "Форма обучения"],
        ["Понедельник", "1", "08.00", "", ""],
        [date(2026, 9, 28), "2", "09.45", "", ""],
        ["", "3", "11.30", "Математический анализ. Черемных Е.Л.", "IV корп А 235"],
        ["", "4", "13.30", "Математический анализ. Черемных Е.Л.", "IV корп А 235"],
        ["Вторник", "1", "08.00", "", ""],
        [date(2026, 9, 29), "2", "09.45", "Программирование Скорнякова А.Ю.", "IV корп А 220"],
    ]
    events = parse_zaoch_sheet(_sheet(rows, "Z142"), year=2026)["Z142"]["events"]

    assert [event["time_start"] for event in events] == ["11:30", "13:30", "09:45"]
    assert events[0]["weekday"] == "ПН"
    assert events[0]["dates"] == "28.09.2026"
    assert events[0]["discipline"] == "Математический анализ"
    assert events[0]["teachers"] == "Черемных Е.Л."
    assert events[0]["rooms"] == "IV корп А 235"
    assert events[2]["weekday"] == "ВТ"
    assert events[2]["teachers"] == "Скорнякова А.Ю."


def test_groups_same_slot_by_dates():
    """Одинаковые занятия в разные дни — одно событие со списком дат."""
    rows = [
        ["День", "№", "Начало занятий", "Дисциплина / ФИО", "Форма"],
        ["понедельник 05.10.2026", "3", "11-30", "Алгебра / Иванов И.И.", "А-101"],
        ["понедельник 12.10.2026", "3", "11-30", "Алгебра / Иванов И.И.", "А-101"],
        ["понедельник 19.10.2026", "3", "11-30", "Алгебра / Иванов И.И.", "А-101"],
    ]
    events = parse_zaoch_sheet(_sheet(rows, "Z211"), year=2026)["Z211"]["events"]

    assert len(events) == 1
    assert events[0]["dates"] == "05.10.2026, 12.10.2026, 19.10.2026"


def test_explicit_exam_date_in_text():
    """«ЗАЧЕТ 20.10.2026г. …» — дата из текста важнее даты дня."""
    rows = [
        ["День", "№", "Начало занятий", "Дисциплина / ФИО", "Форма"],
        ["понедельник 05.10.2026", "5", "15-15", "ЗАЧЕТ 20.10.2026г. Алгебра. Иванов И.И.", ""],
    ]
    events = parse_zaoch_sheet(_sheet(rows, "Z211"), year=2026)["Z211"]["events"]

    assert len(events) == 1
    assert events[0]["dates"] == "20.10.2026"
    assert events[0]["type"] == "зачёт"
    assert events[0]["discipline"] == "Алгебра"
    assert events[0]["teachers"] == "Иванов И.И."


def test_type_in_parentheses():
    rows = [
        ["День", "№", "Начало занятий", "Дисциплина / ФИО", "Форма"],
        ["вторник 16.09.2026", "2", "9-45", "Алгебра (ЗАЧЕТ) / Иванов И.И.", "А-101"],
    ]
    events = parse_zaoch_sheet(_sheet(rows, "Z211"), year=2026)["Z211"]["events"]

    assert events[0]["type"] == "зачёт"
    assert events[0]["discipline"] == "Алгебра"


def test_group_from_header_with_cyrillic_letter():
    rows = [
        ["", "", "", "", ""],
        ["1 курс,  ZМ111", "", "", "", ""],
        ["День", "№", "Начало занятий", "Дисциплина / ФИО", "Форма"],
        ["понедельник 19.10.2026", "3", "11-30", "Алгебра / Иванов И.И.", "А-101"],
    ]
    data = parse_zaoch_sheet(_sheet(rows, "ZM111"), year=2026)

    assert list(data) == ["ZM111"]


def test_section_title_row_is_not_a_lesson():
    rows = [
        ["День", "№", "Начало занятий", "Дисциплина / ФИО", "Форма"],
        ["понедельник 05.10.2026", "3", "11-30", "Алгебра / Иванов И.И.", "А-101"],
        ["Установочная сессия, 8 семестр 2026/2027 учебного года"] * 5,
        ["вторник 06.10.2026", "3", "11-30", "Геометрия / Петров П.П.", "А-102"],
    ]
    events = parse_zaoch_sheet(_sheet(rows, "Z211"), year=2026)["Z211"]["events"]

    assert [event["discipline"] for event in events] == ["Алгебра", "Геометрия"]


def test_merged_discipline_is_not_a_room():
    """Дисциплина объединена с колонкой аудитории — это не аудитория."""
    rows = [
        ["День", "№", "Начало занятий", "Дисциплина", "Дисциплина", "Форма обучения"],
        [date(2026, 10, 5), "3", "11.30", "Консультация. Практика", "Консультация. Практика", "Консультация. Практика"],
    ]
    events = parse_zaoch_sheet(_sheet(rows, "Z211"), year=2026)["Z211"]["events"]

    assert events[0]["rooms"] == ""


def test_skips_header_without_table():
    events = parse_zaoch_sheet(_sheet([["Только заголовок"]]), year=2026)
    assert list(events.values())[0]["events"] == []


def test_dates_outside_academic_year_are_dropped():
    rows = [
        ["День", "№", "Начало занятий", "Дисциплина / ФИО", "Форма"],
        ["понедельник 07.04.2025", "2", "9-45", "Алгебра / Иванов И.И.", "А-101"],
    ]
    events = parse_zaoch_sheet(
        _sheet(rows, "Z211"), year=2025, bounds=BOUNDS,
    )["Z211"]["events"]

    assert events == []


def test_merge_keeps_events_from_stale_copy():
    """«Z1233» и «Z1233 (копия)»: пустой лист не затирает разобранный."""
    good = {
        "Z1233": {
            "kind": "zo",
            "events": [{
                "weekday": "ПН", "time_start": "09:45", "discipline": "Алгебра",
                "teachers": "Иванов И.И.", "rooms": "", "dates": "05.10.2026",
                "type": "",
            }],
        },
    }
    empty = {"Z1233": {"kind": "zo", "events": []}}
    other = {
        "Z1233": {
            "kind": "zo",
            "events": [{
                "weekday": "ПН", "time_start": "09:45", "discipline": "Алгебра",
                "teachers": "Иванов И.И.", "rooms": "", "dates": "05.10.2026",
                "type": "",
            }],
        },
    }

    merge_zaoch_groups(good, empty)
    assert len(good["Z1233"]["events"]) == 1

    merge_zaoch_groups(good, other)
    assert len(good["Z1233"]["events"]) == 1

