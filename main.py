import asyncio
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

import config
from parser.process import process_schedule

logger = logging.getLogger(__name__)

CHECK_CHANGES_TIMER: int = 60 * 60 * 2
WORK_HOUR_START:    int = 7
WORK_HOUR_END:      int = 22
LOCAL_TZ = ZoneInfo("Asia/Yekaterinburg")


def _within_work_hours(now: datetime | None = None) -> bool:
    now = now or datetime.now(LOCAL_TZ)
    return WORK_HOUR_START <= now.hour < WORK_HOUR_END


async def timer() -> None:
    try:
        while True:
            now = datetime.now(LOCAL_TZ)

            if _within_work_hours(now):
                try:
                    logger.info(f"Запуск парсера расписания ({now:%H:%M %Z})...")
                    await process_schedule()
                except Exception as e:
                    logger.error(f"Ошибка в процессе парсинга: {e}", exc_info=True)
            else:
                logger.info(
                    f"Пропуск запуска: {now:%H:%M %Z} вне окна "
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