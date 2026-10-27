"""Отчёт об уверенности детерминированного разбора.

Показывает, где парсер сомневается и какие ячейки стоит проверить
руками или отдать LLM.

    python -m utils.report_confidence
    python -m utils.report_confidence --json report.json
    python -m utils.report_confidence --faculty 06 --limit 40

Кэш скачанных XLSX: ``data/faculties/<id>.xlsx``. Если файлов нет,
их можно предварительно скачать прогоном ``parser.pipeline.parse_all``
или скриптом ``tools/fetch-faculty-xlsx.mjs``.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter, defaultdict
from pathlib import Path

from parser.faculties import load_registry
from parser.pipeline import parse_faculty

ISSUE_HINTS = {
    "parallel_without_subgroup": (
        "в одной ячейке несколько занятий, но не указано, какой подгруппе "
        "какое — комнаты/преподаватели могут перепутаться"
    ),
    "ambiguous_rooms": (
        "аудиторий больше, чем занятий (или наоборот) — привязка комнаты "
        "к занятию неоднозначна"
    ),
    "no_teachers": "не удалось выделить ФИО преподавателя",
    "no_rooms": "не указана аудитория",
    "no_discipline": "не удалось выделить название дисциплины",
    "no_weekday": "не определён день недели",
    "no_time": "не определено время начала",
    "no_dates": "нет дат и не удалось размножить по дню недели",
    "weekly_dates": "дат нет — занятие размножено на весь семестр",
    "group_from_header": "номер группы взят из шапки, а не из имени листа",
}


def _short(value: str, limit: int = 60) -> str:
    value = " ".join(str(value or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


async def collect(faculties_filter: set[str] | None):
    period, faculties = load_registry()
    result = []
    for faculty in faculties:
        if not faculty.enabled:
            continue
        if faculties_filter and faculty.id not in faculties_filter:
            continue
        try:
            parsed = await parse_faculty(faculty, period, repair=False)
        except Exception as exc:  # noqa: BLE001
            print(f"[{faculty.id}] не разобран: {exc}")
            continue
        result.append((faculty, parsed))
    return result


def build_report(parsed_list) -> dict:
    report = {
        "faculties": [],
        "totals": {"branches": 0, "low": 0},
    }

    for faculty, parsed in parsed_list:
        branches = parsed.branches
        low = [b for b in branches if b.confidence < 0.9]
        issues = Counter(issue for b in branches for issue in b.issues)

        faculty_block = {
            "id": faculty.id,
            "name": faculty.name,
            "adapter": faculty.adapter,
            "branches": len(branches),
            "low": len(low),
            "confidence": parsed.confidence,
            "issues": dict(issues.most_common()),
            "examples": [],
        }

        by_issue: dict[str, list] = defaultdict(list)
        for branch in low:
            for issue in branch.issues:
                if issue in ("weekly_dates", "no_rooms", "no_teachers"):
                    continue
                by_issue[issue].append(branch)
                break

        for issue, items in sorted(by_issue.items(), key=lambda kv: -len(kv[1])):
            for branch in items[:5]:
                faculty_block["examples"].append({
                    "issue": issue,
                    "group": branch.group,
                    "weekday": branch.weekday,
                    "time": branch.time_start,
                    "discipline": _short(branch.discipline),
                    "teachers": branch.teachers,
                    "rooms": _short(branch.rooms, 40),
                    "dates": _short(", ".join(branch.dates[:3]), 40),
                    "confidence": branch.confidence,
                    "sheet": branch.source_ref.get("sheet", ""),
                    "row": branch.source_ref.get("row", ""),
                    "raw": _short(branch.source_text or branch.discipline, 120),
                })

        report["faculties"].append(faculty_block)
        report["totals"]["branches"] += len(branches)
        report["totals"]["low"] += len(low)

    return report


def print_report(report: dict, limit: int) -> None:
    totals = report["totals"]
    share = (totals["low"] / totals["branches"] * 100) if totals["branches"] else 0
    print(
        f"Всего занятий: {totals['branches']}, "
        f"из них сомнительных: {totals['low']} ({share:.1f}%)\n"
    )

    for block in report["faculties"]:
        print(
            f"== {block['id']} {block['name']} "
            f"[{block['adapter']}] — {block['branches']} занятий, "
            f"уверенность {block['confidence']:.2f}, сомнительных {block['low']}"
        )
        for issue, count in block["issues"].items():
            hint = ISSUE_HINTS.get(issue, "")
            print(f"   {issue:<28} {count:>5}   {hint}")
        for example in block["examples"][:limit]:
            print(
                f"   · [{example['issue']}] {example['group']} "
                f"{example['weekday']} {example['time']} "
                f"{example['discipline']!r} "
                f"(лист {example['sheet']}, строка {example['row']})"
            )
            if example["raw"] and example["raw"] != example["discipline"]:
                print(f"       исходно: {example['raw']}")
        print()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--faculty", action="append", default=[],
                        help="id факультета (можно несколько)")
    parser.add_argument("--json", help="куда сохранить отчёт в JSON")
    parser.add_argument("--limit", type=int, default=3,
                        help="сколько примеров на проблему (по умолчанию 3)")
    args = parser.parse_args()

    parsed = await collect(set(args.faculty) or None)
    report = build_report(parsed)
    print_report(report, args.limit)

    if args.json:
        Path(args.json).write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"JSON: {args.json}")


if __name__ == "__main__":
    asyncio.run(main())
