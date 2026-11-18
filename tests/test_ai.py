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


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text or json.dumps(self._payload)

    def json(self):
        return self._payload


class _FakeClient:
    """Подменяет httpx.AsyncClient: копит запросы и отдаёт готовые ответы."""

    def __init__(self, responses, captured, **kwargs):
        self._responses = list(responses)
        self._captured = captured

    def __call__(self, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None):
        self._captured.append(
            {"url": url, "json": dict(json) if json else json, "headers": headers}
        )
        return self._responses.pop(0)


def _patch_client(monkeypatch, responses):
    captured = []

    def factory(**kwargs):
        return _FakeClient(responses, captured, **kwargs)

    monkeypatch.setattr(ai_module.httpx, "AsyncClient", factory)
    return captured


def test_groq_request_uses_json_mode_and_bearer(monkeypatch):
    payload = {
        "choices": [
            {"finish_reason": "stop", "message": {"content": '{"events": []}'}},
        ]
    }
    captured = _patch_client(monkeypatch, [_FakeResponse(200, payload)])
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    monkeypatch.setenv("AI_MIN_INTERVAL", "0")

    result = asyncio.run(
        ai_module.ask_ai_json("prompt", {"type": "OBJECT"}, model="gemma-4-31b-it")
    )

    assert result == {"events": []}
    request = captured[0]
    assert request["url"] == "https://api.groq.com/openai/v1/chat/completions"
    assert request["headers"]["Authorization"] == "Bearer gsk-test"
    assert request["json"]["model"] == "gemma-4-31b-it"
    assert request["json"]["response_format"] == {"type": "json_object"}


def test_groq_retries_without_json_mode(monkeypatch):
    error = _FakeResponse(
        400, text='{"error": "response_format is not supported by this model"}'
    )
    ok = _FakeResponse(
        200,
        {
            "choices": [
                {"finish_reason": "stop", "message": {"content": '{"events": []}'}},
            ]
        },
    )
    captured = _patch_client(monkeypatch, [error, ok])
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    monkeypatch.setenv("AI_MIN_INTERVAL", "0")

    result = asyncio.run(
        ai_module.ask_ai_json("prompt", {"type": "OBJECT"}, model="some-model")
    )

    assert result == {"events": []}
    assert "response_format" in captured[0]["json"]
    assert "response_format" not in captured[1]["json"]


def test_groq_truncated_answer_raises(monkeypatch):
    payload = {
        "choices": [{"finish_reason": "length", "message": {"content": "half"}}]
    }
    _patch_client(monkeypatch, [_FakeResponse(200, payload)])
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    monkeypatch.setenv("AI_MIN_INTERVAL", "0")

    try:
        asyncio.run(ai_module.ask_ai("prompt", model="some-model"))
    except RuntimeError as exc:
        assert "не завершён" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_groq_model_list_defaults_to_gemma(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.delenv("AI_MODEL", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    assert ai_module._model_list(None) == ["gemma-4-31b-it"]


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
