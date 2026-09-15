"""
Точка входа: раз в 15 минут перезапускает парсер.
Готовый JSON лежит в data/latest/groups_info_parsed.json.
Сюда позже подключишь синк с Google Calendar.
"""

import asyncio
import logging
import config
from parser.process import process_schedule


logger = logging.getLogger(__name__)

CHECK_CHANGES_TIMER: int = 60 * 60  # минуты


async def timer() -> None:
    try:
        while True:
            try:
                logger.info("Запуск парсера расписания...")
                await process_schedule()
            except Exception as e:
                logger.error(f"Ошибка в процессе парсинга: {e}", exc_info=True)
            await asyncio.sleep(CHECK_CHANGES_TIMER)
    except asyncio.CancelledError:
        logger.info("Таймер парсера остановлен.")


async def main() -> None:
    await timer()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Остановка по Ctrl+C.")
        print("Остановка скрипта.")