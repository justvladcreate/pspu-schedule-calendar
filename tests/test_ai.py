import asyncio
import json

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


def test_model_list_prefers_ai_model(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
    monkeypatch.setenv("AI_MODEL", "google/gemini-2.5-flash")
    assert ai_module._model_list(None) == ["google/gemini-2.5-flash"]


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text or json.dumps(self._payload)

    def json(self):
        return self._payload


def _patch_client(monkeypatch, responses):
    captured = []

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None, headers=None):
            captured.append({"url": url, "json": dict(json) if json else json,
                             "headers": headers})
            return responses.pop(0)

    monkeypatch.setattr(ai_module.httpx, "AsyncClient", FakeClient)
    return captured


def test_openai_provider_uses_vega_by_default(monkeypatch):
    payload = {
        "choices": [
            {"finish_reason": "stop", "message": {"content": '{"events": []}'}},
        ]
    }
    captured = _patch_client(monkeypatch, [_FakeResponse(200, payload)])
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_API_KEY", "vega_test")
    monkeypatch.setenv("AI_MIN_INTERVAL", "0")

    result = asyncio.run(
        ai_module.ask_ai_json("prompt", {"type": "OBJECT"},
                              model="google/gemini-2.5-flash")
    )

    assert result == {"events": []}
    request = captured[0]
    assert request["url"] == "https://api.vega.chat/api/v1/chat/completions"
    assert request["headers"]["Authorization"] == "Bearer vega_test"
    assert request["json"]["model"] == "google/gemini-2.5-flash"
    assert request["json"]["response_format"] == {"type": "json_object"}


def test_openai_provider_respects_custom_base(monkeypatch):
    payload = {
        "choices": [{"finish_reason": "stop", "message": {"content": "OK"}}],
    }
    captured = _patch_client(monkeypatch, [_FakeResponse(200, payload)])
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_API_KEY", "vega_test")
    monkeypatch.setenv("AI_API_BASE", "https://example.test/api/v1")
    monkeypatch.setenv("AI_MIN_INTERVAL", "0")

    assert asyncio.run(ai_module.ask_ai("prompt", model="m")) == ["OK"]
    assert captured[0]["url"] == "https://example.test/api/v1/chat/completions"


def test_openai_provider_truncated_answer_raises(monkeypatch):
    payload = {"choices": [{"finish_reason": "length", "message": {"content": "x"}}]}
    _patch_client(monkeypatch, [_FakeResponse(200, payload)])
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_API_KEY", "vega_test")
    monkeypatch.setenv("AI_MIN_INTERVAL", "0")

    try:
        asyncio.run(ai_module.ask_ai("prompt", model="m"))
    except RuntimeError as exc:
        assert "не завершён" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_openai_default_max_tokens(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.delenv("AI_MAX_TOKENS", raising=False)
    assert ai_module._max_output_tokens() == ai_module.DEFAULT_OPENAI_MAX_TOKENS

    monkeypatch.setenv("AI_MAX_TOKENS", "4096")
    assert ai_module._max_output_tokens() == 4096


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
