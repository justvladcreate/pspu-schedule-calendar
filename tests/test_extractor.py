import pandas as pd

from parser.faculties.f12_inec.extractor import _ffill_weekday_column, clean_group_name, extraction


def _schedule_df(header: str) -> pd.DataFrame:
    return pd.DataFrame([
        ["", "Начало", "Предмет", ""],
        ["ПН", "8.00", "с 10.11 - История (лек.) доц. Иванов И.И.", "IV к. А101"],
        ["Декан", "", "", "форма обучения /"],
        ["", "", "", ""],
        [header, "", "", ""],
    ])


def test_clean_group_name():
    assert clean_group_name("5 курс, 1252 (9 чел.)") == "1252"
    assert clean_group_name("1252") == "1252"


def test_ffill_weekday_column():
    df = pd.DataFrame({"day": ["ПН", None, None, "ВТ", None], "value": [1, 2, 3, 4, 5]})
    result = _ffill_weekday_column(df)
    assert result["day"].tolist() == ["ПН", "ПН", "ПН", "ВТ", "ВТ"]


def test_extraction_uses_session_end_date_only_with_vacation():
    base = "5 курс, 1252 (9 чел.)\n10 семестр 2025/2026 учебного года (01.09.2026 – 23.01.2027)\n"
    with_vacation = (
        base
        + "Экзаменационная сессия: 23.01.2027 – 15.02.2027\n"
        + "Каникулы: 16.02.2027 – 28.02.2027"
    )
    without_vacation = base + "Экзаменационная сессия: 23.01.2027 – 15.02.2027"

    with_data = extraction(_schedule_df(with_vacation))["1252"]
    without_data = extraction(_schedule_df(without_vacation))["1252"]

    assert with_data["semester_start_year"] == 2026
    assert "10.11.2026 - 23.01.2027" in with_data["events"][0]["subject"]
    assert "10.11.2026 -" not in without_data["events"][0]["subject"]
