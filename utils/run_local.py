"""
Что делает:
  1. Скачивает Excel из Google Sheets (нужны sheets-креды).
  2. Извлекает события, чистит, гонит через AI.
  3. Прогоняет postprocess, overrides.
  4. Пишет JSON в data/latest/groups_info_parsed.json.
  5. Обновляет web/data.json и web/old_data.json.
  6. НЕ делает git commit/push.

Как запускать:
  • Из PyCharm: правый клик по файлу → Run 'run_local'.
  • Из другого Python-кода: `from utils.run_local import run; asyncio.run(run())`
  • Из консоли (если очень надо): `python -m utils.run_local`
"""
import asyncio
import logging
import os
from parser.process import process_schedule


logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)

# --- параметры прогона (правь прямо тут) ---
USE_CHUNKS = False
CHUNK_SIZE = 30
SCHEDULE_SOURCE = "google"    # "google" | "xlsx"


async def run(
        use_chunks: bool = USE_CHUNKS,
        chunk_size: int = CHUNK_SIZE,
) -> int:
    """Возвращает количество обработанных событий (0 при ошибке)."""
    logger.info("Локальный прогон пайплайна (web обновляется, git — нет)")
    os.environ["SCHEDULE_SOURCE"] = SCHEDULE_SOURCE
    result = await process_schedule(
        use_chunks=use_chunks,
        chunk_size=chunk_size,
        publish_web=True,    # ← web/data.json и web/old_data.json обновляем
        git_push=False,      # ← но без commit/push
    )
    if result is None:
        logger.error("Пайплайн не вернул результат — смотри логи выше")
        return 0

    events = result.get("events", [])
    logger.info(f"Готово. Всего событий: {len(events)}")
    logger.info("JSON обновлён в data/latest/groups_info_parsed.json")
    logger.info("web/data.json и web/old_data.json обновлены (git push пропущен)")
    return len(events)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("Прервано по Ctrl+C")