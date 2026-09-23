from google.auth.exceptions import RefreshError
from pathlib import Path
import logging
import json
import asyncio
import shutil
import subprocess
import hashlib
from parser.rooms_hints import pick_rooms_for_branch, split_branch_by_rooms
from collections import Counter

from parser.ai import ask_ai, user_prompt
from parser.extractor import DataExtractor, delete_old_file
from parser.finalize import transform_schedule
from parser.overrides import load_overrides, apply_overrides
from parser.preprocess import normalize_time

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

OVERRIDES_PATH = current_dir / "overrides.yaml"

WEB_DATA_PATH     = web_dir / "data.json"
WEB_OLD_DATA_PATH = web_dir / "old_data.json"

data_extractor = DataExtractor()


# ---------------------------------------------------------------- io / misc

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
    def _default(o):
        if isinstance(o, set):
            return sorted(o)
        raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")

    text = json.dumps(data, ensure_ascii=False, indent=4, default=_default)
    await asyncio.to_thread(path.write_text, text, encoding="utf-8")


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"Не удалось прочитать {path}: {e}")
        return {}


# ---------------------------------------------------------------- merge helpers

def format_ai_input(sources: list[dict]) -> str:
    """Собирает текст для AI: [1] subj1\\n\\n[2] subj2 ..."""
    return "\n\n".join(f"[{i}] {s['subject']}" for i, s in enumerate(sources, start=1))


def _chunk_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _add_90_minutes(time_start: str) -> str:
    """time_start + 1.5ч в формате HH:MM. Пусто, если не распарсилось."""
    if not time_start:
        return ""
    t = normalize_time(time_start)
    try:
        h, m = map(int, t.split(":"))
    except (ValueError, AttributeError):
        return ""
    total = h * 60 + m + 90
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


def merge_ai_line(
        line: str,
        offset: int,
        sources: list[dict],
        branch_index: int = 0,   # 0-based позиция среди веток своего enumerator
        branch_total: int = 1,   # всего веток для этого enumerator
) -> list[dict]:
    """
    Возвращает список событий — 0, 1 или несколько, если одна AI-строка
    разбилась по разным комнатам (date-hint внутри одной ветки).
    """
    parts = [p.strip() for p in line.split(";")]
    # "-" — плейсхолдер пустого поля из промпта
    parts = ["" if p == "-" else p for p in parts]

    if len(parts) not in (9, 10):
        logger.warning(f"AI: ожидалось 9/10 полей, получено {len(parts)}: {line!r}")
        return []

    try:
        local_n = int(parts[0].strip("[]").strip())
    except ValueError:
        logger.warning(f"AI: не удалось разобрать enumerator: {parts[0]!r}")
        return []

    global_idx = offset + local_n - 1
    if not (0 <= global_idx < len(sources)):
        logger.warning(
            f"AI: enumerator {local_n} вне диапазона "
            f"(offset={offset}, total={len(sources)})"
        )
        return []

    src = sources[global_idx]

    weekday    = parts[1] or src.get("day_of_week", "")
    time_start = parts[2] or src.get("time_start", "")
    time_end   = parts[3] or _add_90_minutes(time_start)
    dates      = parts[4]
    discipline = parts[5]
    type_      = parts[6]
    subgroup   = parts[7]
    teachers   = parts[8]
    rooms_ai   = parts[9] if len(parts) == 10 else ""

    time_start = normalize_time(time_start) if time_start else ""
    time_end   = normalize_time(time_end) if time_end else ""

    # Если AI сам вернул rooms — доверяем полностью, не распределяем.
    # Иначе берём из источника и раскладываем по ветками.
    # ── hints-режим: может разбить одну AI-строку на несколько event'ов ──
    # ── hints-режим: может разбить одну AI-строку на несколько event'ов ──
    # ── rooms не пришли от AI ──
    if not rooms_ai:
        hints = src.get("rooms_hints") or []
        has_overrides = any(r["hint_type"] or r["hint_dates"] for r in hints)

        # Только base (или hints нет) → старая позиционная логика:
        # первая ветка → первая комната, вторая → вторая.
        # Это нужно, когда в Excel две комнаты без хинтов и две ветки —
        # связать их можно только по порядку.
        if not has_overrides:
            rooms = _assign_rooms(
                src.get("rooms", ""),
                branch_index=branch_index,
                branch_total=branch_total,
            )
            return [{
                "weekday":    weekday,
                "time_start": time_start,
                "time_end":   time_end,
                "dates":      dates,
                "discipline": discipline,
                "type":       type_,
                "subgroup":   subgroup,
                "teachers":   teachers,
                "rooms":      rooms,
            }]

        # Есть override'ы → split_branch_by_rooms
        groups = split_branch_by_rooms(hints, type_, dates)
        return [
            {
                "weekday":    weekday,
                "time_start": time_start,
                "time_end":   time_end,
                "dates":      g_dates,
                "discipline": discipline,
                "type":       type_,
                "subgroup":   subgroup,
                "teachers":   teachers,
                "rooms":      g_rooms,
            }
            for g_dates, g_rooms in groups
        ]

    # ── rooms пришли от AI ──
    return [{
        "weekday":    weekday,
        "time_start": time_start,
        "time_end":   time_end,
        "dates":      dates,
        "discipline": discipline,
        "type":       type_,
        "subgroup":   subgroup,
        "teachers":   teachers,
        "rooms":      rooms_ai,
    }]

