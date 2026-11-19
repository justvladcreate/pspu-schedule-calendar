"""Журнал расхода токенов и отчёт по нему."""
import json
from datetime import datetime, timezone

import pytest

from parser.core import usage as usage_module
from utils import usage


def _write(tmp_path, records):
    path = tmp_path / "2026-11.jsonl"
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n",
        encoding="utf-8",
    )


def test_record_usage_writes_jsonl(tmp_path, monkeypatch):
    monkeypatch.setenv("USAGE_DIR", str(tmp_path))
    monkeypatch.setenv("USAGE_LOG", "1")
    monkeypatch.delenv("USAGE_SOURCE", raising=False)

    with usage_module.usage_context(faculty="12", group="1237"):
        usage_module.record_usage(
            "openai",
            "deepseek-flash",
            {
                "prompt_tokens": 100,
                "prompt_cache_hit_tokens": 40,
                "completion_tokens": 50,
            },
        )

    files = list(tmp_path.glob("*.jsonl"))
    assert len(files) == 1
    record = json.loads(files[0].read_text(encoding="utf-8").splitlines()[0])
    assert record["prompt"] == 100
    assert record["cached"] == 40
    assert record["completion"] == 50
    assert record["faculty"] == "12"
    assert record["group"] == "1237"
    assert record["ts"]


def test_record_usage_can_be_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("USAGE_DIR", str(tmp_path))
    monkeypatch.setenv("USAGE_LOG", "0")

    usage_module.record_usage(
        "openai", "m", {"prompt_tokens": 1, "completion_tokens": 1}
    )

    assert not list(tmp_path.glob("*.jsonl"))


def test_context_is_restored(monkeypatch):
    before = usage_module._context.get()
    with usage_module.usage_context(group="1237"):
        assert usage_module._context.get()["group"] == "1237"
    assert usage_module._context.get() == before


def test_load_and_filter_period(tmp_path):
    now = datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc)
    _write(tmp_path, [
        {"ts": "2026-11-19T11:00:00+00:00", "model": "deepseek-flash",
         "prompt": 100, "cached": 0, "completion": 50},
        {"ts": "2026-11-10T11:00:00+00:00", "model": "deepseek-flash",
         "prompt": 200, "cached": 0, "completion": 100},
    ])

    records = usage.load_records(tmp_path)
    assert len(records) == 2

    day = usage.filter_period(records, "day", now=now)
    assert len(day) == 1
    assert day[0]["prompt"] == 100

    week = usage.filter_period(records, "week", now=now)
    assert len(week) == 1

    everything = usage.filter_period(records, "all", now=now)
    assert len(everything) == 2


def test_summarize_and_aggregate(tmp_path):
    now = datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc)
    _write(tmp_path, [
        {"ts": "2026-11-19T11:00:00+00:00", "model": "deepseek-flash", "group": "1237",
         "prompt": 1000, "cached": 500, "completion": 300},
        {"ts": "2026-11-19T10:00:00+00:00", "model": "deepseek-flash", "group": "1211",
         "prompt": 2000, "cached": 0, "completion": 700},
    ])
    records = usage.filter_period(usage.load_records(tmp_path), "day", now=now)

    total = usage.summarize(records)
    assert total["requests"] == 2
    assert total["prompt"] == 3000
    assert total["cached"] == 500
    assert total["completion"] == 1000
    assert total["total"] == 4000

    by_group = usage.aggregate(records, "group")
    assert set(by_group) == {"1237", "1211"}
    assert by_group["1211"]["total"] == 2700


def test_cost_depends_on_peak_hours():
    peak = datetime(2026, 11, 19, 2, 0, tzinfo=timezone.utc)      # среда, 02:00 UTC
    offpeak = datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc)  # среда, 12:00 UTC

    base = {"model": "deepseek-flash", "prompt": 1_000_000, "cached": 0, "completion": 0}
    assert usage.record_cost({**base, "_ts": peak}) == pytest.approx(0.30)
    assert usage.record_cost({**base, "_ts": offpeak}) == pytest.approx(0.15)


def test_cost_counts_cache_hits_cheaper():
    ts = datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc)
    miss = {"_ts": ts, "model": "deepseek-flash", "prompt": 1_000_000, "cached": 0, "completion": 0}
    hit = {**miss, "cached": 1_000_000}
    assert usage.record_cost(hit) < usage.record_cost(miss)


def test_render_contains_totals(tmp_path):
    now = datetime.now(timezone.utc)
    _write(tmp_path, [
        {"ts": now.isoformat(), "model": "deepseek-flash", "group": "1237",
         "prompt": 1000, "cached": 0, "completion": 500},
    ])
    records = usage.filter_period(usage.load_records(tmp_path), "day")

    text = usage.render(records, "day", "group")

    assert "Запросов: 1" in text
    assert "1 500" in text
    assert "1237" in text
