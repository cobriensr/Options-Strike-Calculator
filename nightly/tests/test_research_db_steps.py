"""Tests for the database-backed research steps: lottery-tracking, quality-sim, takeit-drift.

R2 is moto: the real ResearchStore reads and publishes. The tracker script is a tiny file under a
`tmp_path` APP_ROOT, run as a real subprocess through research_reports' own runner, env and log
capture. The database is patched at research_db_steps' one boundary, `connect_db`: quality-sim
runs the real `refit_ticker_inversion_stats` and takeit-drift the real `run_drift`, each against
a fake connection that records what it is asked and models autocommit, commit and rollback.
"""

from __future__ import annotations

import ast
import logging
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from unittest.mock import create_autospec

import boto3
import enrich_lottery_outcomes
import numpy as np
import pandas as pd
import pytest
import takeit_drift_monitor
from botocore.exceptions import ClientError
from moto import mock_aws

import research_db_steps
import research_reports
import resources
import steps
from config import Settings, load_settings
from research_db_steps import (
    STEP_NAMES,
    TRACKING_STATE_KEY,
    StateShrankError,
    csv_rows,
    publish_state_csv,
    run_quality_sim,
    run_step,
    run_takeit_drift,
    run_tracking,
)
from research_store import ResearchStore
from steps import Step, StepContext, StepResult, run_steps

# pandas reads through a DBAPI connection it cannot type; the warning is the production one too
# (and in production it goes to the step's log) and says nothing about these tests.
pytestmark = pytest.mark.filterwarnings(
    "ignore:pandas only supports SQLAlchemy connectable:UserWarning"
)

BUCKET = "test-bucket"
NOW = datetime(2026, 11, 12, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 11)  # a Wednesday; NOW is the next morning
SESSION = LAST_SESSION.isoformat()
# What a printed marker and a leaked ticker look like: neither may leave the step's log file.
MARKER = "-".join(("MARKER", "SPXW", "450C", "1234567"))

TRACKING = "lottery-tracking"
QUALITY_SIM = "quality-sim"
DRIFT = "takeit-drift"
STATE_KEY = "research/lottery-tracking/state/lottery-tracking.csv"
SNAPSHOT_KEY = f"research/lottery-tracking/{SESSION}/lottery-tracking.csv"
TRACKING_LOG_KEY = f"research/_logs/{SESSION}/lottery-tracking.log"
SIM_KEY = f"research/quality-sim/{SESSION}/lottery-quality-sim-{SESSION}.csv"
SIM_LOG_KEY = f"research/_logs/{SESSION}/quality-sim.log"
DRIFT_LOG_KEY = f"research/_logs/{SESSION}/takeit-drift.log"
DRIFT_REPORT_KEY = f"research/takeit-drift/{SESSION}/takeit-drift-{SESSION}.md"
DRIFT_PLOT_KEYS = [
    f"research/takeit-drift/{SESSION}/reliability_lottery_{SESSION}.png",
    f"research/takeit-drift/{SESSION}/reliability_silent_boom_{SESSION}.png",
]

# A tracking file as the nightly last stored it: CRLF, as csv.writer wrote it.
STATE_HEADER = "date,run_at,n_fires_today"
STATE_TEXT = f"{STATE_HEADER}\r\n2026-11-09,t1,5\r\n2026-11-10,t2,6\r\n"
NO_TRACKING_COUNTS = {"rows_before": 0, "rows_after": 0, "files_uploaded": 0, "log_uploaded": 0}

# --- the rig ---------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_home(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """boto3 and matplotlib cache under the home dir; keep both off the real one."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("MPLCONFIGDIR", str(home / "matplotlib"))


@pytest.fixture
def settings() -> Settings:
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    return load_settings().model_copy(
        update={"r2_endpoint_url": "https://s3.amazonaws.com", "r2_bucket_fulltape": BUCKET}
    )


@dataclass
class Rig:
    """The patched boundary of research_db_steps: a fake app root, a work dir, R2 and the DB."""

    s3: Any
    settings: Settings
    app: Path
    work: Path
    events: list[str]
    monkeypatch: pytest.MonkeyPatch

    def script(self, relative: str, body: str, **names: object) -> str:
        """Write a script under the fake app root; `names` become constants at its top."""
        path = self.app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        header = "".join(f"{name} = {value!r}\n" for name, value in names.items())
        path.write_text(header + body, encoding="utf-8")
        return relative

    def tracker(self, action: str) -> None:
        """The stand-in for scripts/daily_tracker.py: same flag, it rewrites the file."""
        self.script("scripts/daily_tracker.py", TRACKER, ACTION=action, MARKER=MARKER)

    def ctx(self, left: float = 120.0, last_session: date = LAST_SESSION) -> StepContext:
        return StepContext(
            self.settings, NOW, last_session, deadline=time.monotonic() + left, tape=()
        )

    def put(self, key: str, body: bytes = b"x") -> None:
        self.s3.put_object(Bucket=BUCKET, Key=key, Body=body)

    def put_state(self, text: str = STATE_TEXT) -> None:
        self.put(STATE_KEY, text.encode("utf-8"))

    def keys(self, prefix: str = "") -> list[str]:
        pages = self.s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix)
        return sorted(o["Key"] for page in pages for o in page.get("Contents", []))

    def body(self, key: str) -> bytes:
        return self.s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()

    def use_db(self, conn: Any, connect_prints: str | None = None) -> None:
        """Hand `conn` out from research_db_steps' connect_db, as resources.connect_db does:
        autocommit on, closed when the step is done with it, however it ends. `connect_prints`
        is a line to write to stderr while connecting, as connect_with_retry's retry notes do."""

        @contextmanager
        def fake_connect(_settings: Settings) -> Iterator[Any]:
            self.events.append("connect")
            if connect_prints is not None:
                print(connect_prints, file=sys.stderr)
            conn.autocommit = True
            try:
                yield conn
            finally:
                conn.close()
                self.events.append("close")

        connect = create_autospec(resources.connect_db, side_effect=fake_connect)
        self.monkeypatch.setattr(research_db_steps, "connect_db", connect)


@pytest.fixture
def rig(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings: Settings) -> Iterator[Rig]:
    app = tmp_path / "app"
    (app / "scripts").mkdir(parents=True)
    work = tmp_path / "work"  # not created: the step makes it
    monkeypatch.setattr(research_reports, "APP_ROOT", app)
    monkeypatch.setattr(research_reports, "RESEARCH_WORK_DIR", work)
    events: list[str] = []
    # A step that opens a connection it was not given a fake for must not reach a database.
    guard = create_autospec(resources.connect_db, side_effect=AssertionError("no DB expected"))
    monkeypatch.setattr(research_db_steps, "connect_db", guard)
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        yield Rig(s3, settings, app, work, events, monkeypatch)


@pytest.fixture
def puts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every key ResearchStore.put_file is asked to write, in order. The put still happens."""
    seen: list[str] = []
    real = ResearchStore.put_file

    def spy(self: ResearchStore, key: str, path: Path) -> int:
        seen.append(key)
        return real(self, key, path)

    monkeypatch.setattr(ResearchStore, "put_file", spy)
    return seen


def asserted_valid(result: StepResult) -> StepResult:
    """The result must pass run_steps' contract: ints >= 0 and a str detail."""
    assert steps._is_valid(result)
    return result


