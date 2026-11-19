"""Отчёт по расходу токенов LLM.

Данные берутся из ``data/usage/YYYY-MM.jsonl`` (пишется при каждом
запросе, см. ``parser/core/usage.py``).

Примеры:

    .venv/bin/python -m utils.usage --period hour
    .venv/bin/python -m utils.usage --period day
    .venv/bin/python -m utils.usage --period week --by group
    .venv/bin/python -m utils.usage --period month --by model
    .venv/bin/python -m utils.usage --period all

Стоимость считается по прайсу DeepSeek (peak/off-peak, кэш дешевле).
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from parser.core.usage import usage_dir

PERIODS = {
    "hour": (timedelta(hours=1), "последний час"),
    "day": (timedelta(days=1), "последние 24 часа"),
    "week": (timedelta(days=7), "последние 7 дней"),
    "month": (timedelta(days=30), "последние 30 дней"),
}

# USD за 1M токенов: input (cache miss), input (cache hit), output.
PRICES = {
    "deepseek-flash": {
        "peak": {"miss": 0.30, "hit": 0.006, "out": 1.20},
        "offpeak": {"miss": 0.15, "hit": 0.003, "out": 0.60},
    },
    "deepseek-v4-pro": {
        "peak": {"miss": 1.32, "hit": 0.044, "out": 3.96},
        "offpeak": {"miss": 0.66, "hit": 0.022, "out": 1.98},
    },
}

USD_CNY = 7.2


def load_records(directory: Path | None = None) -> list[dict]:
    """Читает все журналы использования, добавляя поле ``_ts``."""
    directory = directory or usage_dir()
    if not directory.exists():
        return []

    records: list[dict] = []
    for path in sorted(directory.glob("*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                record["_ts"] = datetime.fromisoformat(record["ts"])
            except (ValueError, KeyError, TypeError):
                continue
            records.append(record)
    return records


def filter_period(
    records: list[dict],
    period: str = "day",
    now: datetime | None = None,
) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    if period == "all":
        return list(records)
    delta = PERIODS.get(period, PERIODS["day"])[0]
    since = now - delta
    return [r for r in records if r.get("_ts") and r["_ts"] >= since]


def is_peak(ts: datetime) -> bool:
    """Пиковые часы DeepSeek: 01–04 и 06–10 UTC по будням."""
    if ts.weekday() >= 5:
        return False
    return 1 <= ts.hour < 4 or 6 <= ts.hour < 10


def record_cost(record: dict) -> float | None:
    price = PRICES.get(record.get("model") or "")
    if not price:
        return None
    tier = price["peak" if is_peak(record["_ts"]) else "offpeak"]
    prompt = int(record.get("prompt") or 0)
    cached = int(record.get("cached") or 0)
    completion = int(record.get("completion") or 0)
    miss = max(prompt - cached, 0)
    return (
        miss * tier["miss"] + cached * tier["hit"] + completion * tier["out"]
    ) / 1_000_000


def summarize(records: list[dict]) -> dict:
    total = {
        "requests": len(records),
        "prompt": 0,
        "cached": 0,
        "completion": 0,
        "cost": 0.0,
        "cost_known": True,
    }
    for record in records:
        total["prompt"] += int(record.get("prompt") or 0)
        total["cached"] += int(record.get("cached") or 0)
        total["completion"] += int(record.get("completion") or 0)
        cost = record_cost(record)
        if cost is None:
            total["cost_known"] = False
        else:
            total["cost"] += cost
    total["total"] = total["prompt"] + total["completion"]
    return total


def aggregate(records: list[dict], by: str) -> dict[str, dict]:
    groups: dict[str, list[dict]] = {}
    for record in records:
        key = record.get(by) or "—"
        groups.setdefault(str(key), []).append(record)
    return {key: summarize(items) for key, items in groups.items()}


def _num(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def _money(total: dict) -> str:
    if not total["cost_known"]:
        return "?"
    return f"≈ ${total['cost']:.4f} (¥{total['cost'] * USD_CNY:.2f})"


BY_LABELS = {
    "model": "моделям",
    "group": "группам",
    "faculty": "факультетам",
    "source": "источнику",
    "day": "дням",
}


def render(records: list[dict], period: str, by: str | None) -> str:
    now = datetime.now(timezone.utc)
    label = PERIODS.get(period, PERIODS["day"])[1] if period != "all" else "всё время"
    total = summarize(records)

    lines = [
        f"Период: {label} (до {now:%d.%m.%Y %H:%M} UTC)",
        f"Запросов: {total['requests']}",
        f"Вход:    {_num(total['prompt'])} (из них кэш {_num(total['cached'])})",
        f"Выход:   {_num(total['completion'])}",
        f"Всего:   {_num(total['total'])} токенов",
        f"Оценка:  {_money(total)}",
    ]

    if by and total["requests"]:
        lines.append("")
        lines.append(f"По {BY_LABELS.get(by, by)}:")
        rows = sorted(
            aggregate(records, by).items(),
            key=lambda item: item[1]["total"],
            reverse=True,
        )
        width = max(len(key) for key, _ in rows)
        for key, data in rows:
            lines.append(
                f"  {key.ljust(width)}  {data['requests']:>4} запр.  "
                f"вход {_num(data['prompt']):>9}  выход {_num(data['completion']):>9}  "
                f"{_money(data)}"
            )

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Расход токенов LLM")
    parser.add_argument(
        "--period",
        default="day",
        choices=[*PERIODS, "all"],
        help="за какой период считать",
    )
    parser.add_argument(
        "--by",
        default=None,
        help="разбивка: model, group, faculty, source, day",
    )
    parser.add_argument("--dir", default=None, help="каталог журналов")
    args = parser.parse_args(argv)

    directory = Path(args.dir) if args.dir else usage_dir()
    records = filter_period(load_records(directory), args.period)
    print(render(records, args.period, args.by))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
