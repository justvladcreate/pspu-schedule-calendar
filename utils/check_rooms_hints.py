"""
Проверка эвристики распределения аудиторий по веткам.

Прогоняет parse_rooms_with_hints + pick_rooms_for_branch на реальных
примерах из таблицы ПГГПУ и печатает результат в читаемом виде.

Запуск из корня проекта:
    python -m utils.check_rooms_hints
"""
import logging
from parser.rooms_hints import (
    parse_rooms_with_hints,
    pick_rooms_for_branch,
    _parse_dates_hint,
)

CASES = [
    {
        "name": "type-hint: прак. - X",
        "rooms_raw": "IV к.\\ А204\nпрак. - IV к.\\ А304",
        "branches": [
            {"type": "лек.", "dates": "10.09 - 30.10"},
            {"type": "прак.", "dates": "10.09 - 30.10"},
        ],
    },
    {
        "name": "date-hint: одиночная дата",
        "rooms_raw": "IV к.\\ А-305\n28.09 - IV к.\\ А-304",
        "branches": [
            {"type": "прак.", "dates": "21.09, 28.09, 05.10"},
            {"type": "прак.", "dates": "12.10, 19.10"},
        ],
    },
    {
        "name": "date-hint: диапазон",
        "rooms_raw": (
            "дистанционно\\ онлайн\n"
            "6.10 - II к.\\ 314\n"
            "13.10-20.10 - II к.\\ 315"
        ),
        "branches": [
            {"type": "лек.", "dates": "15.09 - 29.09, 6.10"},
            {"type": "прак.", "dates": "13.10, 20.10"},
        ],
    },
    {
        "name": "три дистанционных варианта (без hint)",
        "rooms_raw": (
            "дистанционно\\ видеолекции\n\n"
            "дистанционно\\ СФЕРУМ\n\n"
            "IV к.\\ В105"
        ),
        "branches": [
            {"type": "лек.", "dates": "10.09"},
            {"type": "лек.", "dates": "17.09"},
            {"type": "лек.", "dates": "24.09 - 8.10"},
        ],
    },
    {
        "name": "смешанный: base + два override",
        "rooms_raw": (
            "IV к.\\ А201\n"
            "прак. - IV к.\\ А316\n"
            "28.09 - IV к.\\ А101"
        ),
        "branches": [
            {"type": "лек.", "dates": "14.09, 21.09"},
            {"type": "прак.", "dates": "28.09, 05.10"},
            {"type": "прак.", "dates": "12.10"},
        ],
    },
]


def main() -> None:
    for case in CASES:
        print("=" * 72)
        print(case["name"])
        print("-" * 72)
        print("RAW:")
        for line in case["rooms_raw"].splitlines():
            print(f"    {line!r}")
        print()

        parsed = parse_rooms_with_hints(case["rooms_raw"])

        print("PARSED:")
        for i, p in enumerate(parsed):
            bits = []
            if p["hint_type"]:
                bits.append(f"type={p['hint_type']}")
            if p["hint_dates"]:
                bits.append(f"dates={sorted(p['hint_dates'])}")
            hint_str = ", ".join(bits) if bits else "base"
            print(f"    [{i}] {p['room']!r:<30} hint: {hint_str}")
        print()

        print("BRANCHES → rooms:")
        for br in case["branches"]:
            print(f"    type={br['type']!r:<8} dates={br['dates']!r}")
            for i, p in enumerate(parsed):
                hint_type = p["hint_type"]
                hint_dates = p["hint_dates"]
                if not hint_type and not hint_dates:
                    continue  # base, не проверяем

                t_ok = not hint_type or hint_type in (br["type"] or "").lower()
                branch_dates_set = _parse_dates_hint(br["dates"] or "", expand_ranges=True)
                d_ok = not hint_dates or bool(hint_dates & branch_dates_set)

                mark = "✓" if (t_ok and d_ok) else "✗"
                reason = []
                if hint_type:
                    reason.append(f"type={hint_type} vs {br['type']!r} → {t_ok}")
                if hint_dates:
                    reason.append(
                        f"dates {sorted(hint_dates)} ∩ {sorted(branch_dates_set)} "
                        f"= {sorted(hint_dates & branch_dates_set)} → {d_ok}"
                    )
                print(f"        {mark} [{i}] {p['room']!r:<25} {', '.join(reason)}")

            picked = pick_rooms_for_branch(parsed, br["type"], br["dates"])
            print(f"        → {picked!r}")
            print()
        print()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()