def step_is_gone(rig: Rig, step: str) -> bool:
    return not (rig.work / "reports" / step).exists()


# --- the tracker stand-in --------------------------------------------------------------------

TRACKER = """
import argparse
import csv
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--csv", type=Path, required=True)
args = parser.parse_args()
print(MARKER)
with args.csv.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.reader(handle))
# A zero-byte file has no rows: the real tracker starts from its own COLUMNS then.
header, data = (rows[0], rows[1:]) if rows else (["date", "run_at", "n_fires_today"], [])
if ACTION == "append":
    data.append(["2026-11-11", "t3", "7"])
elif ACTION == "replace":
    data[-1] = ["2026-11-10", "t2b", "9"]
elif ACTION == "drop":
    data = data[:-1]
elif ACTION == "addcol":  # a column appended at the end, the rows padded
    header = [*header, "extra"]
    data = [[*row, ""] for row in data]
elif ACTION == "addcol-append":  # the same, and tonight's row
    header = [*header, "extra"]
    data = [[*row, ""] for row in data]
    data.append(["2026-11-11", "t3", "7", "x"])
elif ACTION == "addcol-drop":  # the same, and a row lost
    header = [*header, "extra"]
    data = [[*row, ""] for row in data[:-1]]
elif ACTION == "reorder":  # the first two columns swapped
    header = [header[1], header[0], *header[2:]]
    data = [[row[1], row[0], *row[2:]] for row in data]
elif ACTION == "rename":  # a column renamed
    header = [header[0], "ran_at", *header[2:]]
elif ACTION == "dropcol":  # the last column removed
    header = header[:-1]
    data = [row[:-1] for row in data]
elif ACTION == "prepend":  # a column inserted at the front
    header = ["extra", *header]
    data = [["", *row] for row in data]
elif ACTION == "truncate":
    data = []
elif ACTION == "crash":
    args.csv.write_text("", encoding="utf-8")  # emptied, then dies
    raise ValueError("SPXW 450C premium 1,234,567")
elif ACTION == "exit3":
    print("[track] no enriched fires found")
    sys.exit(3)
elif ACTION == "sleep":
    time.sleep(600)
with args.csv.open("w", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    writer.writerow(header)
    writer.writerows(data)
"""

# --- the table, the names and the dispatch ---------------------------------------------------


def test_the_state_key_is_the_briefs() -> None:
    assert TRACKING_STATE_KEY == STATE_KEY


def test_the_step_names_are_the_three_db_steps() -> None:
    assert frozenset({TRACKING, QUALITY_SIM, DRIFT}) == STEP_NAMES
    assert isinstance(STEP_NAMES, frozenset)


def test_run_step_dispatches_by_name_and_rejects_an_unknown_one(
    monkeypatch: pytest.MonkeyPatch, rig: Rig
) -> None:
    functions = {
        TRACKING: ("run_tracking", run_tracking),
        QUALITY_SIM: ("run_quality_sim", run_quality_sim),
        DRIFT: ("run_takeit_drift", run_takeit_drift),
    }
    fakes = {}
    for name, (attribute, function) in functions.items():
        fakes[name] = create_autospec(function, return_value=StepResult("ok", {}))
        monkeypatch.setattr(research_db_steps, attribute, fakes[name])
    ctx = rig.ctx()

    for name in sorted(STEP_NAMES):
        for fake in fakes.values():
            fake.reset_mock()
        assert run_step(name, ctx) == StepResult("ok", {})
        for other, fake in fakes.items():
            if other == name:
                fake.assert_called_once_with(ctx)
            else:
                fake.assert_not_called()

    for fake in fakes.values():
        fake.reset_mock()
    for unknown in (
        "research-derive",
        "whale-plots",
        "tracking",
        "quality_sim",
        "",
        "Takeit-Drift",
    ):
        with pytest.raises(KeyError):
            run_step(unknown, ctx)
    for fake in fakes.values():
        fake.assert_not_called()


def test_importing_the_module_loads_no_ml_stack_and_no_drift_code() -> None:
    """A step module is imported when its step runs. This one must not pull sklearn, scipy or
    sqlalchemy (the image has none), and matplotlib is first used by the drift step, which
    imports the monitor when it runs. (`enrich_lottery_outcomes` is not on this list: the derive
    step that research_reports imports loads it. The next test covers it.)"""
    code = (
        "import sys, research_db_steps\n"
        "names = ('sklearn', 'scipy', 'sqlalchemy', 'matplotlib', 'takeit_drift_monitor',\n"
        "         'daily_tracker')\n"
        "loaded = [m for m in names if m in sys.modules]\n"
        "assert not loaded, loaded\n"
    )
    root = Path(research_db_steps.__file__).resolve().parents[2]
    # The image's PYTHONPATH order: src, scripts, ml/src.
    path = os.pathsep.join(str(root / part) for part in ("nightly/src", "scripts", "ml/src"))
    env = {**os.environ, "PYTHONPATH": path}

    done = subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )

    assert done.returncode == 0, done.stderr[-2000:]


def test_the_research_code_is_imported_inside_the_steps_only() -> None:
    # A module another import already loaded cannot show up in sys.modules, so this reads the
    # module's own top level: what a step runs, and the data libraries it drives, are imported
    # when the step runs (the drift step is the image's first in-process use of matplotlib, and
    # the ml stack stays out of anything the pipeline loads).
    tree = ast.parse(Path(research_db_steps.__file__).read_text(encoding="utf-8"))
    top_level: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            top_level |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            top_level.add(node.module.split(".")[0])

    deferred = {
        "enrich_lottery_outcomes",
        "takeit_drift_monitor",
        "daily_tracker",
        "matplotlib",
        "pandas",
        "numpy",
        "polars",
        "psycopg2",
        "sklearn",
        "scipy",
        "sqlalchemy",
    }
    assert not top_level & deferred, sorted(top_level & deferred)


# --- csv_rows and publish_state_csv ----------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "rows"),
    [
        ("", 0),
        ("a,b\n", 0),
        ("a,b", 0),
        ("a,b\n1,2\n", 1),
        ("a,b\r\n1,2\r\n3,4", 2),
        ("a,b\n1,2\n\n\n", 1),
        ('a,b\n"line one\nline two",2\n3,4\n', 2),
        ("﻿a,b\n1,2\n", 1),
    ],
    ids=[
        "empty",
        "header only",
        "header without a newline",
        "one row",
        "crlf and no final newline",
        "blank lines",
        "a quoted newline is one row",
        "a byte order mark",
    ],
)
def test_csv_rows_counts_data_rows_and_excludes_the_header(
    tmp_path: Path, text: str, rows: int
) -> None:
    path = tmp_path / "x.csv"
    path.write_bytes(text.encode("utf-8"))

    assert csv_rows(path) == rows


