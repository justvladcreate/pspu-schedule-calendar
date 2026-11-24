"""Пересборка предрендеренных листов «Оригинала» без парсинга и сети.

Берёт уже скачанные файлы источников из ``data/faculties/<id>/latest/``
(``source.xlsx``, ``source_zo.xlsx``, …) и заново рендерит
``web/data/faculties/<id>/sheets.json`` + ``sheets/*.html``.

Нужно, когда поменялся рендер (RENDER_VERSION) или на сайте остались
старые листы, а полный прогон парсера делать не хочется.

    python -m utils.rebuild_original
    python -m utils.rebuild_original --faculty 01
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import setup_logging  # noqa: E402
from parser.core.original import publish_original  # noqa: E402
from parser.sources.loader import cached_sources  # noqa: E402

logger = logging.getLogger(__name__)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Пересобрать предрендеренные листы «Оригинала»",
    )
    parser.add_argument(
        "--faculty", action="append", metavar="ID",
        help="ID факультета (можно несколько раз); по умолчанию все",
    )
    parser.add_argument(
        "--data-dir", default=str(ROOT / "data"),
        help="каталог с data/faculties/<id>/latest",
    )
    parser.add_argument(
        "--web-dir", default=str(ROOT / "web" / "data"),
        help="каталог web/data",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="перерендерить даже если sheets.json новее исходников",
    )
    args = parser.parse_args()

    setup_logging()

    data_dir = Path(args.data_dir)
    web_dir = Path(args.web_dir)
    faculty_ids = args.faculty or sorted(
        path.name for path in (data_dir / "faculties").glob("*") if path.is_dir()
    )

    total = 0
    for faculty_id in faculty_ids:
        latest = data_dir / "faculties" / faculty_id / "latest"
        files = cached_sources(latest)
        if not files:
            logger.info("Факультет %s: исходных файлов нет — пропуск", faculty_id)
            continue
        if args.force:
            (web_dir / "faculties" / faculty_id / "sheets.json").unlink(missing_ok=True)
        entries = publish_original(web_dir, faculty_id, files)
        count = len(entries or [])
        total += count
        logger.info("Факультет %s: листов %d", faculty_id, count)

    logger.info("Готово: листов %d", total)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
