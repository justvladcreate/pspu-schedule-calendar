# PSPU Schedule Calendar — заметки для агента

## Что это за проект

Парсер расписания ПГГПУ + статический веб-календарь на GitHub Pages.

Два независимых контура:

1. **Парсер (`parser/`, `utils/`, `main.py`)** — у каждого факультета
   свой модуль разбора в `parser/faculties/<id>_*/`. Общий цикл обходит
   факультеты, финализирует события и публикует
   `web/data/index.json` + `web/data/faculties/<id>/data.json`.
2. **Веб-приложение (`web/`)** — plain ES-модули без сборщика. Читает
   `data/index.json` и папки факультетов, показывает
   неделю/месяц/день/нагрузку, фильтр по факультетам, изменения и
   экспорт в календарь. Service worker кэширует статику и отдаёт JSON
   по network-first.

Push-уведомления: фронтенд `web/js/notifications.js` + внешний Cloudflare
Worker (в этом репозитории его исходников нет). URL задаётся в
`web/js/config.js` через `PUSH_API_BASE`.

## Сейчас в проекте два факультета

| id | Факультет | Источник | Модуль | LLM |
|---|---|---|---|---|
| `12` | ИНЭК | Google Sheets | `parser/faculties/f12_inec/` | да (эталон) |
| `01` | Математический | cloud.mail XLSX | `parser/faculties/f01_math/` | только сомнительные строки |

Остальные факультеты добавляются так:

1. `parser/faculties/<id>_<имя>/parser.py` — наследник `FacultyParser`;
2. `parser/faculties/<id>_<имя>/prompt.py` — свой промпт (может быть
   заготовкой, пока LLM не используется);
3. регистрация в `parser/faculties/__init__.py`;
4. запись в `faculties.yaml`.

## Раскладка данных

Бэкенд (в `.gitignore`):

```text
data/faculties/<id>/
  latest/  source.xlsx  extracted.json  after_ai.json  parsed.json  chunks_cache.json
  old/     те же файлы предыдущего прогона
```

Фронтенд (в Git):

```text
web/data/index.json                     # список факультетов, версии, группы
web/data/faculties/<id>/data.json       # текущая версия
web/data/faculties/<id>/old_data.json   # предыдущая версия
web/data/faculties/<id>/source.xlsx     # оригинал (кладёт CI, не коммитится)
```

`index.json` содержит для каждого факультета `folder`, `groups`,
`events`, `generated_at` и `original` (тип источника + ссылка).

## Основные пути

| Путь | Назначение |
|---|---|
| `main.py` | бесконечный таймер парсера (каждые 15 минут в рабочем окне) |
| `config.py`, `config.yaml` | загрузка `.env`, логирование, тип источника ИНЭК |
| `google_services.py` | OAuth и клиенты Drive/Sheets |
| `faculties.yaml` | реестр факультетов: источник, промпт, вкл/выкл |
| `parser/runner.py` | общий цикл: разбор → финализация → публикация → git |
| `parser/core/` | общая часть: `dates`, `finalize`, `model`, `overrides`, |
|  | `postprocess`, `text`, `publish`, `registry`, `ai` |
| `parser/faculties/base.py` | `FacultyParser`, `FacultyPaths`, JSON-хелперы |
| `parser/faculties/__init__.py` | реестр модулей парсеров |
| `parser/faculties/f12_inec/` | эталон: `parser`, `extractor`, `ai_merge`, |
|  | `prompt`, `rooms_hints`, `text` |
| `parser/faculties/f01_math/` | `parser`, `prompt` |
| `parser/sources/` | Google Sheets, XLSX, cloud.mail |
| `utils/run_local.py` | локальный прогон по факультетам (флаги `--faculty`, |
|  | `--no-publish`, `--git-push`, `--source`, `--list`) |
| `utils/rebuild_parsed.py` | пересборка `parsed.json` из `after_ai.json` |
| `web/` | статический сайт |
| `web/vendor/xlsx.mini.min.js` | SheetJS для «Оригинала» XLSX (лениво) |
| `tools/fetch-faculty-xlsx.mjs` | CI: скачивает исходные XLSX в артефакт Pages |
| `web/sw.js` | service worker; при добавлении файла обновите `STATIC_ASSETS` |
| `tools/bump-sw.mjs` | хэш-версия SW для CI; при добавлении JS обновите `WATCHED` |
| `tests/` | детерминированные тесты, без реальных вызовов LLM |

## Пайплайн

```text
process_all()
  для каждого факультета из faculties.yaml:
    parser = get_parser_class(id)(faculty)
    sheets = await parser.load()
    groups = await parser.parse(sheets, period)
    if parser.uses_llm: groups = await parser.refine(groups, period)
    parsed = transform_schedule(groups, faculty_id=id)
    overrides.apply_overrides()
    если события изменились → rotate(latest) + write parsed.json
  publish() → index.json + web/data/faculties/<id>/{data,old_data}.json
  git commit/push
```

### ИНЭК (эталон, не менять без нужды)

```text
Google Sheets → extractor.extraction()
  → format_ai_input() → ask_ai() → merge_ai_line()
  → after_ai.json → finalize → publish
```

