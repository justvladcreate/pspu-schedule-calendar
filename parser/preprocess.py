# [file name]: preprocess.py
import re
from typing import Union, List, Dict, Any, Tuple
from datetime import date

# ---------- Константы для очистки ----------
CLEAN_REPLACEMENTS = {
    "\\": "", "\"": "", "“": "", "”": "", "«": "", "»": "",
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

def normalize_rooms(line: str) -> List[str]:
    distant_pat = re.compile(r'дистанционно\s*[\\/]\s*СФЕРУМ', re.IGNORECASE)
    corpus_pat = re.compile(r'\b([IVX]+)\s+к\.\s*[\\/]?\s*', re.IGNORECASE)

    full_text = line
    result = []
    seen = set()

    # 1. "дистанционно СФЕРУМ"
    for m in distant_pat.finditer(full_text):
        val = "дистанционно СФЕРУМ"
        if val not in seen:
            seen.add(val)
            result.append(val)

    clean_text = distant_pat.sub(' ', full_text)
    clean_text = re.sub(r'\([^)]*\)', ' ', clean_text)
    clean_text = re.sub(r'\b\d{1,2}\.\d{2}(?:-\d{1,2}\.\d{2})?\b', ' ', clean_text)

    # 2. Обработка корпусов
    corpus_matches = list(corpus_pat.finditer(clean_text))
    for i, match in enumerate(corpus_matches):
        corpus_roman = match.group(1)
        corpus_norm = f"{corpus_roman} к."
        start = match.end()
        end = corpus_matches[i+1].start() if i+1 < len(corpus_matches) else len(clean_text)
        tail = clean_text[start:end]

        # Извлекаем все потенциальные токены аудиторий
        tokens = re.findall(r'[А-Яа-я\d-]+(?:\.\s*[А-Яа-я]+)?', tail, re.IGNORECASE)

        for token in tokens:
            token = token.strip()
            if not token:
                continue

            # Особый случай: акт. зал
            if re.fullmatch(r'акт\.\s*зал', token, re.IGNORECASE):
                room = "акт. зал"
            else:
                # Удаляем ведущий числовой префикс с дефисом (05-А305 -> А305)
                room_clean = re.sub(r'^\d{1,2}-(?=[А-Я])', '', token, flags=re.IGNORECASE)
                room_clean = re.sub(r'\s+', ' ', room_clean).strip()

                # Валидация: число из ≥2 цифр или буква+цифры
                if re.fullmatch(r'\d{2,}', room_clean):
                    room = room_clean
                elif re.search(r'[А-Я]', room_clean, re.IGNORECASE) and re.search(r'\d', room_clean):
                    room = room_clean
                else:
                    continue

                # Убираем дефис между буквой и цифрой (А-406 -> А406)
                room = re.sub(r'(?<=[А-Я])-(?=\d)', '', room, flags=re.IGNORECASE)

            full_room = f"{corpus_norm} {room}"
            if full_room not in seen:
                seen.add(full_room)
                result.append(full_room)

    return result

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
        # 4a. висячий дефис — если после дефиса (с учётом пробелов) НЕ идёт цифра
        text = re.sub(
            rf'\b(?:[сc]\s+)?({_DATE})\s*[-–—](?!\s*\d)',
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


def add_year(text: str, current_year: int | None = None) -> str:
    """
    Проставляет год к каждой дате.
    Правило для диапазона: если конец < начало по (месяц, день) — конец в след. году.

    "10.11 - 18.01"   -> "10.11.2026 - 18.01.2027"
    "15.09 - 13.10"   -> "15.09.2026 - 13.10.2026"
    "24.10.2026"      -> "24.10.2026"
    """
    if current_year is None:
        current_year = date.today().year

    def range_repl(m: re.Match) -> str:
        a, b = m.group(1), m.group(2)
        d1, m1, y1 = _parse(a)
        d2, m2, y2 = _parse(b)
        year1 = y1 or current_year
        if y2 is not None:
            year2 = y2
        elif (m2, d2) < (m1, d1):
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
        return f"{d:02d}.{mo:02d}.{current_year}"

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