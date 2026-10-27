import json

from parser.model import Faculty, FacultySource
from parser.publish import publish_faculty_data


def _faculty(faculty_source=None):
    return Faculty(
        id="12",
        name="ИНЭК",
        short="ИНЭК",
        source=faculty_source or FacultySource(
            type="google_sheets", spreadsheet_id="x"
        ),
        adapter="inec_legacy",
        prompt="inec",
    )


def test_publish_creates_index_and_faculty_file(tmp_path):
    events = [
        {"group": "1221", "discipline": "A", "event_id": "1221_ПН_1_1"},
        {"group": "1221", "discipline": "B", "event_id": "1221_ПН_2_1"},
    ]
    index_path = publish_faculty_data(
        tmp_path,
        [_faculty()],
        {"12": events},
        "2026-10-27T00:00:00+00:00",
    )

    index = json.loads(index_path.read_text(encoding="utf-8"))
    assert index["schema_version"] == 2
    assert index["faculties"][0]["id"] == "12"
    assert index["faculties"][0]["groups"] == ["1221"]
    assert index["faculties"][0]["original"]["type"] == "google_sheets"

    faculty_payload = json.loads(
        (tmp_path / "faculties" / "12.json").read_text(encoding="utf-8")
    )
    assert faculty_payload["faculty"]["id"] == "12"
    assert all(e["faculty_id"] == "12" for e in faculty_payload["events"])
    assert all(e["faculty_name"] == "ИНЭК" for e in faculty_payload["events"])


def test_publish_rotates_previous_file(tmp_path):
    publish_faculty_data(tmp_path, [_faculty()], {"12": [{"group": "A"}]}, "v1")
    publish_faculty_data(tmp_path, [_faculty()], {"12": [{"group": "B"}]}, "v2")

    old = json.loads(
        (tmp_path / "faculties" / "old" / "12.json").read_text(encoding="utf-8")
    )
    assert old["generated_at"] == "v1"
    assert old["events"][0]["group"] == "A"


def test_publish_points_to_xlsx_without_copying(tmp_path):
    faculty = Faculty(
        id="04",
        name="Начальное образование",
        short="НО",
        source=FacultySource(type="cloud_mail", url="https://cloud.mail.ru/public/x"),
        adapter="vertical",
        prompt="primary",
    )
    index_path = publish_faculty_data(
        tmp_path,
        [faculty],
        {"04": [{"group": "411"}]},
        "v1",
    )

    index = json.loads(index_path.read_text(encoding="utf-8"))
    original = index["faculties"][0]["original"]
    assert original["type"] == "cloud_mail"
    assert original["url"].startswith("https://cloud.mail.ru/")
    # файл в артефакт кладёт CI, в git его быть не должно
    assert original["file"] == "faculties/04.xlsx"
    assert not (tmp_path / "faculties" / "04.xlsx").exists()
