"""Клиент LLM (Gemini или Groq). Общий для всех факультетов.

Провайдер выбирается ``AI_PROVIDER`` (``gemini`` по умолчанию, либо
``groq``). Настройки берутся из окружения (``private/.env`` подхватывает
config.py):

    AI_PROVIDER      — gemini | groq
    AI_MODEL         — модель или список моделей через запятую
                       (``gemma-4-31b-it,gemini-3-flash-preview``);
                       перебираются по порядку, пока какая-нибудь не ответит
    AI_MIN_INTERVAL  — минимальная пауза между запросами, секунды

    GEMINI_API_KEY   — ключ Google AI Studio (для AI_PROVIDER=gemini)
    GEMINI_API_BASE  — базовый URL, по умолчанию generativelanguage.googleapis.com
    GEMINI_MODEL     — старое имя AI_MODEL (поддерживается для совместимости)

    GROQ_API_KEY     — ключ console.groq.com (для AI_PROVIDER=groq)
    GROQ_API_BASE    — по умолчанию https://api.groq.com/openai/v1

Прокси читаем явно, чтобы одинаково работали HTTP(S) и SOCKS5
(для SOCKS нужен пакет ``httpx[socks]``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

DEFAULT_PROVIDER = "gemini"
DEFAULT_MODEL = "gemini-3.1-flash-lite"
DEFAULT_GROQ_MODEL = "gemma-4-31b-it"
DEFAULT_API_BASE = "https://generativelanguage.googleapis.com"
DEFAULT_GROQ_BASE = "https://api.groq.com/openai/v1"
DEFAULT_TIMEOUT = 120.0
MAX_OUTPUT_TOKENS = 32768
DEFAULT_GROQ_MAX_TOKENS = 8192
# Бесплатный тариф Gemini — 20 запросов в минуту. 4.5с даёт ~13 RPM
# и оставляет запас на повторные попытки. У Groq лимиты мягче.
DEFAULT_MIN_INTERVAL = 4.5
DEFAULT_GROQ_MIN_INTERVAL = 2.0

_last_call = 0.0


def _env(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _provider() -> str:
    return (_env("AI_PROVIDER") or DEFAULT_PROVIDER).strip().lower()


def _api_key() -> str:
    key = _env("GEMINI_API_KEY", "GOOGLE_AI_STUDIO_API_KEY")
    if not key:
        raise RuntimeError(
            "Не задан GEMINI_API_KEY — добавьте ключ Google AI Studio в private/.env"
        )
    return key


def _groq_api_key() -> str:
    key = _env("GROQ_API_KEY")
    if not key:
        raise RuntimeError(
            "Не задан GROQ_API_KEY — добавьте ключ console.groq.com в private/.env"
        )
    return key


def _max_output_tokens() -> int:
    raw = _env("AI_MAX_TOKENS")
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    if _provider() == "groq":
        return DEFAULT_GROQ_MAX_TOKENS
    return MAX_OUTPUT_TOKENS


def _proxy_url() -> str:
    return _env("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")


def _strip_code_fence(text: str) -> str:
    value = str(text or "").strip()
    value = re.sub(r"^```[a-zA-Z0-9_-]*\s*\n?", "", value)
    value = re.sub(r"\n?```\s*$", "", value)
    return value.strip()


async def _throttle() -> None:
    """Держит бесплатную квоту провайдера.

    Интервал задаётся ``AI_MIN_INTERVAL`` (или ``GEMINI_MIN_INTERVAL``).
    ``0`` отключает троттлинг, например если у вас платный тариф.
    """
    global _last_call
    default = (
        DEFAULT_GROQ_MIN_INTERVAL if _provider() == "groq" else DEFAULT_MIN_INTERVAL
    )
    raw = _env("AI_MIN_INTERVAL", "GEMINI_MIN_INTERVAL")
    try:
        interval = float(raw) if raw else default
    except ValueError:
        interval = default
    if interval <= 0:
        return

    loop = asyncio.get_running_loop()
    wait = _last_call + interval - loop.time()
    if wait > 0:
        await asyncio.sleep(wait)
    _last_call = loop.time()


def _client_kwargs() -> dict:
    kwargs: dict = {"timeout": DEFAULT_TIMEOUT}
    proxy = _proxy_url()
    if proxy:
        kwargs["proxy"] = proxy
    return kwargs


async def _generate_gemini(
    prompt: str,
    model: str,
    response_schema: dict | None = None,
) -> str:
    """Один запрос к Gemini. Возвращает текст ответа."""
    api_base = _env("GEMINI_API_BASE") or DEFAULT_API_BASE
    url = f"{api_base.rstrip('/')}/v1beta/models/{model}:generateContent"

    generation_config: dict = {
        "temperature": 0.1,
        "maxOutputTokens": _max_output_tokens(),
    }
    if response_schema:
        generation_config["responseMimeType"] = "application/json"
        generation_config["responseSchema"] = response_schema

    # Gemini 2.5/3 по умолчанию «думает», и размышления съедают
    # maxOutputTokens: ответ приходит обрезанным (MAX_TOKENS).
    # Для разбора расписания размышления не нужны.
    budget = _env("GEMINI_THINKING_BUDGET")
    if budget:
        try:
            generation_config["thinkingConfig"] = {"thinkingBudget": int(budget)}
        except ValueError:
            pass

    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": prompt}]},
        ],
        "generationConfig": generation_config,
    }

    headers = {
        "x-goog-api-key": _api_key(),
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(**_client_kwargs()) as client:
        response = await client.post(url, json=payload, headers=headers)

    if response.status_code >= 400:
        # Тело может содержать полезную причину (квота, неверный ключ).
        raise RuntimeError(
            f"Gemini API HTTP {response.status_code}: {response.text[:400]}"
        )

    data = response.json()

    feedback = data.get("promptFeedback") or {}
    if feedback.get("blockReason"):
        raise RuntimeError(
            f"Gemini API: запрос заблокирован ({feedback['blockReason']})"
        )

    chunks: list[str] = []
    for candidate in data.get("candidates", []):
        finish = candidate.get("finishReason")
        if finish and finish != "STOP":
            # MAX_TOKENS и т.п. — ответ обрезан, лучше повторить,
            # чем вернуть половину расписания.
            raise RuntimeError(f"Gemini API: ответ не завершён ({finish})")

        content = candidate.get("content") or {}
        for part in content.get("parts", []):
            if part.get("thought"):
                continue
            text = part.get("text")
            if text:
                chunks.append(text)

    content = "".join(chunks).strip()
    if not content:
        raise RuntimeError(f"Gemini API: пустой ответ: {str(data)[:400]}")

    return _strip_code_fence(content)


async def _generate_groq(
    prompt: str,
    model: str,
    response_schema: dict | None = None,
) -> str:
    """Один запрос к Groq (OpenAI-совместимый API)."""
    api_base = _env("GROQ_API_BASE") or DEFAULT_GROQ_BASE
    url = f"{api_base.rstrip('/')}/chat/completions"

    payload: dict = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": _max_output_tokens(),
    }
    if response_schema:
        # Не все модели Groq умеют json_object; если откажет — повторяем
        # без него, формат JSON уже описан в промпте.
        payload["response_format"] = {"type": "json_object"}

    headers = {
        "Authorization": f"Bearer {_groq_api_key()}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(**_client_kwargs()) as client:
        response = await client.post(url, json=payload, headers=headers)
        if (
            response.status_code == 400
            and response_schema
            and "response_format" in response.text
        ):
            payload.pop("response_format", None)
            response = await client.post(url, json=payload, headers=headers)

    if response.status_code >= 400:
        raise RuntimeError(
            f"Groq API HTTP {response.status_code}: {response.text[:400]}"
        )

    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"Groq API: пустой ответ: {str(data)[:400]}")

    choice = choices[0]
    finish = choice.get("finish_reason")
    if finish == "length":
        raise RuntimeError("Groq API: ответ не завершён (length)")

    content = ((choice.get("message") or {}).get("content") or "").strip()
    if not content:
        raise RuntimeError(f"Groq API: пустой ответ: {str(data)[:400]}")

    return _strip_code_fence(content)


async def _generate(prompt: str, model: str, response_schema: dict | None = None) -> str:
    """Один запрос к выбранному провайдеру."""
    await _throttle()
    if _provider() == "groq":
        return await _generate_groq(prompt, model, response_schema)
    return await _generate_gemini(prompt, model, response_schema)


async def ask_ai(prompt: str = "", model: str | None = None) -> list[str]:
    """Отправляет промпт в LLM и возвращает ответ по строкам."""
    content = await _generate_any(prompt, model)
    return content.split("\n")


async def ask_ai_json(
    prompt: str,
    schema: dict,
    model: str | None = None,
) -> dict:
    """Запрос со structured output: модель возвращает JSON по схеме."""
    content = await _generate_any(prompt, model, response_schema=schema)
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"LLM: ответ не является JSON: {content[:300]}"
        ) from exc


def _model_list(model: str | None) -> list[str]:
    """Модели по порядку: явная, либо список из AI_MODEL через запятую.

    Провайдеры периодически отвечают 503/429 на конкретную модель,
    а соседняя в это время работает, поэтому модели перебираются
    по очереди, пока какая-нибудь не ответит.
    """
    if model:
        return [model.strip()]

    fallback = DEFAULT_GROQ_MODEL if _provider() == "groq" else DEFAULT_MODEL
    raw = _env("AI_MODEL", "GEMINI_MODEL") or fallback
    models = [part.strip() for part in raw.split(",") if part.strip()]
    return models or [fallback]


async def _generate_any(
    prompt: str,
    model: str | None = None,
    response_schema: dict | None = None,
) -> str:
    models = _model_list(model)
    last_error: Exception | None = None

    for name in models:
        try:
            return await _generate(prompt, name, response_schema)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if len(models) > 1:
                logger.warning("LLM: модель %s не ответила: %s", name, exc)

    assert last_error is not None
    raise last_error
