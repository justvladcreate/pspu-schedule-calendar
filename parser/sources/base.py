from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd


@dataclass
class SheetData:
    """Один лист расписания в универсальном виде."""

    name: str
    df: pd.DataFrame                             # значения, merges уже применены
    links: dict[tuple[int, int], list[str]] = field(default_factory=dict)
    hidden: bool = False
    sheet_id: int | None = None                  # gid для Google, None для xlsx


class ScheduleSource:
    """
    Абстрактный источник расписания.

    Наследники знают, ОТКУДА брать данные. Парсеру (`extraction` и ниже)
    всё равно — лишь бы `load()` вернул список `SheetData`.
    """

    async def load(self) -> list[SheetData]:
        raise NotImplementedError