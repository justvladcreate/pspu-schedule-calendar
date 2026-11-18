"""Клиент LLM (Google AI Studio / Gemini). Общий для всех факультетов.

Настройки берутся из окружения (``private/.env`` подхватывает config.py):

    GEMINI_API_KEY   — ключ Google AI Studio (обязателен)
    GEMINI_MODEL     — модель или список моделей через запятую
                       (``gemini-3-flash-preview,gemini-3.8-flash``);
                       перебираются по порядку, пока какая-нибудь не ответит
    GEMINI_API_BASE  — базовый URL, по умолчанию generativelanguage.googleapis.com
    HTTPS_PROXY / ALL_PROXY — прокси для запросов к Google (необязательно)

Прокси читаем явно, чтобы одинаково работали HTTP(S) и SOCKS5
(для SOCKS нужен пакет ``httpx[socks]``).
"""
from __future__ import annotations

import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-3.1-flash-lite"
DEFAULT_API_BASE = "https://generativelanguage.googleapis.com"
DEFAULT_TIMEOUT = 120.0
MAX_OUTPUT_TOKENS = 16384


def _env(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _api_key() -> str:
    key = _env("GEMINI_API_KEY", "GOOGLE_AI_STUDIO_API_KEY")
    if not key:
        raise RuntimeError(
            "Не задан GEMINI_API_KEY — добавьте ключ Google AI Studio в private/.env"
        )
    return key


def _proxy_url() -> str:
    return _env("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")


def _strip_code_fence(text: str) -> str:
    value = str(text or "").strip()
    value = re.sub(r"^```[a-zA-Z0-9_-]*\s*\n?", "", value)
    value = re.sub(r"\n?```\s*$", "", value)
    return value.strip()


async def _generate(prompt: str, model: str, response_schema: dict | None = None) -> str:
    """Один запрос к Gemini. Возвращает текст ответа."""
    api_base = _env("GEMINI_API_BASE") or DEFAULT_API_BASE
    url = f"{api_base.rstrip('/')}/v1beta/models/{model}:generateContent"

    generation_config: dict = {
        "temperature": 0.1,
        "maxOutputTokens": MAX_OUTPUT_TOKENS,
    }
    if response_schema:
        generation_config["responseMimeType"] = "application/json"
        generation_config["responseSchema"] = response_schema

    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": prompt}]},
        ],
        "generationConfig": generation_config,
    }

    client_kwargs: dict = {"timeout": DEFAULT_TIMEOUT}
    proxy = _proxy_url()
    if proxy:
        client_kwargs["proxy"] = proxy

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
    """Модели по порядку: явная, либо список из GEMINI_MODEL через запятую.

    Google периодически отвечает 503/429/«location» на конкретную модель,
    а соседняя в это время работает, поэтому модели перебираются
    по очереди, пока какая-нибудь не ответит.
    """
    if model:
        return [model.strip()]

    raw = _env("GEMINI_MODEL") or DEFAULT_MODEL
    models = [part.strip() for part in raw.split(",") if part.strip()]
    return models or [DEFAULT_MODEL]


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
