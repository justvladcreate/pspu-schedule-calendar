"""Источник XLSX с публичных ссылок cloud.mail.ru."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import urllib.parse
import urllib.request
from pathlib import Path

from parser.sources.base import ScheduleSource, SheetData
from parser.sources.xlsx_file import XlsxFileSource

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
)
_SAFE_URL = "~@#$()*!=:;,.?/\\'"


def _request(url: str, *, binary: bool = False, timeout: int = 90):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": _USER_AGENT,
            "Referer": "https://cloud.mail.ru/",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
    return data if binary else data.decode("utf-8", "replace")


def resolve_public_file(url: str) -> tuple[str, str]:
    """Возвращает (weblink, base_url) для публичного файла cloud.mail.ru."""
    html = _request(url)
    base_match = re.search(
        r'"weblink_get":\{"count":"?1"?,"url":"([^"]+)"', html
    )
    if not base_match:
        raise ValueError("cloud.mail: не найден weblink_get")

    weblink_match = re.search(r'"weblink":"([^"]+)"', html)
    if not weblink_match:
        raise ValueError("cloud.mail: не найден weblink")

    weblink = urllib.parse.unquote(weblink_match.group(1))
    return weblink, base_match.group(1)


def _download_url(weblink: str, base_url: str) -> str:
    return base_url + "/" + urllib.parse.quote(weblink, safe=_SAFE_URL)


def _remote_meta(weblink: str) -> dict | None:
    try:
        url = (
            "https://cloud.mail.ru/api/v2/file?weblink="
            + urllib.parse.quote(weblink)
            + "&api=2"
        )
        payload = json.loads(_request(url, timeout=30))
        return payload.get("body") or None
    except Exception as exc:
        logger.debug("cloud.mail: не удалось получить метаданные: %s", exc)
        return None


def download_public_xlsx(
    url: str,
    target: Path,
    *,
    force: bool = False,
) -> Path:
    """Скачивает XLSX в target; использует кэш, если файл не изменился."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    meta_path = target.with_suffix(target.suffix + ".meta.json")

    weblink, base_url = resolve_public_file(url)
    remote = _remote_meta(weblink)

    if target.exists() and not force and remote and meta_path.exists():
        try:
            cached = json.loads(meta_path.read_text(encoding="utf-8"))
            if (
                cached.get("mtime") == remote.get("mtime")
                and cached.get("size") == remote.get("size")
            ):
                return target
        except (OSError, json.JSONDecodeError):
            pass

    data = _request(_download_url(weblink, base_url), binary=True)
    if not data.startswith(b"PK"):
        raise ValueError("cloud.mail вернул не XLSX (нет ZIP-подписи)")

    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)

    if remote:
        meta_path.write_text(
            json.dumps({
                "weblink": weblink,
                "mtime": remote.get("mtime"),
                "size": remote.get("size"),
            }, ensure_ascii=False),
            encoding="utf-8",
        )

    logger.info("cloud.mail: скачан %s (%d байт)", target.name, len(data))
    return target


class CloudMailFileSource(ScheduleSource):
    """Скачивает XLSX с cloud.mail и отдаёт его как обычный XLSX-источник."""

    def __init__(
        self,
        url: str,
        cache_path: Path,
        *,
        force: bool = False,
    ):
        self.url = url
        self.cache_path = Path(cache_path)
        self.force = force

    async def load(self) -> list[SheetData]:
        path = await asyncio.to_thread(
            download_public_xlsx,
            self.url,
            self.cache_path,
            force=self.force,
        )
        return await XlsxFileSource(path).load()
