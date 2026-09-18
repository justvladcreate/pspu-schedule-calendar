"""
Что делает:
  1. Скачивает Excel из Google Sheets (нужны sheets-креды).
  2. Извлекает события, чистит, гонит через AI.
  3. Прогоняет postprocess, overrides.
  4. Пишет JSON в data/latest/groups_info_parsed.json.
  5. НЕ трогает Google Calendar.

Как запускать:
  • Из PyCharm: правый клик по файлу → Run 'run_local'.
  • Из другого Python-кода: `from utils.run_local import run; asyncio.run(run())`
  • Из консоли (если очень надо): `python -m utils.run_local`
"""
import asyncio
import logging

from parser.process import process_schedule


logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)

# --- параметры прогона (правь прямо тут) ---
USE_CHUNKS = False       # True — резать события на чанки перед AI
CHUNK_SIZE = 12          # размер чанка при USE_CHUNKS=True


async def run(
        use_chunks: bool = USE_CHUNKS,
        chunk_size: int = CHUNK_SIZE,
) -> int:
    """Возвращает количество обработанных событий (0 при ошибке)."""
    logger.info("Локальный прогон пайплайна (без публикации web)")
    result = await process_schedule(
        use_chunks=use_chunks,
        chunk_size=chunk_size,
        publish_web_flag=False,
    )
    if result is None:
        logger.error("Пайплайн не вернул результат — смотри логи выше")
        return 0

    events = result.get("events", [])
    logger.info(f"Готово. Всего событий: {len(events)}")
    logger.info("JSON обновлён в data/latest/groups_info_parsed.json")
    return len(events)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("Прервано по Ctrl+C")