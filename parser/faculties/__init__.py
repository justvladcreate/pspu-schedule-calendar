"""Реестр парсеров факультетов.

Добавить факультет = создать пакет ``parser/faculties/<id>_<имя>/``
с классом-наследником ``FacultyParser``, зарегистрировать его здесь и
дописать запись в ``faculties.yaml``.
"""
from __future__ import annotations

from parser.faculties.base import FacultyParser, FacultyPaths, paths_for
from parser.faculties.f01_math import MathParser
from parser.faculties.f12_inec import InecParser

_PARSERS: dict[str, type[FacultyParser]] = {
    MathParser.id: MathParser,
    InecParser.id: InecParser,
}


def get_parser_class(faculty_id: str) -> type[FacultyParser] | None:
    return _PARSERS.get(str(faculty_id))


def available_faculties() -> list[str]:
    return sorted(_PARSERS)


__all__ = [
    "FacultyParser",
    "FacultyPaths",
    "paths_for",
    "get_parser_class",
    "available_faculties",
]
