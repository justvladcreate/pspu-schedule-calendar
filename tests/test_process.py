import pytest

from parser.process import (
    _add_90_minutes,
    _assign_rooms,
    _chunk_hash,
    _events_equal,
    format_ai_input,
    merge_ai_line,
)
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
    assert _add_90_minutes("09:45") == "11:15"
    assert _add_90_minutes("23:00") == "00:30"
    assert _add_90_minutes("") == ""
    assert _add_90_minutes("bad") == ""


@pytest.mark.parametrize(
    ("rooms", "index", "total", "expected"),
    [
        ("IV к. А101", 0, 1, "IV к. А101"),
        ("дистанционно онлайн, IV к. А112", 0, 2, "дистанционно онлайн"),
        ("дистанционно онлайн, IV к. А112", 1, 2, "IV к. А112"),
        ("IV к. А111, IV к. А112", 0, 3, "IV к. А111, IV к. А112"),
        ("", 0, 1, ""),
    ],
)
def test_assign_rooms(rooms, index, total, expected):
    assert _assign_rooms(rooms, index, total) == expected


def test_format_ai_input_and_hash():
    sources = [{"subject": "A"}, {"subject": "B"}]
    assert format_ai_input(sources) == "[1] A\n\n[2] B"
    assert _chunk_hash("x") == _chunk_hash("x")


def test_events_equal_ignores_order():
    a = [{"event_id": "1", "group": "101", "weekday": "ПН", "pair_number": 1}]
    b = [{"event_id": "1", "group": "101", "weekday": "ПН", "pair_number": 1}]
    assert _events_equal(a, b)
    b[0]["pair_number"] = 2
    assert not _events_equal(a, b)


def test_merge_ai_line_plain_source():
    src = _source("IV к. А101")
    items = merge_ai_line("[1];-;-;-;14.09;X;лек.;-;Y;", 0, [src])
    assert items[0]["rooms"] == "IV к. А101"
    assert items[0]["discipline"] == "X"
    assert items[0]["weekday"] == "ПН"


def test_merge_ai_line_splits_by_date_hint():
    src = _source("дистанционно\\ онлайн\n28.09 - IV к. В103")
    items = merge_ai_line(
        "[1];-;-;-;14.09, 21.09, 28.09;X;лек.;-;Y;",
        0,
        [src],
    )
    assert [item["rooms"] for item in items] == [
        "дистанционно онлайн",
        "IV к. В103",
    ]


def test_merge_ai_line_uses_text_color():
    src = _source(
        "IV к. А101",
        text_colors=[{"text": "14.09, 21.09", "color": "#cccccc"}],
    )
    items = merge_ai_line("[1];-;-;-;14.09, 21.09;X;лек.;-;Y;", 0, [src])
    assert items[0]["color"] == "#cccccc"
    assert items[0]["is_past"] is True


def test_merge_ai_line_accepts_rooms_from_ai():
    src = _source("")
    items = merge_ai_line("[1];-;-;-;14.09;X;лек.;-;Y;IV к. А404", 0, [src])
    assert items[0]["rooms"] == "IV к. А404"
