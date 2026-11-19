"""Учёт расхода токенов LLM.

Каждый запрос дописывает строку в ``data/usage/YYYY-MM.jsonl``: время,
провайдер, модель, факультет/группа (если известны) и токены.
Отчёты — ``.venv/bin/python -m utils.usage``.

Учёт намеренно «мягкий»: ошибки записи не должны ломать парсинг.
Отключается ``USAGE_LOG=0``, каталог меняется ``USAGE_DIR``.
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import os
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent

_context: contextvars.ContextVar[dict] = contextvars.ContextVar(
    "llm_usage_context", default={}
)


def usage_dir() -> Path:
    custom = (os.environ.get("USAGE_DIR") or "").strip()
    return Path(custom) if custom else BASE_DIR / "data" / "usage"


def _enabled() -> bool:
    value = (os.environ.get("USAGE_LOG") or "1").strip().lower()
    return value not in ("0", "false", "no", "off")


@contextlib.contextmanager
def usage_context(**fields):
    """Дополняет контекст запроса: факультет, группа, что угодно ещё."""
    current = _context.get()
    merged = {**current, **{k: v for k, v in fields.items() if v}}
    token = _context.set(merged)
    try:
        yield
    finally:
        _context.reset(token)


def record_usage(
    provider: str,
    model: str,
    usage: dict,
    *,
    elapsed_ms: float | None = None,
) -> None:
    """Дописывает одну строку в журнал использования."""
    if not _enabled() or not usage:
        return

    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    if prompt == 0 and completion == 0:
        return

    now = datetime.now(timezone.utc)
    record = {
        "ts": now.isoformat(timespec="seconds"),
        "provider": provider,
        "model": model,
        "prompt": prompt,
        "cached": int(usage.get("prompt_cache_hit_tokens") or 0),
        "completion": completion,
    }

    reasoning = int(usage.get("reasoning_tokens") or 0)
    if reasoning:
        record["reasoning"] = reasoning
    if elapsed_ms:
        record["ms"] = round(elapsed_ms)

    for key, value in _context.get().items():
        if value:
            record[key] = value

    source = (os.environ.get("USAGE_SOURCE") or "").strip()
    if source:
        record.setdefault("source", source)

    path = usage_dir() / f"{now:%Y-%m}.jsonl"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        # Учёт не должен ломать парсинг.
        pass
