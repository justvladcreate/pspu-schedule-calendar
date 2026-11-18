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

# Сколько символов исходных ячеек отправлять за один запрос. Промпт с
# правилами занимает ~9k символов, а у бесплатных тарифов (Groq) лимит
# 8000 токенов в минуту на весь запрос, поэтому большие группы режем.
DEFAULT_CHUNK_CHARS = 3000


def _line_enumerator(line: str) -> int | None:
    head = line.split(";", 1)[0].strip().strip("[]").strip()
    try:
        return int(head)
    except ValueError:
        return None


def _merge_lines(lines: list[str], sources: list[dict]) -> list[dict]:
    """Строки «[n];...» → события. Номер ячейки считается внутри пачки."""
    merged: list[dict] = []
    enum_counts: Counter = Counter()
    for line in lines:
        n = _line_enumerator(line)
        if n is not None:
            enum_counts[n] += 1

    seen: dict[int, int] = {}
    for line in lines:
        n = _line_enumerator(line)
        if n is None:
            items = merge_ai_line(line, 0, sources)
            if items:
                merged.extend(items)
            continue

        branch_index = seen.get(n, 0)
        seen[n] = branch_index + 1
        items = merge_ai_line(
            line, 0, sources,
            branch_index=branch_index,
            branch_total=enum_counts[n],
        )
        if items:
            merged.extend(items)
    return merged


def _split_sources(sources: list[dict]) -> list[list[dict]]:
    """Режет ячейки группы на пачки по AI_CHUNK_CHARS символов."""
    try:
        limit = int(os.environ.get("AI_CHUNK_CHARS") or DEFAULT_CHUNK_CHARS)
    except ValueError:
        limit = DEFAULT_CHUNK_CHARS
    if limit <= 0:
        return [sources]

    chunks: list[list[dict]] = []
    current: list[dict] = []
    size = 0
    for source in sources:
        text_len = len(str(source.get("subject", ""))) + 2
        if current and size + text_len > limit:
            chunks.append(current)
            current, size = [], 0
        current.append(source)
        size += text_len
    if current:
        chunks.append(current)
    return chunks or [sources]



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
        # Прошлая версия after_ai: из неё берём группы, для которых LLM
        # не ответила, чтобы сбой сети/прокси не стирал расписание группы.
        previous: dict = read_json(self.paths.latest_file(AFTER_AI_NAME)) or {}
        previous_old: dict = read_json(self.paths.old_file(AFTER_AI_NAME)) or {}

        new_cache: dict[str, list[str]] = {}
        cache_hits = 0
        ai_calls = 0
        after_ai: dict = {}
        failed: list[str] = []
        restored: list[str] = []

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
                new_cache[key] = lines
                merged = _merge_lines(lines, sources)
            else:
                merged = []
                group_failed = False
                chunks = _split_sources(sources)
                if len(chunks) > 1:
                    logger.info(
                        "%s: %d ячеек — отправляю %d частями (лимит токенов)",
                        group, len(sources), len(chunks),
                    )

                for chunk in chunks:
                    chunk_text = format_ai_input(chunk)
                    chunk_key = chunk_hash(chunk_text)

                    if chunk_key in old_cache:
                        chunk_lines = old_cache[chunk_key]
                        cache_hits += 1
                    else:
                        prompt_text = USER_PROMPT.format(data=chunk_text)
                        try:
                            chunk_result = await ask_ai_with_retry(prompt=prompt_text)
                            if isinstance(chunk_result, list):
                                chunk_lines = [e for e in chunk_result if e.strip()]
                            else:
                                chunk_lines = [
                                    e for e in chunk_result.split("\n") if e.strip()
                                ]
                            ai_calls += 1
                            await asyncio.sleep(0.5)
                        except Exception as e:  # noqa: BLE001
                            logger.error("AI ошибка (группа %s): %s", group, e)
                            group_failed = True
                            break

                    new_cache[chunk_key] = chunk_lines
                    merged.extend(_merge_lines(chunk_lines, chunk))

                if group_failed:
                    failed.append(group)
                    continue

            after_ai[group] = {
                "events": merged,
                "semester_start_year": group_data.get("semester_start_year"),
            }

        logger.info(
            "AI-статистика: %d вызовов, %d попаданий в кэш", ai_calls, cache_hits
        )

        for group in failed:
            fallback = previous.get(group) or previous_old.get(group) or {}
            events = fallback.get("events") or []
            if events:
                after_ai[group] = {
                    "events": events,
                    "semester_start_year": fallback.get("semester_start_year"),
                }
                restored.append(group)
            else:
                logger.error(
                    "Группа %s останется без расписания: нет ответа LLM "
                    "и нет прошлой версии",
                    group,
                )
        if failed:
            logger.warning(
                "AI недоступна для групп: %s; восстановлено из прошлой версии: %s",
                ", ".join(failed),
                ", ".join(restored) or "нет",
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
