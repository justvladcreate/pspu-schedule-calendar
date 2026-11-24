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

Push-уведомления: фронтенд `web/js/notifications.js` + Cloudflare
Worker (`cloudflare/push-worker.js`, деплой вручную). URL задаётся в
`web/js/config.js` через `PUSH_API_BASE`.

ICS-фид: `cloudflare/ics-worker.js` (тоже деплой вручную), ссылки без
факультета (`/g/<группы>`, `/t/<преподаватели>`, `/ics`), имя
календаря — с названием факультета.

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

Фронтенд (в Git — **ветка `data`**, в `main` этих файлов нет):

```text
web/data/index.json                     # список факультетов, версии, группы
web/data/faculties/<id>/data.json       # текущая версия
web/data/faculties/<id>/old_data.json   # предыдущая версия
web/data/faculties/<id>/sheets.json     # список листов «Оригинала»
web/data/faculties/<id>/sheets/*.html   # предрендер листов (имя содержит хэш)
```

Парсер пишет `web/data` в рабочем дереве и публикует его отдельным
коммитом в ветку `data` (рабочее дерево — `.data-branch/`). Pages
собирает сайт из двух веток: код из `main`, данные из `data`.
Так коммиты парсера не мешают правкам кода и не ломают `git pull`.

У окружения `github-pages` политика «деплой только с `main`», поэтому
пуш в `data` сам собрать сайт не может: в ветке лежит
`dispatch-pages.yml`, который запускает `deploy-pages.yml` на `main`
через `workflow_dispatch`. Парсер кладёт этот файл в ветку данных
вместе с `web/data`.

`sheets.json` перечисляет листы всех исходных файлов факультета
(очное, заочное, сессии, ГИА): у каждого есть `id` (`<kind>:<имя>`),
`name`, `kind`, `source` и `file`. Имя файла листа включает хэш
содержимого, поэтому изменившийся лист приходит по новому адресу и
не залипает в кэше браузера; лишние файлы прошлых прогонов удаляются
при рендере.

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
| `utils/rebuild_original.py` | пересборка листов «Оригинала» из скачанных XLSX |
| `utils/usage.py` | отчёт по расходу токенов (`--period`, `--by`) |
| `parser/core/usage.py` | журнал расхода: `data/usage/YYYY-MM.jsonl` |
| `web/` | статический сайт |
| `parser/core/original.py` | рендер листов XLSX в HTML для «Оригинала» |
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
  git commit/push → ветка data (код в main не трогается)
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
      parallel_without_subgroup) уходят в LLM
  → аудитории раскладываются детерминированно, LLM их не меняет
  → finalize → publish
