from parser.faculties import get_faculty, load_registry


def test_registry_contains_inec_and_skips_old_files():
    academic, faculties = load_registry()
    assert academic.year == "2026/2027"
    assert get_faculty(faculties, "12") is not None
    assert get_faculty(faculties, "01").enabled is False
    assert get_faculty(faculties, "09").enabled is False
    assert get_faculty(faculties, "11").adapter == "paired_columns"


def test_registry_sources():
    _, faculties = load_registry()
    inec = get_faculty(faculties, "12")
    assert inec.source.type == "google_sheets"
    assert inec.source.spreadsheet_id
    math = get_faculty(faculties, "02")
    assert math.source.type == "cloud_mail"
    assert math.source.url.startswith("https://cloud.mail.ru/")
