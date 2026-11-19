"""Цвета: tint, серый и сопоставление фрагмента с занятием."""
from parser.core.colors import apply_tint, ensure_readable, is_grey, match_color


def test_tint_turns_black_grey():
    assert apply_tint("#000000", 0.5) == "#808080"


def test_tint_darkens_white():
    assert apply_tint("#ffffff", -0.5) == "#808080"


def test_tint_zero_keeps_color():
    assert apply_tint("#ff0000", 0) == "#ff0000"


def test_grey_detection():
    assert is_grey("#808080")
    assert is_grey("#cccccc")
    assert not is_grey("#ff0000")
    assert not is_grey("")


def test_match_color_by_dates():
    chunks = [
        {"text": "14.09-28.09 Русский язык и культура речи", "color": "#cccccc"},
        {"text": "05.10 Современная образовательная среда", "color": "#ff0000"},
    ]
    assert match_color(
        chunks, ["05.10.2026"], "Современная образовательная среда"
    ) == "#ff0000"


def test_match_color_by_words_when_no_dates():
    chunks = [{"text": "Геометрия (прак.) Павелкин В.Н.", "color": "#0000ff"}]
    assert match_color(chunks, [], "Геометрия") == "#0000ff"


def test_match_color_ignores_other_lines():
    chunks = [{"text": "Алгебра (лек.) Мельникова Е.В.", "color": "#00ff00"}]
    assert match_color(chunks, ["01.09.2026"], "Геометрия") is None


def test_match_color_without_chunks():
    assert match_color([], ["01.09.2026"], "Геометрия") is None
    assert match_color(None, ["01.09.2026"], "Геометрия") is None


def test_contrast_keeps_readable_pair():
    assert ensure_readable("#000000", "#ffffff") == "#000000"


def test_white_text_on_light_background_becomes_black():
    assert ensure_readable("#ffffff", "#dae3f3") == "#000000"


def test_dark_text_on_dark_background_becomes_white():
    assert ensure_readable("#222222", "#1f1f1f") == "#ffffff"


def test_no_background_keeps_color():
    assert ensure_readable("#ffffff", None) == "#ffffff"
