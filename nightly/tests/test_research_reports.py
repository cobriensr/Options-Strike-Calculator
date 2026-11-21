"""Tests for the research report steps: the script runner, the rollup and the six report steps.

The report scripts are tiny Python files under a `tmp_path` APP_ROOT. They run as real
subprocesses, through the module's own env, working directory and log capture. R2 is moto: the
real ResearchStore and R2Store list, sync and publish. The database connection and `targets`
(the fingerprint each family should hold) are patched at research_reports' boundary; the
manifest, the tape listing and `fresh_days` are the real ones.
"""

from __future__ import annotations

import io
import json
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
from unittest.mock import MagicMock, create_autospec
from urllib.parse import urlsplit

import boto3
import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from _eod_flow import CHAINS_COLUMNS
from botocore.exceptions import ClientError
from moto import mock_aws
from pydantic import SecretStr

import research_derive
import research_reports
import resources
import steps
from config import Settings, load_settings
from constants import DB_CONNECT_TIMEOUT_SECONDS, DB_STATEMENT_TIMEOUT_MS, RESEARCH_WORK_DIR
from research_derive import FAMILY_KEYS, Manifest
from research_reports import (
    IN_DIR,
    LOG_NAME,
    OUT_DIR,
    REPORTS,
    STEP_NAMES,
    ScriptReport,
    ScriptRun,
    error_class,
    failure_detail,
    log_step,
    prepare_step_dir,
    publish,
    publish_log,
    run_report,
    run_rollup,
    run_script,
    run_step,
    script_env,
)
from research_store import ResearchStore
from steps import Step, StepContext, StepResult, run_steps

BUCKET = "test-bucket"
NOW = datetime(2026, 11, 12, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 11)  # a Wednesday; NOW is the next morning
SESSION = LAST_SESSION.isoformat()
D1, D2, D3, D4 = date(2026, 11, 6), date(2026, 11, 9), date(2026, 11, 10), date(2026, 11, 11)
ROLLUP_STEP = "eod-flow-rollup"
REPORT_STEPS = {
    "whale-plots",
    "exit-policy-report",
    "flow-timing-report",
    "feature-audit",
    "outcome-mining",
    "score-lineage",
}
# What a script's marker and a leaked ticker look like: neither may leave the log file.
MARKER = "-".join(("MARKER", "SPXW", "450C", "1234567"))
NO_COUNTS = {
    "files_uploaded": 0,
    "bytes_uploaded": 0,
    "inputs_synced": 0,
    "inputs_missing": 0,
    "log_uploaded": 1,
    "exit_code": 0,
    "timed_out": 0,
}

# --- the rig ---------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_home(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """boto3 reads ~/.aws and may cache under the home dir; keep it off the real one."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


@pytest.fixture
def settings() -> Settings:
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    return load_settings().model_copy(
        update={"r2_endpoint_url": "https://s3.amazonaws.com", "r2_bucket_fulltape": BUCKET}
    )


@dataclass
class Rig:
    """The patched boundary of research_reports: a fake app root, a work dir, R2 and the DB."""

    s3: Any
    settings: Settings
    app: Path
    work: Path
    flag: Path
    events: list[str]
    connect: MagicMock
    targets: MagicMock
    wanted: dict[str, dict[date, str]]

    # scripts
    def script(self, relative: str, body: str, **names: object) -> str:
        """Write a script under the fake app root; `names` become constants at its top."""
        path = self.app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        header = "".join(f"{name} = {value!r}\n" for name, value in names.items())
        path.write_text(header + body, encoding="utf-8")
        return relative

    def ctx(self, left: float = 120.0, last_session: date = LAST_SESSION) -> StepContext:
        return StepContext(
            self.settings, NOW, last_session, deadline=time.monotonic() + left, tape=()
        )

    # R2
    def put(self, key: str, body: bytes = b"x") -> None:
        self.s3.put_object(Bucket=BUCKET, Key=key, Body=body)

    def land(self, day: date) -> None:
        self.put(f"fulltape/{day.isoformat()}-fulltape.parquet", f"tape {day}".encode())

    def keys(self, prefix: str = "") -> list[str]:
        pages = self.s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix)
        return sorted(o["Key"] for page in pages for o in page.get("Contents", []))

    def body(self, key: str) -> bytes:
        return self.s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()

    def set_manifest(self, families: dict[str, dict[date, str]]) -> None:
        manifest = Manifest({family: {} for family in families})
        for family, days in families.items():
            for day, fingerprint in days.items():
                manifest.families[family][day.isoformat()] = fingerprint
        manifest.save(ResearchStore(self.settings))

    def derived_key(self, family: str, day: date) -> str:
        return FAMILY_KEYS[family](day)


@pytest.fixture
def rig(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings: Settings) -> Iterator[Rig]:
    app = tmp_path / "app"
    (app / "scripts").mkdir(parents=True)
    work = tmp_path / "work"  # not created: the step makes it
    flag = tmp_path / "connection-open.flag"
    events: list[str] = []
    wanted: dict[str, dict[date, str]] = {"chains": {}, "exit-policy": {}, "flow-timing": {}}
    monkeypatch.setattr(research_reports, "APP_ROOT", app)
    monkeypatch.setattr(research_reports, "RESEARCH_WORK_DIR", work)

    @contextmanager
    def fake_connect(_settings: Settings) -> Iterator[MagicMock]:
        events.append("connect")
        flag.write_text("open")
        try:
            yield MagicMock(name="conn")
        finally:
            flag.unlink()
            events.append("close")

    def fake_targets(_conn: object, etags: dict[date, str], last_session: date) -> Any:
        events.append("targets")
        return wanted

    connect = create_autospec(resources.connect_db, side_effect=fake_connect)
    targets = create_autospec(research_derive.targets, side_effect=fake_targets)
    monkeypatch.setattr(research_reports, "connect_db", connect)
    monkeypatch.setattr(research_reports, "targets", targets)
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        yield Rig(s3, settings, app, work, flag, events, connect, targets, wanted)


def report_for(step: str) -> ScriptReport:
    return next(report for report in REPORTS if report.step == step)


def custom_report(
    outputs: tuple[str, ...] = ("out-*.md",), script: str = "scripts/custom.py"
) -> ScriptReport:
    return ScriptReport(
        step="custom-step",
        family="custom-family",
        script=script,
        inputs="none",
        outputs=outputs,
        extra_args=lambda session, in_dir, out_dir: ["--out-dir", str(out_dir)],
    )


# The scripts. Each is a stand-in for a report script: same flags, no imports from the repo.
WRITE_OUTPUT = """
import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--out-dir", type=Path, required=True)
args, _ = parser.parse_known_args()
args.out_dir.mkdir(parents=True, exist_ok=True)
for name in OUTPUTS:
    (args.out_dir / name).write_bytes(BODY.encode("utf-8"))  # bytes: no CRLF on Windows
"""
# Lists what the report was handed, and whether a database connection was open meanwhile.
LIST_INPUT = """
import argparse
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--derived-dir", type=Path)
parser.add_argument("--by-day-dir", type=Path)
parser.add_argument("--out-dir", type=Path, required=True)
args = parser.parse_args()
source = args.derived_dir or args.by_day_dir
names = sorted(path.name for path in source.iterdir())
args.out_dir.mkdir(parents=True, exist_ok=True)
text = ",".join(names) + "|conn_open=" + str(os.path.exists(FLAG))
(args.out_dir / OUTPUT).write_bytes(text.encode("utf-8"))
"""
RAISE = """
raise ValueError("SPY 450C premium 1,234,567")
"""
SLEEP = """
import sys
import time
from pathlib import Path

print("started", flush=True)
beat = Path(HEARTBEAT)
for _ in range(600):
    with beat.open("a") as handle:
        handle.write("x")
    time.sleep(0.05)
"""


