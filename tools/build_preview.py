"""Собрать локальное превью: текущий сайт + заочка ИНЭК."""
import asyncio
import json
import shutil
import tempfile
import warnings
from datetime import date
from pathlib import Path

warnings.filterwarnings("ignore")

from parser.core.finalize import transform_schedule
from parser.core.model import AcademicPeriod, Faculty, FacultySource
from parser.faculties.common.zaoch import parse_zaoch_sheet
from parser.sources.loader import load_sources

FOLDER = "https://cloud.mail.ru/public/xqay/nJth4nGAS"
root = Path(".").resolve()
work = Path(tempfile.mkdtemp(prefix="pspu-preview-"))

faculty = Faculty(
    id="12",
    name="ИНЭК",
    short="ИНЭК",
    source=FacultySource(type="cloud_mail_folder", url=FOLDER, kinds=("zo",)),
    sources=(FacultySource(type="cloud_mail_folder", url=FOLDER, kinds=("zo",)),),
)
sheets = asyncio.run(load_sources(faculty, work / "cache"))

period = AcademicPeriod(
    year="2026/2027",
    semester_start=date(2026, 9, 1),
    semester_end=date(2027, 1, 23),
)
groups = {}
for sheet in sheets:
    groups.update(
        parse_zaoch_sheet(sheet, year=2026, bounds=period.academic_bounds())
    )

parsed = asyncio.run(transform_schedule(groups, faculty_id="12"))
zo = parsed["events"]

print("zo events:", len(zo))
for group in sorted({event["group"] for event in zo}):
    events = [event for event in zo if event["group"] == group]
    dates = sorted({value for event in events for value in event["dates"]})
    print(f"  {group:8} {len(events):3} событий, {dates[0]} — {dates[-1]}")

site = work / "web"
shutil.copytree(root / "web", site)

web = site / "data" / "faculties" / "12"
data = json.loads((web / "data.json").read_text(encoding="utf-8"))
data["events"].extend(zo)
(web / "data.json").write_text(
    json.dumps(data, ensure_ascii=False, indent=4), encoding="utf-8"
)

index = json.loads((site / "data" / "index.json").read_text(encoding="utf-8"))
for item in index.get("faculties", []):
    if item["id"] == "12":
        item["groups"] = sorted({event["group"] for event in data["events"]})
        item["events"] = len(data["events"])
(site / "data" / "index.json").write_text(
    json.dumps(index, ensure_ascii=False, indent=4), encoding="utf-8"
)

print("site:", site)
print("total events:", len(data["events"]))
