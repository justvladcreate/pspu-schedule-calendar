# PSPU Schedule Calendar — заметки для агента

## Что это за проект

Парсер расписания ПГГПУ + статический веб-календарь на GitHub Pages.

Два независимых контура:

1. **Парсер (`parser/`, `utils/`, `main.py`)** — забирает Google Sheets или
   XLSX, извлекает занятия, прогоняет их через LLM, финализирует даты и
   публикует `web/data/index.json` + `web/data/faculties/<id>.json`
   (плюс исходные `faculties/<id>.xlsx` для «Оригинала»).
2. **Веб-приложение (`web/`)** — plain ES-модули без сборщика. Читает
   `data/index.json` и файлы факультетов, показывает
   неделю/месяц/день/нагрузку, фильтры (включая фильтр по факультетам),
   модалки изменений и экспорт в календарь. Service worker кэширует
   статику и отдаёт JSON по network-first.

Расписание теперь **мультифакультетное**: у каждого факультета своя
таблица, свой адаптер разбора и свой профиль промпта. Реестр —
`faculties.yaml`.

Push-уведомления: фронтенд `web/js/notifications.js` + внешний Cloudflare
Worker (в этом репозитории его исходников нет). URL задаётся в
`web/js/config.js` через `PUSH_API_BASE`.

## Основные пути

| Путь | Назначение |
|---|---|
| `main.py` | бесконечный таймер парсера (каждые 15 минут в рабочем окне) |
| `config.py`, `config.yaml` | загрузка `.env`, логирование, тип источника ИНЭК |
| `google_services.py` | OAuth и клиенты Drive/Sheets |
| `faculties.yaml` | реестр факультетов: источник, адаптер, промпт, вкл/выкл |
| `parser/faculties.py` | загрузка реестра в `AcademicPeriod` / `Faculty` |
| `parser/model.py` | `Faculty`, `RawBranch`, `ParseResult`, `AcademicPeriod` |
| `parser/adapters/` | адаптеры форматов таблиц (`base`, `vertical`, `paired_columns`) |
| `parser/pipeline.py` | разбор одного факультета и всех сразу (`parse_all`) |
| `parser/repair.py` | LLM-проверка спорных ячеек по `confidence` |
| `parser/publish.py` | публикация `index.json` + `faculties/<id>.json` + `.xlsx` |
| `parser/sources/cloud_mail.py` | скачивание XLSX с публичных ссылок cloud.mail.ru |
| `parser/process.py` | оркестрация ИНЭК: источник → extractor → AI → finalize → web + git |
| `parser/extractor.py` | разбор листов ИНЭК в события-источники |
| `parser/preprocess.py` | очистка комнат/времени/текста, подготовка дат |
| `parser/dates.py` | **единая** логика дат и учебного года |
| `parser/rooms_hints.py` | распределение аудиторий по ветвям (type/date hints) |
| `parser/finalize.py` | финальные события, `event_id`, `position`, даты |
| `parser/overrides.py` | ручные правки из `overrides.yaml` |
| `utils/run_local.py` | локальный полный прогон без git push |
| `utils/rebuild_parsed.py` | пересборка финального JSON из after_ai без AI |
| `web/` | статический сайт |
| `web/data/` | опубликованные данные факультетов (в Git) |
| `web/vendor/xlsx.mini.min.js` | SheetJS для «Оригинала» XLSX (грузится лениво) |
| `tools/fetch-faculty-xlsx.mjs` | CI: скачивает исходные XLSX в артефакт Pages |
| `utils/report_confidence.py` | отчёт о сомнительных местах разбора |
| `web/sw.js` | service worker; при добавлении файла обновите `STATIC_ASSETS` |
| `tools/bump-sw.mjs` | хэш-версия SW для CI; при добавлении JS обновите `WATCHED` |
| `tests/` | детерминированные тесты, без реальных вызовов LLM |

## Пайплайн ИНЭК (эталон, не менять без нужды)

```text
ScheduleSource.load()
  → SheetData (df, links, colors)
  → extractor.extraction()        # группы и события-источники
  → format_ai_input()             # [1] ..., [2] ...
  → ask_ai()                      # строки "..." с разделителем ;
  → merge_ai_line()               # поля, комнаты, цвета, is_past
  → finalize.transform_schedule() # даты, пары, event_id, position
  → overrides.apply_overrides()   # ручные правки
  → web/data.json + web/old_data.json
  → publish_web_faculties()       # index.json + faculties/*.json
```

## Пайплайн XLSX-факультетов

```text
build_source(faculty)             # google_sheets | cloud_mail (кэш в data/faculties/)
  → adapter.parse(sheets)         # детерминированный разбор → RawBranch[]
  → repair_branches()             # только ветки с низким confidence → LLM
  → branches_to_groups_info()
  → finalize.transform_schedule(faculty_id=...)
  → publish_faculty_data()        # JSON + XLSX для «Оригинала»
```

`RawBranch` хранит `confidence` и `issues`. Правила:

- `confidence >= 0.9` — ветка считается разобранной и в LLM не идёт.
- LLM не может придумать данные: её ответ сверяется с `source_text`
  (ФИО должно быть в исходной ячейке) и с границами учебного года.
- Если LLM недоступна, публикуется детерминированный вариант.


### Важные правила

- Год учебного года берётся из **дат в круглых скобках** шапки, а не из
  `2025/2026`: см. `parser/dates.semester_start_year_from_header()`.
- Сентябрь–декабрь относится к году начала учебного года, январь–август —
  к следующему: `parser/dates.resolve_year()`.
