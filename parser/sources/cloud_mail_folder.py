"""Скрейпер публичной папки cloud.mail.ru.

Ищет только XLSX и раскладывает их по типам расписания:
``oo``, ``zo``, ``oo_exams``, ``zo_exams``.

Имена файлов у факультетов разные:
    NN_РАСПИСАНИЕ ОЧНОГО ОТДЕЛЕНИЯ (…).xlsx      → oo
    NN_РАСПИСАНИЕ ЗАОЧНОГО ОТДЕЛЕНИЯ (…).xlsx    → zo
    NN_РАСПИСАНИЕ УЧЕБНО-ЭКЗАМЕНАЦИОННОЙ СЕССИИ
        ЗАОЧНОГО ОТДЕЛЕНИЯ (…).xlsx              → zo
    NN_ЗАЧЕТЫ и ЭКЗАМЕНЫ ОЧНОГО ОТДЕЛЕНИЯ.xlsx   → oo_exams
    NN_РАСПИСАНИЕ ГИА.xlsx                       → exams (ГИА = экзамены)
"""
from __future__ import annotations

import json
import logging
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from parser.sources.cloud_mail import _request, download_public_xlsx

logger = logging.getLogger(__name__)

_ITEM_RE = re.compile(
    r'\{"name":"((?:[^"\\]|\\.)*)","weblink":"((?:[^"\\]|\\.)*)",'
    r'"size":(\d+),"mtime":(\d+),"hash":"[^"]*","kind":"([^"]+)"'
)

# Тип файла → тип листов. ГИА содержит и очные, и заочные группы,
# поэтому уточняется по имени группы.
FILE_KINDS = ("oo", "zo", "oo_exams", "gia")


@dataclass
class FolderFile:
    name: str
    weblink: str
    size: int
    mtime: int
    kind: str = ""


def classify(name: str) -> str | None:
    """Тип расписания по имени файла (только .xlsx)."""
    low = name.lower()
    if not low.endswith(".xlsx"):
        return None

    if "гиа" in low:
        return "gia"
    if "заочн" in low:
        return "zo"
    if "зачет" in low or "экзамен" in low:
        return "oo_exams"
    if "очн" in low:
        return "oo"
    if "расписание" in low:
        # 16_РАСПИСАНИЕ.xlsx — единственный файл без пометки отделения.
        return "oo"
    return None


def _unescape(value: str) -> str:
    """Снимает JSON-экранирование, не ломая кириллицу."""
    return value.replace('\\"', '"').replace("\\\\", "\\")


def parse_folder_html(html: str) -> list[FolderFile]:
    """Достаёт список файлов из встроенного JSON страницы."""
    files: dict[str, FolderFile] = {}
    for match in _ITEM_RE.finditer(html):
        name = _unescape(match.group(1))
        weblink = _unescape(match.group(2))
        files[name] = FolderFile(
            name=name,
            weblink=weblink,
            size=int(match.group(3)),
            mtime=int(match.group(4)),
        )
    return list(files.values())


def list_public_folder(url: str) -> list[FolderFile]:
    html = _request(url)
    files = parse_folder_html(html)
    for item in files:
        item.kind = classify(item.name) or ""
    return files


def pick_latest(files: list[FolderFile]) -> dict[str, FolderFile]:
    """Самый свежий файл каждого типа."""
    latest: dict[str, FolderFile] = {}
    for item in files:
        if not item.kind:
            continue
        current = latest.get(item.kind)
        if current is None or item.mtime > current.mtime:
            latest[item.kind] = item
    return latest


def file_url(item: FolderFile) -> str:
    path = urllib.parse.quote(item.weblink, safe="/")
    return f"https://cloud.mail.ru/public/{path}"


def download_kind(folder_url: str, kind: str, target: Path) -> Path | None:
    """Скачивает самый свежий файл нужного типа в ``target``."""
    files = list_public_folder(folder_url)
    item = pick_latest(files).get(kind)
    if item is None:
        logger.warning(
            "cloud.mail: в папке нет файла типа %s (%s)", kind, folder_url
        )
        return None

    logger.info(
        "cloud.mail: %s ← %s (%s)", kind, item.name,
        __import__("datetime").datetime.utcfromtimestamp(item.mtime).strftime("%d.%m.%Y"),
    )
    return download_public_xlsx(file_url(item), Path(target))


def sheet_kind(file_kind: str, sheet_name: str) -> str:
    """Тип листа: ГИА делится на очные и заочные по имени группы."""
    if file_kind == "gia":
        return "zo_exams" if sheet_name.strip().upper().startswith("Z") else "oo_exams"
    if file_kind == "oo_exams":
        return "zo_exams" if sheet_name.strip().upper().startswith("Z") else "oo_exams"
    return file_kind