def report_files(rig: Rig, prefix: str) -> dict[str, bytes]:
    return {key: rig.body(key) for key in rig.keys(prefix)}


def asserted_valid(result: StepResult) -> StepResult:
    """The result must pass run_steps' contract: ints >= 0 and a str detail."""
    assert steps._is_valid(result)
    return result


# --- the table, the names and the dispatch ---------------------------------------------------


def test_the_report_table_is_the_briefs(tmp_path: Path) -> None:
    in_dir, out_dir = tmp_path / "in", tmp_path / "out"
    by_day = ["--by-day-dir", str(in_dir), "--out-dir", str(out_dir)]
    derived = ["--derived-dir", str(in_dir), "--out-dir", str(out_dir)]
    only_out = ["--out-dir", str(out_dir)]
    as_of = ["--as-of", SESSION, "--out-dir", str(out_dir)]
    expected = [
        ("whale-plots", "whale-plots", "ml/src/whale_plots.py", "chains", ("*.png",), by_day),
        (
            "exit-policy-report",
            "exit-policy",
            "scripts/exit_policy_search.py",
            "exit-policy",
            ("lottery-exit-policy-search-*.md",),
            derived,
        ),
        (
            "flow-timing-report",
            "flow-timing",
            "scripts/flow_inversion_timing.py",
            "flow-timing",
            ("flow-inversion-timing-*.md",),
            derived,
        ),
        (
            "feature-audit",
            "feature-audit",
            "scripts/feature_audit.py",
            "none",
            ("lottery-feature-audit-*.md",),
            only_out,
        ),
        (
            "outcome-mining",
            "outcome-mining",
            "scripts/mine_outcome_patterns.py",
            "none",
            ("lottery-composite-candidates-*.md",),
            as_of,
        ),
        (
            "score-lineage",
            "score-lineage",
            "scripts/score_lineage_audit.py",
            "none",
            ("lottery-score-lineage-*.md",),
            as_of,
        ),
    ]

    actual = [
        (
            r.step,
            r.family,
            r.script,
            r.inputs,
            r.outputs,
            r.extra_args(LAST_SESSION, in_dir, out_dir),
        )
        for r in REPORTS
    ]

    assert actual == expected
    assert all(isinstance(r.outputs, tuple) for r in REPORTS)


def test_every_report_script_is_in_the_repo() -> None:
    root = research_reports.APP_ROOT
    assert (root / "scripts").is_dir()
    assert Path(research_reports.__file__).resolve().is_relative_to(root)
    for report in REPORTS:
        assert (root / report.script).is_file(), report.script


def test_the_report_step_names_are_unique_and_the_rollup_joins_them() -> None:
    steps_ = [report.step for report in REPORTS]
    assert len(set(steps_)) == len(steps_)
    assert set(steps_) == REPORT_STEPS
    assert {ROLLUP_STEP, *REPORT_STEPS} == STEP_NAMES
    assert isinstance(STEP_NAMES, frozenset)


def test_run_step_dispatches_by_name_and_rejects_an_unknown_one(
    monkeypatch: pytest.MonkeyPatch, rig: Rig
) -> None:
    rollup = create_autospec(run_rollup, return_value=StepResult("ok", {}))
    report = create_autospec(run_report, return_value=StepResult("ok", {}))
    monkeypatch.setattr(research_reports, "run_rollup", rollup)
    monkeypatch.setattr(research_reports, "run_report", report)
    ctx = rig.ctx()

    for name in sorted(STEP_NAMES):
        rollup.reset_mock()
        report.reset_mock()
        assert run_step(name, ctx) == StepResult("ok", {})
        if name == ROLLUP_STEP:
            rollup.assert_called_once_with(ctx)
            report.assert_not_called()
        else:
            report.assert_called_once_with(report_for(name), ctx)
            rollup.assert_not_called()

    rollup.reset_mock()
    report.reset_mock()
    for unknown in ("research-derive", "quality-sim", "whale_plots", "", "Feature-Audit"):
        with pytest.raises(KeyError):
            run_step(unknown, ctx)
    rollup.assert_not_called()
    report.assert_not_called()


def test_importing_the_module_pulls_no_ml_stack() -> None:
    """A step module is imported when its step runs: sklearn, scipy or sqlalchemy would be
    a heavy import for a report runner, and the scripts run as subprocesses, never imported
    for their ML dependencies."""
    code = (
        "import sys, research_reports\n"
        "heavy = [m for m in ('sklearn', 'scipy', 'sqlalchemy') if m in sys.modules]\n"
        "assert not heavy, heavy\n"
    )
    root = Path(research_reports.__file__).resolve().parents[2]
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


# --- error_class ----------------------------------------------------------------------------

TRACEBACK = (
    "Traceback (most recent call last):\n"
    '  File "/app/scripts/x.py", line 9, in <module>\n'
    "    main()\n"
)
# (a last line, or a whole log) that must yield no class.
NO_CLASS = {
    "a bracketed no-data exit": "loading fires\n[search] no fire produced a derived row\n",
    "a count line": "SPXW: 12 fires\n",
    "a files line": "Wrote 12 files\n",
    "a chains line": "NDXP: 3 chains\n",
    "a bare name outside a traceback": "Timeout\n",
    "a name that only contains Error": "ErrorLog: 3\n",
    "a killed run, mid traceback": TRACEBACK,
    "an earlier traceback, then normal output": TRACEBACK + "KeyError: 'x'\nSPXW: 12 fires\n",
    "an empty log": "",
    "only blank lines": "\n  \n\n",
    "a 101-character class": "A" * 96 + "Error: x\n",
    "a 101-character class ending a traceback": TRACEBACK + "B" * 101 + ": x\n",
    "a non-ASCII class": "ValuéError: x\n",
    "a leading digit": "3Error: x\n",
    "a second line after the class": TRACEBACK
    + "psycopg2.errors.QueryCanceled: canceling statement\nCONTEXT:  SQL statement x\n",
}
# (the log, the class it names): the class only, never the message.
CLASS = {
    "an Error with a message": ("ValueError: SPY 450C\n", "ValueError"),
    "a bare interrupt": ("KeyboardInterrupt\n", "KeyboardInterrupt"),
    "an exit with a code": ("SystemExit: 1\n", "SystemExit"),
    "an Exception suffix": ("MyException: x\n", "MyException"),
    "no space after the colon": ("ValueError:SPY\n", "ValueError"),
    "a dotted class, whole": (
        "_report_weights.ActiveWeightsError: no active pointer\n",
        "_report_weights.ActiveWeightsError",
    ),
    "a traceback end with no suffix": (
        TRACEBACK + "psycopg2.errors.QueryCanceled: canceling statement\n",
        "psycopg2.errors.QueryCanceled",
    ),
    "a bare traceback end": (TRACEBACK + "Timeout\n", "Timeout"),
    "the last of two chained tracebacks": (
        TRACEBACK
        + "KeyError: 'a'\n\nDuring handling of the above exception, another exception occurred:\n\n"
        + TRACEBACK
        + "psycopg2.errors.QueryCanceled: c\n",
        "psycopg2.errors.QueryCanceled",
    ),
    "trailing blanks and spaces": (TRACEBACK + "QueryCanceled: x   \n\n  \n", "QueryCanceled"),
    "windows line ends": (
        (TRACEBACK + "QueryCanceled: x\n").replace("\n", "\r\n"),
        "QueryCanceled",
    ),
    "a 100-character class": ("A" * 95 + "Error: x\n", "A" * 95 + "Error"),
    "a 100-character class ending a traceback": (TRACEBACK + "B" * 100 + ": x\n", "B" * 100),
}


