from google.auth.exceptions import RefreshError
from pathlib import Path
import logging
import json
import asyncio
import shutil
import subprocess
import hashlib

from parser.ai import ask_ai, user_prompt
from parser.extractor import DataExtractor, delete_old_file
from parser.finalize import transform_schedule
from parser.overrides import load_overrides, apply_overrides

logger = logging.getLogger(__name__)

current_dir = Path(__file__).resolve().parent.parent

latest_files_path = current_dir / "data" / "latest"
old_files_path    = current_dir / "data" / "old"
latest_files_path.mkdir(parents=True, exist_ok=True)
old_files_path.mkdir(parents=True, exist_ok=True)

web_dir = current_dir / "web"

excel_file_name     = "pspu_schedule.xlsx"
extracted_file_name = "groups_info_extracted_and_cleaned.json"
after_ai_file_name  = "groups_info_after_ai.json"
parsed_file_name    = "groups_info_parsed.json"

latest_excel_path = latest_files_path / excel_file_name
old_excel_path    = old_files_path    / excel_file_name

latest_extracted_path = latest_files_path / extracted_file_name
old_extracted_path    = old_files_path    / extracted_file_name

latest_after_ai_path = latest_files_path / after_ai_file_name
old_after_ai_path    = old_files_path    / after_ai_file_name

latest_parsed_path = latest_files_path / parsed_file_name
old_parsed_path    = old_files_path    / parsed_file_name

chunks_cache_path = latest_files_path / "chunks_cache.json"

OVERRIDES_PATH = current_dir / "private" / "overrides.yaml"

WEB_DATA_PATH     = web_dir / "data.json"
WEB_OLD_DATA_PATH = web_dir / "old_data.json"

data_extractor = DataExtractor()


async def handle_excel_files(latest_excel: Path, old_excel: Path) -> bool:
    try:
        if old_excel.exists():
            if latest_excel.exists() and latest_excel.is_file():
                delete_old_file(latest_excel, old_excel)
            if not (latest_excel.exists() and latest_excel.is_file()):
                await data_extractor.download_file(latest_excel)
        else:
            if latest_excel.exists():
                delete_old_file(latest_excel, old_excel, max_time=0)
            if not (latest_excel.exists() and latest_excel.is_file()):
                await data_extractor.download_file(latest_excel)
        return True
    except PermissionError:
        logger.error("Нет прав на удаление/запись файла расписания.")
        if not (latest_excel.exists() and latest_excel.is_file()):
            await data_extractor.download_file(latest_excel)
        return True
    except RefreshError as e:
        logger.error(f"Credentials OAuth устарели: {e}")
        return False
    except Exception as e:
        logger.error(f"Ошибка при работе с Excel: {e}")
        return False


async def handle_json_files(data, latest_path: Path, old_path: Path) -> bool:
    try:
        if latest_path.exists():
            if old_path.exists():
                old_path.unlink()
            shutil.move(str(latest_path), str(old_path))
        await save_data(data, latest_path)
        return True
    except PermissionError:
        logger.error("Нет прав на запись JSON.")
        if not latest_path.exists():
            await save_data(data, latest_path)
        return True
    except Exception as e:
        logger.error(f"Ошибка при работе с JSON: {e}")
        return False


async def save_data(data, path: Path) -> None:
    text = json.dumps(data, ensure_ascii=False, indent=4)
    await asyncio.to_thread(path.write_text, text, encoding="utf-8")

def _chunk_hash(chunk: list[str]) -> str:
    payload = "\n".join(chunk).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"Не удалось прочитать {path}: {e}")
        return {}

async def sync_web_data(latest: Path, old: Path) -> bool:
    """Копирует свежие parsed-файлы в web/ для публикации через GitHub Actions."""
    try:
        web_dir.mkdir(parents=True, exist_ok=True)

        if latest.exists():
            await asyncio.to_thread(shutil.copyfile, latest, WEB_DATA_PATH)
        else:
            logger.warning(f"Нет файла для web/data.json: {latest}")
            return False

        if old.exists():
            await asyncio.to_thread(shutil.copyfile, old, WEB_OLD_DATA_PATH)
        else:
            logger.warning(f"Нет файла для web/old_data.json: {old}")

        return True
    except Exception as e:
        logger.error(f"Не удалось скопировать данные в web/: {e}")
        return False


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=current_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _sync_commit_and_push() -> bool:
    """Коммитит web/data.json и web/old_data.json и пушит в текущую ветку.

    Возвращает True, если коммит был создан (и пуш прошёл).
    Требует настроенного upstream (git push -u origin <branch> хотя бы раз).
    """
    add = _git("add", "web/data.json", "web/old_data.json")
    if add.returncode != 0:
        logger.error(f"git add: {add.stderr.strip()}")
        return False

    diff = _git("diff", "--cached", "--quiet")
    if diff.returncode == 0:
        logger.info("Нет изменений для коммита")
        return False

    commit = _git("commit", "-m", "chore: update schedule")
    if commit.returncode != 0:
        logger.error(f"git commit: {commit.stderr.strip()}")
        return False

    push = _git("push")
    if push.returncode != 0:
        logger.error(f"git push: {push.stderr.strip()}")
        return False

    logger.info("Расписание закоммичено и запушено — GitHub Actions запустится сам")
    return True


