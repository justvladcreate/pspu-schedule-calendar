import json

from parser.core.model import Faculty, FacultySource
from parser.core.publish import publish, publish_faculty

STAMP = "2026-10-27T00:00:00+00:00"


def _faculty(faculty_id="12", source=None):
    return Faculty(
        id=faculty_id,
        name="ИНЭК" if faculty_id == "12" else "Математика",
        short="ИНЭК" if faculty_id == "12" else "Математика",
        source=source or FacultySource(type="google_sheets", spreadsheet_id="x"),
        prompt="inec",
    )


def test_publish_creates_faculty_folder(tmp_path):
    events = [
        {"group": "1221", "discipline": "A", "event_id": "1221_ПН_1_1"},
        {"group": "1221", "discipline": "B", "event_id": "1221_ПН_2_1"},
    ]
    index_path = publish(tmp_path, [_faculty()], {"12": events}, STAMP)

    payload = json.loads(
        (tmp_path / "faculties" / "12" / "data.json").read_text(encoding="utf-8")
    )
    assert payload["faculty"]["id"] == "12"
    assert payload["groups"] == ["1221"]
    assert all(event["faculty_id"] == "12" for event in payload["events"])
    assert payload["generated_at"] == STAMP

    index = json.loads(index_path.read_text(encoding="utf-8"))
    entry = index["faculties"][0]
    assert entry["id"] == "12"
    assert entry["folder"] == "faculties/12"
    assert entry["events"] == 2
    assert entry["generated_at"] == STAMP


def test_publish_rotates_previous_version(tmp_path):
    publish(tmp_path, [_faculty()], {"12": [{"group": "A"}]}, "v1")
    publish(tmp_path, [_faculty()], {"12": [{"group": "B"}]}, "v2")

    folder = tmp_path / "faculties" / "12"
    current = json.loads((folder / "data.json").read_text(encoding="utf-8"))
    previous = json.loads((folder / "old_data.json").read_text(encoding="utf-8"))
    assert current["generated_at"] == "v2"
    assert current["events"][0]["group"] == "B"
    assert previous["events"][0]["group"] == "A"


def test_publish_keeps_version_when_nothing_changed(tmp_path):
    publish(tmp_path, [_faculty()], {"12": [{"group": "A"}]}, "v1")
    publish(tmp_path, [_faculty()], {"12": [{"group": "A"}]}, "v2")

    payload = json.loads(
        (tmp_path / "faculties" / "12" / "data.json").read_text(encoding="utf-8")
    )
    assert payload["generated_at"] == "v1"
    assert not (tmp_path / "faculties" / "12" / "old_data.json").exists()


def test_publish_points_to_prerendered_sheets(tmp_path):
    faculty = _faculty(
        "01",
        FacultySource(type="cloud_mail", url="https://cloud.mail.ru/public/x"),
    )
    folder = tmp_path / "faculties" / "01"
    folder.mkdir(parents=True)
    (folder / "sheets.json").write_text('{"sheets":[]}', encoding="utf-8")

    index_path = publish(tmp_path, [faculty], {"01": [{"group": "111"}]}, "v1")

    index = json.loads(index_path.read_text(encoding="utf-8"))
    original = index["faculties"][0]["original"]
    assert original["type"] == "cloud_mail"
    assert original["url"].startswith("https://cloud.mail.ru/")
    assert original["sheets"] == "sheets.json"
    assert "file" not in original


def test_publish_several_faculties(tmp_path):
    publish(
        tmp_path,
        [_faculty("12"), _faculty("01", FacultySource(type="cloud_mail", url="u"))],
        {"12": [{"group": "1221"}], "01": [{"group": "111"}]},
        STAMP,
    )

    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert [entry["id"] for entry in index["faculties"]] == ["12", "01"]
    assert (tmp_path / "faculties" / "01" / "data.json").exists()
    assert (tmp_path / "faculties" / "12" / "data.json").exists()


def test_partial_publish_keeps_other_faculties(tmp_path):
    publish(
        tmp_path,
        [_faculty("12"), _faculty("01", FacultySource(type="cloud_mail", url="u"))],
        {"12": [{"group": "1221"}], "01": [{"group": "111"}]},
        STAMP,
    )
    # Прогон только по 01 не должен выкинуть 12 из индекса.
    publish(
        tmp_path,
        [_faculty("01", FacultySource(type="cloud_mail", url="u"))],
        {"01": [{"group": "111"}]},
        STAMP,
    )

    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert [entry["id"] for entry in index["faculties"]] == ["12", "01"]


def test_drop_ids_remove_faculty(tmp_path):
    publish(
        tmp_path,
        [_faculty("12"), _faculty("01", FacultySource(type="cloud_mail", url="u"))],
        {"12": [{"group": "1221"}], "01": [{"group": "111"}]},
        STAMP,
    )
    publish(
        tmp_path,
        [_faculty("12")],
        {"12": [{"group": "1221"}]},
        STAMP,
        drop_ids={"01"},
    )

    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert [entry["id"] for entry in index["faculties"]] == ["12"]