def _log(tmp_path: Path, content: str | bytes) -> Path:
    path = tmp_path / "step.log"
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    return path


@pytest.mark.parametrize("content", NO_CLASS.values(), ids=NO_CLASS.keys())
def test_error_class_rejects_non_identifiers(tmp_path: Path, content: str) -> None:
    assert error_class(_log(tmp_path, content)) is None


@pytest.mark.parametrize(("content", "name"), CLASS.values(), ids=CLASS.keys())
def test_error_class_names_the_class_and_never_the_message(
    tmp_path: Path, content: str, name: str
) -> None:
    assert error_class(_log(tmp_path, content)) == name


def test_error_class_survives_undecodable_bytes(tmp_path: Path) -> None:
    assert error_class(_log(tmp_path, b"\xff\xfe junk \x00\nValueError: x\n")) == "ValueError"


def test_error_class_of_a_large_log_reads_its_end(tmp_path: Path) -> None:
    noise = "".join(f"  row {n} SPXW 450C\n" for n in range(40_000))  # about 800 KB
    content = TRACEBACK + "KeyError: 'early'\n" + noise + TRACEBACK + "QueryCanceled: late\n"
    assert error_class(_log(tmp_path, content)) == "QueryCanceled"
    content = noise + "SPXW: 12 fires\n"
    assert error_class(_log(tmp_path, content)) is None


# --- script_env -----------------------------------------------------------------------------