```

Особенность: даты в ячейках без года, а шапка листа часто осталась от
прошлого учебного года. Год берётся из строки с реальным диапазоном
занятий. Если ни на одном листе нет текущего учебного года — файл
считается устаревшим и не публикуется.

Диапазон, начинающийся с «с» (`с 07.10-02.12`), — это даты, а не время;
парсер не должен отрезать его как «с 07:10 до 02:12». Аудитории чистятся:
`Max`/`мах`/`макс` → «дистанционно онлайн», `гл. корп / N` →
`гл. корп. N`, даты, ссылки и ФИО из поля аудитории убираются.

### Заочка (сессия) — `parser/faculties/common/zaoch.py`

Две раскладки, обе разбирает один парсер:

- **строка = занятие** (ИНЭК): `понедельник 14.09.2026 | 5 | 15-15 | Практикум / Кузаев А.Ф. | А-112`;
- **сетка «день / пара»** (матфак): день — в первой паре дня, дата — строкой
  ниже, к ней относятся все пары до следующего дня недели. Занятие бывает
  и в строке с названием дня (та самая «первая пара»), поэтому такие
  строки придерживаются до появления даты.

Номер пары и день недели берутся из времени и самой даты, а не из колонок
(в ИНЭКе `№` иногда пустой). Дата внутри текста («ЗАЧЕТ 20.10.2026г. …»)
важнее даты дня. Одинаковые занятия на разные даты сводятся в одно событие
со списком дат. Даты вне учебного года (`academic_bounds`) отбрасываются:
прошлогоднюю сессию, забытую в файле, публиковать нельзя. Если на листе
есть только чужие годы — группа остаётся без событий (в лог уходит
предупреждение).

Если в имени листа несколько групп («Z151   Z152»), расписание считается
общим: оно публикуется каждой группе из имени. Так бывает, когда две
группы одного курса занимаются вместе — в файле на них один лист.

LLM вызывается только для строк с низкой уверенностью; ответы кэшируются
в `data/faculties/01/latest/llm_cache.json`. Отключить: `PSPU_DISABLE_LLM=1`.

## Веб-приложение

- `data.js`: `loadFacultyIndex()`, `loadFacultyData(id)`,
  `facultyDataUrl(id)`.
- `state.allEvents` хранит **сырые** события; `expandEvents()` вызывается
  после фильтрации.
- «Нагрузка за семестр»: `load-view.js` (карта/шкала) + `load-model.js`
  (пороги и единицы) + `load-details.js` (модалка дня/недели). Клик по
  клетке, номеру недели, столбику шкалы или строке в «Топе дней» открывает
  карточку с занятиями и действиями «В календаре / В таблице».
  «В таблице» уходит событием `pspu:open-original`, его слушает `main.js`
  и открывает «Оригинал» на листе группы. Шкала всегда включает норму
  27 пар в неделю (54 ч), плюс линии «комфорт» и «среднее».
- Фильтр применяется сразу (live): закрытие панели ничего не отменяет.
  Факультеты сужают и группы, и преподавателей (`groupFaculties` /
  `teacherFaculties`); уже отмеченные значения остаются в списке, даже
  если выпали из выбранных факультетов.
- Все фильтры собраны из одних деталей — `filter-core.js`: поиск с
  крестиком, строка-вариант с галочкой, чипы выбранного, чипы факультетов,
  заголовок колонки со счётчиком и «Все/Снять». Отмеченные значения
  остаются в списке на месте. Списки групп делятся на «1 курс», «2 курс», …
  (курс — предпоследняя цифра номера: `1214` → 1, `142` → 4; `M` и `Z`
  на курс не влияют). Главный фильтр (`filters.js`) применяет
  выбор сразу и умеет избранное; настройки уведомлений (`notifications.js`)
  копят выбор до «Готово», а факультеты там только сужают список и в
  подписку не уходят; выбор группы в «Оригинале» (`original.js`) —
  тот же список, но выбор один.
- `original.js` + `original-source.js` — «Оригинал»: Google htmlview или
  предрендеренные листы (`sheets.json` + `sheets/*.html`) с сохранением
  шрифтов, цветов, рамок и объединённых ячеек; при их отсутствии —
  ссылка на cloud.mail. Сверху — чипы факультетов, в полосе листов —
  стрелка выбора группы; последний лист запоминается отдельно для
  каждого факультета. Если в `sheets.json` есть листы, показываем их
  (это приоритетнее Google), а при наличии и Google-таблицы, и
  предрендеренных файлов (у ИНЭКа заочка) — и то, и другое. Список
  листов Google перепроверяется в фоне, чтобы новый лист-группа не ждал
  сутки.
- `sw.js` кэширует статику cache-first, `/data/` — network-first.
  При установке новой версии файлы скачиваются с `cache: 'reload'`, мимо
  HTTP-кэша: иначе GitHub Pages отдавал статику с `max-age`, и в кэш
  попадала смесь нового HTML со старыми модулями (приложение падало на
  импортах). Версия кэша считается от содержимого файлов **и** от кода
  самого `sw.js` (строка `CACHE` исключена), см. `tools/bump-sw.mjs`.
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
- Исходник воркера — `cloudflare/push-worker.js`; после изменений его
  нужно задеплоить в Cloudflare вручную.
- Воркер читает `data/index.json`, сравнивает
  `data/faculties/<id>/data.json` с `data/faculties/<id>/old_data.json`
  и рассылает push по группам/преподавателям. Факультет в подписке не
  хранится: совпадения по названию группы достаточно.
- В `index.json` у факультета есть `folder` (`faculties/<id>`), поля
  `file` нет — путь к данным строится от `index.json`.
- Cron Trigger — каждые 5 минут: `*/5 * * * *` (без пробела после `*`).
  Выражение `5 * * * *` срабатывает раз в час.
- `GET /health` показывает сборку, `indexUrl`, публичный VAPID-ключ и
  блок `parser`: когда данные опубликованы (`generated_at`), каким кодом
  (`version`, `host`) и сколько событий/факультетов. Берётся из
  `index.json`, отдельного health-файла нет;
  `GET /diag` — видит ли воркер `data.json`/`old_data.json` факультетов
  и какие версии лежат в KV.
- `VAPID_SUBJECT` должен быть URI: `mailto:you@example.com`.
- На iPhone push работают только в PWA, добавленном на экран «Домой».

## Окружение и секреты

- `.env` и Google-креды — в `private/` (игнорируется Git).
- LLM: провайдер выбирается `AI_PROVIDER` — `gemini` (Google AI
  Studio напрямую) или `openai` (OpenAI-совместимый шлюз). Рабочая
  конфигурация — DeepSeek: `AI_API_BASE=https://api.deepseek.com`,
  `AI_MODEL=deepseek-flash`, `AI_THINKING=disabled` (у DeepSeek
  thinking включён по умолчанию и съедает весь лимит ответа).
  Модель/список моделей — `AI_MODEL` (старое `GEMINI_MODEL`
  поддерживается); пауза между запросами — `AI_MIN_INTERVAL`;
  таймаут — `AI_TIMEOUT`; лимит ответа — `AI_MAX_TOKENS`.
