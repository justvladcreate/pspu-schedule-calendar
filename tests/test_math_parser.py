import pandas as pd
import pytest

from parser.faculties.f01_math.parser import MathParser, _split_subject
from parser.core.model import AcademicPeriod, Faculty, FacultySource
from parser.sources.base import SheetData

PERIOD = AcademicPeriod(
    year="2026/2027",
    semester_start=pd.Timestamp("2026-09-01").date(),
    semester_end=pd.Timestamp("2027-01-23").date(),
)

HEADER = [
    "Дата", "Дата", "№", "Время",
    "Дисциплина/ФИО преподавателя",
    "Форма обучения // Аудитории",
    "примечание",
]


def _faculty():
    return Faculty(
        id="01",
        name="Математический факультет",
        short="Математика",
        source=FacultySource(type="cloud_mail", url="https://cloud.mail.ru/x"),
        prompt="math",
    )


def _sheet(rows, name="111"):
    df = pd.DataFrame(rows)
    return SheetData(name=name, df=df, links={}, colors={}, hidden=False)


def _schedule(semester: str, discipline: str):
    return _sheet([
        ["РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ"],
        [semester],
        HEADER,
        ["Понедельник", "", "1", "8.00 - 9.30", discipline, "IV / А-231", ""],
    ])


def test_split_subject_dates_type_teachers():
    pieces = _split_subject(
        "14.09-28.09 Русский язык и культура речи (л) / Бакланова И.И.",
        2026,
    )
    assert len(pieces) == 1
    piece = pieces[0]
    assert piece["discipline"] == "Русский язык и культура речи"
    assert piece["type"] == "лек."
    assert piece["teachers"] == ["Бакланова И.И."]
    assert piece["dates"][:3] == ["14.09.2026", "21.09.2026", "28.09.2026"]


def test_split_subject_subgroup_and_multiple_lines():
    pieces = _split_subject(
        "05.10 Современная образовательная среда (ДНК) пг. 1 / Ширинкина К.А.\n"
        "с 12.10-16.11 Геометрия (пр пг 1) / Павелкин В.Н.",
        2026,
    )
    assert len(pieces) == 2
    assert pieces[0]["subgroup"] == "п/г 1"
    assert pieces[0]["teachers"] == ["Ширинкина К.А."]
    assert pieces[1]["type"] == "прак."
    assert pieces[1]["subgroup"] == "п/г 1"


def test_parse_current_year():
    sheet = _schedule(
        "2 семестр 2026 - 2027 учебного года",
        "14.09-28.09 Алгебра (л) / Иванов И.И.",
    )
    groups = __import__("asyncio").run(MathParser(_faculty()).parse([sheet], PERIOD))

    assert list(groups) == ["111"]
    events = groups["111"]["events"]
    assert len(events) == 1
    event = events[0]
    assert event["weekday"] == "ПН"
    assert event["time_start"] == "08:00"
    assert event["discipline"] == "Алгебра"
    assert event["type"] == "лек."
    assert event["teachers"] == "Иванов И.И."
    assert event["rooms"] == "IV / А-231"
    assert event["dates"].startswith("14.09.2026")


def test_parse_skips_previous_academic_year():
    sheet = _schedule(
        "2 семестр 2025 - 2026 учебного года",
        "14.09-28.09 Алгебра (л) / Иванов И.И.",
    )
    groups = __import__("asyncio").run(MathParser(_faculty()).parse([sheet], PERIOD))
    assert groups == {}


def test_parse_drops_dates_outside_period():
    # Даты весны 2027 попадают в учебный год, даты 2024 — нет.
    sheet = _schedule(
        "2 семестр 2026 - 2027 учебного года",
        "15.03.2027 Алгебра (л) / Иванов И.И.",
    )
    groups = __import__("asyncio").run(MathParser(_faculty()).parse([sheet], PERIOD))
    events = groups["111"]["events"]
    assert events[0]["dates"] == "15.03.2027"
