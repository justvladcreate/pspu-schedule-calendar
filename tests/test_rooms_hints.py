import pytest

from parser.faculties.f12_inec.rooms_hints import (
    parse_rooms_with_hints,
    pick_rooms_for_branch,
    split_branch_by_rooms,
)


def _parsed(room_raw):
    return parse_rooms_with_hints(room_raw)


def test_parse_type_and_date_hints():
    rooms = _parsed("IV к. А204\nпрак. - 28.09 - IV к. А304")
    assert [(r["room"], r["hint_type"], r["hint_dates"]) for r in rooms] == [
        ("IV к. А204", None, None),
        ("IV к. А304", "прак.", ["09-28"]),
    ]


def test_parse_date_range():
    rooms = _parsed("13.10-20.10 - II к. 315")
    assert rooms == [
        {"room": "II к. 315", "hint_type": None, "hint_dates": ["10-13", "10-20"]},
    ]


def test_parse_urls():
    rooms = parse_rooms_with_hints(
        "дистанционно\\ онлайн\nдистанционно\\ видеолекции",
        urls=["https://max.ru/call", "https://example.com/file"],
    )
    assert [r["room"] for r in rooms] == [
        "[дистанционно онлайн](https://max.ru/call)",
        "[дистанционно онлайн](https://example.com/file)",
    ]


@pytest.mark.parametrize(
    ("raw", "branch_type", "branch_dates", "expected"),
    [
        ("IV к. А201\nпрак. - IV к. А316", "лек.", "", "IV к. А201"),
        ("IV к. А201\nпрак. - IV к. А316", "прак.", "", "IV к. А316"),
        ("IV к. А305\n28.09 - IV к. А304", "прак.", "21.09, 28.09", "IV к. А304"),
        ("IV к. А305\n28.09 - IV к. А304", "прак.", "21.09, 05.10", "IV к. А305"),
        ("прак. - IV к. А304", "лек.", "", ""),
    ],
)
def test_pick_rooms_for_branch(raw, branch_type, branch_dates, expected):
    assert pick_rooms_for_branch(_parsed(raw), branch_type, branch_dates) == expected


def test_split_branch_by_rooms():
    rooms = _parsed("дистанционно\\ онлайн\n28.09 - IV к. В103")
    groups = split_branch_by_rooms(rooms, "лек.", "14.09, 21.09, 28.09")
    assert groups == [
        ("14.09, 21.09", "дистанционно онлайн"),
        ("28.09", "IV к. В103"),
    ]


def test_split_sorts_january_after_december():
    rooms = _parsed("base\n01.01 - B")
    groups = split_branch_by_rooms(rooms, "лек.", "25.12, 01.01")
    assert groups == [("25.12", "base"), ("01.01", "B")]
