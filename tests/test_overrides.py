import pytest

from parser.overrides import apply_overrides


def _event(**overrides):
    event = {
        "event_id": "1252_ПН_4_1",
        "group": "1252",
        "weekday": "ПН",
        "pair_number": 4,
        "time_start": "13:30",
        "time_end": "15:00",
        "discipline": "Старое название",
        "type": "лек.",
        "subgroup": "",
        "teachers": ["Иванов И.И."],
        "dates": ["07.09.2026"],
        "rooms": "IV к. А101",
        "comment": "",
    }
    event.update(overrides)
    return event


@pytest.mark.asyncio
async def test_no_rules_returns_same_list():
    events = [_event()]
    assert await apply_overrides(events, {}) == events


@pytest.mark.asyncio
async def test_drop_and_field_override():
    events = [
        _event(),
        _event(event_id="drop", discipline="Удалить"),
    ]
    rules = {
        "overrides": [
            {"match": {"discipline": "Удалить"}, "drop": True},
            {
                "match": {"discipline": "Старое название"},
                "discipline": "Новое название",
                "teachers": ["Петров П.П."],
            },
        ]
    }
    result = await apply_overrides(events, rules)
    assert len(result) == 1
    assert result[0]["discipline"] == "Новое название"
    assert result[0]["teachers"] == ["Петров П.П."]


@pytest.mark.asyncio
async def test_dates_and_fill_semester():
    events = [_event()]
    rules = {
        "semester": {"start": "07.09.2026", "end": "28.09.2026"},
        "overrides": [
            {"match": {"group": "1252"}, "dates": "07.09.2026"},
            {"match": {"group": "1252"}, "fill_semester": True},
        ],
    }
    result = await apply_overrides(events, rules)
    assert result[0]["dates"] == [
        "07.09.2026", "14.09.2026", "21.09.2026", "28.09.2026",
    ]


@pytest.mark.asyncio
async def test_negative_match():
    events = [_event(subgroup="п/г 1"), _event(event_id="2", subgroup="")]
    rules = {
        "overrides": [
            {
                "match": {"group": "1252", "not": {"subgroup": "п/г 1"}},
                "comment": "только без подгруппы",
            }
        ]
    }
    result = await apply_overrides(events, rules)
    assert result[0]["comment"] == ""
    assert result[1]["comment"] == "только без подгруппы"