def _assign_rooms(rooms_str: str, branch_index: int, branch_total: int) -> str:
    """
    Распределяет комнаты по ветками одной ячейки.

      1 комната          → всем ветками эта комната
      M комнат == N веток → каждой ветке своя по позиции
      иначе              → всем ветками все комнаты (fallback)
    """
    if not rooms_str:
        return ""

    rooms_list = [r.strip() for r in rooms_str.split(",") if r.strip()]
    if not rooms_list:
        return ""

    if len(rooms_list) == 1:
        return rooms_list[0]

    if 1 < branch_total == len(rooms_list):
        return rooms_list[branch_index]

    return ", ".join(rooms_list)


# ---------------------------------------------------------------- web / git

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
    """Коммитит web/data.json и web/old_data.json и пушит в текущую ветку."""
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


# ---------------------------------------------------------------- main pipeline

async def process_schedule(
        use_chunks: bool = False,
        chunk_size: int = 30,
        publish_web: bool = True,
        git_push: bool = True,
) -> dict | None:
    """
    Скачать Excel → извлечь → AI + merge → finalize → overrides.

    publish_web=True  — копирует parsed.json в web/data.json и
                        parsed_old.json в web/old_data.json.
    git_push=True     — делает git add/commit/push (только если publish_web=True,
                        иначе пушить нечего).

    main.py      → дефолты (оба True): публикация + пуш как раньше.
    run_local.py → publish_web=True, git_push=False: web/ обновляется,
                   но коммита/пуша нет.
    """
    logger.info(
        f"Начата обработка расписания "
        f"(publish_web={publish_web}, git_push={git_push})"
    )

    if not await handle_excel_files(latest_excel_path, old_excel_path):
        logger.error("Не удалось обработать Excel.")
        return None

    # 1. extractor: {group: {"events": [{day_of_week, time_start, rooms, subject}, ...]}}
    groups_info = await data_extractor.extract(latest_excel_path)

    # 2. AI + merge
    groups_info_after_ai: dict = {}

    old_cache_data = _read_json(chunks_cache_path)
    # ключи — хэши групп, значения — ответы AI
    old_cache: dict[str, list[str]] = old_cache_data.get("entries", {}) or {}

    new_cache: dict[str, list[str]] = {}
    cache_hits = 0
    ai_calls = 0

    for group, group_data in groups_info.items():
        sources: list[dict] = group_data.get("events", [])
        if not sources:
            groups_info_after_ai[group] = {"events": []}
            continue

        # Группа целиком: один ключ = один вызов AI
        ai_input_text = format_ai_input(sources)
        key = _chunk_hash(ai_input_text)

        if key in old_cache:
            lines = old_cache[key]
            cache_hits += 1
            logger.info(f"[skip AI] {group}: cache hit ({len(sources)} ячеек)")
        else:
            prompt_text = user_prompt.format(data=ai_input_text)
            try:
                chunk_result = await ask_ai(prompt=prompt_text)
                if isinstance(chunk_result, list):
                    lines = [e for e in chunk_result if e.strip()]
                else:
                    lines = [e for e in chunk_result.split("\n") if e.strip()]
            except Exception as e:
                logger.error(f"AI ошибка (группа {group}): {e}")
                continue
            ai_calls += 1
            await asyncio.sleep(0.5)

        new_cache[key] = lines

        # merge (branch_index / branch_total уже считаются по всем lines
        # одной группы — сдвига между чанками больше нет)
        merged: list[dict] = []
        enum_counts = Counter()
        for line in lines:
            head = line.split(";", 1)[0].strip()
            try:
                n = int(head.strip("[]").strip())
            except ValueError:
                continue
            enum_counts[n] += 1

        seen: dict[int, int] = {}
        for line in lines:
            head = line.split(";", 1)[0].strip()
            try:
                n = int(head.strip("[]").strip())
            except ValueError:
                items = merge_ai_line(line, 0, sources)
                if items:
                    merged.extend(items)
                continue

            branch_index = seen.get(n, 0)
            seen[n] = branch_index + 1
            branch_total = enum_counts[n]

            items = merge_ai_line(
                line, 0, sources,
                branch_index=branch_index,
                branch_total=branch_total,
            )
            if items:
                merged.extend(items)

        groups_info_after_ai[group] = {"events": merged}

    logger.info(
        f"AI-статистика: {ai_calls} вызовов, {cache_hits} попаданий в кэш"
    )

    await save_data({"entries": new_cache}, chunks_cache_path)

    # 3. промежуточные JSON
    await handle_json_files(groups_info, latest_extracted_path, old_extracted_path)
    await handle_json_files(groups_info_after_ai, latest_after_ai_path, old_after_ai_path)

    # 4. финализация
    parsed = await transform_schedule(groups_info_after_ai)

    # 5. ручные правки
    rules = load_overrides(OVERRIDES_PATH)
    parsed["events"] = await apply_overrides(parsed["events"], rules)

    await handle_json_files(parsed, latest_parsed_path, old_parsed_path)

    # 6. публикация в web/ (копирование)
    if publish_web:
        await sync_web_data(latest_parsed_path, old_parsed_path)
    else:
        logger.info("publish_web=False — пропускаю копирование в web/")

    # 7. git commit + push (только если web/ реально обновлялся)
    if git_push and publish_web:
        await commit_and_push()
    elif git_push and not publish_web:
        logger.warning("git_push=True, но publish_web=False — пушить нечего, пропускаю")
    else:
        logger.info("git_push=False — пропускаю git commit/push")

    logger.info(f"Расписание обработано: {len(parsed['events'])} событий.")
    return parsed