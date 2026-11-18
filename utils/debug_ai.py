"""Показать сырой ответ LLM по одной группе расписания ИНЭК.

Запуск (на сервере, из корня проекта):

    .venv/bin/python -m utils.debug_ai 1211

Печатает промпт (размер), JSON, который вернула модель, и сколько
событий из него получилось после ``events_to_lines``. Нужен, когда в
логе «модель вернула пустой список событий» и непонятно почему.
"""
from __future__ import annotations

import asyncio
import json
import sys

from parser.core.ai import ask_ai_json
from parser.faculties.base import paths_for
from parser.faculties.f12_inec.ai_merge import (
    F12_AI_SCHEMA,
    JSON_OUTPUT_SUFFIX,
    events_to_lines,
    format_ai_input,
)
from parser.faculties.f12_inec.parser import _split_sources
from parser.faculties.f12_inec.prompt import USER_PROMPT


def main() -> None:
    paths = paths_for("12")
    data = json.loads(
        paths.latest_file("extracted.json").read_text(encoding="utf-8")
    )

    group = sys.argv[1] if len(sys.argv) > 1 else sorted(data)[0]
    sources = (data.get(group) or {}).get("events") or []
    if not sources:
        print(f"в extracted.json нет ячеек для группы {group}")
        return

    chunks = _split_sources(sources)
    chunk = chunks[0]
    prompt = USER_PROMPT.format(data=format_ai_input(chunk)) + JSON_OUTPUT_SUFFIX
    print(f"группа: {group}")
    print(f"ячеек: {len(sources)}, пачек: {len(chunks)} (в этой: {len(chunk)})")
    print(f"символов в промпте: {len(prompt)} (~{len(prompt) // 2} токенов)")

    payload = asyncio.run(ask_ai_json(prompt, F12_AI_SCHEMA))

    raw = json.dumps(payload, ensure_ascii=False, indent=2)
    print("--- ответ модели (первые 4000 символов) ---")
    print(raw[:4000])

    lines = events_to_lines(payload)
    print("--- после events_to_lines ---")
    print(f"событий: {len(lines)}")
    for line in lines[:5]:
        print(line)


if __name__ == "__main__":
    main()
