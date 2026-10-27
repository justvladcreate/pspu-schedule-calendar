import pytest

from parser.finalize import (
    get_pair_number,
    normalize_teachers,
    transform_schedule,
)


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
