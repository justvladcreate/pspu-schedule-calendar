from parser.faculties import available_faculties, get_parser_class
from parser.registry import get_faculty, load_registry


def test_registry_has_only_inec_and_math():
    academic, faculties = load_registry()
    assert academic.year == "2026/2027"
    assert [faculty.id for faculty in faculties] == ["12", "01"]
    assert all(faculty.enabled for faculty in faculties)


def test_registry_sources():
    _, faculties = load_registry()

    inec = get_faculty(faculties, "12")
    assert inec.source.type == "google_sheets"
    assert inec.source.spreadsheet_id

    math = get_faculty(faculties, "01")
    assert math.source.type == "cloud_mail"
    assert math.source.url.startswith("https://cloud.mail.ru/")


def test_every_faculty_has_parser_module():
    _, faculties = load_registry()
    for faculty in faculties:
        parser_class = get_parser_class(faculty.id)
        assert parser_class is not None, f"нет парсера для {faculty.id}"
        assert parser_class.id == faculty.id


def test_available_faculties_matches_registry():
    _, faculties = load_registry()
    assert sorted(faculty.id for faculty in faculties) == available_faculties()


def test_inec_uses_llm_math_does_not():
    _, faculties = load_registry()
    inec = get_parser_class(get_faculty(faculties, "12").id)
    math = get_parser_class(get_faculty(faculties, "01").id)
    assert inec.uses_llm is True
    assert math.uses_llm is False
