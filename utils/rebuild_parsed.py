"""
Пересборка финального JSON из groups_info_after_ai.json.

Что делает:
  1. Читает data/latest/groups_info_after_ai.json
  2. Прогоняет через transform_schedule (parser/finalize.py)
  3. Применяет overrides из private/overrides.yaml
  4. Пишет результат в data/latest/groups_info_parsed.json
     (старый parsed.json при этом уезжает в data/old/)

Не трогает ни Excel, ни Google Sheets, ни AI, ни Google Calendar.
Полезно, когда надо переиграть только финализацию/overrides
после ручных правок в after_ai.json или overrides.yaml.

Как запускать:
  • PyCharm: правый клик по файлу → Run 'rebuild_parsed'
  • Из другого кода: `from utils.rebuild_parsed import rebuild_parsed; asyncio.run(rebuild_parsed())`
  • Из консоли (если надо): `python -m utils.rebuild_parsed`
"""
import asyncio
import json
import logging
from pathlib import Path

import config  # noqa: F401  — загружает .env и настраивает логирование

from parser.finalize import transform_schedule
from parser.overrides import load_overrides, apply_overrides
from parser.process import handle_json_files


logger = logging.getLogger(__name__)

# --- пути (совпадают с parser/process.py) ---
BASE_DIR    = Path(__file__).resolve().parent.parent
LATEST_DIR  = BASE_DIR / "data" / "latest"
OLD_DIR     = BASE_DIR / "data" / "old"

AFTER_AI_PATH   = LATEST_DIR / "groups_info_after_ai.json"
PARSED_PATH     = LATEST_DIR / "groups_info_parsed.json"
OLD_PARSED_PATH = OLD_DIR    / "groups_info_parsed.json"

OVERRIDES_PATH  = BASE_DIR / "overrides.yaml"


async def rebuild_parsed() -> int:
    """
    Возвращает количество событий в финальном JSON (0 при ошибке).
    """
    if not AFTER_AI_PATH.exists():
        logger.error(f"Нет файла: {AFTER_AI_PATH}")
        return 0

    logger.info(f"Читаю: {AFTER_AI_PATH.name}")
    try:
        raw = json.loads(AFTER_AI_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.error(f"Не удалось прочитать JSON: {e}")
        return 0

    # 1. Финализация: dict-ы → структурированные события
    logger.info("Применяю transform_schedule (finalize)")
    parsed = await transform_schedule(raw)

    # 2. Overrides поверх расписания
    rules = load_overrides(OVERRIDES_PATH)
    overrides_count = len(rules.get("overrides", []))
    logger.info(f"Применяю overrides: {overrides_count} правил")
    parsed["events"] = await apply_overrides(parsed["events"], rules)

    # 3. Запись с ротацией: старый parsed.json → data/old/
    ok = await handle_json_files(parsed, PARSED_PATH, OLD_PARSED_PATH)
    if not ok:
        logger.error("Не удалось записать parsed.json")
        return 0

    count = len(parsed["events"])
    logger.info(f"Готово. Записано событий: {count} → {PARSED_PATH.name}")
    return count


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )
    try:
        asyncio.run(rebuild_parsed())
    except KeyboardInterrupt:
        logger.info("Прервано по Ctrl+C")