"""Модели, общие для всех факультетов."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class AcademicPeriod:
    year: str
    semester_start: date | None = None
    semester_end: date | None = None

    def contains(self, value: date) -> bool:
        if self.semester_start and value < self.semester_start:
            return False
        if self.semester_end and value > self.semester_end:
            return False
        return True

    def academic_bounds(self) -> tuple[date, date] | None:
        """Границы учебного года: 1 сентября — 31 августа.

        Нужны, чтобы отсекать файлы прошлых лет, не теряя сессию,
        которая может выходить за ``semester_end``.
        """
        if not self.semester_start:
            return None
        year = (
            self.semester_start.year
            if self.semester_start.month >= 9
            else self.semester_start.year - 1
        )
        return date(year, 9, 1), date(year + 1, 8, 31)


@dataclass(frozen=True)
class FacultySource:
    type: str
    url: str | None = None
    spreadsheet_id: str | None = None


@dataclass(frozen=True)
class Faculty:
    id: str
    name: str
    short: str
    source: FacultySource
    prompt: str = ""
    enabled: bool = True
