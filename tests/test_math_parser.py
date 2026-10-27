import asyncio

import pandas as pd
import pytest

from parser.core.model import AcademicPeriod, Faculty, FacultySource, RawBranch
from parser.faculties.base import FacultyPaths
from parser.faculties.f01_math.parser import MathParser, _parse_line, _split_teachers
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


def _parser(tmp_path, ask=None):
    paths = FacultyPaths("01", tmp_path / "data", tmp_path / "web")
    return MathParser(_faculty(), paths, ask)


def _sheet(rows, name="131"):
    return SheetData(name=name, df=pd.DataFrame(rows), links={}, colors={})


def _schedule(semester: str, date_range: str, discipline: str, rooms: str = "IV / А-231"):
    return _sheet([
        ["РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ"],
        ["3 курс, группа 131"],
        [semester],
        [date_range],
        HEADER,
        ["Понедельник", "", "1", "8.00 - 9.30", discipline, rooms, ""],
    ])


# ---------------------------------------------------------------- строки
def test_split_teachers_slash_and_no_slash():
    rest, teachers = _split_teachers("Алгебра (л) / Шеремет Г.Г.")
    assert rest == "Алгебра (л)"
    assert teachers == ["Шеремет Г.Г."]

    rest, teachers = _split_teachers("Иностранный язык пг. 1.2 Некрасова И.М.")
    assert teachers == ["Некрасова И.М."]
    assert "Некрасова" not in rest


def test_parse_line_dates_type_subgroup():
    item = _parse_line(
        "с 12.10-16.11 Геометрия (пр пг 1) / Павелкин В.Н.",
        2026,
    )
    assert item["discipline"] == "Геометрия"
    assert item["type"] == "прак."
    assert item["subgroup"] == "п/г 1"
    assert item["teachers"] == ["Павелкин В.Н."]
    assert item["dates"][0] == "12.10.2026"
    assert item["dates"][-1] == "16.11.2026"


def test_parse_line_leading_comma_and_full_date():
    item = _parse_line(", 21.12, 28.12, 11.01, 18.01 Электронная школа / Скорнякова А.Ю.", 2026)
    assert item["dates"] == ["21.12.2026", "28.12.2026", "11.01.2027", "18.01.2027"]


def test_parse_line_teacher_in_parentheses():
    item = _parse_line("25.09 Творческое мероприятие (Козлова Д.Ю.)", 2026)
    assert item["teachers"] == ["Козлова Д.Ю."]
    assert "Козлова" not in item["discipline"]


# ---------------------------------------------------------------- год
def test_actual_year_from_date_range_even_if_label_is_stale(tmp_path):
    sheet = _schedule(
        "2 семестр 2025 - 2026 учебного года",
        "01.09.2026-16.01.2027",
        "14.09-28.09 Алгебра (л) / Шеремет Г.Г.",
    )
    groups = asyncio.run(_parser(tmp_path).parse([sheet], PERIOD))

    assert list(groups) == ["131"]
    dates = groups["131"]["events"][0]["dates"]
    assert dates.startswith("14.09.2026")


def test_actual_year_from_label(tmp_path):
    sheet = _schedule(
        "1 семестр 2026 - 2027 учебного года",
        "01.09.2026-16.01.2027",
        "07.09 Алгебра (л) / Шеремет Г.Г.",
    )
    groups = asyncio.run(_parser(tmp_path).parse([sheet], PERIOD))
    assert groups["131"]["events"][0]["dates"] == "07.09.2026"


def test_stale_file_is_skipped(tmp_path):
    sheet = _schedule(
        "2 семестр 2025 - 2026 учебного года",
        "02.02.2026-25.06.2026",
        "14.09-28.09 Алгебра (л) / Шеремет Г.Г.",
    )
    assert asyncio.run(_parser(tmp_path).parse([sheet], PERIOD)) == {}


def test_one_actual_sheet_makes_whole_file_actual(tmp_path):
    stale = _schedule(
        "2 семестр 2025 - 2026 учебного года",
        "02.02.2026-25.06.2026",
        "14.09-28.09 Алгебра (л) / Шеремет Г.Г.",
        )
    actual = _sheet([
        ["РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ"],
        ["2 курс, группа 121"],
        ["1 семестр 2026 - 2027 учебного года"],
        ["01.09.2026-16.01.2027"],
        HEADER,
        ["Вторник", "", "2", "09.45 - 11.15", "07.09 Геометрия (л) / Павелкин В.Н.", "", ""],
    ], name="121")

    groups = asyncio.run(_parser(tmp_path).parse([stale, actual], PERIOD))
    assert set(groups) == {"131", "121"}
    assert groups["131"]["events"][0]["dates"].startswith("14.09.2026")


