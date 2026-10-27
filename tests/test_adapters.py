import pandas as pd
import pytest

from parser.adapters.base import (
    extract_teachers,
    extract_type,
    parse_cell_blocks,
    parse_time,
    split_lines,
)
from parser.adapters.vertical import VerticalAdapter
from parser.dates import expand_date_text
from parser.model import AcademicPeriod, Faculty, FacultySource
from parser.sources.base import SheetData

PERIOD = AcademicPeriod(
    year="2026/2027",
    semester_start=pd.Timestamp("2026-09-01").date(),
    semester_end=pd.Timestamp("2027-01-23").date(),
)


def _faculty(adapter="vertical"):
    return Faculty(
        id="04",
        name="Начальное образование",
        short="НО",
        source=FacultySource(type="cloud_mail", url="https://cloud.mail.ru/x"),
        adapter=adapter,
        prompt="primary",
    )


def test_expand_date_text_handles_ranges_and_exclusions():
    assert expand_date_text("с 14.09 по 28.09", 2026) == [
        "14.09.2026", "21.09.2026", "28.09.2026",
    ]
    assert expand_date_text("с 15.09 (кроме 22.09) - 06.10", 2026) == [
        "15.09.2026", "29.09.2026", "06.10.2026",
    ]
    assert expand_date_text("15.12, 29.12.,12.01", 2026) == [
        "15.12.2026", "29.12.2026", "12.01.2027",
    ]


def test_expand_date_text_ignores_activity_number():
    # 44.03.05 — не дата
    assert expand_date_text("44.03.05 Педагогическое образование", 2026) == []


def test_extract_type_does_not_eat_subject_words():
    type_, rest = extract_type("Теория и практика обучения / преп. Юрганов Ф.А.")
    assert type_ == ""
    assert "Теория и практика обучения" in rest

    assert extract_type("История России (л)")[0] == "лек."
    assert extract_type("История России Практическая фонетика / практические занятия (13)")[0] == "прак."
    assert extract_type("Конституционное право практ. с 07.12")[0] == "прак."


def test_extract_teachers_both_orders():
    teachers, rest = extract_teachers("Практическая фонетика / 1 подгруппа / Н.П. Ивинских")
    assert teachers == ["Ивинских Н.П."]
    assert "Ивинских" not in rest

    teachers, _ = extract_teachers("доц. Подавылова И.А. 30.11")
    assert teachers == ["Подавылова И.А."]


def test_parse_cell_blocks_merges_date_only_lines():
    blocks = parse_cell_blocks(
        "РУССКИЙ ЯЗЫК И КУЛЬТУРА РЕЧИ (л)\nс 14.09 по 28.09 Бакланова И.И."
    )
    assert len(blocks) == 1
    assert blocks[0]["discipline"] == "РУССКИЙ ЯЗЫК И КУЛЬТУРА РЕЧИ"
    assert blocks[0]["type"] == "лек."
    assert blocks[0]["teachers"] == ["Бакланова И.И."]


def test_parse_cell_blocks_splits_parallel_subgroups():
    blocks = parse_cell_blocks(
        "Практическая фонетика / практические занятия (13) / 1 подгруппа / Н.П. Ивинских\n"
        "Физическая культура и спорт / практические занятия (6) / 2 подгруппа / Н.Н. Винник"
    )
    assert len(blocks) == 2
    assert blocks[0]["subgroup"] == "п/г 1"
    assert blocks[1]["subgroup"] == "п/г 2"
    assert blocks[0]["discipline"] == "Практическая фонетика"


def test_split_lines_keeps_urls():
    assert split_lines("А-305, 4 корпус//47, гл. корп.") == [
        "А-305, 4 корпус", "47, гл. корп.",
    ]
    assert split_lines("https://max.ru/joincall/abc") == [
        "https://max.ru/joincall/abc",
    ]


def test_parse_time_formats():
    assert parse_time("8.00") == ("08:00", "09:30")
    assert parse_time("08.00-9.30") == ("08:00", "09:30")
    assert parse_time("11-30") == ("11:30", "13:00")
    assert parse_time("1 семестр 2026/2027 (01.09.2026 – 23.01.2027)") == ("", "")


def _sheet(df, name="411"):
    return SheetData(name=name, df=df, links={}, colors={}, hidden=False)


def test_vertical_adapter_builds_branches_with_rooms_and_days():
    df = pd.DataFrame([
        ["Расписание", "", "", "", ""],
        ["1 курс, группа 411", "", "", "", ""],
        ["День", "Начало занятий", "Дисциплина", "Даты", "Аудитория"],
        ["понедельник", "8.00", "Математика / 1 подгруппа / Иванов И.И.", "26.10", "А-101"],
        ["вторник", "9.45", "Физика / практические занятия / Петров П.П.", "27.10", "Б-202"],
    ])
    branches = VerticalAdapter().parse([_sheet(df)], _faculty(), PERIOD)

    assert len(branches) == 2
    first = branches[0]
    assert first.group == "411"
    assert first.weekday == "ПН"
    assert first.time_start == "08:00"
    assert first.discipline == "Математика"
    assert first.subgroup == "п/г 1"
    assert first.teachers == ["Иванов И.И."]
    assert first.dates == ["26.10.2026"]
    assert first.rooms == "А-101"


def test_vertical_adapter_repeats_undated_branch_every_week():
    df = pd.DataFrame([
        ["День", "Начало занятий", "Дисциплина", "Даты", "Аудитория"],
        ["среда", "11.30", "Физкультура", "", "Зал"],
    ])
    branches = VerticalAdapter().parse([_sheet(df)], _faculty(), PERIOD)
    assert len(branches) == 1
    assert "weekly_dates" in branches[0].issues
    # 02.09.2026 — первая среда семестра
    assert branches[0].dates[0] == "02.09.2026"
    assert len(branches[0].dates) == len(
        [d for d in branches[0].dates if d.endswith("2026") or d.endswith("2027")]
    )


def test_vertical_adapter_drops_other_academic_year():
    df = pd.DataFrame([
        ["День", "Начало занятий", "Дисциплина", "Даты", "Аудитория"],
        ["понедельник", "8.00", "Старое занятие", "18.03.24 - 15.04.24", "А-1"],
    ])
    assert VerticalAdapter().parse([_sheet(df)], _faculty(), PERIOD) == []


def test_weekly_branch_does_not_duplicate_dated_slot():
    df = pd.DataFrame([
        ["День", "Начало занятий", "Дисциплина", "Даты", "Аудитория"],
        ["понедельник", "8.00", "Математика", "05.10", "А-1"],
        ["понедельник", "8.00", "Математика", "", "А-1"],
    ])
    branches = VerticalAdapter().parse([_sheet(df)], _faculty(), PERIOD)
    dates = [value for branch in branches for value in branch.dates]
    assert dates.count("05.10.2026") == 1
