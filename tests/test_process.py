import pytest

from parser.faculties.f12_inec.ai_merge import (
    add_90_minutes,
    assign_rooms,
    chunk_hash,
    format_ai_input,
    merge_ai_line,
)
from parser.process import events_equal
from parser.rooms_hints import parse_rooms_with_hints


def _source(room_raw="", **extra):
    hints = parse_rooms_with_hints(room_raw)
    return {
        "day_of_week": "ПН",
        "time_start": "13:30",
        "rooms": ", ".join(r["room"] for r in hints),
        "rooms_hints": hints,
        "subject": "Предмет",
        "text_colors": [],
        **extra,
    }


def test_add_90_minutes():
    assert add_90_minutes("08:00") == "09:30"
    assert add_90_minutes("13:30") == "15:00"
    assert add_90_minutes("") == ""


def test_assign_rooms_single():
    assert assign_rooms("А-101", 0, 2) == "А-101"


def test_assign_rooms_by_branch():
    assert assign_rooms("А-101, Б-202", 0, 2) == "А-101"
    assert assign_rooms("А-101, Б-202", 1, 2) == "Б-202"


def test_assign_rooms_fallback():
    assert assign_rooms("А-101, Б-202", 0, 3) == "А-101, Б-202"


def test_chunk_hash_is_stable():
    assert chunk_hash("abc") == chunk_hash("abc")
    assert chunk_hash("abc") != chunk_hash("abd")


def test_format_ai_input_numbers_sources():
    text = format_ai_input([{"subject": "Первый"}, {"subject": "Второй"}])
    assert text == "[1] Первый\n\n[2] Второй"


def test_merge_ai_line_basic():
    source = _source()
    line = "[1];ПН;13:30;15:00;07.09.2026;Математика;лек.;;Иванов И.И.;А-101"
    items = merge_ai_line(line, 0, [source])
    assert len(items) == 1
    item = items[0]
    assert item["weekday"] == "ПН"
    assert item["discipline"] == "Математика"
    assert item["dates"] == "07.09.2026"
    assert item["rooms"] == "А-101"
    assert item["is_past"] is False


def test_merge_ai_line_bad_field_count():
    assert merge_ai_line("[1];ПН;13:30", 0, [_source()]) == []


def test_merge_ai_line_unknown_enumerator():
    line = "[99];ПН;13:30;15:00;07.09.2026;Математика;лек.;;Иванов И.И.;А-101"
    assert merge_ai_line(line, 0, [_source()]) == []


def test_grey_color_marks_past():
    source = _source(text_colors=[{"text": "07.09.2026", "color": "#999999"}])
    line = "[1];ПН;13:30;15:00;07.09.2026;Математика;лек.;;Иванов И.И.;"
    items = merge_ai_line(line, 0, [source])
    assert items and items[0]["is_past"] is True


def test_events_equal_ignores_order():
    a = [{"event_id": "1", "group": "A", "weekday": "ПН", "pair_number": 1}]
    b = [{"event_id": "1", "group": "A", "weekday": "ПН", "pair_number": 1}]
    assert events_equal(a, b)
    assert not events_equal(a, [])