def test_script_env_carries_no_store_or_uw_secrets(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    pooled = "postgresql://owner:p%40ss@ep-cool-darkness-123-pooler.us-east-2.aws.neon.tech/db?sslmode=require"
    settings = rig.settings.model_copy(update={"database_url": SecretStr(pooled)})
    for name, value in {
        "PATH": "/usr/local/bin:/usr/bin",
        "PYTHONPATH": "/app/src:/app/scripts:/app/ml/src",
        "POLARS_MAX_THREADS": "4",
        "R2_ACCESS_KEY_ID": "leak-r2-id",
        "R2_SECRET_ACCESS_KEY": "leak-r2-secret",
        "R2_ENDPOINT_URL": "https://leak.r2.example",
        "R2_BUCKET_FULLTAPE": "leak-bucket",
        "UW_API_KEY": "leak-uw-key",
        "SENTRY_DSN": "https://leak@sentry.invalid/1",
        "AWS_SECRET_ACCESS_KEY": "leak-aws",
        "DATABASE_URL": pooled,
        "RAILWAY_TOKEN": "leak-railway",
        "UNRELATED": "x",
    }.items():
        monkeypatch.setenv(name, value)

    env = script_env(settings, "exit-policy-report")

    assert set(env) == {
        "PATH",
        "PYTHONPATH",
        "POLARS_MAX_THREADS",
        "LANG",
        "TZ",
        "PYTHONUNBUFFERED",
        "PYTHONDONTWRITEBYTECODE",
        "HOME",
        "MPLCONFIGDIR",
        "MPLBACKEND",
        "DATABASE_URL",
        "DATABASE_URL_UNPOOLED",
        "PGOPTIONS",
        "PGAPPNAME",
        "PGCONNECT_TIMEOUT",
    }
    assert "leak" not in " ".join(env.values())
    assert env["PATH"] == "/usr/local/bin:/usr/bin"
    assert env["PYTHONPATH"] == "/app/src:/app/scripts:/app/ml/src"
    assert env["POLARS_MAX_THREADS"] == "4"
    # D4's direct host: the pooler rejects the startup options a statement timeout needs.
    for name in ("DATABASE_URL", "DATABASE_URL_UNPOOLED"):
        parts = urlsplit(env[name])
        assert parts.hostname == "ep-cool-darkness-123.us-east-2.aws.neon.tech"
        assert "-pooler" not in env[name]
        assert (parts.username, parts.password) == ("owner", "p%40ss")
        assert parts.query == "sslmode=require"


def test_script_env_sets_the_fixed_values_and_the_per_step_names(rig: Rig) -> None:
    env = script_env(rig.settings, "whale-plots")

    assert env["LANG"] == "C.UTF-8"
    assert env["TZ"] == "UTC"
    assert env["PYTHONUNBUFFERED"] == "1"
    assert env["PYTHONDONTWRITEBYTECODE"] == "1"
    assert env["MPLBACKEND"] == "Agg"
    assert env["PGAPPNAME"] == "nightly-whale-plots"
    assert script_env(rig.settings, "score-lineage")["PGAPPNAME"] == "nightly-score-lineage"


def test_script_env_builds_the_pg_timeouts_from_the_constants(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = script_env(rig.settings, "feature-audit")
    assert env["PGOPTIONS"] == f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}"
    assert env["PGCONNECT_TIMEOUT"] == str(DB_CONNECT_TIMEOUT_SECONDS)

    # Read from the constants when called, never copied as a literal.
    monkeypatch.setattr(research_reports, "DB_STATEMENT_TIMEOUT_MS", 123_457)
    monkeypatch.setattr(research_reports, "DB_CONNECT_TIMEOUT_SECONDS", 7)
    env = script_env(rig.settings, "feature-audit")
    assert env["PGOPTIONS"] == "-c statement_timeout=123457"
    assert env["PGCONNECT_TIMEOUT"] == "7"


def test_script_env_puts_home_and_the_matplotlib_cache_under_the_work_dir(rig: Rig) -> None:
    env = script_env(rig.settings, "whale-plots")

    for name in ("HOME", "MPLCONFIGDIR"):
        assert Path(env[name]).is_relative_to(rig.work)
    assert env["HOME"] != env["MPLCONFIGDIR"]
    other = script_env(rig.settings, "feature-audit")
    assert other["HOME"] != env["HOME"]
    assert other["MPLCONFIGDIR"] != env["MPLCONFIGDIR"]


def test_script_env_keeps_only_the_inherited_names_that_are_set(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("PATH", "PYTHONPATH", "POLARS_MAX_THREADS"):
        monkeypatch.delenv(name, raising=False)

    env = script_env(rig.settings, "feature-audit")

    assert not {"PATH", "PYTHONPATH", "POLARS_MAX_THREADS"} & set(env)


def test_the_work_dir_is_the_constants_research_work_dir() -> None:
    # script_env, the step folders and the matplotlib cache all hang off it (constants.py).
    assert research_reports.RESEARCH_WORK_DIR is RESEARCH_WORK_DIR


# --- run_script -----------------------------------------------------------------------------


def test_run_script_captures_both_streams_in_the_log_and_nowhere_else(
    rig: Rig, tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    script = rig.script(
        "scripts/chatty.py",
        "import sys\n"
        f"print('out-{MARKER}', flush=True)\n"
        f"print('err-{MARKER}', file=sys.stderr, flush=True)\n",
    )
    log = tmp_path / "logs" / "deep" / "chatty.log"

    run = run_script(script, [], log_path=log, timeout=60, env={})

    assert run == ScriptRun(0, False, None)
    text = log.read_text(encoding="utf-8")
    assert f"out-{MARKER}" in text
    assert f"err-{MARKER}" in text
    captured = capfd.readouterr()
    assert MARKER not in captured.out + captured.err


def test_run_script_runs_the_apps_interpreter_in_the_app_root_with_the_given_env(
    rig: Rig, tmp_path: Path
) -> None:
    script = rig.script(
        "scripts/probe.py",
        "import json, os, sys\n"
        "print(json.dumps({'cwd': os.getcwd(), 'argv': sys.argv[1:], 'exe': sys.executable,\n"
        "                  'env': sorted(os.environ), 'stdin': sys.stdin.read()}))\n",
    )
    log = tmp_path / "probe.log"

    run = run_script(script, ["--a", "b c"], log_path=log, timeout=60, env={"ONLY": "this"})

    assert run.returncode == 0
    seen = json.loads(log.read_text(encoding="utf-8").splitlines()[-1])
    assert Path(seen["cwd"]).resolve() == rig.app.resolve()
    assert seen["argv"] == ["--a", "b c"]
    assert Path(seen["exe"]).resolve() == Path(sys.executable).resolve()
    # The child sees the given env and nothing else. (In a C locale Python itself adds
    # LC_CTYPE, PEP 538; no other name may appear.)
    assert set(seen["env"]) - {"LC_CTYPE"} == {"ONLY"}
    assert seen["stdin"] == ""  # no terminal to wait on


def test_run_script_names_the_class_of_a_failure_and_not_the_message(
    rig: Rig, tmp_path: Path
) -> None:
    script = rig.script("scripts/boom.py", RAISE)
    log = tmp_path / "boom.log"

    run = run_script(script, [], log_path=log, timeout=60, env={})

    assert run == ScriptRun(1, False, "ValueError")
    assert "SPY 450C" in log.read_text(encoding="utf-8")  # the message is in the log only


def test_run_script_finds_no_class_for_a_non_zero_exit_with_no_class_line(
    rig: Rig, tmp_path: Path
) -> None:
    # What the scripts' own no-data exits look like: a message, exit 1, no traceback.
    script = rig.script(
        "scripts/nodata.py", "import sys\nsys.exit('[search] no fire produced a derived row')\n"
    )

    run = run_script(script, [], log_path=tmp_path / "n.log", timeout=60, env={})

    assert run == ScriptRun(1, False, None)


def test_run_script_ignores_an_error_looking_last_line_when_the_exit_is_zero(
    rig: Rig, tmp_path: Path
) -> None:
    script = rig.script("scripts/fine.py", "print('ValueError: handled and logged')\n")

    run = run_script(script, [], log_path=tmp_path / "f.log", timeout=60, env={})

    assert run == ScriptRun(0, False, None)


def test_run_script_times_out_and_kills_the_child(rig: Rig, tmp_path: Path) -> None:
    heartbeat = tmp_path / "heartbeat"
    script = rig.script("scripts/sleepy.py", SLEEP, HEARTBEAT=str(heartbeat))
    log = tmp_path / "sleepy.log"
    started = time.monotonic()

    run = run_script(script, [], log_path=log, timeout=2.0, env={})

    assert run == ScriptRun(None, True, None)
    assert time.monotonic() - started < 20  # the script would run for 30 s
    assert "started" in log.read_text(encoding="utf-8")  # what it printed before the kill
    beats = heartbeat.stat().st_size
    assert beats > 0
    time.sleep(0.4)
    assert heartbeat.stat().st_size == beats  # a dead process writes no more


@pytest.mark.parametrize(
    ("returncode", "expected"), [(0, 0), (1, 1), (3, 3), (255, 255), (-9, 137), (-15, 143)]
)
def test_an_exit_code_is_never_negative(returncode: int, expected: int) -> None:
    # Popen reports death by signal N as -N, which a step count cannot hold; shells say 128+N.
    assert research_reports._exit_code(returncode) == expected


@pytest.mark.skipif(os.name == "nt", reason="Windows has no death by signal")
def test_a_child_killed_by_a_signal_exits_with_128_plus_the_signal(
    rig: Rig, tmp_path: Path
) -> None:
    script = rig.script(
        "scripts/oom.py", "import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n"
    )

    run = run_script(script, [], log_path=tmp_path / "o.log", timeout=60, env={})

    assert run == ScriptRun(137, False, None)


# --- publish --------------------------------------------------------------------------------


def test_publish_uploads_every_file_of_the_out_dir_under_the_family_and_session(
    rig: Rig, tmp_path: Path
) -> None:
    out = tmp_path / "out"
    out.mkdir()
    (out / "b.md").write_bytes(b"bb")
    (out / "a.png").write_bytes(b"aaaa")
    (out / "sub").mkdir()  # a folder is not an output

    files, size = publish(ResearchStore(rig.settings), out, "whale-plots", LAST_SESSION)

    assert (files, size) == (2, 6)
    assert report_files(rig, "research/") == {
        f"research/whale-plots/{SESSION}/a.png": b"aaaa",
        f"research/whale-plots/{SESSION}/b.md": b"bb",
    }


def test_publish_log_uploads_to_the_logs_folder_of_the_session(rig: Rig, tmp_path: Path) -> None:
    log = tmp_path / "x.log"
    log.write_bytes(b"hello")

    assert publish_log(ResearchStore(rig.settings), log, LAST_SESSION, "score-lineage") == 1

    assert report_files(rig, "research/") == {
        f"research/_logs/{SESSION}/score-lineage.log": b"hello"
    }


def test_publish_log_of_a_missing_log_uploads_nothing(rig: Rig, tmp_path: Path) -> None:
    assert publish_log(ResearchStore(rig.settings), tmp_path / "none.log", LAST_SESSION, "x") == 0
    assert rig.keys() == []


# --- the helpers research_db_steps shares ----------------------------------------------------


def test_prepare_step_dir_makes_an_empty_folder_with_the_step_layout(rig: Rig) -> None:
    stale = rig.work / "reports" / "some-step" / OUT_DIR
    stale.mkdir(parents=True)
    (stale / "old.md").write_text("stale", encoding="utf-8")

    work = prepare_step_dir("some-step")

    assert work == rig.work / "reports" / "some-step"
    assert sorted(path.name for path in work.iterdir()) == sorted(
        [IN_DIR, OUT_DIR, "home", "matplotlib"]
    )
    assert list((work / OUT_DIR).iterdir()) == []  # an earlier run's output is gone
    assert LOG_NAME == "step.log"
    assert not (work / LOG_NAME).exists()  # the log is the step's to create


@pytest.mark.parametrize(
    ("run", "expected"),
    [
        (ScriptRun(None, True, None), "script timed out"),
        (ScriptRun(1, False, None), "script exited 1"),
        (ScriptRun(1, False, "ValueError"), "script exited 1 (ValueError)"),
        (ScriptRun(137, False, None), "script exited 137"),
        (ScriptRun(0, False, None), ""),
    ],
    ids=["timed out", "exit code", "exit code and class", "killed", "clean exit"],
)
def test_failure_detail_is_a_fixed_phrase_with_at_most_a_code_and_a_class(
    tmp_path: Path, run: ScriptRun, expected: str
) -> None:
    assert failure_detail(run, (), tmp_path) == expected


def test_failure_detail_wants_every_output_glob_to_match_a_non_empty_file(tmp_path: Path) -> None:
    clean = ScriptRun(0, False, None)
    patterns = ("a-*.md", "b-*.csv")
    (tmp_path / "a-1.md").write_text("x", encoding="utf-8")

    assert failure_detail(clean, patterns, tmp_path) == "no output written"

    (tmp_path / "b-1.csv").write_text("", encoding="utf-8")  # an empty file is no output

    assert failure_detail(clean, patterns, tmp_path) == "no output written"

    (tmp_path / "b-1.csv").write_text("x", encoding="utf-8")

    assert failure_detail(clean, patterns, tmp_path) == ""


def test_log_step_writes_its_line_through_the_logger_it_is_given(
    caplog: pytest.LogCaptureFixture,
) -> None:
    mine = logging.getLogger("some_other_step_module")
    ok = StepResult("ok", {"files_uploaded": 2, "log_uploaded": 1})
    partial = StepResult("partial", {"files_uploaded": 0}, "derived day missing")

    with caplog.at_level(logging.INFO):
        log_step(mine, "feature-audit", ok, time.monotonic())
        log_step(mine, "whale-plots", partial, time.monotonic())

    first, second = [r for r in caplog.records if r.name == "some_other_step_module"]
    assert first.levelno == logging.INFO
    assert first.getMessage().startswith(
        "research-report feature-audit ok files_uploaded=2 log_uploaded=1 seconds="
    )
    assert second.levelno == logging.WARNING  # anything but ok
    assert second.getMessage().startswith("research-report whale-plots partial files_uploaded=0 ")


# --- run_report -----------------------------------------------------------------------------


def test_run_report_publishes_outputs_and_log(rig: Rig, tmp_path: Path) -> None:
    out_name = "lottery-feature-audit-2026-11-11.md"
    rig.script(
        "scripts/feature_audit.py",
        WRITE_OUTPUT
        + "import json, os, sys\n"
        + "print(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'tz': os.environ['TZ']}))\n",
        OUTPUTS=[out_name],
        BODY="# audit\n",
    )

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert asserted_valid(result) == StepResult(
        "ok", {**NO_COUNTS, "files_uploaded": 1, "bytes_uploaded": 8}, ""
    )
    published = report_files(rig, "research/")
    assert set(published) == {
        f"research/feature-audit/{SESSION}/{out_name}",
        f"research/_logs/{SESSION}/feature-audit.log",
    }
    assert published[f"research/feature-audit/{SESSION}/{out_name}"] == b"# audit\n"
    seen = json.loads(published[f"research/_logs/{SESSION}/feature-audit.log"].splitlines()[-1])
    assert seen["argv"][0] == "--out-dir"
    assert Path(seen["argv"][1]).name == "out"
    assert Path(seen["cwd"]).resolve() == rig.app.resolve()
    assert seen["tz"] == "UTC"
    assert rig.events == []  # no input, so no database and no manifest


def test_a_report_runs_under_the_last_session_not_the_clock(rig: Rig) -> None:
    rig.script(
        "scripts/mine_outcome_patterns.py",
        WRITE_OUTPUT + "import sys\nprint(sys.argv[1:3])\n",
        OUTPUTS=["lottery-composite-candidates-2026-11-11.md"],
        BODY="x",
    )

    result = run_report(report_for("outcome-mining"), rig.ctx(last_session=D3))

    assert result.status == "ok"
    assert rig.keys("research/outcome-mining/") == [
        "research/outcome-mining/2026-11-10/lottery-composite-candidates-2026-11-11.md"
    ]
    assert (
        "['--as-of', '2026-11-10']"
        in rig.body("research/_logs/2026-11-10/outcome-mining.log").decode()
    )


def test_exit_zero_without_output_is_failed(rig: Rig) -> None:
    rig.script("scripts/feature_audit.py", "print('no archive day to read')\n")

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert asserted_valid(result) == StepResult("failed", NO_COUNTS, "no output written")
    assert rig.keys("research/") == [f"research/_logs/{SESSION}/feature-audit.log"]


def test_an_empty_output_file_is_no_output(rig: Rig) -> None:
    rig.script(
        "scripts/feature_audit.py",
        WRITE_OUTPUT,
        OUTPUTS=["lottery-feature-audit-2026-11-11.md"],
        BODY="",
    )

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert result == StepResult("failed", NO_COUNTS, "no output written")
    assert rig.keys("research/feature-audit/") == []


def test_every_output_glob_must_match_a_file(rig: Rig) -> None:
    rig.script("scripts/custom.py", WRITE_OUTPUT, OUTPUTS=["out-a.md"], BODY="x")
    report = custom_report(("out-*.md", "other-*.csv"))

    result = run_report(report, rig.ctx())

    assert result == StepResult("failed", NO_COUNTS, "no output written")
    assert rig.keys("research/custom-family/") == []


def test_every_glob_matched_publishes_all_the_files(rig: Rig) -> None:
    rig.script("scripts/custom.py", WRITE_OUTPUT, OUTPUTS=["out-a.md", "other-b.csv"], BODY="xyz")

    result = run_report(custom_report(("out-*.md", "other-*.csv")), rig.ctx())

    assert result == StepResult("ok", {**NO_COUNTS, "files_uploaded": 2, "bytes_uploaded": 6}, "")
    assert rig.keys("research/custom-family/") == [
        f"research/custom-family/{SESSION}/other-b.csv",
        f"research/custom-family/{SESSION}/out-a.md",
    ]


def test_nonzero_exit_names_the_class_only(
    rig: Rig, caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    rig.script("scripts/feature_audit.py", RAISE)

    with caplog.at_level(logging.DEBUG):
        result = run_report(report_for("feature-audit"), rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed", {**NO_COUNTS, "exit_code": 1}, "script exited 1 (ValueError)"
    )
    assert "SPY" not in result.detail
    assert "SPY" not in repr(dict(result.counts))
    # The log is the one place the message goes.
    log = rig.body(f"research/_logs/{SESSION}/feature-audit.log").decode()
    assert "SPY 450C premium 1,234,567" in log
    assert "SPY" not in caplog.text
    captured = capfd.readouterr()
    assert "SPY" not in captured.out + captured.err


def test_a_nonzero_exit_without_a_class_line_names_the_code_only(rig: Rig) -> None:
    rig.script("scripts/feature_audit.py", "import sys\nsys.exit('[audit] no fires found')\n")

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert result == StepResult("failed", {**NO_COUNTS, "exit_code": 1}, "script exited 1")


def test_a_non_traceback_exit_code_is_reported(rig: Rig) -> None:
    rig.script("scripts/feature_audit.py", "import sys\nprint('SPXW: 12 fires')\nsys.exit(3)\n")

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert result == StepResult("failed", {**NO_COUNTS, "exit_code": 3}, "script exited 3")


def test_failed_run_publishes_no_outputs(rig: Rig) -> None:
    rig.script(
        "scripts/feature_audit.py",
        WRITE_OUTPUT + "import sys\nsys.exit(3)\n",
        OUTPUTS=["lottery-feature-audit-2026-11-11.md"],
        BODY="a half-finished report",
    )

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert result.status == "failed"
    assert result.counts["files_uploaded"] == 0
    assert result.counts["bytes_uploaded"] == 0
    # The report was written, and still stays out of R2; the log is the failure's evidence.
    assert rig.keys("research/") == [f"research/_logs/{SESSION}/feature-audit.log"]


def test_a_kill_by_the_oom_killer_is_a_valid_failed_result(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig.script("scripts/feature_audit.py", "print('x')\n")
    real_run = subprocess.run

    def killed(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        done = real_run(*args, **kwargs)
        done.returncode = -9
        return done

    monkeypatch.setattr(research_reports.subprocess, "run", killed)

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed", {**NO_COUNTS, "exit_code": 137}, "script exited 137"
    )


def test_timeout_kills_the_script_and_fails(rig: Rig, tmp_path: Path) -> None:
    heartbeat = tmp_path / "heartbeat"
    rig.script("scripts/feature_audit.py", SLEEP, HEARTBEAT=str(heartbeat))
    started = time.monotonic()

    result = run_report(report_for("feature-audit"), rig.ctx(left=3.5))

    assert time.monotonic() - started < 20
    assert asserted_valid(result) == StepResult(
        "failed", {**NO_COUNTS, "timed_out": 1}, "script timed out"
    )
    beats = heartbeat.stat().st_size
    time.sleep(0.4)
    assert heartbeat.stat().st_size == beats  # killed, not abandoned
    # Published: what the script said before it was killed. No outputs.
    assert rig.keys("research/") == [f"research/_logs/{SESSION}/feature-audit.log"]
    assert "started" in rig.body(f"research/_logs/{SESSION}/feature-audit.log").decode()


def test_the_script_gets_the_steps_remaining_time_no_stdin_and_one_log_stream(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig.script("scripts/feature_audit.py", "pass\n")
    seen: list[dict[str, Any]] = []
    real_run = subprocess.run

    def spying(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        seen.append(kwargs)
        return real_run(*args, **kwargs)

    monkeypatch.setattr(research_reports.subprocess, "run", spying)

    run_report(report_for("feature-audit"), rig.ctx(left=500.0))

    (kwargs,) = seen
    assert 400.0 < kwargs["timeout"] <= 500.0  # what is left of the step's time
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["stderr"] is subprocess.STDOUT  # one stream, into the one log file
    assert kwargs["stdout"] is not subprocess.DEVNULL
    assert kwargs["stdout"] is not None  # never inherited from the job
    assert kwargs["cwd"] == rig.app
    assert kwargs["env"]["PGAPPNAME"] == "nightly-feature-audit"


def test_script_output_never_reaches_the_log(
    rig: Rig, caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    rig.script(
        "scripts/feature_audit.py",
        "import sys\n"
        f"print('stdout {MARKER}')\n"
        f"print('stderr {MARKER}', file=sys.stderr)\n"
        f"raise RuntimeError('{MARKER}')\n",
    )
    outcomes: list[steps.StepOutcome] = []
    step = Step("feature-audit", lambda ctx: run_step("feature-audit", ctx), 1)

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
    assert outcome.status == "failed"
    assert outcome.detail == "script exited 1 (RuntimeError)"
    assert MARKER not in repr(outcome)
    assert MARKER not in caplog.text
    captured = capfd.readouterr()
    assert MARKER not in captured.out + captured.err
    # And it is in the log file in R2.
    assert MARKER in rig.body(f"research/_logs/{SESSION}/feature-audit.log").decode()


def test_the_step_logs_its_name_status_and_seconds(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    rig.script("scripts/feature_audit.py", "print('x')\n")

    with caplog.at_level(logging.INFO, logger="research_reports"):
        run_report(report_for("feature-audit"), rig.ctx())

    (record,) = [r for r in caplog.records if r.name == "research_reports"]
    assert record.levelno == logging.WARNING  # no output: failed
    assert "feature-audit" in record.getMessage()
    assert "failed" in record.getMessage()
    assert "seconds=" in record.getMessage()


def test_a_leftover_of_an_earlier_run_is_never_published(rig: Rig) -> None:
    stale = rig.work / "reports" / "feature-audit" / "out"
    stale.mkdir(parents=True)
    (stale / "lottery-feature-audit-OLD.md").write_text("stale", encoding="utf-8")
    rig.script(
        "scripts/feature_audit.py",
        WRITE_OUTPUT,
        OUTPUTS=["lottery-feature-audit-2026-11-11.md"],
        BODY="fresh",
    )

    result = run_report(report_for("feature-audit"), rig.ctx())

    assert result.counts["files_uploaded"] == 1
    assert rig.keys("research/feature-audit/") == [
        f"research/feature-audit/{SESSION}/lottery-feature-audit-2026-11-11.md"
    ]


def test_the_work_files_are_removed_when_the_step_ends(rig: Rig) -> None:
    rig.script(
        "scripts/feature_audit.py",
        WRITE_OUTPUT,
        OUTPUTS=["lottery-feature-audit-2026-11-11.md"],
        BODY="x",
    )
    run_report(report_for("feature-audit"), rig.ctx())
    assert not (rig.work / "reports" / "feature-audit").exists()

    rig.script("scripts/feature_audit.py", RAISE)
    run_report(report_for("feature-audit"), rig.ctx())
    assert not (rig.work / "reports" / "feature-audit").exists()


def test_a_rerun_for_the_same_session_overwrites_its_keys(rig: Rig) -> None:
    name = "lottery-feature-audit-2026-11-11.md"
    for body in ("first", "second one"):
        rig.script("scripts/feature_audit.py", WRITE_OUTPUT, OUTPUTS=[name], BODY=body)
        run_report(report_for("feature-audit"), rig.ctx())

    assert rig.body(f"research/feature-audit/{SESSION}/{name}") == b"second one"
    assert len(rig.keys("research/feature-audit/")) == 1


# --- run_report: inputs ---------------------------------------------------------------------


def test_chains_inputs_sync_every_by_day_file(rig: Rig) -> None:
    for day in (D1, D2, D3):
        rig.put(FAMILY_KEYS["chains"](day), b"chains")
    rig.put("research/eod-flow/by-day-old/2026-11-05-chains.parquet")  # another folder
    rig.put("research/eod-flow/2026-11-10/cumulative-rollup.json")  # a rollup output
    rig.script("ml/src/whale_plots.py", LIST_INPUT, OUTPUT="chart.png", FLAG=str(rig.flag))

    result = run_report(report_for("whale-plots"), rig.ctx())

    chart = rig.body(f"research/whale-plots/{SESSION}/chart.png")
    assert chart.decode() == (
        "2026-11-06-chains.parquet,2026-11-09-chains.parquet,2026-11-10-chains.parquet"
        "|conn_open=False"
    )
    assert asserted_valid(result) == StepResult(
        "ok",
        {**NO_COUNTS, "inputs_synced": 3, "files_uploaded": 1, "bytes_uploaded": len(chart)},
        "",
    )
    assert rig.events == []  # the chains need no database and no manifest


def test_inputs_sync_only_fresh_derived_days(rig: Rig) -> None:
    for day in (D1, D2, D3, D4):
        rig.land(day)
        rig.put(rig.derived_key("exit-policy", day))
        rig.put(rig.derived_key("flow-timing", day))
    rig.wanted["exit-policy"] = {D1: "fp1", D2: "fp2", D3: "fp3"}  # D4 has no fires
    rig.wanted["flow-timing"] = {D1: "t1", D2: "t2", D3: "t3", D4: "t4"}
    rig.set_manifest(
        {
            "exit-policy": {D1: "fp1", D2: "an old fingerprint", D3: "fp3"},
            "flow-timing": {D1: "t1", D2: "t2", D3: "t3", D4: "t4"},
        }
    )
    rig.script(
        "scripts/exit_policy_search.py",
        LIST_INPUT,
        OUTPUT="lottery-exit-policy-search-2026-11-11.md",
        FLAG=str(rig.flag),
    )

    result = run_report(report_for("exit-policy-report"), rig.ctx())

    assert asserted_valid(result).status == "ok"
    assert result.counts["inputs_synced"] == 2
    assert result.counts["inputs_missing"] == 0  # a stale day or one with no fires is not expected
    seen = rig.body(f"research/exit-policy/{SESSION}/lottery-exit-policy-search-2026-11-11.md")
    # Oldest first is fresh_days' order; the script lists the directory.
    assert seen.decode() == "2026-11-06.parquet,2026-11-10.parquet|conn_open=False"
    (call,) = rig.targets.call_args_list
    etags, last_session = call.args[1:]
    assert set(etags) == {D1, D2, D3, D4}  # the tape listing, from R2
    assert last_session == LAST_SESSION


def test_each_fire_family_reads_its_own_derived_folder(rig: Rig) -> None:
    # The two folders hold different days, so a report that read the other's finds fewer.
    for day in (D1, D2, D3):
        rig.land(day)
    for day in (D1, D2):
        rig.put(rig.derived_key("exit-policy", day))
    for day in (D2, D3):
        rig.put(rig.derived_key("flow-timing", day))
    rig.wanted["exit-policy"] = {D1: "e1", D2: "e2"}
    rig.wanted["flow-timing"] = {D2: "t2", D3: "t3"}
    rig.set_manifest({"exit-policy": {D1: "e1", D2: "e2"}, "flow-timing": {D2: "t2", D3: "t3"}})
    rig.script(
        "scripts/flow_inversion_timing.py",
        LIST_INPUT,
        OUTPUT="flow-inversion-timing-2026-11-11.md",
        FLAG=str(rig.flag),
    )

    result = run_report(report_for("flow-timing-report"), rig.ctx())

    assert result.status == "ok"
    assert (result.counts["inputs_synced"], result.counts["inputs_missing"]) == (2, 0)
    seen = rig.body(f"research/flow-timing/{SESSION}/flow-inversion-timing-2026-11-11.md")
    assert seen.decode() == "2026-11-09.parquet,2026-11-10.parquet|conn_open=False"


def test_a_seeded_day_is_not_fresh_for_a_fire_family(rig: Rig) -> None:
    rig.land(D1)
    rig.put(rig.derived_key("exit-policy", D1))
    rig.wanted["exit-policy"] = {D1: "fp1"}
    rig.set_manifest({"exit-policy": {D1: research_derive.SEED}})
    rig.script(
        "scripts/exit_policy_search.py",
        LIST_INPUT,
        OUTPUT="lottery-exit-policy-search-x.md",
        FLAG=str(rig.flag),
    )

    result = run_report(report_for("exit-policy-report"), rig.ctx())

    assert (result.counts["inputs_synced"], result.counts["inputs_missing"]) == (0, 0)


def test_no_fresh_day_still_runs_the_script_on_an_empty_directory(rig: Rig) -> None:
    rig.land(D1)
    rig.wanted["exit-policy"] = {D1: "fp1"}  # never derived: not in the manifest
    rig.script(
        "scripts/exit_policy_search.py",
        LIST_INPUT,
        OUTPUT="lottery-exit-policy-search-x.md",
        FLAG=str(rig.flag),
    )

    result = run_report(report_for("exit-policy-report"), rig.ctx())

    assert result.status == "ok"
    assert (result.counts["inputs_synced"], result.counts["inputs_missing"]) == (0, 0)
    seen = rig.body(f"research/exit-policy/{SESSION}/lottery-exit-policy-search-x.md")
    assert seen.decode() == "|conn_open=False"


def one_fresh_derived_day_missing_from_r2(rig: Rig, body: str, **names: object) -> None:
    """Two days the manifest calls fresh, of which R2 holds only the older one's derived object."""
    for day in (D1, D2):
        rig.land(day)
    rig.put(rig.derived_key("exit-policy", D1))  # D2's object is gone
    rig.wanted["exit-policy"] = {D1: "fp1", D2: "fp2"}
    rig.set_manifest({"exit-policy": {D1: "fp1", D2: "fp2"}})
    rig.script("scripts/exit_policy_search.py", body, **names)


def test_a_fresh_derived_day_missing_from_r2_makes_the_report_partial(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    name = "lottery-exit-policy-search-2026-11-11.md"
    one_fresh_derived_day_missing_from_r2(rig, LIST_INPUT, OUTPUT=name, FLAG=str(rig.flag))

    with caplog.at_level(logging.INFO, logger="research_reports"):
        result = run_report(report_for("exit-policy-report"), rig.ctx())

    report = rig.body(f"research/exit-policy/{SESSION}/{name}")
    assert report.decode() == "2026-11-06.parquet|conn_open=False"  # the day R2 still holds
    assert asserted_valid(result) == StepResult(
        "partial",
        {
            **NO_COUNTS,
            "inputs_synced": 1,
            "inputs_missing": 1,
            "files_uploaded": 1,
            "bytes_uploaded": len(report),
        },
        "derived day missing",
    )
    # Published exactly as on ok: the report and the log.
    assert rig.keys(f"research/exit-policy/{SESSION}/") == [
        f"research/exit-policy/{SESSION}/{name}"
    ]
    assert rig.keys("research/_logs/") == [f"research/_logs/{SESSION}/exit-policy-report.log"]
    # One warning for the shortfall: the step and the two counts, no day and no file name.
    (warning,) = [r for r in caplog.records if "expected=" in r.getMessage()]
    assert warning.name == "research_reports"
    assert warning.levelno == logging.WARNING
    message = warning.getMessage()
    assert "exit-policy-report" in message
    assert "expected=2" in message
    assert "synced=1" in message
    assert "2026" not in message
    assert "parquet" not in message
    for record in caplog.records:
        if record.name == "research_reports":
            assert "2026-11-0" not in record.getMessage()
            assert "parquet" not in record.getMessage()


@pytest.mark.parametrize(
    ("body", "detail"),
    [
        (RAISE, "script exited 1 (ValueError)"),
        ("print('nothing written')\n", "no output written"),
    ],
    ids=["a non-zero exit", "no output"],
)
def test_a_failing_script_with_a_missing_input_stays_failed(
    rig: Rig, body: str, detail: str
) -> None:
    one_fresh_derived_day_missing_from_r2(rig, body)

    result = run_report(report_for("exit-policy-report"), rig.ctx())

    assert asserted_valid(result).status == "failed"
    assert result.detail == detail  # the failure, not "derived day missing"
    assert result.counts["inputs_missing"] == 1
    assert result.counts["files_uploaded"] == 0
    assert rig.keys(f"research/exit-policy/{SESSION}/") == []
    assert rig.keys("research/_logs/") == [f"research/_logs/{SESSION}/exit-policy-report.log"]


def test_the_database_connection_is_closed_before_the_script_starts(rig: Rig) -> None:
    rig.land(D1)
    rig.wanted["exit-policy"] = {D1: "fp1"}
    rig.set_manifest({"exit-policy": {D1: "fp1"}})
    rig.put(rig.derived_key("exit-policy", D1))
    rig.script(
        "scripts/exit_policy_search.py",
        LIST_INPUT,
        OUTPUT="lottery-exit-policy-search-x.md",
        FLAG=str(rig.flag),
    )

    run_report(report_for("exit-policy-report"), rig.ctx())

    # One connection, for `targets` alone, shut before the script (which opens its own).
    assert rig.events == ["connect", "targets", "close"]
    seen = rig.body(f"research/exit-policy/{SESSION}/lottery-exit-policy-search-x.md")
    assert seen.decode().endswith("|conn_open=False")


def test_a_failing_targets_query_propagates_and_closes_the_connection(rig: Rig) -> None:
    rig.targets.side_effect = RuntimeError("canceling statement due to statement timeout")
    rig.script("scripts/exit_policy_search.py", "print('never runs')\n")

    with pytest.raises(RuntimeError):
        run_report(report_for("exit-policy-report"), rig.ctx())

    assert rig.events == ["connect", "close"]
    assert rig.keys("research/") == []  # no script ran, so there is no log
    assert not (rig.work / "reports" / "exit-policy-report").exists()


def test_a_malformed_manifest_propagates_and_no_script_runs(rig: Rig) -> None:
    rig.put(research_derive.MANIFEST_KEY, b'{"version": 1, "families": []}')
    rig.script("scripts/exit_policy_search.py", "print('never runs')\n")

    with pytest.raises(research_derive.ManifestError):
        run_report(report_for("exit-policy-report"), rig.ctx())

    assert rig.events == []
    assert rig.keys("research/_logs/") == []


# --- run_report: R2 failures ----------------------------------------------------------------


def test_the_log_is_published_before_the_outputs_and_survives_a_failed_upload(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    name = "lottery-feature-audit-2026-11-11.md"
    rig.script("scripts/feature_audit.py", WRITE_OUTPUT, OUTPUTS=[name], BODY="report")
    real_put = ResearchStore.put_file

    def refusing(self: ResearchStore, key: str, path: Path) -> int:
        if key.endswith(".md"):
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "PutObject")
        return real_put(self, key, path)

    monkeypatch.setattr(ResearchStore, "put_file", refusing)

    with pytest.raises(ClientError):  # run_steps turns it into a failed step with the class
        run_report(report_for("feature-audit"), rig.ctx())

    assert rig.keys("research/") == [f"research/_logs/{SESSION}/feature-audit.log"]
    assert not (rig.work / "reports" / "feature-audit").exists()


def test_a_failed_log_upload_is_not_swallowed(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    rig.script("scripts/feature_audit.py", "print('x')\n")

    def refusing(self: ResearchStore, key: str, path: Path) -> int:
        raise ClientError({"Error": {"Code": "InternalError", "Message": "no"}}, "PutObject")

    monkeypatch.setattr(ResearchStore, "put_file", refusing)

    with pytest.raises(ClientError):
        run_report(report_for("feature-audit"), rig.ctx())


# --- run_rollup -----------------------------------------------------------------------------

ARROW_TYPES = {
    "VARCHAR": pa.string(),
    "DOUBLE": pa.float64(),
    "DATE": pa.date32(),
    "BIGINT": pa.int64(),
    "TIMESTAMPTZ": pa.timestamp("us", tz="UTC"),
}


def chains_parquet(day: date) -> bytes:
    """One by-day chains file: an ask-dominant SPXW call that doubled, first printed 09:35 ET."""
    opened = datetime(day.year, day.month, day.day, 14, 35, tzinfo=UTC)
    row: dict[str, Any] = {
        "trade_date": day.isoformat(),
        "option_chain_id": f"SPXW{day:%y%m%d}C06800000",
        "ticker": "SPXW",
        "underlying_symbol": "SPX",
        "strike": 6800.0,
        "option_type": "call",
        "expiry": day,
        "equity_type": "Index",
        "sector": None,
        "total_size": 100.0,
        "total_premium": 500_000.0,
        "day_volume": 1000,
        "day_oi": 100,
        "ask_size": 90.0,
        "bid_size": 10.0,
        "first_ts": opened,
        "last_ts": opened,
        "first_price": 10.0,
        "last_price": 15.0,
        "first_underlying": 6800.0,
        "last_underlying": 6810.0,
        "trade_count": 5,
    }
    table = pa.table(
        {name: pa.array([row[name]], ARROW_TYPES[sql]) for name, sql in CHAINS_COLUMNS}
    )
    sink = io.BytesIO()
    pq.write_table(table, sink)
    return sink.getvalue()


def put_chains(rig: Rig, *days: date) -> None:
    for day in days:
        rig.put(FAMILY_KEYS["chains"](day), chains_parquet(day))


def test_rollup_ok_publishes_json_and_headlines(
    rig: Rig, capfd: pytest.CaptureFixture[str]
) -> None:
    put_chains(rig, D3, D4)

    result = run_rollup(rig.ctx())

    published = report_files(rig, "research/eod-flow/2026")
    assert set(published) == {
        f"research/eod-flow/{SESSION}/cumulative-rollup.json",
        f"research/eod-flow/{SESSION}/cumulative-headlines.txt",
    }
    assert asserted_valid(result) == StepResult(
        "ok",
        {"days": 2, "files_uploaded": 2, "bytes_uploaded": sum(map(len, published.values()))},
        "",
    )
    rolled_text = published[f"research/eod-flow/{SESSION}/cumulative-rollup.json"].decode("ascii")
    rolled = json.loads(rolled_text)
    assert rolled["days"] == ["2026-11-10", "2026-11-11"]
    assert rolled_text.startswith('{\n  "days": [\n    "2026-11-10"')  # indent 2
    # `default=str` turns the datetimes of a winner row into text.
    (first_winner, *_) = rolled["watchlist_winners"]
    assert first_winner["first_ts"].startswith("2026-11-1")
    headlines = published[f"research/eod-flow/{SESSION}/cumulative-headlines.txt"]
    text = headlines.decode("utf-8")
    assert text.startswith("# EOD Option-Flow Multi-Day Rollup (2 days)")
    assert "→" in text  # the arrow of the date range survives as UTF-8
    captured = capfd.readouterr()
    assert (captured.out, captured.err) == ("", "")  # it prints nothing
    assert not (rig.work / "reports" / ROLLUP_STEP).exists()
    assert rig.events == []  # in-process, but with no database


def test_rollup_partial_when_latest_session_missing(rig: Rig) -> None:
    put_chains(rig, D2, D3)  # the last session is D4

    result = run_rollup(rig.ctx())

    assert asserted_valid(result).status == "partial"
    assert result.detail == "latest session not in rollup"
    assert result.counts["days"] == 2
    assert result.counts["files_uploaded"] == 2  # what there is, published
    assert len(rig.keys(f"research/eod-flow/{SESSION}/")) == 2


def test_rollup_is_ok_when_the_latest_day_is_the_last_session(rig: Rig) -> None:
    put_chains(rig, D4)

    assert run_rollup(rig.ctx(last_session=D4)).status == "ok"
    assert run_rollup(rig.ctx(last_session=date(2026, 11, 12))).status == "partial"


def test_rollup_fails_with_no_chains_days(rig: Rig) -> None:
    result = run_rollup(rig.ctx())

    assert asserted_valid(result) == StepResult(
        "failed", {"days": 0, "files_uploaded": 0, "bytes_uploaded": 0}, "no chains days"
    )
    assert rig.keys() == []


def test_rollup_reads_only_the_by_day_folder(rig: Rig) -> None:
    put_chains(rig, D4)
    rig.put("research/eod-flow/by-day-old/2026-11-05-chains.parquet", b"not parquet")
    rig.put("research/eod-flow/2026-11-10/cumulative-rollup.json", b"{}")

    result = run_rollup(rig.ctx())

    assert result.status == "ok"
    assert result.counts["days"] == 1


def test_a_corrupt_chains_file_fails_the_rollup_by_name_and_publishes_nothing(rig: Rig) -> None:
    put_chains(rig, D3)
    rig.put(FAMILY_KEYS["chains"](D4), b"this is not a parquet file")

    with pytest.raises(duckdb.Error):
        run_rollup(rig.ctx())

    assert rig.keys(f"research/eod-flow/{SESSION}/") == []
    assert not (rig.work / "reports" / ROLLUP_STEP).exists()


def test_the_rollup_passes_run_steps_validation_and_keeps_text_out_of_the_detail(
    rig: Rig,
) -> None:
    put_chains(rig, D4)
    outcomes: list[steps.StepOutcome] = []

    run_steps(
        [Step(ROLLUP_STEP, lambda ctx: run_step(ROLLUP_STEP, ctx), 1)],
        settings=rig.settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=time.monotonic() + 120,
        tape=(),
        on_outcome=outcomes.append,
    )

    (outcome,) = outcomes
    assert (outcome.status, outcome.detail) == ("ok", "")
    assert set(outcome.counts) == {"days", "files_uploaded", "bytes_uploaded"}


# --- the bucket -----------------------------------------------------------------------------


def test_a_report_writes_only_under_research(rig: Rig) -> None:
    rig.script(
        "scripts/feature_audit.py",
        WRITE_OUTPUT,
        OUTPUTS=["lottery-feature-audit-2026-11-11.md"],
        BODY="x",
    )
    rig.land(D4)

    run_report(report_for("feature-audit"), rig.ctx())

    everything = rig.keys()
    assert [k for k in everything if not k.startswith("research/")] == [
        f"fulltape/{D4.isoformat()}-fulltape.parquet"  # the tape, which the report never touches
    ]
    assert rig.body(f"fulltape/{D4.isoformat()}-fulltape.parquet") == b"tape 2026-11-11"
