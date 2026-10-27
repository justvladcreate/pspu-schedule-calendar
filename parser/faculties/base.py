"""Общие вещи для парсеров факультетов.

У каждого факультета своя папка с артефактами:

    data/faculties/<id>/latest/*   — текущий прогон
    data/faculties/<id>/old/*      — предыдущий прогон
    web/data/faculties/<id>/       — опубликованные data.json / old_data.json
                                     и source.xlsx (кладёт CI)

Модуль парсера факультета реализует ``FacultyParser``: сам решает,
откуда брать таблицу, как её разбирать и нужен ли LLM.
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from parser.core.model import AcademicPeriod, Faculty
from parser.sources.base import ScheduleSource, SheetData

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = PROJECT_ROOT / "data" / "faculties"
WEB_ROOT = PROJECT_ROOT / "web" / "data" / "faculties"

SOURCE_NAME = "source.xlsx"
EXTRACTED_NAME = "extracted.json"
AFTER_AI_NAME = "after_ai.json"
PARSED_NAME = "parsed.json"
CHUNKS_NAME = "chunks_cache.json"


@dataclass(frozen=True)
class FacultyPaths:
    """Пути одного факультета — и на бэке, и на фронте."""

    faculty_id: str

    @property
    def root(self) -> Path:
        return DATA_ROOT / self.faculty_id

    @property
    def latest(self) -> Path:
        return self.root / "latest"

    @property
    def old(self) -> Path:
        return self.root / "old"

    @property
    def web(self) -> Path:
        return WEB_ROOT / self.faculty_id

    def latest_file(self, name: str) -> Path:
        return self.latest / name

    def old_file(self, name: str) -> Path:
        return self.old / name

    def ensure(self) -> "FacultyPaths":
        self.latest.mkdir(parents=True, exist_ok=True)
        self.old.mkdir(parents=True, exist_ok=True)
        return self


def paths_for(faculty_id: str) -> FacultyPaths:
    return FacultyPaths(str(faculty_id))


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_json(path: Path, data) -> None:
    def _default(value):
        if isinstance(value, set):
            return sorted(value)
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")

    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=4, default=_default)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def rotate(path: Path) -> None:
    """latest/<name> → old/<name> перед записью новой версии."""
    if not path.exists():
        return
    old = path.parent.parent / "old" / path.name
    old.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, old)


class FacultyParser:
    """Интерфейс парсера факультета.

    Наследники переопределяют ``load``/``parse``, при необходимости —
    ``refine`` (шаг с LLM) и ``uses_llm``.
    """

    id: str = ""
    uses_llm: bool = False

    def __init__(self, faculty: Faculty, paths: FacultyPaths | None = None):
        self.faculty = faculty
        self.paths = (paths or paths_for(faculty.id)).ensure()

    # ---------------------------------------------------------- source
    def source(self) -> ScheduleSource:
        raise NotImplementedError

    async def load(self) -> list[SheetData]:
        return await self.source().load()

    # ---------------------------------------------------------- parse
    async def parse(
        self,
        sheets: list[SheetData],
        period: AcademicPeriod,
    ) -> dict:
        """Возвращает {группа: {"events": [...], "semester_start_year": int}}."""
        raise NotImplementedError

    async def refine(self, groups: dict, period: AcademicPeriod) -> dict:
        """Необязательный шаг с LLM. По умолчанию данные не меняются."""
        return groups