async def commit_and_push() -> bool:
    return await asyncio.to_thread(_sync_commit_and_push)


async def process_schedule(
        use_chunks: bool = False,
        chunk_size: int = 30,
) -> dict | None:
    """Полный цикл: скачать Excel → извлечь → прогнать через AI → собрать финальный JSON."""
    logger.info("Начата обработка расписания")

    if not await handle_excel_files(latest_excel_path, old_excel_path):
        logger.error("Не удалось обработать Excel.")
        return None

    groups_info = await data_extractor.extract(latest_excel_path)
    groups_info_after_ai: dict = {}

    # --- Кэш чанков ---
    old_cache_data = _read_json(chunks_cache_path)
    old_cache: dict[str, list[str]] = {}

    # Если размер чанка изменился с прошлого раза — сбрасываем кэш,
    # иначе старые ключи бессмысленны
    if old_cache_data.get("chunk_size") == chunk_size:
        old_cache = old_cache_data.get("entries", {}) or {}
    else:
        logger.info(
            f"chunk_size изменён "
            f"({old_cache_data.get('chunk_size')} → {chunk_size}), кэш чанков сброшен"
        )

    new_cache: dict[str, list[str]] = {}
    cache_hits = 0
    ai_calls  = 0

    for group, group_data in groups_info.items():
        events_list = group_data.get("events", [])
        if not events_list:
            groups_info_after_ai[group] = {"events": []}
            continue

        current_chunk_size = chunk_size if use_chunks else len(events_list)
        all_events: list[str] = []

        for i in range(0, len(events_list), current_chunk_size):
            chunk = events_list[i:i + current_chunk_size]
            key = _chunk_hash(chunk)

            # --- cache hit ---
            if key in old_cache:
                result_lines = old_cache[key]
                all_events.extend(result_lines)
                new_cache[key] = result_lines
                cache_hits += 1
                logger.info(
                    f"[skip AI] {group} chunk {i // current_chunk_size}: "
                    f"cache hit ({len(chunk)} строк)"
                )
                continue

            # --- cache miss: зовём AI ---
            prompt_text = user_prompt.format(data=str(chunk))
            try:
                chunk_result = await ask_ai(prompt=prompt_text)
                if isinstance(chunk_result, list):
                    result_lines = [e for e in chunk_result if e.strip()]
                else:
                    result_lines = [e for e in chunk_result.split("\n") if e.strip()]
            except Exception as e:
                logger.error(
                    f"AI ошибка (группа {group}, чанк {i // current_chunk_size}): {e}"
                )
                continue

            ai_calls += 1
            all_events.extend(result_lines)
            new_cache[key] = result_lines
            await asyncio.sleep(0.5)

        groups_info_after_ai[group] = {
            "events": [e for e in all_events if e.strip()]
        }

    logger.info(
        f"AI-статистика: {ai_calls} вызовов, {cache_hits} попаданий в кэш"
    )

    # Сохраняем новый кэш (старые ключи автоматически выпали)
    await save_data(
        {"chunk_size": chunk_size, "entries": new_cache},
        chunks_cache_path,
    )

    # Промежуточные JSON (можно отключить, если не нужны)
    await handle_json_files(groups_info, latest_extracted_path, old_extracted_path)
    await handle_json_files(groups_info_after_ai, latest_after_ai_path, old_after_ai_path)

    # Сведение к финальной структуре
    parsed = await transform_schedule(groups_info_after_ai)

    # ручные правки поверх расписания
    rules = load_overrides(OVERRIDES_PATH)
    parsed["events"] = apply_overrides(parsed["events"], rules)

    await handle_json_files(parsed, latest_parsed_path, old_parsed_path)

    # 1. Обновляем web/data.json и web/old_data.json
    await sync_web_data(latest_parsed_path, old_parsed_path)

    # 2. Коммитим и пушим — Actions пересоберёт Pages
    await commit_and_push()

    logger.info(f"Расписание обработано: {len(parsed['events'])} событий.")
    return parsed