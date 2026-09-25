# [file name]: preprocess.py
import re
from typing import Union, List, Dict, Any, Tuple
from datetime import date

# ---------- Константы для очистки ----------
CLEAN_REPLACEMENTS = {
    "\\": "", "\"": "", "“": "", "”": "", "«": "", "»": "",
    ";": " ",                                   # запрещаем разделитель AI
    "+": " ",                                   # мусорный префикс дисциплины
    "—": "-", "–": "-", "−": "-", "‐": "-", "‑": "-",
    "`": "'", "´": "'",
    "„": "", "‚": "",
    "…": "...", "•": "*", "⋅": "*", "◦": "*"
}

# Предварительная компиляция регулярных выражений для производительности
_MULTIPLE_SPACES_RE = re.compile(r"\s+")
_MULTIPLE_DOTS_RE = re.compile(r"\.{2,}")
_MULTIPLE_DASHES_RE = re.compile(r"-{2,}")
_MULTIPLE_COMMAS_RE = re.compile(r",{2,}")
_CLEAN_PUNCTUATION_RE = re.compile(r"([!?])\1+")

# ---------- Основные функции очистки ----------
def clean(text: Union[str, None]) -> str:
    """Основная функция очистки строки от мусорных символов и лишних пробелов"""
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)

    text = _replace_chars(text)
    text = _clean_with_regex(text)
    text = _normalize_spaces(text)
    return text.strip()

def _replace_chars(text: str) -> str:
    """Замена символов по словарю CLEAN_REPLACEMENTS"""
    trans_table = str.maketrans(CLEAN_REPLACEMENTS)
    return text.translate(trans_table)

def _clean_with_regex(text: str) -> str:
    """Применение регулярных выражений для схлопывания повторов"""
    text = text.replace("*", "•")
    text = _MULTIPLE_SPACES_RE.sub(" ", text)
    text = _MULTIPLE_DOTS_RE.sub(".", text)
    text = _MULTIPLE_DASHES_RE.sub("-", text)
    text = _MULTIPLE_COMMAS_RE.sub(",", text)
    text = _CLEAN_PUNCTUATION_RE.sub(r"\1", text)
    return text.strip()

def _normalize_spaces(text: str) -> str:
    """Нормализует пробелы вокруг знаков препинания, но не трогает даты вида число.число"""
    # Защищаем даты вида ДД.ММ или ДД.ММ.ГГГГ от разбиения
    date_pattern = r'\d{1,2}\.\d{2}(?:\.\d{4})?'
    text = re.sub(date_pattern, lambda m: m.group(0).replace('.', '\x00'), text)

    # Добавляем пробел после знака, если его нет
    text = re.sub(r'([,!?;])(\S)', r'\1 \2', text)
    # Убираем лишний пробел перед знаком
    text = re.sub(r'\s+([.,!?;:])', r'\1', text)
    # Добавляем пробел после точки, если за ней не пробел и не цифра (чтобы не разбивать даты)
    text = re.sub(r'\.([А-Яа-яA-Za-z])', r'. \1', text)

    # Восстанавливаем даты
    text = text.replace('\x00', '.')
    return text

def normalize_rooms(line: str, url: str | None = None) -> List[str]:
    """
    Нормализует строку с аудиториями в список уникальных аудиторий.

    Особенности:
      • Разбивает по переносам строк и запятым.
      • Убирает кавычки.
      • Схлопывает множественные пробелы, убирает слеши.
      • "дистанционно <что угодно>" → "дистанционно онлайн"
        или "дистанционно СФЕРУМ".
      • Убирает дубликаты, сохраняя порядок первого появления.
      • Мусорные значения ("-", "нет", "n/a", "н/д") — отбрасываются.
      • Если передан url — markdown-ссылка [дистанционно онлайн](url)
        привязывается ТОЛЬКО к первой дистанционной записи.
        Если дистанционной записи нет, url игнорируется.
    """
    if line is None:
        return []

    text = str(line)
    if not text.strip():
        return []

    # 1. Убираем кавычки
    for ch in ('"', '«', '»', '“', '”'):
        text = text.replace(ch, ' ')

    # 2. Разбиваем по переносам строк и запятым (СЛЕШИ пока не трогаем)
    raw_parts = re.split(r'[\n\r,]+', text)

    JUNK = {
        "-", "—", "–",
        "нет",
        "n/a", "n a",
        "н/д", "н д",
        "n\\a", "n a",
    }

    # 3. Первый проход: чистим и дедуплицируем БЕЗ url
    rooms_clean: List[str] = []
    seen: set = set()

    for part in raw_parts:
        room = re.sub(r'\s+', ' ', part).strip()
        if not room:
            continue

        low = room.lower()
        if low in JUNK:
            continue

        room = room.replace('\\', ' ').replace('/', ' ')
        room = re.sub(r'\s+', ' ', room).strip()
        if not room:
            continue

        low = room.lower()

        if low.startswith('дистанционно'):
            room = "дистанционно онлайн"
        else:
            room = re.sub(r'\b([IVX]+)\s*к\.\s*', r'\1 к. ', room)
            room = re.sub(r'\s+', ' ', room).strip()

        if room and room not in seen:
            seen.add(room)
            rooms_clean.append(room)

    # 4. Второй проход: привязываем url ТОЛЬКО к первой дистанционной записи
    if url:
        for i, r in enumerate(rooms_clean):
            if r.startswith("дистанционно"):
                rooms_clean[i] = f"[{r}]({url})"
                break

    return rooms_clean

