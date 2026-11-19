"""Бенчмарк LLM на реальном промпте одной группы.

Сколько времени, сколько токенов и сколько событий получилось.
Нужен, чтобы выбирать модель по деньгам, а не на глаз.

Запуск (из корня проекта):

    .venv/bin/python -m utils.ai_bench --group 1211 --model deepseek-flash
    .venv/bin/python -m utils.ai_bench --group 1211 --model deepseek-flash --effort low
    .venv/bin/python -m utils.ai_bench --group 1211 --model deepseek-v4-pro

Ключ и адрес берутся из ``AI_API_KEY`` / ``AI_API_BASE``
(``private/.env`` подхватывается через config). Модель можно передать
списком: ``--model a,b``.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time

import httpx

# Бенчмарк не должен попадать в статистику парсера как обычный прогон.
os.environ.setdefault("USAGE_SOURCE", "bench")

from parser.core.ai import _client_kwargs, _openai_key
from parser.faculties.base import paths_for
from parser.faculties.f12_inec.ai_merge import (
    F12_AI_SCHEMA,
    JSON_OUTPUT_SUFFIX,
    events_to_lines,
    format_ai_input,
)
from parser.faculties.f12_inec.prompt import USER_PROMPT

# Ориентировочные цены, USD за 1M токенов (вход, выход). Меняются —
# сверяйтесь с прайсом провайдера, здесь только для оценки.
PRICES = {
    "deepseek-flash": (0.10, 0.40),
    "deepseek-v4-pro": (0.30, 1.20),
}


def build_prompt(group: str) -> tuple[str, int]:
    paths = paths_for("12")
    data = json.loads(
        paths.latest_file("extracted.json").read_text(encoding="utf-8")
    )
    sources = (data.get(group) or {}).get("events") or []
    if not sources:
        raise SystemExit(f"в extracted.json нет ячейки для группы {group}")
    prompt = USER_PROMPT.format(data=format_ai_input(sources)) + JSON_OUTPUT_SUFFIX
    return prompt, len(sources)


async def run_one(
    model: str,
    prompt: str,
    effort: str | None,
    thinking: str | None,
    max_tokens: int = 8192,
) -> dict:
    base = (os.environ.get("AI_API_BASE") or "https://api.deepseek.com").rstrip("/")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    if effort:
        payload["reasoning_effort"] = effort
    if thinking:
        payload["thinking"] = {"type": thinking}

    started = time.monotonic()
    wall_started = time.time()
    async with httpx.AsyncClient(**_client_kwargs()) as client:
        response = await client.post(
            f"{base}/chat/completions",
            json=payload,
            headers={
                "Authorization": f"Bearer {_openai_key()}",
                "Content-Type": "application/json",
            },
        )
    elapsed = time.monotonic() - started
    wall_elapsed = time.time() - wall_started

    if response.status_code >= 400:
        return {
            "model": model,
            "effort": effort,
            "ok": False,
            "ms": elapsed,
            "error": f"HTTP {response.status_code}: {response.text[:200]}",
        }

    data = response.json()
    choice = (data.get("choices") or [{}])[0]
    content = ((choice.get("message") or {}).get("content") or "").strip()
    usage = data.get("usage") or {}

    events = 0
    parsed = None
    try:
        parsed = json.loads(content)
        events = len(events_to_lines(parsed))
    except json.JSONDecodeError:
        pass

    return {
        "model": model,
        "effort": effort,
        "ok": True,
        "ms": elapsed,
        "wall": wall_elapsed,
        "api_id": data.get("id"),
        "api_model": data.get("model"),
        "finish": choice.get("finish_reason"),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get(
            "reasoning_tokens"
        ),
        "cached_tokens": usage.get("prompt_cache_hit_tokens"),
        "events": events,
        "json_chars": len(content),
        "parsed": parsed,
    }


def money(model: str, prompt_tokens: int, completion_tokens: int) -> str:
    price = PRICES.get(model)
    if not price:
        return "?"
    cost = prompt_tokens / 1e6 * price[0] + completion_tokens / 1e6 * price[1]
    return f"${cost:.4f}"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--group", default="1211")
    parser.add_argument("--model", required=True, help="модель или список через запятую")
    parser.add_argument("--effort", default=None, help="low/high/max, если поддерживается")
    parser.add_argument(
        "--thinking",
        default=None,
        choices=["enabled", "disabled"],
        help="DeepSeek: thinking:{type:...}",
    )
    parser.add_argument("--max-tokens", type=int, default=8192)
    parser.add_argument("--dump", type=int, default=0, help="показать N событий")
    args = parser.parse_args()

    prompt, cells = build_prompt(args.group)
    print(f"группа {args.group}: ячеек {cells}, промпт {len(prompt)} символов")
    print()

    for model in [m.strip() for m in args.model.split(",") if m.strip()]:
        result = await run_one(model, prompt, args.effort, args.thinking)
        if not result["ok"]:
            print(f"{model}: FAIL {result['error']} ({result['ms']:.0f} мс)")
            continue
        cost = money(
            model,
            result["prompt_tokens"] or 0,
            result["completion_tokens"] or 0,
        )
        print(
            f"{model} (effort={result['effort']}): "
            f"{result['ms']:.0f} мс (wall {result['wall']:.1f} с), "
            f"id={result['api_id']}, api_model={result['api_model']}, "
            f"вход {result['prompt_tokens']} (кэш {result['cached_tokens']}), "
            f"выход {result['completion_tokens']} "
            f"(из них размышления {result['reasoning_tokens']}), "
            f"событий {result['events']}/{cells}, "
            f"finish={result['finish']}, ~{cost}"
        )
        if args.dump and result.get("parsed"):
            for event in (result["parsed"].get("events") or [])[: args.dump]:
                print("   ", json.dumps(event, ensure_ascii=False)[:180])


if __name__ == "__main__":
    asyncio.run(main())
