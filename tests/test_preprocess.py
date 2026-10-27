import pytest

from parser.preprocess import (
    clean,
    english_to_russian_lookalike,
    normalize_rooms,
    normalize_subgroup,
    normalize_time,
    remove_invalid_dates,
    remove_spaces_between_initials,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, []),
        ("", []),
        ("   ", []),
        ("IV к.\\ А101", ["IV к. А101"]),
        ("IVк.А101", ["IV к. А101"]),
        ("IV к. А111\nIV к. А216", ["IV к. А111", "IV к. А216"]),
        ("IV к. А111, IV к. А216", ["IV к. А111", "IV к. А216"]),
        ("дистанционно\\ СФЕРУМ", ["дистанционно онлайн"]),
        ("дистанционно\\ онлайн\nIV к. В103", ["дистанционно онлайн", "IV к. В103"]),
        ("IV к. А101\nIV к. А101", ["IV к. А101"]),
        ("IV к. холл 2 эт.", ["IV к. холл 2 эт."]),
        ('"IV к. А101"', ["IV к. А101"]),
        ("-\nнет\nIV к. А216", ["IV к. А216"]),
    ],
)
def test_normalize_rooms(raw, expected):
    assert normalize_rooms(raw) == expected


def test_normalize_rooms_url():
    assert normalize_rooms("дистанционно\\ онлайн", url="https://example.com") == [
        "[дистанционно онлайн](https://example.com)"
    ]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("9-45", "09:45"),
        ("12-30", "12:30"),
        ("14.00-15.00", "14:00"),
        ("14:00 – 15:00", "14:00"),
    ],
)
def test_normalize_time(raw, expected):
    assert normalize_time(raw) == expected


def test_clean_and_lookalikes():
    assert clean("  IV   к.\\  А101 , ") == "IV к. А101,"
    assert english_to_russian_lookalike("A101") == "А101"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("п/г1", "п/г 1"),
        ("пг 2", "п/г 2"),
        ("п\\г 3", "п/г 3"),
    ],
)
def test_normalize_subgroup(raw, expected):
    assert normalize_subgroup(raw) == expected


def test_remove_invalid_dates():
    assert remove_invalid_dates("31.02, 10.11") == "10.11"
    assert remove_invalid_dates("10.11 - 18.01") == "10.11 - 18.01"


def test_remove_spaces_between_initials():
    assert remove_spaces_between_initials("Иванов И. И.") == "Иванов И.И."
