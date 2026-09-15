# calendar_sync.py
import asyncio
import json
import logging
from datetime import date, datetime
from pathlib import Path

from google_services import get_calendar_service, CALENDAR_ID

logger = logging.getLogger(__name__)

# --- константы ---
SOURCE_TAG       = "pspu_schedule"
TIMEZONE         = "Asia/Yekaterinburg"
TZ_OFFSET        = "+05:00"
PAIR_DURATION_M  = 90            # все пары длятся 1.5 часа
TARGET_GROUP: str | None = "1237"

BASE_DIR      = Path(__file__).resolve().parent
SCHEDULE_JSON = BASE_DIR / "data" / "latest" / "groups_info_parsed.json"


# ---------------------------------------------------------------- утилиты

def _end_time(start_hhmm: str, duration_minutes: int = PAIR_DURATION_M) -> str:
    """'11:30' -> '13:00' (при duration_minutes=90)."""
    h, m = map(int, start_hhmm.split(":"))
    total = h * 60 + m + duration_minutes
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


def _iso(d: date, hhmm: str) -> str:
    return f"{d.isoformat()}T{hhmm}:00{TZ_OFFSET}"


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%d.%m.%Y").date()


def _description(ev: dict) -> str:
    parts = []
    if ev.get("teachers"):
        parts.append(f"Преподаватель: {', '.join(ev['teachers'])}")
    if ev.get("subgroup"):
        parts.append(f"Подгруппа: {ev['subgroup']}")
    if ev.get("group"):
        parts.append(f"Группа: {ev['group']}")
    if ev.get("comment"):
        parts.append(ev["comment"])
    return "\n".join(parts)


# ---------------------------------------------------------------- построение desired

def build_desired_events(path: Path | None = None) -> list[dict]:
    """JSON → плоский список событий: одна пара на одну дату."""
    if path is None:
        path = SCHEDULE_JSON
    if not path.exists():
        logger.warning(f"Schedule JSON не найден: {path}")
        return []

    data = json.loads(path.read_text(encoding="utf-8"))
    out: list[dict] = []

    for ev in data.get("events", []):
        if TARGET_GROUP is not None and ev.get("group") != TARGET_GROUP:
            continue

        start_time = ev.get("time") or ""
        if not start_time:
            logger.warning(f"Нет time у {ev.get('event_id')}")
            continue
        end_time = _end_time(start_time)

        summary = (ev.get("discipline") or "").strip()
        if ev.get("type"):
            summary = f"{summary} ({ev['type']})"

        base = {
            "summary":     summary,
            "location":    ev.get("rooms") or "",
            "description": _description(ev),
        }

        for d_str in ev.get("dates", []):
            try:
                d = _parse_date(d_str)
            except ValueError:
                logger.warning(f"Некорректная дата {d_str!r} в {ev.get('event_id')}")
                continue

            key = f"{ev['event_id']}_{d_str}"
            out.append({
                "key": key,
                "body": {
                    **base,
                    "start": {"dateTime": _iso(d, start_time), "timeZone": TIMEZONE},
                    "end":   {"dateTime": _iso(d, end_time),   "timeZone": TIMEZONE},
                    "extendedProperties": {
                        "private": {"source": SOURCE_TAG, "key": key},
                    },
                },
            })

    return out


# ---------------------------------------------------------------- доступ к календарю

def _fetch_existing(service, calendar_id: str) -> list[dict]:
    """Все наши события (source=pspu_schedule), без ограничения по времени."""
    result: list[dict] = []
    page_token = None

    while True:
        resp = service.events().list(
            calendarId=calendar_id,
            privateExtendedProperty=f"source={SOURCE_TAG}",
            singleEvents=True,
            maxResults=2500,
            pageToken=page_token,
        ).execute()

        for item in resp.get("items", []):
            key = item.get("extendedProperties", {}).get("private", {}).get("key")
            if key:
                result.append({"id": item["id"], "key": key, "body": item})

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return result


def _same_content(existing: dict, desired: dict) -> bool:
    a, b = existing["body"], desired["body"]
    for f in ("summary", "location", "description"):
        if (a.get(f) or "") != (b.get(f) or ""):
            return False
    for f in ("start", "end"):
        if a.get(f, {}).get("dateTime") != b[f]["dateTime"]:
            return False
    return True


def _delete_event(service, calendar_id: str, event_id: str) -> None:
    service.events().delete(calendarId=calendar_id, eventId=event_id).execute()


def _insert_event(service, calendar_id: str, body: dict) -> None:
    service.events().insert(calendarId=calendar_id, body=body).execute()


# ---------------------------------------------------------------- основной вход

async def sync_calendar(calendar_id: str = CALENDAR_ID) -> dict:
    desired = build_desired_events()
    if not desired:
        logger.info("Нет желаемых событий — синхронизация пропущена")
        return {"deleted": 0, "created": 0, "total_desired": 0}

    service = get_calendar_service()

    existing = await asyncio.to_thread(_fetch_existing, service, calendar_id)

    existing_by_key = {e["key"]: e for e in existing}
    desired_by_key  = {e["key"]: e for e in desired}

    # что удалить: лишнее или изменившееся
    to_delete = [
        ev for key, ev in existing_by_key.items()
        if key not in desired_by_key or not _same_content(ev, desired_by_key[key])
    ]
    delete_keys = {e["key"] for e in to_delete}

    # что создать: новое или то, что только что удалили
    to_insert = [
        ev for key, ev in desired_by_key.items()
        if key not in existing_by_key or key in delete_keys
    ]

    # --- фаза 1: удаление ---
    for ev in to_delete:
        try:
            await asyncio.to_thread(_delete_event, service, calendar_id, ev["id"])
        except Exception as e:
            logger.error(f"Не удалось удалить {ev['key']}: {e}")

    # --- фаза 2: вставка ---
    created = 0
    for ev in to_insert:
        try:
            await asyncio.to_thread(_insert_event, service, calendar_id, ev["body"])
            created += 1
        except Exception as e:
            logger.error(f"Не удалось вставить {ev['key']}: {e}")

    stats = {
        "deleted":       len(to_delete),
        "created":       created,
        "total_desired": len(desired),
    }
    logger.info(f"Синхронизация календаря: {stats}")
    return stats