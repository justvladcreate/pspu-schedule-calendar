"""Общие модели данных для парсеров факультетов."""
from __future__ import annotations

from dataclasses import dataclass, field
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
        year = self.semester_start.year if self.semester_start.month >= 9 else self.semester_start.year - 1
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
    adapter: str
    prompt: str
    enabled: bool = True


@dataclass
class RawBranch:
    """Одна ветка занятия до финальной сборки events."""

    faculty_id: str
    group: str
    weekday: str
    time_start: str
    time_end: str = ""
    dates: list[str] = field(default_factory=list)
    discipline: str = ""
    type: str = ""
    subgroup: str = ""
    teachers: list[str] = field(default_factory=list)
    rooms: str = ""
    comment: str = ""
    color: str = ""
    source_ref: dict = field(default_factory=dict)
    source_text: str = ""
    confidence: float = 1.0
    issues: list[str] = field(default_factory=list)
    faculty_name: str = ""


@dataclass
class ParseResult:
    faculty: Faculty
    branches: list[RawBranch]
    confidence: float = 1.0
    issues: list[str] = field(default_factory=list)