- Не дублируйте разбор дат в других модулях — используйте `parser.dates`.
- `old_data.json` — предыдущая версия; на ней построен diff изменений и
  fallback для офлайна.
- Если события не изменились, `process_schedule()` не перезаписывает файлы
  и не коммитит.
- LLM никогда не должна придумывать данные. Промпт — `parser/prompts.py`.
- Файлы прошлых учебных годов отсекаются по датам: ветка, у которой все
  даты вне текущего учебного года, не публикуется
  (`VerticalAdapter._drop_stale`).
- Занятие без дат повторяется каждую неделю до конца семестра, но не
  пересекается с уже занятыми датами (`_fill_weekly_gaps`).

## Веб-приложение

- ES-модули, без npm/сборки. Точка входа — `web/js/main.js`.
- `state.js` — состояние, localStorage, snapshot/URL-контекст.
- `changes.js` — diff снимков; `changes-modal.js` — отображение изменений.
- `filters.js` — фильтры (факультеты/группы/преподаватели) и избранное.
- `settings.js` — «Персонализация»; `notifications.js` — Web Push.
- `original.js` + `original-source.js` — «Оригинал»: Google htmlview или
  XLSX через SheetJS (`web/vendor/xlsx.mini.min.js`, грузится лениво).
- `sheet-render.js` — поиск/навигация по iframe оригинальной таблицы.
- `load-view.js` — экран «Нагрузка».
- `data.js` API: `loadFacultyIndex()`, `loadFacultyData(id)`.
- `state.allEvents` хранит **сырые** события; `expandEvents()` вызывается
  после фильтрации (иначе на телефоне слишком много объектов).
- `sw.js` кэширует статику cache-first, JSON (`data.json`,
  `data/index.json`, `data/faculties/*`) — network-first. После изменения
  списка файлов обновите `STATIC_ASSETS`.
- GitHub Actions запускает `tools/bump-sw.mjs`, который меняет версию кэша.
  В репозитории `sw.js` должен оставаться с плейсхолдером `v00000000`.

## Push-уведомления

- Публичный VAPID-ключ и URL воркера — `web/js/config.js`.
- Приватный ключ хранится **только** в Cloudflare Secret, не в Git.
- Подписки и настройки групп/преподавателей хранятся в Worker KV.
- Worker по cron сравнивает `data.json` и `old_data.json` и рассылает push
  (пока только по ИНЭК — см. «Известные ограничения»).
- На iPhone push работают только в PWA, добавленном на экран «Домой».

## Известные ограничения

- `web/data.json` / `old_data.json` остаются ради обратной совместимости и
  push-воркера, но содержат только ИНЭК. Остальные факультеты — в
  `web/data/faculties/`.
- Исходные XLSX **не хранятся в Git**: CI (`tools/fetch-faculty-xlsx.mjs`)
  скачивает их с cloud.mail.ru в артефакт GitHub Pages. Если файла нет,
  «Оригинал» предлагает открыть ссылку на облако.
- `parser/repair.py` включает LLM только для веток с `confidence < 0.9`;
  без `OLLAMA_API_KEY` публикуется детерминированный вариант.
- Сводка сомнительных мест: `python -m utils.report_confidence`.


## Окружение и секреты

- `.env` и Google-креды — в `private/` (игнорируется Git).
- `data/` — рабочие JSON/кэш парсера (не коммитить).
- `data/faculties/*.xlsx` — локальный кэш скачанных таблиц.
- `web/data/index.json`, `web/data/faculties/*.json` — публикуемые данные, в Git.
- `web/data/faculties/*.xlsx` — **не коммитить**: их кладёт CI при деплое.
- Не коммитить `private/`, `.venv/`, `data/`, `__pycache__/`, `.idea/`.

## Команды

```bash
# тесты
.venv\Scripts\python.exe -m pytest
# или (Linux/macOS)
.venv/bin/python -m pytest

# локальный полный прогон парсера
.venv\Scripts\python.exe -m utils.run_local

# пересборка final JSON без AI и Google
.venv\Scripts\python.exe -m utils.rebuild_parsed

# разбор всех XLSX-факультетов без сети (использует кэш data/faculties)
# см. parser.pipeline.parse_all(repair=False)

# отчёт о сомнительных местах разбора
.venv\Scripts\python.exe -m utils.report_confidence
.venv\Scripts\python.exe -m utils.report_confidence --faculty 06 --json report.json

# таймер парсера
.venv\Scripts\python.exe main.py

# версия service worker (делает CI, локально — при необходимости)
node tools/bump-sw.mjs --root web
```

## Тесты

- `tests/` — детерминированные unit-тесты. Реальный LLM не вызывается.
- Основные зоны: даты/учебный год, комнаты, merge AI-строк, finalize,
  overrides, источники, postprocess.
- Тесты не должны зависеть от текущей календарной даты: передавайте
  `semester_start_year` или используйте явные годы.
- Для приватных функций (`_add_90_minutes`, `_assign_rooms`) тесты
  импортируют их напрямую — это осознанно.

## Стиль изменений

- Сначала сохранить поведение, потом уменьшать код.
- Не менять публичные форматы `data.json` без версии схемы.
- Не добавлять сборщик/зависимости во фронтенд без необходимости.
- При добавлении JS-файла обновить `web/sw.js` (`STATIC_ASSETS`) и
  `tools/bump-sw.mjs` (`WATCHED`).
- При изменении парсера проверять `pytest` и, если возможно, прогон
  `utils.rebuild_parsed` на существующих данных.
