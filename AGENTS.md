# PSPU Schedule Calendar — заметки для агента

## Что это за проект

Парсер расписания ПГГПУ + статический веб-календарь на GitHub Pages.

Два независимых контура:

1. **Парсер (`parser/`, `utils/`, `main.py`)** — забирает Google Sheets или
   XLSX, извлекает занятия, прогоняет их через LLM, финализирует даты и
   публикует `web/data.json` + `web/old_data.json`.
2. **Веб-приложение (`web/`)** — plain ES-модули без сборщика. Читает
   `data.json`, показывает неделю/месяц/день/нагрузку, фильтры, модалки
   изменений и экспорт в календарь. Service worker кэширует статику и
   отдаёт `data.json` по network-first.

Push-уведомления: фронтенд `web/js/notifications.js` + внешний Cloudflare
Worker (в этом репозитории его исходников нет). URL задаётся в
`web/js/config.js` через `PUSH_API_BASE`.

## Основные пути

| Путь | Назначение |
|---|---|
| `main.py` | бесконечный таймер парсера (каждые 15 минут в рабочем окне) |
| `config.py`, `config.yaml` | загрузка `.env`, логирование, тип источника |
| `google_services.py` | OAuth и клиенты Drive/Sheets |
| `parser/process.py` | оркестрация: источник → extractor → AI → finalize → web + git |
| `parser/extractor.py` | разбор листов расписания в события-источники |
| `parser/preprocess.py` | очистка комнат/времени/текста, подготовка дат |
| `parser/dates.py` | **единая** логика дат и учебного года |
| `parser/rooms_hints.py` | распределение аудиторий по ветвям (type/date hints) |
| `parser/finalize.py` | финальные события, `event_id`, `position`, даты |
| `parser/overrides.py` | ручные правки из `overrides.yaml` |
| `utils/run_local.py` | локальный полный прогон без git push |
| `utils/rebuild_parsed.py` | пересборка финального JSON из after_ai без AI |
| `web/` | статический сайт |
| `web/sw.js` | service worker; при добавлении файла обновите `STATIC_ASSETS` |
| `tools/bump-sw.mjs` | хэш-версия SW для CI; при добавлении JS обновите `WATCHED` |
| `tests/` | детерминированные тесты, без реальных вызовов LLM |

## Пайплайн парсера

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
```

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

## Веб-приложение

- ES-модули, без npm/сборки. Точка входа — `web/js/main.js`.
- `state.js` — состояние, localStorage, snapshot/URL-контекст.
- `changes.js` — diff снимков; `changes-modal.js` — отображение изменений.
- `filters.js` — фильтры и избранное.
- `settings.js` — «Персонализация»; `notifications.js` — Web Push.
- `sheet-render.js` — поиск/навигация по iframe оригинальной таблицы.
- `load-view.js` — экран «Нагрузка».
- `sw.js` кэширует статику cache-first, `data.json`/`old_data.json` —
  network-first. После изменения списка файлов обновите `STATIC_ASSETS`.
- GitHub Actions запускает `tools/bump-sw.mjs`, который меняет версию кэша.
  В репозитории `sw.js` должен оставаться с плейсхолдером `v00000000`.

## Push-уведомления

- Публичный VAPID-ключ и URL воркера — `web/js/config.js`.
- Приватный ключ хранится **только** в Cloudflare Secret, не в Git.
- Подписки и настройки групп/преподавателей хранятся в Worker KV.
- Worker по cron сравнивает `data.json` и `old_data.json` и рассылает push.
- На iPhone push работают только в PWA, добавленном на экран «Домой».

## Окружение и секреты

- `.env` и Google-креды — в `private/` (игнорируется Git).
- `data/` — рабочие JSON/кэш парсера (не коммитить).
- `web/data.json` и `web/old_data.json` — публикуемые данные, они в Git.
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
