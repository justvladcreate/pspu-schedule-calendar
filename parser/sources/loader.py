"""Сбор листов со всех источников факультета в единый список.

Новый шаг пайплайна: вместо одного источника факультет может иметь
несколько (очное из Google, заочное из папки cloud.mail и т.п.).
Все листы сводятся в один ``list[SheetData]`` с полем ``kind``.
"""
from __future__ import annotations

import logging
from pathlib import Path

from parser.core.model import Faculty, FacultySource
from parser.sources.base import SheetData
from parser.sources.cloud_mail import CloudMailFileSource
from parser.sources.cloud_mail_folder import download_kind, sheet_kind
from parser.sources.xlsx_file import XlsxFileSource

logger = logging.getLogger(__name__)


def _cache_path(cache_dir: Path, kind: str) -> Path:
    name = "source.xlsx" if kind in ("", "oo") else f"source_{kind}.xlsx"
    return Path(cache_dir) / name


async def _load_source(
    faculty: Faculty,
    source: FacultySource,
    cache_dir: Path,
) -> list[SheetData]:
    kind = source.kind or "oo"

    if source.type == "google_sheets":
        from google_services import get_drive_and_sheets_services
        from parser.sources.google_sheets import GoogleSheetsSource

        _, sheets = await __import__("asyncio").to_thread(
            get_drive_and_sheets_services
        )
        sheets_data = await GoogleSheetsSource(
            source.spreadsheet_id or "", sheets
        ).load()
        for sheet in sheets_data:
            sheet.kind = kind
            sheet.source = "google_sheets"
        return sheets_data

    if source.type == "cloud_mail":
        target = _cache_path(cache_dir, kind)
        sheets_data = await CloudMailFileSource(source.url or "", target).load()
        for sheet in sheets_data:
            sheet.kind = kind
            sheet.source = "cloud_mail"
        return sheets_data

    if source.type == "cloud_mail_folder":
        sheets_data = []
        for file_kind in source.kinds or ("oo",):
            target = _cache_path(cache_dir, file_kind)
            path = await __import__("asyncio").to_thread(
                download_kind, source.url or "", file_kind, target
            )
            if path is None:
                continue
            for sheet in await XlsxFileSource(path).load():
                sheet.kind = sheet_kind(file_kind, sheet.name)
                sheet.source = "cloud_mail_folder"
                sheets_data.append(sheet)
        return sheets_data

    raise ValueError(f"Неизвестный тип источника: {source.type}")


async def load_sources(faculty: Faculty, cache_dir: Path) -> list[SheetData]:
    """Все листы всех источников факультета, без совпадающих имён."""
    sources = list(faculty.sources) or [faculty.source]
    result: list[SheetData] = []

    for source in sources:
        sheets = await _load_source(faculty, source, cache_dir)
        for sheet in sheets:
            if sheet.hidden:
                logger.info("Лист %r скрыт, пропускаю", sheet.name)
                continue
            # Имя листа — это группа; переименовывать нельзя.
            result.append(sheet)

    logger.info(
        "Факультет %s: листов %d (%s)",
        faculty.id,
        len(result),
        ", ".join(f"{sheet.kind}:{sheet.name}" for sheet in result[:6])
        + ("…" if len(result) > 6 else ""),
    )
    return result