def normalize_time(time_str: str) -> str:
    """
    Нормализует время из формата H-M, H:M, H.M, H M в HH:MM.
    Если встречается диапазон вида "14.00-15.00" или "14:00 – 15:00",
    берётся только начало (первое время).
    Примеры:
      "9-45"          -> "09:45"
      "12-30"         -> "12:30"
      "14.00"         -> "14:00"
      "14.00-15.00"   -> "14:00"
      "14:00 – 15:00" -> "14:00"
    """
    if not isinstance(time_str, str):
        return str(time_str)

    # Отрезаем вторую часть, если это полный диапазон времени.
    # Одиночный дефис в "9-45" не трогаем — там обе стороны не являются
    # полным временем с минутами.
    time_str = re.sub(
        r'(\d{1,2}[.:]\d{2})\s*[-–—]\s*\d{1,2}[.:]\d{2}',
        r'\1',
        time_str,
    )
    time_str = time_str.strip()

    # Ищем два числа, разделённые нецифровым символом
    match = re.search(r'(\d{1,2})\D+(\d{1,2})', time_str)
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2))
        # Только если час и минута в допустимых пределах
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"
    # Если не подошло — возвращаем без изменений
    return time_str

def english_to_russian_lookalike(text: str) -> str:
    """
    Заменяет одиночные латинские буквы на похожие русские,
    но не трогает целые слова (последовательности из двух и более латинских букв).
    """
    mapping = {
        # Заглавные
        'A': 'А', 'B': 'В', 'C': 'С', 'E': 'Е', 'H': 'Н',
        'I': 'І', 'J': 'Ј', 'K': 'К', 'M': 'М', 'O': 'О',
        'P': 'Р', 'T': 'Т', 'W': 'Ш', 'X': 'Х', 'Y': 'У',
        # Строчные
        'a': 'а', 'b': 'ь', 'c': 'с', 'e': 'е', 'i': 'і',
        'j': 'ј', 'k': 'к', 'm': 'м', 'o': 'о', 'p': 'р',
        'w': 'ш', 'x': 'х', 'y': 'у',
    }

    # Паттерн находит любую последовательность латинских букв
    pattern = re.compile(r'[A-Za-z]+')

    def replacer(match: re.Match) -> str:
        word = match.group(0)
        if len(word) == 1:
            # Одиночная буква – заменяем, если есть аналог
            return mapping.get(word, word)
        else:
            # Слово или аббревиатура – оставляем как есть
            return word

    return pattern.sub(replacer, text)


_DATE       = r'\d{1,2}\.\d{2}(?:\.\d{4})?'
_DATE_PLAIN = r'\d{1,2}\.\d{2}'


def _parse(t: str) -> tuple[int, int, int | None]:
    parts = t.split(".")
    return int(parts[0]), int(parts[1]), int(parts[2]) if len(parts) == 3 else None


def _is_valid(day: int, month: int, year: int | None = None) -> bool:
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return False
    if month in (4, 6, 9, 11) and day > 30:
        return False
    if month == 2 and day > 29:
        return False
    if year and month == 2 and day == 29:
        if not (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)):
            return False
    return True