def test_publish_state_csv_writes_the_snapshot_then_the_state(
    rig: Rig, tmp_path: Path, puts: list[str]
) -> None:
    path = tmp_path / "t.csv"
    path.write_bytes(STATE_TEXT.encode("utf-8"))

    files = publish_state_csv(ResearchStore(rig.settings), STATE_KEY, SNAPSHOT_KEY, path, 2)

    assert files == 2
    assert puts == [SNAPSHOT_KEY, STATE_KEY]
    assert rig.body(SNAPSHOT_KEY) == rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")


def test_publish_state_csv_refuses_fewer_rows_and_writes_nothing(
    rig: Rig, tmp_path: Path, puts: list[str]
) -> None:
    path = tmp_path / "t.csv"
    path.write_bytes(f"{STATE_HEADER}\r\n2026-11-09,t1,5\r\n".encode())
    rig.put_state()

    with pytest.raises(StateShrankError):
        publish_state_csv(ResearchStore(rig.settings), STATE_KEY, SNAPSHOT_KEY, path, 2)

    assert puts == []
    assert rig.keys("research/lottery-tracking/") == [STATE_KEY]  # the old state, untouched
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")


def test_publish_state_csv_accepts_the_same_number_of_rows(rig: Rig, tmp_path: Path) -> None:
    path = tmp_path / "t.csv"
    path.write_bytes(STATE_TEXT.replace("t2", "t2b").encode("utf-8"))

    files = publish_state_csv(ResearchStore(rig.settings), STATE_KEY, SNAPSHOT_KEY, path, 2)

    assert files == 2


# --- lottery-tracking ------------------------------------------------------------------------


def test_tracking_state_missing_fails_and_writes_nothing(rig: Rig, puts: list[str]) -> None:
    rig.tracker("append")  # a script that would write: it must never run

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed", NO_TRACKING_COUNTS, "tracking state missing"
    )
    assert puts == []
    assert rig.keys() == []  # no state, no snapshot, not even a log: the script never ran
    assert step_is_gone(rig, TRACKING)


def test_tracking_an_unreadable_state_is_an_error_and_not_a_missing_one(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, puts: list[str]
) -> None:
    def denied(self: ResearchStore, key: str, dest: Path) -> bool:
        raise ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetObject")

    monkeypatch.setattr(ResearchStore, "get_file", denied)
    rig.tracker("append")

    with pytest.raises(ClientError):
        run_tracking(rig.ctx())

    assert puts == []
    assert step_is_gone(rig, TRACKING)


def test_tracking_csv_never_shrinks(rig: Rig, puts: list[str]) -> None:
    rig.put_state()
    rig.tracker("drop")

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed",
        {"rows_before": 2, "rows_after": 1, "files_uploaded": 0, "log_uploaded": 1},
        "tracking state shrank",
    )
    # No snapshot and no state PUT. The log is the one object: it is what shows the script's rows.
    assert puts == [TRACKING_LOG_KEY]
    assert rig.keys("research/") == [TRACKING_LOG_KEY, STATE_KEY]
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")
    assert step_is_gone(rig, TRACKING)


def test_tracking_a_script_that_empties_the_file_is_a_shrink(rig: Rig, puts: list[str]) -> None:
    rig.put_state()
    rig.tracker("truncate")

    result = run_tracking(rig.ctx())

    assert result.status == "failed"
    assert result.detail == "tracking state shrank"
    assert (result.counts["rows_before"], result.counts["rows_after"]) == (2, 0)
    assert puts == [TRACKING_LOG_KEY]
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")


def test_tracking_a_column_appended_at_the_end_is_not_a_header_change(
    rig: Rig, puts: list[str]
) -> None:
    rig.put_state()
    rig.tracker("addcol")  # the tracker's own contract: new columns go at the end; same rows

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "ok", {"rows_before": 2, "rows_after": 2, "files_uploaded": 2, "log_uploaded": 1}, ""
    )
    assert puts == [TRACKING_LOG_KEY, SNAPSHOT_KEY, STATE_KEY]
    assert rig.body(STATE_KEY).decode().splitlines()[0] == f"{STATE_HEADER},extra"
    assert rig.body(STATE_KEY) == rig.body(SNAPSHOT_KEY)


def test_tracking_appended_columns_with_a_new_row_count_the_rows(rig: Rig, puts: list[str]) -> None:
    rig.put_state()
    rig.tracker("addcol-append")

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "ok", {"rows_before": 2, "rows_after": 3, "files_uploaded": 2, "log_uploaded": 1}, ""
    )
    assert puts == [TRACKING_LOG_KEY, SNAPSHOT_KEY, STATE_KEY]
    lines = rig.body(STATE_KEY).decode().splitlines()
    assert lines[0] == f"{STATE_HEADER},extra"
    assert lines[-1] == "2026-11-11,t3,7,x"


@pytest.mark.parametrize(
    "action",
    ["reorder", "rename", "dropcol", "prepend"],
    ids=["reordered", "renamed", "a column removed", "a column inserted first"],
)
def test_tracking_any_other_header_change_fails_and_uploads_only_the_log(
    rig: Rig, puts: list[str], action: str
) -> None:
    rig.put_state()
    rig.tracker(action)  # same rows, a different header

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed",
        {"rows_before": 2, "rows_after": 2, "files_uploaded": 0, "log_uploaded": 1},
        "tracking state header changed",
    )
    assert puts == [TRACKING_LOG_KEY]
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")
    assert step_is_gone(rig, TRACKING)


def test_tracking_a_zero_byte_state_fails_as_a_header_change(rig: Rig, puts: list[str]) -> None:
    rig.put_state("")  # there is no header to extend: nothing here may start a new file
    rig.tracker("append")  # the real tracker writes its own header and the night's row

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed",
        {"rows_before": 0, "rows_after": 1, "files_uploaded": 0, "log_uploaded": 1},
        "tracking state header changed",
    )
    assert puts == [TRACKING_LOG_KEY]
    assert rig.body(STATE_KEY) == b""


def test_tracking_a_lost_row_is_a_shrink_even_with_an_appended_column(
    rig: Rig, puts: list[str]
) -> None:
    rig.put_state()
    rig.tracker("addcol-drop")  # the header is fine; one row is gone

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed",
        {"rows_before": 2, "rows_after": 1, "files_uploaded": 0, "log_uploaded": 1},
        "tracking state shrank",
    )
    assert puts == [TRACKING_LOG_KEY]
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")


def test_tracking_publishes_snapshot_then_state(rig: Rig, puts: list[str]) -> None:
    rig.put_state()
    rig.tracker("append")

    result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "ok", {"rows_before": 2, "rows_after": 3, "files_uploaded": 2, "log_uploaded": 1}, ""
    )
    # The log first (it is the evidence when anything after it fails), then the snapshot, and
    # the state last: a failure between the two leaves the old state and a rerun redoes the day.
    assert puts == [TRACKING_LOG_KEY, SNAPSHOT_KEY, STATE_KEY]
    expected = f"{STATE_HEADER}\r\n2026-11-09,t1,5\r\n2026-11-10,t2,6\r\n2026-11-11,t3,7\r\n"
    assert rig.body(STATE_KEY) == rig.body(SNAPSHOT_KEY) == expected.encode("utf-8")
    assert step_is_gone(rig, TRACKING)


