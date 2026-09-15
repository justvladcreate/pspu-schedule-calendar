# utils/cleanup_calendar.py
"""
Разовая утилита: удалить наши события (source=pspu_schedule) из календаря
в заданном диапазоне дат.

Запуск:
    python -m utils.cleanup_calendar                   # dry-run (только показать)
    python -m utils.cleanup_calendar --yes             # реально удалить
    python -m utils.cleanup_calendar --from 01.09.2026 --to 18.01.2027 --yes
"""
import argparse
import logging
from datetime import datetime, timedelta

from google_services import get_calendar_service
from calendar_sync import SOURCE_TAG
from config import CONFIG

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")

CALENDAR_ID = CONFIG.get("calendar_id")
# CALENDAR_ID = "vladjust059@gmail.com"

def _iso_range(date_from: str, date_to: str) -> tuple[str, str]:
    d1 = datetime.strptime(date_from, "%d.%m.%Y")
    d2 = datetime.strptime(date_to,   "%d.%m.%Y") + timedelta(days=1)  # конец включительно
    return d1.isoformat() + "+05:00", d2.isoformat() + "+05:00"


def cleanup_calendar(
        date_from: str = "01.09.2026",
        date_to:   str = "18.01.2027",
        calendar_id: str = CALENDAR_ID,
        apply: bool = False,
) -> int:
    """Удаляет наши события (source=pspu_schedule) в диапазоне. Возвращает число удалённых."""
    service = get_calendar_service()
    time_min, time_max = _iso_range(date_from, date_to)

    logger.info(f"Календарь: {calendar_id}")
    logger.info(f"Диапазон:  {date_from} — {date_to}")
    logger.info(f"Режим:     {'DELETE' if apply else 'DRY-RUN'}")

    deleted = 0
    page_token = None
    while True:
        resp = service.events().list(
            calendarId=calendar_id,
            timeMin=time_min,
            timeMax=time_max,
            privateExtendedProperty=f"source={SOURCE_TAG}",
            singleEvents=True,
            maxResults=2500,
            pageToken=page_token,
        ).execute()

        for item in resp.get("items", []):
            start = item.get("start", {}).get("dateTime", "?")
            summary = item.get("summary", "?")
            event_id = item["id"]

            if apply:
                try:
                    service.events().delete(
                        calendarId=calendar_id, eventId=event_id
                    ).execute()
                    deleted += 1
                    logger.info(f"deleted  {start}  {summary}")
                except Exception as e:
                    logger.error(f"failed   {start}  {summary}: {e}")
            else:
                deleted += 1
                logger.info(f"[dry]    {start}  {summary}")

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    logger.info(f"Итого: {deleted} событий {'удалено' if apply else '(будет удалено)'}")
    return deleted


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="date_from", default="01.09.2026")
    parser.add_argument("--to",   dest="date_to",   default="18.01.2027")
    parser.add_argument("--calendar", default=CALENDAR_ID)
    parser.add_argument("--yes", action="store_true", help="реально удалить (без флага — dry-run)")
    args = parser.parse_args()

    cleanup_calendar(
        date_from=args.date_from,
        date_to=args.date_to,
        calendar_id=args.calendar,
        apply=args.yes,
    )