def normalize_date_ranges(text: str, default_end_date: str = None) -> str:
    # 1. Единый разделитель
    text = re.sub(rf'({_DATE})\s*[-–—]\s*({_DATE})', r'\1 - \2', text)
    # 2. Точка в конце даты
    text = re.sub(rf'({_DATE})\.(?=\s|$|[,–—\-])', r'\1', text)
    # 3. "с X - Y" -> "X - Y"
    text = re.sub(
        rf'\b[сc]\s+({_DATE})\s*[-–—]\s*({_DATE})',
        r'\1 - \2', text, flags=re.I,
    )
    if default_end_date:
        # 4a. висячий дефис — только если после него НЕ идёт ни цифра,
        # ни буква (кириллица/латиница). Если идёт буква — это не диапазон,
        # а разделитель полей ("30.11, 7.12 - лаб. п/г 1").
        text = re.sub(
            rf'\b(?:[сc]\s+)?({_DATE})\s*[-–—](?!\s*[\dA-Za-zА-Яа-яЁё])',
            rf'\1 - {default_end_date}',
            text, flags=re.I,
        )
        # 4b. "с X" без диапазона
        text = re.sub(
            rf'\b[сc]\s+({_DATE})(?!\s*[-–—]\s*\d)',
            rf'\1 - {default_end_date}', text, flags=re.I,
        )
    else:
        # 4c. "с X" -> "X"
        text = re.sub(rf'\b[сc]\s+({_DATE})', r'\1', text, flags=re.I)
    # 5. Оставшийся висячий дефис
    text = re.sub(rf'({_DATE})\s*[-–—]\s*(?![0-9])', r'\1', text)
    # 6. Две даты через пробел
    text = re.sub(rf'({_DATE})\s+({_DATE})', r'\1 - \2', text)
    # 7. Чистка пробелов
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'(\d{1,2}\.\d{2})([А-Яа-я])', r'\1 \2', text)
    return text


def remove_invalid_dates(text: str) -> str:
    """
    Убирает невалидные даты (31.02, 32.11 и т.п.).
    Диапазоны с "перевёрнутым" порядком ("10.11 - 18.01") считаются валидными —
    это переход через новый год, а не ошибка.
    """
    def range_repl(m: re.Match) -> str:
        a, b = m.group(1), m.group(2)
        d1, m1, y1 = _parse(a)
        d2, m2, y2 = _parse(b)
        return f"{a} - {b}" if _is_valid(d1, m1, y1) and _is_valid(d2, m2, y2) else ""

    text = re.sub(rf'({_DATE})\s*[-–—]\s*({_DATE})', range_repl, text)

    def single_repl(m: re.Match) -> str:
        d, mo, y = _parse(m.group(1))
        return m.group(1) if _is_valid(d, mo, y) else ""

    text = re.sub(rf'\b({_DATE})\b(?!\s*[-–—])', single_repl, text)

    # уборка остатков
    text = re.sub(r'\b[сc]\s+', '', text, flags=re.I)
    text = re.sub(r',\s*,', ',', text)
    text = re.sub(r',\s*$', '', text)
    text = re.sub(r'^\s*,', '', text)
    text = re.sub(r'\s*,\s*', ', ', text)
    return re.sub(r'\s+', ' ', text).strip()


def _infer_semester_start_year(text: str, current_calendar_year: int) -> int:
    """
    Год начала учебного семестра (сентябрь).

    Приоритет:
      1. Явная дата с годом внутри самого текста:
         месяц 9-12 → год начала семестра = этот год;
         месяц 1-8  → год начала семестра = этот год минус 1
                      (январь-август относится к весне того же уч. года).
      2. Fallback по сегодняшней дате:
         сентябрь-декабрь → текущий календарный год;
         январь-август    → предыдущий год.
    """
    best: int | None = None
    for m in re.finditer(rf'\b({_DATE})\b', text):
        parts = m.group(1).split(".")
        if len(parts) != 3:
            continue
        try:
            mo, y = int(parts[1]), int(parts[2])
        except ValueError:
            continue
        candidate = y if mo >= 9 else y - 1
        if best is None or candidate > best:
            best = candidate

    if best is not None:
        return best

    today = date.today()
    return current_calendar_year if today.month >= 9 else current_calendar_year - 1


