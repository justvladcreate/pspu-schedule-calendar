import asyncio

import pytest

import parser.faculties.f12_inec.ai_merge as ai_merge_module
from parser.faculties.f12_inec.ai_merge import (
    add_90_minutes,
    assign_rooms,
    chunk_hash,
    events_to_lines,
    format_ai_input,
    merge_ai_line,
    _get_event_color,
)
from parser.runner import events_equal
from parser.faculties.f12_inec.rooms_hints import parse_rooms_with_hints


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


def test_merge_ai_line_recovers_extra_empty_field():
    """Модель добавила лишнее поле — строка не должна теряться."""
    source = _source()
    line = "[1];-;-;-;07.09.2026;Математика;-;-;-;Иванов И.И.;-"
    items = merge_ai_line(line, 0, [source])
    assert len(items) == 1
    assert items[0]["discipline"] == "Математика"
    assert items[0]["teachers"] == "Иванов И.И."
    assert items[0]["rooms"] == ""


def test_merge_ai_line_recovers_extra_field_without_teacher():
    source = _source()
    line = "[1];-;-;-;-;Физическая культура;-;-;-;-;-"
    items = merge_ai_line(line, 0, [source])
    assert len(items) == 1
    assert items[0]["discipline"] == "Физическая культура"


def test_events_to_lines_from_json():
    payload = {
        "events": [{
            "enumerator": 1,
            "day_of_week": "",
            "time_start": "",
            "time_end": "",
            "dates": "07.09.2026",
            "discipline": "Математика",
            "type": "",
            "subgroup": "",
            "teachers": "",
            "rooms": "",
        }],
    }
    assert events_to_lines(payload) == [
        "[1];-;-;-;07.09.2026;Математика;-;-;-;-",
    ]


def test_events_to_lines_replaces_semicolons():
    payload = {
        "events": [{
            "enumerator": 2,
            "discipline": "A;B",
        }],
    }
    assert events_to_lines(payload)[0].split(";")[5] == "A,B"


def test_ask_ai_with_retry_uses_structured_output(monkeypatch):
    async def fake_json(prompt, schema):
        assert "events" in schema["properties"]
        return {"events": [{"enumerator": 1, "discipline": "Математика"}]}

    monkeypatch.setattr(ai_merge_module, "ask_ai_json", fake_json)
    lines = asyncio.run(ai_merge_module.ask_ai_with_retry("prompt"))
    assert lines == ["[1];-;-;-;-;Математика;-;-;-;-"]


def test_ask_ai_with_retry_falls_back_to_text(monkeypatch):
    async def fake_json(prompt, schema):
        raise RuntimeError("no json")

    async def fake_text(prompt, model=None):
        return ["[1];-;-;-;-;Математика;-;-;-;-"]

    monkeypatch.setattr(ai_merge_module, "ask_ai_json", fake_json)
    monkeypatch.setattr(ai_merge_module, "ask_ai", fake_text)
    lines = asyncio.run(ai_merge_module.ask_ai_with_retry("prompt", max_attempts=1))
    assert lines == ["[1];-;-;-;-;Математика;-;-;-;-"]


def test_grey_text_keeps_grey_color():
    """Серый текст снова красит событие, но помечает его прошедшим."""
    source = _source(text_colors=[{"text": "07.09.2026", "color": "#cccccc"}])
    line = "[1];ПН;13:30;15:00;07.09.2026;Математика;лек.;;Иванов И.И.;"
    items = merge_ai_line(line, 0, [source])
    assert items[0]["is_past"] is True
    assert items[0]["color"] == "#cccccc"


def test_color_does_not_leak_between_disciplines_in_one_cell():
    """Серый цвет одной строки не красит соседний предмет с той же датой."""
    colors = [{
        "text": "25.09 Методы проектной и исследовательской деятельности "
                "(лек.) доц. П.",
        "color": "#cccccc",
    }]

    assert _get_event_color(
        colors,
        "25.09, 02.10",
        "Возрастная и педагогическая психология практикумом",
    ) is None

    assert _get_event_color(
        colors,
        "25.09",
        "Методы проектной и исследовательской деятельности",
    ) == "#cccccc"


def test_color_matches_reworded_discipline():
    colors = [{
        "text": "25.09 - 20.11 Возрастная и педагогическая психология "
                "с практикумом доц. Баландина Л.Л.",
        "color": "#cccccc",
    }]
    assert _get_event_color(
        colors,
        "25.09, 02.10, 20.11",
        "Возрастная и педагогическая психология практикумом",
    ) == "#cccccc"


def test_merge_ai_line_date_in_rooms_falls_back_to_hints():
    """Если LLM положила дату в аудитории — берём детерминированный разбор."""
    source = _source(
        room_raw="IV к. А305\n11.11, 18.11 - дистанционно\\ \nОНЛАЙН",
    )
    line = (
        "[1];СР;11:30;13:00;07.10, 11.11, 18.11;Спецпрактикум;лек.прак.;;"
        "Худорожков Л.Ю.;IV к. А305, 11.11, ОНЛАЙН"
    )
    items = merge_ai_line(line, 0, [source])
    rooms = {item["dates"]: item["rooms"] for item in items}
    assert rooms["07.10"] == "IV к. А305"
    assert rooms["11.11, 18.11"] == "дистанционно онлайн"


def test_finalize_rooms_restores_online_link():
    from parser.faculties.f12_inec.ai_merge import finalize_rooms

    src = {"rooms": "IV к. А305, [дистанционно онлайн](https://example.com/call)"}
    assert finalize_rooms("IV к. А305, 11.11, ОНЛАЙН", src) == (
        "IV к. А305, [дистанционно онлайн](https://example.com/call)"
    )


def test_events_equal_ignores_order():
    a = [{"event_id": "1", "group": "A", "weekday": "ПН", "pair_number": 1}]
    b = [{"event_id": "1", "group": "A", "weekday": "ПН", "pair_number": 1}]
    assert events_equal(a, b)
    assert not events_equal(a, [])