def test_dates_outside_window_are_dropped(tmp_path):
    sheet = _schedule(
        "1 семестр 2026 - 2027 учебного года",
        "01.09.2026-16.01.2027",
        "15.03.2027 Алгебра (л) / Шеремет Г.Г.",
    )
    groups = asyncio.run(_parser(tmp_path).parse([sheet], PERIOD))
    assert groups == {}


# ---------------------------------------------------------------- уверенность
def test_undated_event_is_weekly_without_llm(tmp_path):
    sheet = _schedule(
        "1 семестр 2026 - 2027 учебного года",
        "01.09.2026-16.01.2027",
        "Физическая культура и спорт",
        rooms="",
    )
    parser = _parser(tmp_path)
    groups = asyncio.run(parser.parse([sheet], PERIOD))

    event = groups["131"]["events"][0]
    assert event["dates"].count(",") >= 5
    branch = parser._branches[0]
    assert branch.confidence >= 0.9
    assert "weekly_no_dates" in branch.issues


def test_score_marks_unparsed_dates_low():
    branch = RawBranch(
        group="131",
        weekday="ПН",
        time_start="08:00",
        discipline="Алгебра",
        dates=[],
        source_text="12.10 Алгебра / Шеремет Г.Г.",
    )
    MathParser._score(branch, parallel_ambiguous=False, rooms_status="")

    assert "dates_unparsed" in branch.issues
    assert branch.confidence < 0.9


def test_score_marks_parallel_without_subgroup_low():
    branch = RawBranch(
        group="131",
        weekday="ПН",
        time_start="08:00",
        discipline="Алгебра",
        dates=["12.10.2026"],
        source_text="12.10 Алгебра / Шеремет Г.Г.",
    )
    MathParser._score(branch, parallel_ambiguous=True, rooms_status="")

    assert "parallel_without_subgroup" in branch.issues
    assert branch.confidence < 0.9


# ---------------------------------------------------------------- LLM
def _branch(**extra):
    data = dict(
        group="131",
        weekday="ПН",
        time_start="08:00",
        discipline="Алгебра",
        dates=["12.10.2026"],
        source_text="12.10 Алгебра / Шеремет Г.Г.",
        confidence=0.5,
        issues=["dates_unparsed"],
    )
    data.update(extra)
    return RawBranch(**data)


def test_refine_sends_only_repairable(tmp_path):
    asked = []

    async def fake_ask(prompt):
        asked.append(prompt)
        return ['{"i": 1, "discipline": "Алгебра", "type": "лек.", "subgroup": "", '
                '"teachers": [], "dates": ["12.10.2026"], "rooms": ""}']

    parser = _parser(tmp_path, ask=fake_ask)
    parser._branches = [
        _branch(),
        _branch(discipline="Физкультура", source_text="Физкультура",
                confidence=0.83, issues=["weekly_no_dates", "no_teachers"]),
    ]

    asyncio.run(parser.refine({}, PERIOD))

    assert len(asked) == 1
    assert "Алгебра" in asked[0]
    assert "Физкультура" not in asked[0]
    assert parser._branches[1].discipline == "Физкультура"


def test_refine_does_not_drop_rooms_or_dates(tmp_path):
    async def fake_ask(prompt):
        return ['{"i": 1, "discipline": "Алгебра", "type": "лек.", "subgroup": "", '
                '"teachers": [], "dates": ["12.10.2026", "19.10.2026"], "rooms": "А-231"}']

    parser = _parser(tmp_path, ask=fake_ask)
    parser._branches = [
        _branch(
            rooms="IV / А-231",
            room_source="IV / А-231",
            source_text="12.10, 19.10 Алгебра / Шеремет Г.Г.",
        ),
    ]

    asyncio.run(parser.refine({}, PERIOD))
    branch = parser._branches[0]

    # аудиторию не меняем, если она уже была
    assert branch.rooms == "IV / А-231"
    # даты только добавляются и только те, что есть в строке
    assert branch.dates == ["12.10.2026", "19.10.2026"]


def test_refine_caches_results(tmp_path):
    calls = []

    async def fake_ask(prompt):
        calls.append(prompt)
        return ['{"i": 1, "discipline": "Алгебра", "type": "", "subgroup": "", '
                '"teachers": [], "dates": [], "rooms": ""}']

    parser = _parser(tmp_path, ask=fake_ask)
    parser._branches = [_branch()]
    asyncio.run(parser.refine({}, PERIOD))
    assert len(calls) == 1

    # повторный прогон — из кэша
    parser2 = _parser(tmp_path, ask=fake_ask)
    parser2._branches = [_branch()]
    asyncio.run(parser2.refine({}, PERIOD))
    assert len(calls) == 1