def add_year(text: str, current_year: int | None = None) -> str:
    """
    Проставляет год к каждой дате.

    Учитывает, что учебный семестр начинается в сентябре и пересекает
    границу календарного года: сентябрь-декабрь — год начала семестра,
    январь-август — следующий год.

    Контекст семестра определяется так:
      1. Если в тексте уже есть явная дата с годом — берём её как якорь.
      2. Иначе — по сегодняшней дате (сентябрь-декабрь → текущий год,
         январь-август → предыдущий).

    "10.11 - 18.01"   -> "10.11.2026 - 18.01.2027"
    "15.09 - 13.10"   -> "15.09.2026 - 13.10.2026"
    "05.11 - 03.12, 14.01, 21.01, 28.01"
                      -> "05.11.2026 - 03.12.2026, 14.01.2027, 21.01.2027, 28.01.2027"
    "24.10.2026"      -> "24.10.2026"
    """
    if current_year is None:
        current_year = date.today().year

    semester_start_year = _infer_semester_start_year(text, current_year)

    def resolve_year(month: int) -> int:
        # Сентябрь-декабрь → год начала семестра.
        # Январь-август    → следующий год.
        return semester_start_year if month >= 9 else semester_start_year + 1

    def range_repl(m: re.Match) -> str:
        a, b = m.group(1), m.group(2)
        d1, m1, y1 = _parse(a)
        d2, m2, y2 = _parse(b)

        year1 = y1 if y1 is not None else resolve_year(m1)

        if y2 is not None:
            year2 = y2
        elif (m2, d2) < (m1, d1):
            # Классический переход через новый год внутри диапазона.
            year2 = year1 + 1
        elif m1 >= 9 and m2 < 9:
            # Осенне-зимний диапазон: сентябрь-декабрь → январь-август.
            year2 = year1 + 1
        else:
            year2 = year1

        return f"{d1:02d}.{m1:02d}.{year1} - {d2:02d}.{m2:02d}.{year2}"

    text = re.sub(rf'({_DATE})\s*[-–—]\s*({_DATE})', range_repl, text)

    def single_repl(m: re.Match) -> str:
        full = m.group(0)
        parts = full.split(".")
        if len(parts) == 3:
            return full                       # год уже есть
        d, mo = int(parts[0]), int(parts[1])
        return f"{d:02d}.{mo:02d}.{resolve_year(mo)}"

    text = re.sub(rf'\b{_DATE}\b', single_repl, text)
    return text

def extract_first_date(text: str) -> str:
    """
    Извлекает первую дату в формате ДД.ММ (или ДД.ММ.ГГГГ) из строки.
    Пример: "Экзаменационная сессия: 29.06 – 4.07.2026" -> "29.06"
    """
    match = re.search(r'\b(\d{1,2}\.\d{2})(?:\.\d{4})?\b', text)
    if match:
        return match.group(1)  # возвращаем только основную часть (ДД.ММ)
    return ""

def remove_spaces_between_initials(text: str) -> str:
    """
    Удаляет пробел между инициалами: "И. О." -> "И.О."
    Оставляет без изменений даты, сокращения, числа.
    """
    # Защищаем даты (цифра.цифра или цифра.цифра.цифра) от изменений
    date_pattern = r'\b\d{1,2}\.\d{2}(?:\.\d{4})?\b'
    protected = {}

    def replacer(match):
        placeholder = f'__DATE_{len(protected)}__'
        protected[placeholder] = match.group(0)
        return placeholder

    text = re.sub(date_pattern, replacer, text)

    # Ищем шаблон: заглавная буква (кириллица или латиница), точка, пробелы, заглавная буква, точка
    # Превращаем в "Буква.Буква." без пробела
    text = re.sub(r'([A-ZА-ЯЁ])\.\s+([A-ZА-ЯЁ])\.', r'\1.\2.', text)

    # Восстанавливаем даты
    for placeholder, original in protected.items():
        text = text.replace(placeholder, original)

    return text


def normalize_subgroup(text: str) -> str:
    """
    Приводит различные написания подгрупп (п/г1, пг 2, п\\г 2, п/г 1 и т.п.)
    к единому виду "п/г N", где N — номер группы.
    """
    # Шаблон: "п", затем возможные разделители (пробелы, слеш, обратный слеш),
    # затем "г", затем снова возможные разделители, затем одна или более цифр.
    pattern = r'\bп\s*[\/\\]?\s*г\s*(\d+)\b'
    return re.sub(pattern, r'п/г \1', text)