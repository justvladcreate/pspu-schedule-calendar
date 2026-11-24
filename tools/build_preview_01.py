"""Превью факультета 01: локально разобранные данные в копии сайта."""
import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

root = Path(".").resolve()
work = Path(tempfile.mkdtemp(prefix="pspu-preview01-"))
site = work / "web"
shutil.copytree(root / "web", site)

parsed = json.loads(
    (root / "data" / "faculties" / "01" / "latest" / "parsed.json").read_text(
        encoding="utf-8"
    )
)
events = parsed["events"]
for event in events:
    event.setdefault("faculty_id", "01")
    event.setdefault("faculty_name", "Математический факультет")
now = datetime.now(timezone.utc).isoformat(timespec="seconds")

target = site / "data" / "faculties" / "01" / "data.json"
target.write_text(
    json.dumps(
        {"schema_version": 3, "generated_at": now, "events": events},
        ensure_ascii=False,
        indent=4,
    ),
    encoding="utf-8",
)

index_path = site / "data" / "index.json"
index = json.loads(index_path.read_text(encoding="utf-8"))
for item in index.get("faculties", []):
    if item["id"] == "01":
        item["groups"] = sorted({event["group"] for event in events})
        item["events"] = len(events)
        item["generated_at"] = now
index["generated_at"] = now
index_path.write_text(json.dumps(index, ensure_ascii=False, indent=4), encoding="utf-8")

print("site:", site)
print("events:", len(events))
