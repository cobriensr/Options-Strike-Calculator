"""The research report steps: six report scripts run as isolated subprocesses, and the EOD-flow
rollup, run in this process. Each publishes its dated outputs under `research/` in R2.

A report reads the per-day state that `research-derive` keeps in R2, never the tape: the
chains for `whale-plots` and the rollup, and for the two fire families only the days whose
manifest entry is current (`research_derive.fresh_days`). The step downloads them to a folder
of its own under RESEARCH_WORK_DIR, runs the script with its working directory at APP_ROOT,
publishes, and removes the folder when it ends, so nothing outlives the step or leaks into the
next run.

Isolation (plan D6). A script runs as `[sys.executable, APP_ROOT/<script>, ...]`, never
imported, with a child env that carries no R2, UW or Sentry secret (`script_env`). Its stdout and
stderr go to one log file, which goes only to `research/_logs/{session}/{step}.log`: these
scripts print whole reports, so none of it reaches the job's logs or Sentry. What Sentry gets is
the step name, the exit code and the script's exception class (`error_class`), never a
message. The step's own log lines carry the step name, status, counts and seconds.

Status of a report step:
- `ok`: the script exited 0 and every output glob matched a non-empty file. The outputs are
  published to `research/{family}/{session}/`, and only then.
- `failed`: `script exited {code}` (plus ` ({class})` when the log names one), `script timed
  out` (the process is killed at the step's deadline) or `no output written` (exit 0 with an
  output missing or empty, which `exit_policy_search.py`'s "no derived day" path does).
The log is published whatever happens, before the outputs. An exception (R2, the manifest,
the database) propagates to `run_steps`, which reports the step failed with its class name.

The rollup (`eod-flow-rollup`) runs `_eod_flow.rollup` in-process over every chains day and
publishes `cumulative-rollup.json` and `cumulative-headlines.txt`: `failed` with no days,
`partial` when the newest day is older than the last session, else `ok`.

The details are fixed phrases (they are part of the Sentry fingerprint) and carry at most an
exit code and an exception class name. Counts are plain ints >= 0: a death by signal is
reported as 128 + the signal, as a shell does.

Register the steps through `pipeline.lazy_group_step` and never import this module at pipeline
load. Its own imports pull no sklearn, scipy or sqlalchemy; the scripts that need them run as
subprocesses.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from time import monotonic
from typing import Literal

from _eod_flow import rollup, write_headlines

from config import Settings
from constants import DB_CONNECT_TIMEOUT_SECONDS, DB_STATEMENT_TIMEOUT_MS, RESEARCH_WORK_DIR
from r2_store import R2Store
from research_derive import FAMILY_KEYS, FamilyName, Manifest, fresh_days, targets
from research_store import RESEARCH_PREFIX, ResearchStore
from resources import connect_db, direct_dsn
from steps import StepContext, StepResult

log = logging.getLogger(__name__)

# The first parent of this file that holds `scripts/`: the repo root here, `/app` in the image
# (where this file is `/app/src/research_reports.py`).
APP_ROOT = next(
    parent for parent in Path(__file__).resolve().parents if (parent / "scripts").is_dir()
)

ROLLUP_STEP = "eod-flow-rollup"
_ROLLUP_FAMILY = "eod-flow"
# Fixed phrases: they are part of the `nightly step failed` / `partial` fingerprint.
_TIMED_OUT_DETAIL = "script timed out"
_NO_OUTPUT_DETAIL = "no output written"
_NO_DAYS_DETAIL = "no chains days"
_NOT_IN_ROLLUP_DETAIL = "latest session not in rollup"

# What a step keeps under RESEARCH_WORK_DIR/reports/{step}/.
_IN, _OUT, _HOME, _MPL, _LOG = "in", "out", "home", "matplotlib", "step.log"
# The names a script inherits from the job; every other name is built here or left out.
_INHERITED_ENV = ("PATH", "PYTHONPATH", "POLARS_MAX_THREADS")
# A day for `_state_prefix`: any day names the folder its file lives in.
_PROBE_DAY = date(2000, 1, 1)

# `error_class`: the log's last line is looked at for a class name only.
_TRACEBACK_HEADER = "Traceback (most recent call last):"
_CLASS_LINE = re.compile(r"^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?::|$)", re.ASCII)
_CLASS_SUFFIXES = ("Error", "Exception", "Exit", "Interrupt")
_MAX_CLASS_CHARS = 100
# A traceback and its last line are far shorter. The cap bounds what a log that grew to
# megabytes costs, and what is read of it.
_LOG_TAIL_BYTES = 64 * 1024


@dataclass(frozen=True)
class ScriptRun:
    """How a script ended. `returncode` is None only for a timeout, and is never negative (see
    `_exit_code`). `error_class` is the class name from the log, for a non-zero exit only."""

    returncode: int | None
    timed_out: bool
    error_class: str | None


def _step_dir(step: str) -> Path:
    return RESEARCH_WORK_DIR / "reports" / step


def script_env(settings: Settings, step: str) -> dict[str, str]:
    """The environment of a report subprocess: nothing of the job's own.

    It keeps PATH, PYTHONPATH and POLARS_MAX_THREADS and builds the rest: a UTC clock, a
    UTF-8 locale, unbuffered output (so a killed script leaves its log), a `HOME` and a
    matplotlib cache inside the step's folder, the Agg backend, and the Neon URL as D4's direct
    DSN (the pooler rejects the startup options a statement timeout needs). The statement and
    connect timeouts come from the same two constants `connect_db` uses. No R2, UW or Sentry
    value is carried, and `DATABASE_URL` is built from the settings, never copied from the job's
    environment.
    """
    dsn = direct_dsn(settings.database_url.get_secret_value())
    work = _step_dir(step)
    env = {name: os.environ[name] for name in _INHERITED_ENV if name in os.environ}
    env.update(
        {
            "LANG": "C.UTF-8",
            "TZ": "UTC",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "HOME": str(work / _HOME),
            "MPLCONFIGDIR": str(work / _MPL),
            "MPLBACKEND": "Agg",
            "DATABASE_URL": dsn,
            "DATABASE_URL_UNPOOLED": dsn,
            "PGOPTIONS": f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}",
            "PGAPPNAME": f"nightly-{step}",
            "PGCONNECT_TIMEOUT": str(DB_CONNECT_TIMEOUT_SECONDS),
        }
    )
    return env


def _tail_lines(log_path: Path) -> list[str]:
    """The last lines of a log, trailing whitespace cut, from at most its last _LOG_TAIL_BYTES.

    A window that starts inside a line drops that partial line.
    """
    with log_path.open("rb") as handle:
        size = handle.seek(0, 2)
        start = max(0, size - _LOG_TAIL_BYTES)
        handle.seek(start)
        data = handle.read()
    lines = [line.rstrip() for line in data.decode("utf-8", errors="replace").splitlines()]
    return lines[1:] if start else lines


def _ends_a_traceback(lines: Sequence[str], last: int) -> bool:
    """Whether `lines[last]` is the first unindented line after the last traceback header."""
    header = next((i for i in range(last - 1, -1, -1) if lines[i] == _TRACEBACK_HEADER), None)
    if header is None:
        return False
    first = next(
        (i for i in range(header + 1, last + 1) if lines[i] and not lines[i][0].isspace()), None
    )
    return first == last


def error_class(log_path: Path) -> str | None:
    """The exception class a script's log ends with, or None. Never the message.

    The class of the log's last non-empty line, only when that line ends a traceback block (it
    is the first unindented line after the last `Traceback (most recent call last):`), or when
    the class name ends in Error, Exception, Exit or Interrupt (its last dotted segment does).
    The name is returned whole (`psycopg2.errors.QueryCanceled`). A line such as
    `SPXW: 12 fires` or `[search] no fire produced ...` yields none: a class name is a dotted
    identifier of at most 100 characters, and a ticker or a count line passes as one only at
    a traceback's end, where it is the exception's own name.
    """
    lines = _tail_lines(log_path)
    last = next((i for i in range(len(lines) - 1, -1, -1) if lines[i].strip()), None)
    if last is None:
        return None
    match = _CLASS_LINE.match(lines[last])
    if match is None:
        return None
    name = match.group(1)
    if len(name) > _MAX_CLASS_CHARS:
        return None
    if name.endswith(_CLASS_SUFFIXES) or _ends_a_traceback(lines, last):
        return name
    return None


def _exit_code(returncode: int) -> int:
    """A shell-style exit code, never negative.

    Popen reports a death by signal N as -N (the OOM killer's SIGKILL is -9), which a step
    count cannot hold: a negative one would fail the whole result as invalid. A shell says
    128 + N.
    """
    return returncode if returncode >= 0 else 128 - returncode


def run_script(
    script: str,
    argv: Sequence[str],
    *,
    log_path: Path,
    timeout: float,
    env: Mapping[str, str],
) -> ScriptRun:
    """Run `APP_ROOT/script` as a subprocess of this interpreter, in APP_ROOT, with exactly `env`.

    Stdout and stderr go to `log_path` and nowhere else; stdin is closed. A script still running
    after `timeout` seconds is killed and reaped.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(APP_ROOT / script), *argv]
    with log_path.open("wb") as sink:
        try:
            done = subprocess.run(
                command,
                cwd=APP_ROOT,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=sink,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return ScriptRun(None, True, None)
    code = _exit_code(done.returncode)
    return ScriptRun(code, False, error_class(log_path) if code else None)


def publish(store: ResearchStore, out_dir: Path, family: str, session: date) -> tuple[int, int]:
    """Upload every file of `out_dir` to `research/{family}/{session}/`; (files, bytes)."""
    prefix = f"{RESEARCH_PREFIX}{family}/{session.isoformat()}/"
    files = size = 0
    for path in sorted(out_dir.iterdir()):
        if path.is_file():
            size += store.put_file(prefix + path.name, path)
            files += 1
    return files, size


def publish_log(store: ResearchStore, log_path: Path, session: date, step: str) -> int:
    """Upload a step's log to `research/_logs/{session}/{step}.log`; 1, or 0 for no log file."""
    if not log_path.is_file():
        return 0
    store.put_file(f"{RESEARCH_PREFIX}_logs/{session.isoformat()}/{step}.log", log_path)
    return 1


def _args_by_day(session: date, in_dir: Path, out_dir: Path) -> list[str]:
    return ["--by-day-dir", str(in_dir), "--out-dir", str(out_dir)]


def _args_derived(session: date, in_dir: Path, out_dir: Path) -> list[str]:
    return ["--derived-dir", str(in_dir), "--out-dir", str(out_dir)]


def _args_out(session: date, in_dir: Path, out_dir: Path) -> list[str]:
    return ["--out-dir", str(out_dir)]


def _args_as_of(session: date, in_dir: Path, out_dir: Path) -> list[str]:
    return ["--as-of", session.isoformat(), "--out-dir", str(out_dir)]


@dataclass(frozen=True)
class ScriptReport:
    """One report script. `inputs` names the state it reads (`none`: it reads Neon alone),
    `outputs` the globs it must leave in the out dir, and `extra_args` its flags, given the
    session and the input and output folders."""

    step: str
    family: str
    script: str
    inputs: Literal["none", "chains", "exit-policy", "flow-timing"]
    outputs: tuple[str, ...]
    extra_args: Callable[[date, Path, Path], list[str]]


# Each step's `min_seconds` is registered in pipeline.py from the budget constants.
REPORTS: tuple[ScriptReport, ...] = (
    ScriptReport(
        "whale-plots", "whale-plots", "ml/src/whale_plots.py", "chains", ("*.png",), _args_by_day
    ),
    ScriptReport(
        "exit-policy-report",
        "exit-policy",
        "scripts/exit_policy_search.py",
        "exit-policy",
        ("lottery-exit-policy-search-*.md",),
        _args_derived,
    ),
    ScriptReport(
        "flow-timing-report",
        "flow-timing",
        "scripts/flow_inversion_timing.py",
        "flow-timing",
        ("flow-inversion-timing-*.md",),
        _args_derived,
    ),
    ScriptReport(
        "feature-audit",
        "feature-audit",
        "scripts/feature_audit.py",
        "none",
        ("lottery-feature-audit-*.md",),
        _args_out,
    ),
    ScriptReport(
        "outcome-mining",
        "outcome-mining",
        "scripts/mine_outcome_patterns.py",
        "none",
        ("lottery-composite-candidates-*.md",),
        _args_as_of,
    ),
    ScriptReport(
        "score-lineage",
        "score-lineage",
        "scripts/score_lineage_audit.py",
        "none",
        ("lottery-score-lineage-*.md",),
        _args_as_of,
    ),
)
STEP_NAMES: frozenset[str] = frozenset({ROLLUP_STEP, *(report.step for report in REPORTS)})


def _prepare(step: str) -> Path:
    """An empty folder for the step (an earlier run's is removed) with its subfolders made."""
    work = _step_dir(step)
    if work.exists():
        shutil.rmtree(work)
    for name in (_IN, _OUT, _HOME, _MPL):
        (work / name).mkdir(parents=True)
    return work


def _state_prefix(family: FamilyName) -> str:
    """The folder a family keeps its days in: a day's key from FAMILY_KEYS, less the file name."""
    return FAMILY_KEYS[family](_PROBE_DAY).rpartition("/")[0] + "/"


def _fresh_derived_names(family: FamilyName, ctx: StepContext, store: ResearchStore) -> list[str]:
    """The file names (oldest day first) of the family's days whose derived state is current.

    A malformed manifest raises ManifestError instead of reading as "nothing is fresh": the
    report would then describe no days and look like a quiet night. The connection serves
    `targets` alone and is closed before the script, which opens its own.
    """
    manifest = Manifest.load(store)
    etags = R2Store(ctx.settings).tape_etags()
    with connect_db(ctx.settings) as conn:
        wanted = targets(conn, etags, ctx.last_session)
    return [
        PurePosixPath(FAMILY_KEYS[family](day)).name for day in fresh_days(manifest, wanted, family)
    ]


def _sync_inputs(report: ScriptReport, ctx: StepContext, store: ResearchStore, in_dir: Path) -> int:
    """Download what the report reads into `in_dir`; the number of files."""
    if report.inputs == "none":
        return 0
    prefix = _state_prefix(report.inputs)
    if report.inputs == "chains":
        return len(store.sync_down(prefix, in_dir))
    names = _fresh_derived_names(report.inputs, ctx, store)
    return len(store.sync_down(prefix, in_dir, names))


def _outputs_written(out_dir: Path, patterns: Sequence[str]) -> bool:
    """Whether every glob matched at least one non-empty file."""
    return all(
        any(path.is_file() and path.stat().st_size > 0 for path in out_dir.glob(pattern))
        for pattern in patterns
    )


def _failure_detail(run: ScriptRun, patterns: Sequence[str], out_dir: Path) -> str:
    """The fixed phrase for a run that did not produce its report, or "" for one that did."""
    if run.timed_out:
        return _TIMED_OUT_DETAIL
    if run.returncode != 0:
        suffix = f" ({run.error_class})" if run.error_class else ""
        return f"script exited {run.returncode}{suffix}"
    if not _outputs_written(out_dir, patterns):
        return _NO_OUTPUT_DETAIL
    return ""


def _log_step(step: str, result: StepResult, started: float) -> None:
    """One line: the step, its status, its counts and its seconds. Nothing of a script's."""
    log.log(
        logging.INFO if result.status == "ok" else logging.WARNING,
        "research-report %s %s %s seconds=%.1f",
        step,
        result.status,
        " ".join(f"{name}={n}" for name, n in result.counts.items()),
        monotonic() - started,
    )


# `run_report`, not `report_step`: monitoring.report_step is the Sentry report of a step.
def run_report(report: ScriptReport, ctx: StepContext) -> StepResult:
    """Run one report script and publish its outputs and its log to R2."""
    started = monotonic()
    store = ResearchStore(ctx.settings)
    work = _prepare(report.step)
    try:
        synced = _sync_inputs(report, ctx, store, work / _IN)
        run = run_script(
            report.script,
            report.extra_args(ctx.last_session, work / _IN, work / _OUT),
            log_path=work / _LOG,
            timeout=ctx.seconds_left(),
            env=script_env(ctx.settings, report.step),
        )
        # The log goes first: it is the evidence when anything after it fails.
        log_uploaded = publish_log(store, work / _LOG, ctx.last_session, report.step)
        detail = _failure_detail(run, report.outputs, work / _OUT)
        files = size = 0
        if not detail:
            files, size = publish(store, work / _OUT, report.family, ctx.last_session)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    counts = {
        "files_uploaded": files,
        "bytes_uploaded": size,
        "inputs_synced": synced,
        "log_uploaded": log_uploaded,
        "exit_code": run.returncode or 0,
        "timed_out": int(run.timed_out),
    }
    result = StepResult("failed" if detail else "ok", counts, detail)
    _log_step(report.step, result, started)
    return result


def run_rollup(ctx: StepContext) -> StepResult:
    """The cumulative EOD-flow rollup and headlines over every chains day, published to R2."""
    started = monotonic()
    store = ResearchStore(ctx.settings)
    work = _prepare(ROLLUP_STEP)
    try:
        store.sync_down(_state_prefix("chains"), work / _IN)
        rolled = rollup(work / _IN)
        days = rolled["days"]
        counts = {"days": len(days), "files_uploaded": 0, "bytes_uploaded": 0}
        if not days:
            result = StepResult("failed", counts, _NO_DAYS_DETAIL)
        else:
            out = work / _OUT
            (out / "cumulative-rollup.json").write_bytes(
                json.dumps(rolled, indent=2, default=str).encode("utf-8")
            )
            (out / "cumulative-headlines.txt").write_bytes(write_headlines(rolled).encode("utf-8"))
            counts["files_uploaded"], counts["bytes_uploaded"] = publish(
                store, out, _ROLLUP_FAMILY, ctx.last_session
            )
            # The days are ISO text (the chains' `trade_date`), which orders as dates do.
            if max(str(day) for day in days) < ctx.last_session.isoformat():
                result = StepResult("partial", counts, _NOT_IN_ROLLUP_DETAIL)
            else:
                result = StepResult("ok", counts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _log_step(ROLLUP_STEP, result, started)
    return result


def run_step(name: str, ctx: StepContext) -> StepResult:
    """Run the step called `name`; KeyError for a name that is not in STEP_NAMES."""
    if name == ROLLUP_STEP:
        return run_rollup(ctx)
    for report in REPORTS:
        if report.step == name:
            return run_report(report, ctx)
    raise KeyError(name)