### 01 (математический)

```text
cloud.mail XLSX → лист на группу
  → поиск актуального учебного года по всем листам
      (строка «01.09.2026-16.01.2027» важнее шапки «2 семестр 2025 - 2026»)
  → строки «даты + дисциплина + (форма) + пг N / ФИО»
  → confidence по каждой строке
  → только сомнительные (dates_unparsed, teacher_unparsed,
      rooms_mismatch, parallel_without_subgroup) уходят в LLM
  → finalize → publish
```

Особенность: даты в ячейках без года, а шапка листа часто осталась от
прошлого учебного года. Год берётся из строки с реальным диапазоном
занятий. Если ни на одном листе нет текущего учебного года — файл
считается устаревшим и не публикуется.

LLM вызывается только для строк с низкой уверенностью; ответы кэшируются
в `data/faculties/01/latest/llm_cache.json`. Отключить: `PSPU_DISABLE_LLM=1`.

## Веб-приложение

- `data.js`: `loadFacultyIndex()`, `loadFacultyData(id)`,
  `facultyDataUrl(id)`.
- `state.allEvents` хранит **сырые** события; `expandEvents()` вызывается
  после фильтрации.
- `original.js` + `original-source.js` — «Оригинал»: Google htmlview или
  SheetJS по `data/faculties/<id>/source.xlsx`; при отсутствии файла —
  ссылка на cloud.mail.
- `sw.js` кэширует статику cache-first, `/data/` — network-first.
- После добавления JS обновите `STATIC_ASSETS` и `WATCHED`.

## Важные правила

- Год учебного года берётся из **дат в круглых скобках** шапки, а не из
  `2025/2026`: см. `parser/dates.semester_start_year_from_header()`.
- Сентябрь–декабрь относится к году начала учебного года, январь–август —
  к следующему: `parser/dates.resolve_year()`.
- Не дублируйте разбор дат в других модулях — используйте `parser/core/dates.py`.
- Прошлые учебные годы не публикуются: даты фильтруются по границам
  учебного года (`AcademicPeriod.academic_bounds`).
- Если события факультета не изменились, его `data.json` не перезаписывается,
  `generated_at` остаётся прежним.
- Ошибка разбора одного факультета не убирает его с сайта: публикуется
  последняя версия из `web/data/faculties/<id>/data.json`.
- LLM никогда не должна придумывать данные. Промпт — в модуле факультета.

## Push-уведомления

- Публичный VAPID-ключ и URL воркера — `web/js/config.js`.
- Приватный ключ хранится **только** в Cloudflare Secret, не в Git.
- Воркер читает `data/index.json`, сравнивает `faculties/<id>/data.json`
  с `faculties/<id>/old_data.json` и рассылает push по группам/преподавателям.
- На iPhone push работают только в PWA, добавленном на экран «Домой».

## Окружение и секреты

- `.env` и Google-креды — в `private/` (игнорируется Git).
- `data/` — рабочие файлы парсера (не коммитить).
- `web/data/index.json`, `web/data/faculties/<id>/*.json` — публикуемые
  данные, они в Git.
- `web/data/faculties/<id>/source.xlsx` — **не коммитить**: кладёт CI.
- Не коммитить `private/`, `.venv/`, `data/`, `__pycache__/`, `.idea/`.

## Команды

```bash
# тесты
.venv\Scripts\python.exe -m pytest
# или (Linux/macOS)
.venv/bin/python -m pytest

# локальный прогон по всем факультетам (их модулями), без git push
.venv\Scripts\python.exe -m utils.run_local
.venv\Scripts\python.exe -m utils.run_local --list
.venv\Scripts\python.exe -m utils.run_local --faculty 01
.venv\Scripts\python.exe -m utils.run_local --no-publish
.venv\Scripts\python.exe -m utils.run_local --git-push

# пересборка parsed.json из after_ai.json без AI и сети
.venv\Scripts\python.exe -m utils.rebuild_parsed
.venv\Scripts\python.exe -m utils.rebuild_parsed --faculty 01

# таймер парсера
.venv\Scripts\python.exe main.py

# версия service worker (делает CI, локально — при необходимости)
node tools/bump-sw.mjs --root web
```

## Тесты

- `tests/` — детерминированные unit-тесты, реальный LLM не вызывается.
- Основные зоны: даты/учебный год, комнаты, merge AI-строк, finalize,
  overrides, источники, postprocess, реестр факультетов, публикация.
- Тесты не должны зависеть от текущей календарной даты: передавайте
  `semester_start_year` или используйте явные годы.
- Для приватных функций тесты импортируют их напрямую — это осознанно.

## Стиль изменений

- Сначала сохранить поведение, потом уменьшать код.
- Не менять публичные форматы `data.json` без версии схемы.
- Не добавлять сборщик/зависимости во фронтенд без необходимости.
- При добавлении JS обновить `web/sw.js` и `tools/bump-sw.mjs`.
- При изменении парсера проверять `pytest` и, если возможно,
  `utils.rebuild_parsed` на существующих данных.
