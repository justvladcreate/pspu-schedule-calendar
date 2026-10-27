# [file name]: preprocess.py
import re
from typing import List, Union

from parser.dates import (
    DATE_RE as _DATE,
    is_valid_date as _is_valid,
    parse_date_token as _parse,
)

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

_JUNK_ROOMS = {
    "-", "—", "–",
    "нет",
    "n/a", "n a",
    "н/д", "н д",
    "n\\a",
}


def clean_room(room: str) -> str:
    """Очистка одной записи аудитории. Возвращает "" для мусора."""
    if not room:
        return ""

    room = str(room).replace('\\', ' ').replace('/', ' ')
    room = re.sub(r'\s+', ' ', room).strip()
    if not room:
        return ""

    low = room.lower()
    if low in _JUNK_ROOMS:
        return ""
    if low.startswith("дистанционно"):
        return "дистанционно онлайн"

    room = re.sub(r'\b([IVX]+)\s*к\.\s*', r'\1 к. ', room)
    room = re.sub(r'(?<=[А-Я])-(?=\d)', '', room, flags=re.IGNORECASE)
    return room.strip()


def normalize_rooms(line: str, url: str | None = None) -> List[str]:
    """Разбивает строку на части по \\n и , и чистит каждую через clean_room."""
    if line is None:
        return []

    text = str(line)
    if not text.strip():
        return []

    for ch in ('"', '«', '»', '“', '”'):
        text = text.replace(ch, ' ')

    raw_parts = re.split(r'[\n\r,]+', text)

    rooms_clean: List[str] = []
    seen: set = set()
    for part in raw_parts:
        room = clean_room(part)
        if room and room not in seen:
            seen.add(room)
            rooms_clean.append(room)

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