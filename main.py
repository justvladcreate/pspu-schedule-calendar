"""
Точка входа: раз в 2 часа перезапускает парсер,
но только в окне с 07:00 до 22:00.
Готовый JSON лежит в data/latest/groups_info_parsed.json.
"""

import asyncio
import logging
from datetime import datetime

import config
from parser.process import process_schedule

logger = logging.getLogger(__name__)

CHECK_CHANGES_TIMER: int = 60 * 60 * 2   # 2 часа в секундах
WORK_HOUR_START:    int = 7              # 07:00 включительно
WORK_HOUR_END:      int = 22             # 22:00 исключительно


def _within_work_hours(now: datetime | None = None) -> bool:
    now = now or datetime.now()
    return WORK_HOUR_START <= now.hour < WORK_HOUR_END


async def timer() -> None:
    try:
        while True:
            now = datetime.now()

            if _within_work_hours(now):
                try:
                    logger.info(f"Запуск парсера расписания ({now:%H:%M})...")
                    await process_schedule()
                except Exception as e:
                    logger.error(f"Ошибка в процессе парсинга: {e}", exc_info=True)
            else:
                next_run_h = WORK_HOUR_START if now.hour >= WORK_HOUR_END else WORK_HOUR_START
                logger.info(
                    f"Пропуск запуска: {now:%H:%M} вне окна "
                    f"{WORK_HOUR_START:02d}:00–{WORK_HOUR_END:02d}:00"
                )

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