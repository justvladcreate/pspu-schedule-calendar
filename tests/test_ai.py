import asyncio

import parser.core.ai as ai_module
from parser.faculties.f12_inec.prompt import USER_PROMPT


def test_prompt_has_input_placeholder():
    rendered = USER_PROMPT.format(data="[1] Физическая культура")
    assert "[1] Физическая культура" in rendered
    assert "[<enumerator>]" in rendered


def test_ask_ai_splits_response(monkeypatch):
    async def fake_generate(prompt, model, response_schema=None):
        assert prompt == "prompt"
        assert model
        return "[1];-;-;-;-;A;лек.;-;Y;-\n[1];-;-;-;-;B;прак.;-;Y;-"

    monkeypatch.setattr(ai_module, "_generate", fake_generate)
    lines = asyncio.run(ai_module.ask_ai("prompt"))
    assert lines == [
        "[1];-;-;-;-;A;лек.;-;Y;-",
        "[1];-;-;-;-;B;прак.;-;Y;-",
    ]


def test_ask_ai_falls_back_to_next_model(monkeypatch):
    calls = []

    async def fake_generate(prompt, model, response_schema=None):
        calls.append(model)
        if model == "blocked":
            raise RuntimeError("HTTP 400: User location is not supported")
        return "OK"

    monkeypatch.setattr(ai_module, "_generate", fake_generate)
    monkeypatch.setenv("GEMINI_MODEL", "blocked,working")

    assert asyncio.run(ai_module.ask_ai("prompt")) == ["OK"]
    assert calls == ["blocked", "working"]


def test_ask_ai_fallback_raises_last_error(monkeypatch):
    async def fake_generate(prompt, model, response_schema=None):
        raise RuntimeError(f"HTTP 503 for {model}")

    monkeypatch.setattr(ai_module, "_generate", fake_generate)
    monkeypatch.setenv("GEMINI_MODEL", "first,second")

    try:
        asyncio.run(ai_module.ask_ai("prompt"))
    except RuntimeError as exc:
        assert "second" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_model_list_strips_spaces(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", " a , b ,, c ")
    assert ai_module._model_list(None) == ["a", "b", "c"]
    assert ai_module._model_list("explicit") == ["explicit"]


def test_strip_code_fence():
    assert ai_module._strip_code_fence("```\n[1];A\n```") == "[1];A"
    assert ai_module._strip_code_fence("```text\n[1];A\n```") == "[1];A"
    assert ai_module._strip_code_fence("[1];A") == "[1];A"


def test_ask_ai_requires_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_AI_STUDIO_API_KEY", raising=False)
    try:
        ai_module._api_key()
    except RuntimeError as exc:
        assert "GEMINI_API_KEY" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")