def test_tracking_a_same_day_row_replaced_keeps_the_size_and_publishes(rig: Rig) -> None:
    rig.put_state()
    rig.tracker("replace")

    result = run_tracking(rig.ctx())

    assert result.status == "ok"
    assert (result.counts["rows_before"], result.counts["rows_after"]) == (2, 2)
    assert b"t2b" in rig.body(STATE_KEY)


def test_a_failed_snapshot_put_leaves_the_state_as_it_was(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig.put_state()
    rig.tracker("append")
    attempted: list[str] = []
    real = ResearchStore.put_file

    def failing(self: ResearchStore, key: str, path: Path) -> int:
        attempted.append(key)
        if key == SNAPSHOT_KEY:
            raise OSError("r2 is down")
        return real(self, key, path)

    monkeypatch.setattr(ResearchStore, "put_file", failing)

    with pytest.raises(OSError, match="r2 is down"):
        run_tracking(rig.ctx())

    assert STATE_KEY not in attempted  # the state is written after the snapshot, never before
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")
    assert step_is_gone(rig, TRACKING)


def test_a_failed_state_put_after_the_snapshot_fails_the_step(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig.put_state()
    rig.tracker("append")
    real = ResearchStore.put_file

    def failing(self: ResearchStore, key: str, path: Path) -> int:
        if key == STATE_KEY:
            raise OSError("r2 is down")
        return real(self, key, path)

    monkeypatch.setattr(ResearchStore, "put_file", failing)
    outcomes: list[steps.StepOutcome] = []
    step = Step(TRACKING, lambda ctx: run_step(TRACKING, ctx), 1)

    run_steps(
        [step],
        settings=rig.settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=time.monotonic() + 120,
        tape=(),
        on_outcome=outcomes.append,
    )

    (outcome,) = outcomes
    assert (outcome.status, outcome.error) == ("failed", "OSError")
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")  # the old state: a rerun redoes it


def test_tracking_a_failing_script_names_the_class_only_and_uploads_only_its_log(
    rig: Rig, puts: list[str], caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    rig.put_state()
    rig.tracker("crash")

    with caplog.at_level(logging.DEBUG):
        result = run_tracking(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed",
        {"rows_before": 2, "rows_after": 0, "files_uploaded": 0, "log_uploaded": 1},
        "script exited 1 (ValueError)",
    )
    assert puts == [TRACKING_LOG_KEY]
    assert rig.body(STATE_KEY) == STATE_TEXT.encode("utf-8")  # the emptied file is never stored
    log = rig.body(TRACKING_LOG_KEY).decode()
    assert "SPXW 450C premium 1,234,567" in log  # the message is in the log file only
    assert MARKER in log
    assert "SPXW" not in caplog.text
    assert MARKER not in caplog.text
    captured = capfd.readouterr()
    assert "SPXW" not in captured.out + captured.err


def test_tracking_a_nonzero_exit_without_a_class_line_names_the_code_only(rig: Rig) -> None:
    rig.put_state()
    rig.tracker("exit3")

    result = run_tracking(rig.ctx())

    assert asserted_valid(result).status == "failed"
    assert result.detail == "script exited 3"
    assert result.counts["files_uploaded"] == 0


def test_tracking_a_timeout_kills_the_script_and_fails(rig: Rig, puts: list[str]) -> None:
    rig.put_state()
    rig.tracker("sleep")
    started = time.monotonic()

    result = run_tracking(rig.ctx(left=2.5))

    assert time.monotonic() - started < 30  # the script would sleep for 600 s
    assert asserted_valid(result) == StepResult(
        "failed",
        {"rows_before": 2, "rows_after": 0, "files_uploaded": 0, "log_uploaded": 1},
        "script timed out",
    )
    assert puts == [TRACKING_LOG_KEY]


def test_the_tracker_gets_the_steps_remaining_time_no_stdin_and_one_log_stream(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig.put_state()
    rig.tracker("append")
    seen: list[dict[str, Any]] = []
    real_run = subprocess.run

    def spying(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        seen.append(kwargs)
        return real_run(*args, **kwargs)

    monkeypatch.setattr(research_reports.subprocess, "run", spying)

    run_tracking(rig.ctx(left=500.0))

    (kwargs,) = seen
    assert 400.0 < kwargs["timeout"] <= 500.0  # what is left of the step's time
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["stderr"] is subprocess.STDOUT  # one stream, into the one log file
    assert kwargs["cwd"] == rig.app


def test_tracking_runs_the_tracker_on_the_downloaded_state_with_the_script_env(
    rig: Rig,
) -> None:
    rig.put_state()
    rig.script(
        "scripts/daily_tracker.py",
        "import os, sys\n"
        "from pathlib import Path\n"
        "csv_path = Path(sys.argv[2])\n"
        "print('args', sys.argv[1], csv_path.parent.name, csv_path.name, len(sys.argv))\n"
        "print('env', os.environ['PGAPPNAME'], 'R2_BUCKET_FULLTAPE' in os.environ)\n"
        "print('db', os.environ['DATABASE_URL'].split('@')[-1])\n",
    )

    run_tracking(rig.ctx())

    lines = rig.body(TRACKING_LOG_KEY).decode().splitlines()
    # The one flag, and the state downloaded under its own file name into the step's in dir.
    assert lines[0] == "args --csv in lottery-tracking.csv 3"
    assert lines[1] == "env nightly-lottery-tracking False"  # D6: no R2 value in the child
    assert lines[2] == "db localhost/test"


def test_tracking_script_output_never_reaches_the_job(
    rig: Rig, caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    rig.put_state()
    rig.tracker("append")
    outcomes: list[steps.StepOutcome] = []
    step = Step(TRACKING, lambda ctx: run_step(TRACKING, ctx), 1)

    with caplog.at_level(logging.DEBUG):
        run_steps(
            [step],
            settings=rig.settings,
            now_utc=NOW,
            last_session=LAST_SESSION,
            run_deadline=time.monotonic() + 120,
            tape=(),
            on_outcome=outcomes.append,
        )

    (outcome,) = outcomes
    assert outcome.status == "ok"
    assert MARKER not in repr(outcome)
    assert MARKER not in caplog.text
    captured = capfd.readouterr()
    assert MARKER not in captured.out + captured.err
    assert MARKER in rig.body(TRACKING_LOG_KEY).decode()


def test_tracking_logs_its_name_status_counts_and_seconds(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    rig.put_state()
    rig.tracker("append")

    with caplog.at_level(logging.INFO, logger="research_db_steps"):
        run_tracking(rig.ctx())

    # The line comes from this module's own logger, in the report steps' line format.
    (record,) = [r for r in caplog.records if r.name == "research_db_steps"]
    message = record.getMessage()
    assert record.levelno == logging.INFO
    assert message.startswith(f"research-report {TRACKING} ok ")
    assert TRACKING in message
    assert "ok" in message
    assert "rows_after=3" in message
    assert "seconds=" in message
    assert "2026" not in message


# --- quality-sim -----------------------------------------------------------------------------


class SimCursor:
    """A DBAPI cursor over a SimConn: it answers each of the function's two SELECTs."""

    def __init__(self, conn: SimConn) -> None:
        self.conn = conn
        self._rows: list[tuple[Any, ...]] = []

    def __enter__(self) -> SimCursor:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> None:
        self.conn.executed.append(sql)
        if self.conn.fail_on and self.conn.fail_on in sql:
            raise RuntimeError("connection lost")
        if "GROUP BY underlying_symbol" in sql:
            self._rows = self.conn.ticker_rows
        elif "score IS NOT NULL" in sql:
            self._rows = self.conn.fire_rows
        else:
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class SimConn:
    """`ticker_rows`: (ticker, n_21d, w_21d, n_90d, w_90d). `fire_rows`: (id, ticker, date, score).
    It writes nothing: a commit or a rollback is a bug in a read-only step."""

    def __init__(
        self,
        ticker_rows: list[tuple[Any, ...]],
        fire_rows: list[tuple[Any, ...]],
        fail_on: str | None = None,
    ) -> None:
        self.ticker_rows = ticker_rows
        self.fire_rows = fire_rows
        self.fail_on = fail_on
        self.executed: list[str] = []
        self.autocommit = True
        self.closed = False

    def cursor(self) -> SimCursor:
        return SimCursor(self)

    def commit(self) -> None:
        raise AssertionError("quality-sim writes nothing")

    def rollback(self) -> None:
        raise AssertionError("quality-sim writes nothing")

    def close(self) -> None:
        self.closed = True


TICKER_ROWS = [
    ("AAA", 40, 8, 120, 30),
    ("BBB", 40, 20, 120, 60),
    ("CCC", 40, 12, 120, 40),
    ("DDD", 40, 30, 120, 90),
    ("EEE", 40, 4, 120, 10),
    ("FFF", 5, 1, 120, 30),  # too few in 21 days
]
FIRE_ROWS = [
    (1, "AAA", date(2026, 11, 9), 24),
    (2, "BBB", date(2026, 11, 9), 28),
    (3, "CCC", date(2026, 11, 10), 21),
    (4, "DDD", date(2026, 11, 10), 30),
    (5, "EEE", date(2026, 11, 11), 19),
]


def sim_conn(fire_rows: list[tuple[Any, ...]] | None = None, **kwargs: Any) -> SimConn:
    return SimConn(TICKER_ROWS, FIRE_ROWS if fire_rows is None else fire_rows, **kwargs)


def test_quality_sim_is_select_only(rig: Rig) -> None:
    conn = sim_conn()
    rig.use_db(conn)

    result = run_quality_sim(rig.ctx())

    assert asserted_valid(result).status == "ok"
    assert len(conn.executed) == 2  # the ticker counts and the fires
    assert all(sql.lstrip().upper().startswith("SELECT") for sql in conn.executed)
    assert conn.autocommit is True  # nothing here opens a transaction to commit
    assert conn.closed
    assert rig.events == ["connect", "close"]


def test_quality_sim_publishes_the_csv_and_the_log(rig: Rig, puts: list[str]) -> None:
    rig.use_db(sim_conn())

    result = run_quality_sim(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "ok", {"csv_rows": 5, "files_uploaded": 1, "log_uploaded": 1}, ""
    )
    assert puts == [SIM_LOG_KEY, SIM_KEY]
    assert rig.keys("research/") == sorted([SIM_LOG_KEY, SIM_KEY])
    lines = rig.body(SIM_KEY).decode().splitlines()
    assert lines[0] == (
        "fire_id,ticker,fire_date,score,quintile,bonus,quality_adjusted_score,would_be_filtered"
    )
    assert len(lines) == 6
    assert lines[1].startswith("1,AAA,2026-11-09,24,")
    assert step_is_gone(rig, QUALITY_SIM)


def test_quality_sim_empty_csv_fails(rig: Rig, puts: list[str]) -> None:
    rig.use_db(sim_conn(fire_rows=[]))

    result = run_quality_sim(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed", {"csv_rows": 0, "files_uploaded": 0, "log_uploaded": 1}, "no scored fires"
    )
    assert puts == [SIM_LOG_KEY]  # a header-only CSV is not published as if it were a result
    assert rig.events == ["connect", "close"]
    assert step_is_gone(rig, QUALITY_SIM)


def test_quality_sim_a_database_failure_propagates_and_keeps_the_log(
    rig: Rig, puts: list[str]
) -> None:
    conn = sim_conn(fail_on="GROUP BY underlying_symbol")
    rig.use_db(conn)

    with pytest.raises(RuntimeError, match="connection lost"):
        run_quality_sim(rig.ctx())

    assert conn.closed
    assert rig.events == ["connect", "close"]
    assert puts == [SIM_LOG_KEY]  # the evidence, and nothing else
    assert step_is_gone(rig, QUALITY_SIM)


def test_quality_sim_a_failed_fire_select_keeps_the_ticker_log_and_publishes_no_csv(
    rig: Rig, puts: list[str]
) -> None:
    rig.use_db(sim_conn(fail_on="score IS NOT NULL"))

    with pytest.raises(RuntimeError, match="connection lost"):
        run_quality_sim(rig.ctx())

    assert puts == [SIM_LOG_KEY]
    assert "[ticker-quality] 6 tickers seen in 90d window" in rig.body(SIM_LOG_KEY).decode()


def test_quality_sim_a_failed_log_upload_never_hides_the_original_error(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def broken(store: ResearchStore, log_path: Path, session: date, step: str) -> int:
        raise OSError("r2 is down")

    rig.use_db(sim_conn(fail_on="GROUP BY underlying_symbol"))
    monkeypatch.setattr(research_db_steps, "publish_log", broken)

    with caplog.at_level(logging.WARNING), pytest.raises(RuntimeError, match="connection lost"):
        run_quality_sim(rig.ctx())

    # The upload failure is logged by class name, never by text.
    assert "OSError" in caplog.text
    assert "r2 is down" not in caplog.text


def test_quality_sim_output_never_reaches_the_job(
    rig: Rig, caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    rig.use_db(sim_conn())

    with caplog.at_level(logging.DEBUG):
        run_quality_sim(rig.ctx())

    # What the function prints about the tickers is in the log in R2 and nowhere else.
    log = rig.body(SIM_LOG_KEY).decode()
    assert "[ticker-quality] 6 tickers seen in 90d window" in log
    assert "median daily Tier 1+2 count" in log
    assert "[ticker-quality]" not in caplog.text
    captured = capfd.readouterr()
    assert "[ticker-quality]" not in captured.out + captured.err


def test_quality_sim_stdout_and_stderr_of_the_research_code_go_to_the_log(
    rig: Rig,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    capfd: pytest.CaptureFixture[str],
) -> None:
    def chatty(conn: object, sim_csv_path: Path | None = None) -> None:
        print(f"out {MARKER}")
        print(f"err {MARKER}", file=sys.stderr)
        assert sim_csv_path is not None
        sim_csv_path.write_text("fire_id,ticker\n1,AAA\n", encoding="utf-8")

    monkeypatch.setattr(enrich_lottery_outcomes, "refit_ticker_inversion_stats", chatty)
    rig.use_db(sim_conn())

    with caplog.at_level(logging.DEBUG):
        result = run_quality_sim(rig.ctx())

    assert result.status == "ok"
    log = rig.body(SIM_LOG_KEY).decode()
    assert f"out {MARKER}" in log
    assert f"err {MARKER}" in log
    assert MARKER not in caplog.text
    captured = capfd.readouterr()
    assert MARKER not in captured.out + captured.err


def test_quality_sim_hands_the_function_its_session_dated_csv_path(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, object] = {}

    def recording(conn: object, sim_csv_path: Path | None = None) -> None:
        seen["conn"], seen["path"] = conn, sim_csv_path
        assert sim_csv_path is not None
        sim_csv_path.write_text("fire_id\n1\n", encoding="utf-8")

    monkeypatch.setattr(enrich_lottery_outcomes, "refit_ticker_inversion_stats", recording)
    conn = sim_conn()
    rig.use_db(conn)

    run_quality_sim(rig.ctx(last_session=date(2026, 11, 10)))  # not the clock's date

    assert seen["conn"] is conn
    assert isinstance(seen["path"], Path)
    assert seen["path"].name == "lottery-quality-sim-2026-11-10.csv"
    assert rig.keys("research/quality-sim/") == [
        "research/quality-sim/2026-11-10/lottery-quality-sim-2026-11-10.csv"
    ]


def test_quality_sim_logs_its_name_status_counts_and_seconds(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    rig.use_db(sim_conn())

    with caplog.at_level(logging.INFO, logger="research_db_steps"):
        run_quality_sim(rig.ctx())

    (record,) = [r for r in caplog.records if r.name == "research_db_steps"]
    message = record.getMessage()
    assert message.startswith(f"research-report {QUALITY_SIM} ok ")
    assert QUALITY_SIM in message
    assert "csv_rows=5" in message
    assert "seconds=" in message
    assert "AAA" not in message


# --- takeit-drift ----------------------------------------------------------------------------

FIRE_COLUMNS = [
    "date",
    "underlying_symbol",
    "option_type",
    "dte",
    "takeit_prob",
    "takeit_model_version",
    "peak_ceiling_pct",
    "realized_trail30_10_pct",
]


def fires(*, separable: bool, n: int = 12) -> pd.DataFrame:
    """`n` fires over the 5 days before the session. Separable: a high takeit_prob goes with a
    win on both targets, so every AUC is 1.0. Otherwise every fire loses, a single class, and
    every AUC is NaN: no metric is written, and the plot still is."""
    prob = np.tile([0.1, 0.9], n // 2)
    win = prob > 0.5 if separable else np.zeros(n, dtype=bool)
    return pd.DataFrame(
        {
            "date": [pd.Timestamp(LAST_SESSION) - pd.Timedelta(days=1 + i % 5) for i in range(n)],
            "underlying_symbol": ["SPY"] * n,
            "option_type": ["C"] * n,
            "dte": [0] * n,
            "takeit_prob": prob,
            "takeit_model_version": ["v1"] * n,
            "peak_ceiling_pct": np.where(win, 30.0, 5.0),
            "realized_trail30_10_pct": np.where(win, 4.0, -4.0),
        }
    )


class DriftCursor:
    """Answers each feed's SELECT with that feed's frame and records the upserts. pandas uses
    it without a context manager, run_drift with one."""

    def __init__(self, conn: DriftConn) -> None:
        self.conn = conn
        self.description: list[tuple[str]] | None = None
        self._rows: list[tuple[Any, ...]] = []

    def __enter__(self) -> DriftCursor:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: Any = None) -> None:
        conn = self.conn
        if conn.fail_on and conn.fail_on in sql:
            raise RuntimeError("connection lost")
        if "INSERT INTO takeit_health_daily" in sql:
            attempt = len(conn.upserts) + 1
            if attempt == conn.fail_on_upsert:
                raise RuntimeError(f"upsert {attempt} failed")
            conn.upserts.append(params)
            # Under autocommit a statement is durable at once; otherwise at the commit.
            (conn.committed if conn.autocommit else conn.pending).append(params)
            return
        if "FROM lottery_finder_fires" in sql:
            frame = conn.frames["lottery"]
        elif "FROM silent_boom_alerts" in sql:
            frame = conn.frames["silent_boom"]
        else:
            raise AssertionError(f"unexpected SQL: {sql}")
        self.description = [(column,) for column in frame.columns]
        self._rows = list(frame.itertuples(index=False, name=None))

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows

    def close(self) -> None:
        pass


class DriftConn:
    """`fail_on`: any statement containing this text raises. `fail_on_upsert`: the n-th upsert
    (1-based) raises after n-1 went through. `committed` is what a database would keep: every
    upsert made under autocommit, and the open transaction's at a commit."""

    def __init__(
        self,
        frames: dict[str, pd.DataFrame],
        fail_on: str | None = None,
        fail_on_upsert: int | None = None,
    ) -> None:
        self.frames = frames
        self.fail_on = fail_on
        self.fail_on_upsert = fail_on_upsert
        self.autocommit = True
        self.upserts: list[Any] = []
        self.pending: list[Any] = []
        self.committed: list[Any] = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self) -> DriftCursor:
        return DriftCursor(self)

    def commit(self) -> None:
        self.commits += 1
        self.committed += self.pending
        self.pending = []

    def rollback(self) -> None:
        self.rollbacks += 1
        self.pending = []

    def close(self) -> None:
        self.closed = True


def drift_conn(*, lottery: bool = True, silent_boom: bool = True, **kwargs: Any) -> DriftConn:
    frames = {
        "lottery": fires(separable=lottery),
        "silent_boom": fires(separable=silent_boom),
    }
    return DriftConn(frames, **kwargs)


def test_drift_publishes_report_and_plots_dated_by_session(rig: Rig, puts: list[str]) -> None:
    conn = drift_conn()
    rig.use_db(conn)

    result = run_takeit_drift(rig.ctx())  # NOW is the 12th; the session is the 11th

    assert asserted_valid(result) == StepResult(
        "ok",
        {"metrics_written": 8, "plots_written": 2, "files_uploaded": 3, "log_uploaded": 1},
        "",
    )
    assert rig.keys("research/") == sorted([DRIFT_LOG_KEY, DRIFT_REPORT_KEY, *DRIFT_PLOT_KEYS])
    assert puts[0] == DRIFT_LOG_KEY
    assert rig.body(DRIFT_REPORT_KEY).decode().startswith(f"# TAKE-IT drift report — {SESSION}")
    for key in DRIFT_PLOT_KEYS:
        assert rig.body(key).startswith(b"\x89PNG")
    # The metrics are the session's, not the clock's, and committed once.
    assert {params[0] for params in conn.upserts} == {LAST_SESSION}
    assert conn.commits == 1
    assert conn.committed == conn.upserts
    assert conn.closed
    assert rig.events == ["connect", "close"]
    assert step_is_gone(rig, DRIFT)


def test_drift_zero_metrics_fails(rig: Rig, puts: list[str]) -> None:
    # Both feeds have fires but one class: every AUC is NaN, so no metric is written. The plots
    # exist, and still the step must not be ok.
    conn = drift_conn(lottery=False, silent_boom=False)
    rig.use_db(conn)

    result = run_takeit_drift(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed",
        {"metrics_written": 0, "plots_written": 2, "files_uploaded": 0, "log_uploaded": 1},
        "no drift metrics",
    )
    assert conn.upserts == []
    assert puts == [DRIFT_LOG_KEY]  # no report, no plots: a failed run publishes no outputs
    assert rig.keys("research/takeit-drift/") == []
    assert rig.keys("research/") == [DRIFT_LOG_KEY]
    # The evidence for why no AUC was written is the report run_drift wrote, so it is in the log.
    log = rig.body(DRIFT_LOG_KEY).decode()
    assert f"# TAKE-IT drift report — {SESSION}" in log
    assert "- auc_7d_peak: n/a" in log
    assert conn.closed
    assert step_is_gone(rig, DRIFT)


def test_drift_a_run_with_metrics_does_not_copy_the_report_into_the_log(rig: Rig) -> None:
    rig.use_db(drift_conn())

    run_takeit_drift(rig.ctx())

    # The report is published as a file; the log keeps to what the research code printed.
    assert "# TAKE-IT drift report" not in rig.body(DRIFT_LOG_KEY).decode()
    assert DRIFT_REPORT_KEY in rig.keys(f"research/takeit-drift/{SESSION}/")


def test_drift_one_feed_with_metrics_is_ok(rig: Rig) -> None:
    rig.use_db(drift_conn(silent_boom=False))

    result = run_takeit_drift(rig.ctx())

    assert asserted_valid(result).status == "ok"
    assert (result.counts["metrics_written"], result.counts["plots_written"]) == (4, 2)


def test_drift_runs_without_autocommit(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    # connect_db hands over an autocommit connection; run_drift's contract is one commit after
    # the last upsert, so the step turns autocommit off before it runs.
    seen: dict[str, object] = {}
    real = takeit_drift_monitor.run_drift

    def spying(conn: Any, as_of: date, report_dir: Path, plot_dir: Path) -> Any:
        seen["autocommit"] = conn.autocommit
        seen["args"] = (as_of, report_dir, plot_dir)
        return real(conn, as_of, report_dir, plot_dir)

    monkeypatch.setattr(takeit_drift_monitor, "run_drift", spying)
    conn = drift_conn()
    rig.use_db(conn)

    run_takeit_drift(rig.ctx())

    assert seen["autocommit"] is False
    as_of, report_dir, plot_dir = seen["args"]  # type: ignore[misc]
    assert as_of == LAST_SESSION
    assert report_dir == plot_dir
    assert report_dir.is_relative_to(rig.work)  # the step's own folder


def test_a_failing_upsert_commits_nothing_and_fails_the_step(rig: Rig, puts: list[str]) -> None:
    conn = drift_conn(fail_on_upsert=2)
    rig.use_db(conn)
    outcomes: list[steps.StepOutcome] = []
    step = Step(DRIFT, lambda ctx: run_step(DRIFT, ctx), 1)

    run_steps(
        [step],
        settings=rig.settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=time.monotonic() + 120,
        tape=(),
        on_outcome=outcomes.append,
    )

    (outcome,) = outcomes
    assert (outcome.status, outcome.error) == ("failed", "RuntimeError")
    assert "upsert 2 failed" not in repr(outcome)  # the class, never the text
    assert len(conn.upserts) == 1  # the first went through its transaction...
    assert conn.committed == []  # ...and was never made durable
    assert (conn.commits, conn.rollbacks) == (0, 1)
    assert conn.closed
    # Nothing but the log: the report that run_drift wrote on disk is not published.
    assert puts == [DRIFT_LOG_KEY]
    assert rig.keys("research/") == [DRIFT_LOG_KEY]
    assert step_is_gone(rig, DRIFT)


def test_drift_a_database_failure_propagates_and_keeps_the_log(rig: Rig, puts: list[str]) -> None:
    conn = drift_conn(fail_on="FROM silent_boom_alerts")
    rig.use_db(conn)

    with pytest.raises(RuntimeError, match="connection lost"):
        run_takeit_drift(rig.ctx())

    assert (conn.commits, conn.rollbacks, conn.closed) == (0, 1, True)
    assert puts == [DRIFT_LOG_KEY]


def test_drift_a_missing_dependency_fails_before_any_connection(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, puts: list[str]
) -> None:
    monkeypatch.setitem(sys.modules, "takeit_drift_monitor", None)  # `import` now raises

    with pytest.raises(ImportError):
        run_takeit_drift(rig.ctx())

    assert rig.events == []  # no connection was opened for a step that could not start
    assert puts == [DRIFT_LOG_KEY]


@pytest.mark.parametrize("step", [QUALITY_SIM, DRIFT])
def test_stdout_and_stderr_are_the_originals_after_a_step_whose_research_call_raises(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    originals = (sys.stdout, sys.stderr)
    inside: list[tuple[object, object]] = []

    def raising(*args: object, **kwargs: object) -> None:
        inside.append((sys.stdout, sys.stderr))
        raise RuntimeError("the research call failed")

    if step == QUALITY_SIM:
        monkeypatch.setattr(enrich_lottery_outcomes, "refit_ticker_inversion_stats", raising)
        rig.use_db(sim_conn())
    else:
        monkeypatch.setattr(takeit_drift_monitor, "run_drift", raising)
        rig.use_db(drift_conn())

    with pytest.raises(RuntimeError, match="the research call failed"):
        run_step(step, rig.ctx())

    (seen,) = inside
    assert seen[0] is not originals[0]  # the research call did run with the output redirected
    assert seen[1] is not originals[1]
    assert sys.stdout is originals[0]
    assert sys.stderr is originals[1]


@pytest.mark.parametrize("step", [QUALITY_SIM, DRIFT])
def test_the_connection_is_opened_outside_the_redirect_and_only_the_research_call_inside(
    rig: Rig, capsys: pytest.CaptureFixture[str], step: str
) -> None:
    # connect_with_retry's notes (a class name only, never a host) belong in the job's log, where
    # the owner looks first when Neon is down; what the research code prints belongs in the file.
    note = "[retry] connect attempt 1/3 failed (OperationalError)"
    if step == QUALITY_SIM:
        rig.use_db(sim_conn(), connect_prints=note)
        log_key, inside = SIM_LOG_KEY, "[ticker-quality] 6 tickers seen"
    else:
        rig.use_db(drift_conn(), connect_prints=note)
        log_key, inside = DRIFT_LOG_KEY, None

    result = run_step(step, rig.ctx())

    assert result.status == "ok"
    log = rig.body(log_key).decode()
    assert "OperationalError" not in log
    assert "[retry]" not in log
    assert note in capsys.readouterr().err  # on the job's own stderr
    if inside is not None:
        assert inside in log  # the research call's output is still in the log


def test_drift_output_never_reaches_the_job(
    rig: Rig,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    capfd: pytest.CaptureFixture[str],
) -> None:
    def chatty(conn: object, as_of: date, report_dir: Path, plot_dir: Path) -> Any:
        print(f"out {MARKER}")
        print(f"err {MARKER}", file=sys.stderr)
        report = report_dir / f"takeit-drift-{as_of.isoformat()}.md"
        report.write_text("# report\n", encoding="utf-8")
        return takeit_drift_monitor.DriftRun(report, (), 1)

    monkeypatch.setattr(takeit_drift_monitor, "run_drift", chatty)
    rig.use_db(drift_conn())

    with caplog.at_level(logging.DEBUG):
        result = run_takeit_drift(rig.ctx())

    assert result.status == "ok"
    log = rig.body(DRIFT_LOG_KEY).decode()
    assert f"out {MARKER}" in log
    assert f"err {MARKER}" in log
    assert MARKER not in caplog.text
    captured = capfd.readouterr()
    assert MARKER not in captured.out + captured.err


def test_drift_output_of_a_failing_run_stays_in_the_log(
    rig: Rig,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    capfd: pytest.CaptureFixture[str],
) -> None:
    def failing(conn: object, as_of: date, report_dir: Path, plot_dir: Path) -> Any:
        print(f"out {MARKER}")
        print(f"err {MARKER}", file=sys.stderr)
        raise RuntimeError("upsert failed")

    monkeypatch.setattr(takeit_drift_monitor, "run_drift", failing)
    rig.use_db(drift_conn())

    with caplog.at_level(logging.DEBUG), pytest.raises(RuntimeError):
        run_takeit_drift(rig.ctx())

    log = rig.body(DRIFT_LOG_KEY).decode()
    assert f"out {MARKER}" in log
    assert f"err {MARKER}" in log
    assert MARKER not in caplog.text
    captured = capfd.readouterr()
    assert MARKER not in captured.out + captured.err


# --- the step log is appended to, never truncated -------------------------------------------
#
# The step opens its log for each writer: the import of the research module, the research call and,
# on a drift run with no metric, the report's text. Each must add to what is there. A module the
# test process has already imported prints nothing when a step imports it again, so these tests
# put stand-ins that print at import time on the import path in place of the real modules.

IMPORT_OUT, IMPORT_ERR = "stdout while importing", "stderr while importing"
CALL_OUT, CALL_ERR = "stdout of the research call", "stderr of the research call"
REPORT_TEXT = "the drift report's own text"
PHASE_LINES = [IMPORT_OUT, IMPORT_ERR, CALL_OUT, CALL_ERR]

QUALITY_SIM_STAND_IN = f"""
import sys

print({IMPORT_OUT!r})
print({IMPORT_ERR!r}, file=sys.stderr)


def refit_ticker_inversion_stats(conn, sim_csv_path=None):
    print({CALL_OUT!r})
    print({CALL_ERR!r}, file=sys.stderr)
    sim_csv_path.write_text("fire_id,ticker\\n1,AAA\\n", encoding="utf-8")
"""


def drift_stand_in(metrics_written: int) -> str:
    return f"""
import sys
from pathlib import Path
from types import SimpleNamespace

print({IMPORT_OUT!r})
print({IMPORT_ERR!r}, file=sys.stderr)


def run_drift(conn, as_of, report_dir, plot_dir):
    print({CALL_OUT!r})
    print({CALL_ERR!r}, file=sys.stderr)
    report = Path(report_dir) / f"takeit-drift-{{as_of.isoformat()}}.md"
    report.write_text({REPORT_TEXT!r} + "\\n", encoding="utf-8")
    return SimpleNamespace(report_path=report, plot_paths=(), metrics_written={metrics_written})
"""


def put_stand_in(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str, source: str) -> None:
    """Take `name`'s place on the import path with a module that prints when it is imported. The
    real module comes back in sys.modules when the test ends."""
    folder = tmp_path / "stand-ins"
    folder.mkdir(exist_ok=True)
    (folder / f"{name}.py").write_text(source, encoding="utf-8")
    monkeypatch.syspath_prepend(str(folder))
    monkeypatch.delitem(sys.modules, name)


@pytest.mark.parametrize("step", [QUALITY_SIM, DRIFT])
def test_the_step_log_keeps_the_import_output_when_the_research_call_adds_its_own(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, step: str
) -> None:
    if step == QUALITY_SIM:
        put_stand_in(monkeypatch, tmp_path, "enrich_lottery_outcomes", QUALITY_SIM_STAND_IN)
        rig.use_db(sim_conn())
        run, log_key = run_quality_sim, SIM_LOG_KEY
    else:
        put_stand_in(monkeypatch, tmp_path, "takeit_drift_monitor", drift_stand_in(1))
        rig.use_db(drift_conn())
        run, log_key = run_takeit_drift, DRIFT_LOG_KEY

    result = run(rig.ctx())

    assert result.status == "ok"
    # The import's lines came first and are still there when the research call's follow them:
    # the second redirect opens the same file and adds to it.
    assert rig.body(log_key).decode().splitlines() == PHASE_LINES


def test_the_zero_metrics_report_is_added_after_what_the_research_code_wrote_to_the_log(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # On a run that wrote no metric the warnings the research code printed are the other half of
    # the evidence, so the report goes after them and does not replace them.
    put_stand_in(monkeypatch, tmp_path, "takeit_drift_monitor", drift_stand_in(0))
    rig.use_db(drift_conn())

    result = run_takeit_drift(rig.ctx())

    assert (result.status, result.detail) == ("failed", "no drift metrics")
    lines = rig.body(DRIFT_LOG_KEY).decode().splitlines()
    assert lines[:4] == PHASE_LINES
    assert [line for line in lines[4:] if line] == [
        f"--- takeit-drift-{SESSION}.md ---",
        REPORT_TEXT,
    ]
    assert rig.keys("research/takeit-drift/") == []


def test_drift_never_calls_the_monitors_own_main(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    # main() opens its own connection from the ml utils, parses sys.argv and returns an exit code.
    main = create_autospec(takeit_drift_monitor.main, side_effect=AssertionError("main called"))
    monkeypatch.setattr(takeit_drift_monitor, "main", main)
    rig.use_db(drift_conn())

    assert run_takeit_drift(rig.ctx()).status == "ok"

    main.assert_not_called()


def test_drift_logs_its_name_status_counts_and_seconds(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    rig.use_db(drift_conn())

    with caplog.at_level(logging.INFO, logger="research_db_steps"):
        run_takeit_drift(rig.ctx())

    (record,) = [r for r in caplog.records if r.name == "research_db_steps"]
    message = record.getMessage()
    assert message.startswith(f"research-report {DRIFT} ok ")
    assert DRIFT in message
    assert "metrics_written=8" in message
    assert "seconds=" in message
    assert "SPY" not in message
