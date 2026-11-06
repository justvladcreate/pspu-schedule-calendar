import pytest

from parser.core.finalize import (
    get_pair_number,
    normalize_teachers,
    stamp_updated_at,
    transform_schedule,
)


def _event(**over):
    event = {
        "event_id": "12_1237_ВТ_3_1",
        "group": "1237",
        "weekday": "ВТ",
        "pair_number": 3,
        "discipline": "Операционные системы",
        "type": "лек.",
        "subgroup": "",
        "time_start": "11:30",
        "time_end": "13:00",
        "teachers": ["Щипицын В.Д."],
        "dates": ["15.09.2026", "22.09.2026"],
        "rooms": "IV к. А111",
        "comment": "",
        "color": "",
        "is_past": False,
        "position": 1,
        "updated_at": "",
    }
    event.update(over)
    return event


def test_stamp_updated_at_keeps_unchanged():
    previous = [_event(updated_at="2026-11-01T10:00:00+00:00")]
    fresh = [_event()]

    stamp_updated_at(
        fresh, previous,
        now_iso="2026-11-06T16:00:00+00:00",
        fallback_iso="2026-10-01T00:00:00+00:00",
    )

    assert fresh[0]["updated_at"] == "2026-11-01T10:00:00+00:00"


def test_stamp_updated_at_updates_changed_and_new():
    previous = [
        _event(updated_at="2026-11-01T10:00:00+00:00"),
        _event(event_id="12_1237_ВТ_4_1", pair_number=4, updated_at="2026-11-02T10:00:00+00:00"),
    ]
    fresh = [
        _event(rooms="IV к. А112"),  # изменено
        _event(event_id="12_1237_ВТ_5_1", pair_number=5, time_start="15:15"),  # новое
    ]

    stamp_updated_at(
        fresh, previous,
        now_iso="2026-11-06T16:00:00+00:00",
        fallback_iso="2026-10-01T00:00:00+00:00",
    )

    assert fresh[0]["updated_at"] == "2026-11-06T16:00:00+00:00"
    assert fresh[1]["updated_at"] == "2026-11-06T16:00:00+00:00"


def test_stamp_updated_at_migration_uses_fallback():
    previous = [_event()]  # без updated_at
    fresh = [_event()]

    stamp_updated_at(
        fresh, previous,
        now_iso="2026-11-06T16:00:00+00:00",
        fallback_iso="2026-11-05T12:00:00+00:00",
    )

    assert fresh[0]["updated_at"] == "2026-11-05T12:00:00+00:00"


@pytest.mark.parametrize(
    ("time_str", "expected"),
    [
        ("08:00", 1),
        ("09:45", 2),
        ("11:30", 3),
        ("13:30", 4),
        ("15:15", 5),
        ("17:00", 6),
        ("21:44", 8),
        ("22:00", None),
        ("bad", None),
    ],
)
def test_get_pair_number(time_str, expected):
    assert get_pair_number(time_str) == expected


@pytest.mark.asyncio
async def test_normalize_teachers():
    assert await normalize_teachers("доц. Зорин А.А., преп. Карсукова Н.К.") == [
        "Зорин А.А.",
        "Карсукова Н.К.",
    ]
    assert await normalize_teachers("") == []


@pytest.mark.asyncio
async def test_transform_schedule_positions_and_years():
    raw = {
        "1252": {
            "semester_start_year": 2026,
            "events": [
                {
                    "weekday": "ПН",
                    "time_start": "13:30",
                    "discipline": "A",
                    "dates": "08.09",
                    "teachers": "доц. Зорин А.А.",
                    "rooms": "IV к. А101",
                },
                {
                    "weekday": "ПН",
                    "time_start": "13:30",
                    "discipline": "B",
                    "dates": "14.01",
                    "teachers": "",
                    "rooms": "IV к. А102",
                },
                {
                    "weekday": "",
                    "time_start": "13:30",
                    "discipline": "ignored",
                    "dates": "08.09",
                },
            ],
        }
    }

    result = await transform_schedule(raw)
    events = result["events"]
    assert [e["position"] for e in events] == [1, 2]
    assert [e["event_id"] for e in events] == ["1252_ПН_4_1", "1252_ПН_4_2"]
    assert events[0]["dates"] == ["08.09.2026"]
    assert events[1]["dates"] == ["14.01.2027"]
    assert events[0]["teachers"] == ["Зорин А.А."]
    assert result["generated_at"]
