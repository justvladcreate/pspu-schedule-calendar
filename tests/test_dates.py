import pytest

from parser.dates import (
    add_year,
    expand_dates,
    extract_first_date,
    is_valid_date,
    semester_start_year_from_header,
)
from parser.preprocess import normalize_date_ranges


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("10 семестр 2025/2026 учебного года (01.09.2026 – 23.01.2027)", 2026),
        ("1 семестр 2025/2026 учебного года (01.09.2025 – 25.01.2026)", 2025),
        ("2 семестр 2025/2026 учебного года (09.02.2026 – 30.06.2026)", 2025),
        ("10 семестр 2025/2026 учебного года (01.09.2026-23.01.2027)", 2026),
        ("10 семестр 2025/2026 учебного года", 2025),
        ("10 семестр учебного года (23.01.2027)", 2026),
    ],
)
def test_semester_start_year_from_header(header, expected):
    assert semester_start_year_from_header(header) == expected


@pytest.mark.parametrize(
    ("src", "semester_start_year", "expected"),
    [
        ("15.09 - 13.10, 10.11", 2026, [
            "15.09.2026", "22.09.2026", "29.09.2026",
            "06.10.2026", "13.10.2026", "10.11.2026",
        ]),
        ("20.12 - 10.01", 2026, [
            "20.12.2026", "27.12.2026", "03.01.2027", "10.01.2027",
        ]),
        ("07.03", 2026, ["07.03.2027"]),
        ("24.10.2026", 2026, ["24.10.2026"]),
        ("9.02, 16.02, 23.02", 2025, ["09.02.2026", "16.02.2026", "23.02.2026"]),
        ("29.02.2024 - 21.03.2024", 2023, [
            "29.02.2024", "07.03.2024", "14.03.2024", "21.03.2024",
        ]),
        ("13.10-", 2026, ["13.10.2026"]),
        ("-", 2026, []),
    ],
)
def test_expand_dates(src, semester_start_year, expected):
    assert expand_dates(src, semester_start_year=semester_start_year) == expected


@pytest.mark.parametrize(
    ("src", "expected"),
    [
        ("08.09", "08.09.2026"),
        ("14.01", "14.01.2027"),
        ("24.10.2026", "24.10.2026"),
        ("05.11 - 03.12, 14.01", "05.11.2026 - 03.12.2026, 14.01.2027"),
    ],
)
def test_add_year(src, expected):
    assert add_year(src, semester_start_year=2026) == expected


@pytest.mark.parametrize(
    ("src", "default_end_date", "expected"),
    [
        ("15.09 - 13.10", None, "15.09 - 13.10"),
        ("с 14.04", "18.01", "14.04 - 18.01"),
        ("10.11 -", "18.01", "10.11 - 18.01"),
        ("15.09. - 13.10.", None, "15.09 - 13.10"),
        # Дефис перед словом — не диапазон, а разделитель полей.
        ("20.12 - тест", "18.01", "20.12 тест"),
    ],
)
def test_normalize_date_ranges(src, default_end_date, expected):
    assert normalize_date_ranges(src, default_end_date) == expected


def test_extract_first_date():
    assert extract_first_date("Экзаменационная сессия: 29.06 – 4.07.2026") == "29.06"


def test_is_valid_date():
    assert is_valid_date(29, 2, 2024)
    assert not is_valid_date(29, 2, 2023)
    assert not is_valid_date(31, 4, 2026)
