"""Клиент LLM (Google AI Studio / Gemini). Общий для всех факультетов.

Настройки берутся из окружения (``private/.env`` подхватывает config.py):

    GEMINI_API_KEY   — ключ Google AI Studio (обязателен)
    GEMINI_MODEL     — модель, по умолчанию ``gemini-2.5-flash``
    GEMINI_API_BASE  — базовый URL, по умолчанию generativelanguage.googleapis.com
    HTTPS_PROXY / ALL_PROXY — прокси для запросов к Google (необязательно)

Прокси читаем явно, чтобы одинаково работали HTTP(S) и SOCKS5
(для SOCKS нужен пакет ``httpx[socks]``).
"""
from __future__ import annotations

import os
import re

import httpx

DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_API_BASE = "https://generativelanguage.googleapis.com"
DEFAULT_TIMEOUT = 120.0


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


async def _generate(prompt: str, model: str) -> str:
    """Один запрос к Gemini. Возвращает текст ответа."""
    api_base = _env("GEMINI_API_BASE") or DEFAULT_API_BASE
    url = f"{api_base.rstrip('/')}/v1beta/models/{model}:generateContent"

    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": prompt}]},
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192,
        },
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
    chunks: list[str] = []
    for candidate in data.get("candidates", []):
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
    chosen_model = (model or _env("GEMINI_MODEL") or DEFAULT_MODEL).strip()
    content = await _generate(prompt, chosen_model)
    return content.split("\n")