- Gemini: `GEMINI_API_KEY`, `GEMINI_API_BASE`, `GEMINI_THINKING_BUDGET`
  (0 отключает «размышления»).
- Google Sheets/Drive с hp-server напрямую недоступны, поэтому
  `google_services.py` отправляет их через тот же SOCKS-туннель
  (`ALL_PROXY`). Отключить — `GOOGLE_USE_PROXY=0`.
- `ALL_PROXY` нужен для Google (Gemini и Sheets); DeepSeek/OpenAI-шлюзы
  идут напрямую — `httpx` создаётся с `trust_env=False`.
- `data/usage/YYYY-MM.jsonl` — журнал расхода токенов LLM (в `.gitignore`,
  как и весь `data/`). Пишется в `parser/core/usage.py`, отчёт —
  `python -m utils.usage`. Отключается `USAGE_LOG=0`, каталог меняется
  `USAGE_DIR`, источник (`service` / `manual` / `bench`) — `USAGE_SOURCE`.
- `data/` — рабочие файлы парсера (не коммитить).
- `web/data/` в `main` не отслеживается (`.gitignore`): публикуемые данные
  живут в ветке `data`, её обновляет парсер. Для локального просмотра файлы
  остаются на диске как обычный кэш.
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

# пересборка листов «Оригинала» из скачанных XLSX
.venv\Scripts\python.exe -m utils.rebuild_original
.venv\Scripts\python.exe -m utils.rebuild_original --faculty 01

# расход токенов (журнал data/usage/YYYY-MM.jsonl)
.venv\Scripts\python.exe -m utils.usage --period day
.venv\Scripts\python.exe -m utils.usage --period week --by group
.venv\Scripts\python.exe -m utils.usage --period month --by model

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
- У каждого события есть `updated_at` (ISO UTC). Он меняется только при
  добавлении/изменении события и показывается в поповере как
  «Обновлено 6.11.26 21:02». Поле добавлено в схему v2 (обратносовместимо).
- Не добавлять сборщик/зависимости во фронтенд без необходимости.
- При добавлении JS обновить `web/sw.js` и `tools/bump-sw.mjs`.
- При изменении парсера проверять `pytest` и, если возможно,
  `utils.rebuild_parsed` на существующих данных.
