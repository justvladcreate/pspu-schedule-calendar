"""ИНЭК (id 12) — эталонный парсер.

Работает как раньше: Google Sheets или Google Drive XLSX → извлечение
ячеек → LLM-склейка → стандартные события. Изменились только пути:
артефакты лежат в ``data/faculties/12/{latest,old}``.
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections import Counter

from config import CONFIG
from google.auth.exceptions import RefreshError
from googleapiclient.http import MediaIoBaseDownload

from google_services import (
    SPREADSHEET_ID,
    get_drive_and_sheets_services,
    get_drive_service,
)
from parser.faculties.base import (
    AFTER_AI_NAME,
    CHUNKS_NAME,
    EXTRACTED_NAME,
    SOURCE_NAME,
    FacultyParser,
    read_json,
    rotate,
    write_json,
)
from parser.faculties.f12_inec.ai_merge import (
    ask_ai_with_retry,
    chunk_hash,
    format_ai_input,
    merge_ai_line,
)
from parser.faculties.f12_inec.extractor import DataExtractor
from parser.faculties.f12_inec.prompt import USER_PROMPT
from parser.core.model import AcademicPeriod
from parser.sources import GoogleSheetsSource, ScheduleSource, XlsxFileSource
from parser.sources.base import SheetData

logger = logging.getLogger(__name__)


class InecParser(FacultyParser):
    id = "12"
    uses_llm = True

    # ---------------------------------------------------------- source
    def source_type(self) -> str:
        return (
            os.environ.get("SCHEDULE_SOURCE")
            or (CONFIG.get("schedule_source") or {}).get("type")
            or "google"
        ).lower()

    def source(self) -> ScheduleSource:
        if self.source_type() == "xlsx":
            self._download_drive_xlsx()
            return XlsxFileSource(self.paths.latest_file(SOURCE_NAME))
        _, sheets_service = get_drive_and_sheets_services()
        return GoogleSheetsSource(SPREADSHEET_ID, sheets_service)

    async def load(self) -> list[SheetData]:
        if self.source_type() == "xlsx":
            await asyncio.to_thread(self._download_drive_xlsx)
            return await XlsxFileSource(self.paths.latest_file(SOURCE_NAME)).load()

        source = await asyncio.to_thread(self.source)
        return await source.load()

    def _download_drive_xlsx(self) -> None:
        target = self.paths.latest_file(SOURCE_NAME)
        target.parent.mkdir(parents=True, exist_ok=True)
        service = get_drive_service()
        request = service.files().export_media(
            fileId=SPREADSHEET_ID,
            mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        with open(target, "wb") as file:
            downloader = MediaIoBaseDownload(file, request)
            done = False
            while not done:
                status, done = downloader.next_chunk()
                logger.info("Download progress: %d%%", int(status.progress() * 100))

    # ---------------------------------------------------------- parse
    async def parse(
        self,
        sheets: list[SheetData],
        period: AcademicPeriod,
    ) -> dict:
        groups = await DataExtractor(_SheetsSource(sheets)).extract()
        extracted_path = self.paths.latest_file(EXTRACTED_NAME)
        rotate(extracted_path)
        write_json(extracted_path, groups)
        return groups

    # ---------------------------------------------------------- LLM
    async def refine(self, groups: dict, period: AcademicPeriod) -> dict:
        cache_path = self.paths.latest_file(CHUNKS_NAME)
        old_cache = read_json(cache_path).get("entries", {}) or {}

        new_cache: dict[str, list[str]] = {}
        cache_hits = 0
        ai_calls = 0
        after_ai: dict = {}

        for group, group_data in groups.items():
            sources: list[dict] = group_data.get("events", [])
            if not sources:
                after_ai[group] = {"events": []}
                continue

            ai_input_text = format_ai_input(sources)
            key = chunk_hash(ai_input_text)

            if key in old_cache:
                lines = old_cache[key]
                cache_hits += 1
                logger.info("[skip AI] %s: cache hit (%d ячеек)", group, len(sources))
            else:
                prompt_text = USER_PROMPT.format(data=ai_input_text)
                try:
                    chunk_result = await ask_ai_with_retry(prompt=prompt_text)
                    if isinstance(chunk_result, list):
                        lines = [e for e in chunk_result if e.strip()]
                    else:
                        lines = [e for e in chunk_result.split("\n") if e.strip()]
                    ai_calls += 1
                    await asyncio.sleep(0.5)
                except Exception as e:  # noqa: BLE001
                    logger.error("AI ошибка (группа %s): %s", group, e)
                    continue

            new_cache[key] = lines

            merged: list[dict] = []
            enum_counts = Counter()
            for line in lines:
                head = line.split(";", 1)[0].strip()
                try:
                    n = int(head.strip("[]").strip())
                except ValueError:
                    continue
                enum_counts[n] += 1

            seen: dict[int, int] = {}
            for line in lines:
                head = line.split(";", 1)[0].strip()
                try:
                    n = int(head.strip("[]").strip())
                except ValueError:
                    items = merge_ai_line(line, 0, sources)
                    if items:
                        merged.extend(items)
                    continue

                branch_index = seen.get(n, 0)
                seen[n] = branch_index + 1
                branch_total = enum_counts[n]

                items = merge_ai_line(
                    line, 0, sources,
                    branch_index=branch_index,
                    branch_total=branch_total,
                )
                if items:
                    merged.extend(items)

            after_ai[group] = {
                "events": merged,
                "semester_start_year": group_data.get("semester_start_year"),
            }

        logger.info(
            "AI-статистика: %d вызовов, %d попаданий в кэш", ai_calls, cache_hits
        )

        write_json(cache_path, {"entries": new_cache})

        after_ai_path = self.paths.latest_file(AFTER_AI_NAME)
        rotate(after_ai_path)
        write_json(after_ai_path, after_ai)
        return after_ai


class _SheetsSource:
    """Обёртка: отдать extractor уже загруженные листы."""

    def __init__(self, sheets: list[SheetData]):
        self._sheets = sheets

    async def load(self) -> list[SheetData]:
        return self._sheets
