"""Клиент LLM. Общий для всех факультетов.

Провайдер выбирается ``AI_PROVIDER``:

    gemini  — Google AI Studio напрямую (по умолчанию)
    openai  — любой OpenAI-совместимый шлюз, по умолчанию API ВЕГА
              (https://api.vega.chat/api/v1), прокси к 800+ моделям,
              включая google/gemini-*

Настройки берутся из окружения (``private/.env`` подхватывает config.py):

    AI_PROVIDER      — gemini | openai
    AI_MODEL         — модель или список через запятую; перебираются
                       по порядку, пока какая-нибудь не ответит
                       (старое имя ``GEMINI_MODEL`` тоже поддерживается)
    AI_MIN_INTERVAL  — пауза между запросами, секунды (0 — не ждать)

    GEMINI_API_KEY   — ключ Google AI Studio
    GEMINI_API_BASE  — базовый URL, по умолчанию generativelanguage.googleapis.com

    AI_API_KEY       — ключ OpenAI-совместимого шлюза (ВЕГА)
    AI_API_BASE      — базовый URL, по умолчанию https://api.vega.chat/api/v1

    HTTPS_PROXY / ALL_PROXY — прокси (необязательно).
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
DEFAULT_API_BASE = "https://generativelanguage.googleapis.com"
DEFAULT_OPENAI_BASE = "https://api.vega.chat/api/v1"
DEFAULT_OPENAI_MODEL = "google/gemini-2.5-flash"
DEFAULT_TIMEOUT = 120.0
# NVIDIA NIM на большом промпте и длинном JSON отвечает дольше двух минут.
DEFAULT_OPENAI_TIMEOUT = 300.0
MAX_OUTPUT_TOKENS = 32768
# OpenAI-совместимые шлюзы (NVIDIA NIM, ВЕГА) не любят огромный max_tokens.
DEFAULT_OPENAI_MAX_TOKENS = 8192
# Бесплатный тариф Gemini — 20 запросов в минуту. 4.5с даёт ~13 RPM
# и оставляет запас на повторные попытки.
DEFAULT_MIN_INTERVAL = 4.5
DEFAULT_OPENAI_MIN_INTERVAL = 1.0

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


def _openai_key() -> str:
    key = _env("AI_API_KEY", "VEGA_API_KEY", "OPENAI_API_KEY")
    if not key:
        raise RuntimeError(
            "Не задан AI_API_KEY — добавьте ключ OpenAI-совместимого шлюза в private/.env"
        )
    return key


def _max_output_tokens() -> int:
    raw = _env("AI_MAX_TOKENS")
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    if _provider() == "openai":
        return DEFAULT_OPENAI_MAX_TOKENS
    return MAX_OUTPUT_TOKENS


def _proxy_url() -> str:
    return _env("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")


def _strip_code_fence(text: str) -> str:
    value = str(text or "").strip()
    value = re.sub(r"^```[a-zA-Z0-9_-]*\s*\n?", "", value)
    value = re.sub(r"\n?```\s*$", "", value)
    return value.strip()


async def _throttle() -> None:
    """Держит паузу между запросами (лимиты бесплатных тарифов).

    Интервал задаётся ``AI_MIN_INTERVAL`` (секунды) или ``GEMINI_MIN_INTERVAL``.
    ``0`` отключает троттлинг, например если у вас платный тариф.
    """
    global _last_call
    default = (
        DEFAULT_OPENAI_MIN_INTERVAL
        if _provider() == "openai"
        else DEFAULT_MIN_INTERVAL
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


def _use_proxy() -> bool:
    """Идти ли к провайдеру через HTTPS_PROXY/ALL_PROXY.

    По умолчанию Gemini — через прокси (иначе Google блокирует по IP),
    а OpenAI-совместимые шлюзы (NVIDIA, ВЕГА) — напрямую: лишний хоп
    через SOCKS заметно замедляет длинные ответы.
    """
    raw = _env("AI_USE_PROXY").lower()
    if raw:
        return raw not in ("0", "false", "no", "off")
    return _provider() != "openai"


def _client_kwargs() -> dict:
    default = (
        DEFAULT_OPENAI_TIMEOUT if _provider() == "openai" else DEFAULT_TIMEOUT
    )
    raw = _env("AI_TIMEOUT")
    try:
        timeout = float(raw) if raw else default
    except ValueError:
        timeout = default

    kwargs: dict = {"timeout": timeout}
    if _use_proxy():
        proxy = _proxy_url()
        if proxy:
            kwargs["proxy"] = proxy
    return kwargs


def _json_mode_unusable(text: str) -> bool:
    """Шлюз отказал именно из-за JSON-режима, а не из-за самого запроса."""
    markers = (
        "response_format",
        "json_validate_failed",
        "Failed to generate JSON",
        "does not support JSON",
    )
    return any(marker in text for marker in markers)


async def _generate_openai(
    prompt: str,
    model: str,
    response_schema: dict | None = None,
) -> str:
    """Запрос к OpenAI-совместимому шлюзу (NVIDIA NIM, API ВЕГА)."""
    api_base = _env("AI_API_BASE") or DEFAULT_OPENAI_BASE
    url = f"{api_base.rstrip('/')}/chat/completions"

    payload: dict = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": _max_output_tokens(),
    }
    if response_schema:
        payload["response_format"] = {"type": "json_object"}

    headers = {
        "Authorization": f"Bearer {_openai_key()}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(**_client_kwargs()) as client:
        response = await client.post(url, json=payload, headers=headers)
        if (
            response.status_code == 400
            and response_schema
            and _json_mode_unusable(response.text)
        ):
            # Модель не умеет json_object — формат JSON и так описан в промпте.
            payload.pop("response_format", None)
            response = await client.post(url, json=payload, headers=headers)

    if response.status_code >= 400:
        raise RuntimeError(
            f"LLM API HTTP {response.status_code}: {response.text[:400]}"
        )

    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"LLM API: пустой ответ: {str(data)[:400]}")

    choice = choices[0]
    if choice.get("finish_reason") == "length":
        raise RuntimeError("LLM API: ответ не завершён (length)")

    content = ((choice.get("message") or {}).get("content") or "").strip()
    if not content:
        raise RuntimeError(f"LLM API: пустой ответ: {str(data)[:400]}")

    return _strip_code_fence(content)


async def _generate(prompt: str, model: str, response_schema: dict | None = None) -> str:
    """Один запрос к выбранному провайдеру."""
    await _throttle()
    if _provider() == "openai":
        return await _generate_openai(prompt, model, response_schema)
    return await _generate_gemini(prompt, model, response_schema)


async def _generate_gemini(
    prompt: str,
    model: str,
    response_schema: dict | None = None,
) -> str:
    """Запрос к Google AI Studio напрямую."""
    api_base = _env("GEMINI_API_BASE") or DEFAULT_API_BASE
    url = f"{api_base.rstrip('/')}/v1beta/models/{model}:generateContent"

    generation_config: dict = {
        "temperature": 0.1,
        "maxOutputTokens": MAX_OUTPUT_TOKENS,
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

    client_kwargs: dict = _client_kwargs()

    headers = {
        "x-goog-api-key": _api_key(),
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(**client_kwargs) as client:
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


async def ask_ai(prompt: str = "", model: str | None = None) -> list[str]:
    """Отправляет промпт в Gemini и возвращает ответ по строкам."""
    content = await _generate_any(prompt, model)
    return content.split("\n")


async def ask_ai_json(
    prompt: str,
    schema: dict,
    model: str | None = None,
) -> dict:
    """Запрос со structured output: Gemini сам собирает JSON по схеме."""
    content = await _generate_any(prompt, model, response_schema=schema)
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Gemini API: ответ не является JSON: {content[:300]}"
        ) from exc


def _model_list(model: str | None) -> list[str]:
    """Модели по порядку: явная, либо список из AI_MODEL через запятую.

    Провайдеры периодически отвечают 503/429 на конкретную модель,
    а соседняя в это время работает, поэтому модели перебираются
    по очереди, пока какая-нибудь не ответит.
    """
    if model:
        return [model.strip()]

    fallback = (
        DEFAULT_OPENAI_MODEL if _provider() == "openai" else DEFAULT_MODEL
    )
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
                logger.warning("Gemini: модель %s не ответила: %s", name, exc)

    assert last_error is not None
    raise last_error
