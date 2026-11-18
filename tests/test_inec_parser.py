"""ИНЭК: сбой LLM не должен стирать группы из расписания."""
import asyncio

from parser.core.model import AcademicPeriod
from parser.core.registry import FacultySource
from parser.faculties.base import AFTER_AI_NAME, Faculty, FacultyPaths, read_json, write_json
from parser.faculties.f12_inec import parser as inec_parser

PERIOD = AcademicPeriod(year="2026/2027")


def _paths(tmp_path) -> FacultyPaths:
    return FacultyPaths(faculty_id="12", data_root=tmp_path, web_root=tmp_path).ensure()


def _make_parser(tmp_path) -> inec_parser.InecParser:
    faculty = Faculty(
        id="12",
        name="ИНЭК",
        short="ИНЭК",
        source=FacultySource(type="google_sheets", spreadsheet_id="test"),
    )
    return inec_parser.InecParser(faculty, paths=_paths(tmp_path))


def test_refine_restores_group_from_previous_version(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    previous = {
        "1237": {
            "events": [{"discipline": "Физическая культура", "weekday": "ЧТ"}],
            "semester_start_year": 2026,
        }
    }
    write_json(paths.latest_file(AFTER_AI_NAME), previous)

    async def boom(**kwargs):
        raise RuntimeError("All connection attempts failed")

    monkeypatch.setattr(inec_parser, "ask_ai_with_retry", boom)

    parser = _make_parser(tmp_path)
    groups = {
        "1237": {
            "events": [{"subject": "Физическая культура"}],
            "semester_start_year": 2026,
        }
    }
    result = asyncio.run(parser.refine(groups, PERIOD))

    assert result["1237"]["events"] == previous["1237"]["events"]
    saved = read_json(paths.latest_file(AFTER_AI_NAME))
    assert saved["1237"]["events"] == previous["1237"]["events"]


def test_refine_restores_group_from_old_version(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    previous = {"1237": {"events": [{"discipline": "Физическая культура"}],
                         "semester_start_year": 2026}}
    write_json(paths.old_file(AFTER_AI_NAME), previous)

    async def boom(**kwargs):
        raise RuntimeError("All connection attempts failed")

    monkeypatch.setattr(inec_parser, "ask_ai_with_retry", boom)

    parser = _make_parser(tmp_path)
    groups = {"1237": {"events": [{"subject": "Физическая культура"}],
                       "semester_start_year": 2026}}
    result = asyncio.run(parser.refine(groups, PERIOD))

    assert result["1237"]["events"] == previous["1237"]["events"]


def test_inherit_discipline_from_previous_line():
    lines = [
        "[1];СР;13:30;-;16.09.2026 - 23.09.2026;Конкурсная деятельность в профессии;лек.прак.;-;Пфлюг В.П.;IV к. A202",
        "[1];СР;13:30;-;30.09.2026 - 21.10.2026;-;прак.;-;Пфлюг В.П.;IV к. A202",
    ]
    result = inec_parser._inherit_discipline(lines)
    assert result[1].split(";")[5] == "Конкурсная деятельность в профессии"
    # первая строка не меняется
    assert result[0].split(";")[5] == "Конкурсная деятельность в профессии"


def test_inherit_discipline_keeps_empty_when_no_previous():
    lines = ["[1];СР;13:30;-;30.09.2026;-;прак.;-;Пфлюг В.П.;IV к. A202"]
    result = inec_parser._inherit_discipline(lines)
    assert result[0].split(";")[5] == "-"


def test_refine_keeps_other_groups_when_one_fails(tmp_path, monkeypatch):
    paths = _paths(tmp_path)

    async def partial(**kwargs):
        prompt = kwargs.get("prompt", "")
        if "Плохая" in prompt:
            raise RuntimeError("proxy down")
        return [
            "5;Лекция;лек.;-;Иванов И.И.;-;-;1;сентябрь;12:00",
        ]

    monkeypatch.setattr(inec_parser, "ask_ai_with_retry", partial)

    parser = _make_parser(tmp_path)
    groups = {
        "1111": {"events": [{"subject": "Хорошая"}], "semester_start_year": 2026},
        "2222": {"events": [{"subject": "Плохая"}], "semester_start_year": 2026},
    }
    result = asyncio.run(parser.refine(groups, PERIOD))

    # группа, для которой LLM ответила, осталась на месте
    assert "1111" in result
    # группа без ответа и без прошлой версии честно помечена как отсутствующая
    assert "2222" not in result
