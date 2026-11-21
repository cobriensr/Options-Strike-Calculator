"""The research steps that work against Neon: lottery-tracking, quality-sim and takeit-drift.

Each publishes its dated outputs under `research/` in R2 and its log to `research/_logs/`, as
the report steps of `research_reports` do, and reuses that module's runner, environment and
publishers.

- `lottery-tracking` keeps one growing CSV in R2. The step downloads it, runs
  `scripts/daily_tracker.py --csv` on it as a subprocess (D6: no R2, UW or Sentry secret in the
  child), and stores the rewritten file twice, the dated snapshot first and the state last.
  Neither object is written unless the state kept its rows and its columns. Status:
  - `ok`: the new header is the old one with columns appended at the end (the tracker's own
    contract, `COLUMNS` in scripts/daily_tracker.py), and no data row was lost.
  - `failed`, `tracking state missing`: there is no state in R2 (a new file is never started).
  - `failed`, `script exited {code}` (plus ` ({class})` when the log names one) or `script timed
    out`: the script did not finish.
  - `failed`, `tracking state header changed`: the new header is anything but the old one with
    columns appended (reordered, renamed, shortened), or there is no old header (a zero-byte
    state) to extend.
  - `failed`, `tracking state shrank`: fewer data rows than the step downloaded.
  Only the log is published when it fails.
- `quality-sim` runs `enrich_lottery_outcomes.refit_ticker_inversion_stats`, which only reads,
  in this process, and publishes the simulation CSV it writes. No scored fire fails the step.
- `takeit-drift` runs `takeit_drift_monitor.run_drift` in this process and publishes the report
  and the reliability plots. The connection is the step's own and autocommit is turned off on
  it: `run_drift` upserts a day's metrics and commits once after the last, or rolls back and
  raises, and under the autocommit `connect_db` hands over a failed upsert would leave part of
  a day. No metric written fails the step, even when the plots exist, and then nothing is
  published under `research/takeit-drift/`: the report's text is appended to the log, which is.
  The monitor's own `main` is never called.

Isolation. The two in-process steps run research code that prints (counts, tickers, a rollback
note) and warns (pandas, matplotlib). Their stdout and stderr go to the step's log file while
that code runs (the connection is opened and closed outside the redirect, so its retry lines,
which name a class only, stay in the job's log), and the file is published, so none of the
research code's output reaches the job's logs or Sentry. The tracker's output goes to its log
through `run_script`. What the step reports is a name, a status, counts and a fixed phrase: at
most an exit code or an exception class, never a ticker, a strike, a price, a date or an
exception's text. An exception (R2, the database, the research code) propagates to
`run_steps`, which reports the step failed by class name; the log is published first, as the
evidence, and an upload that fails then never replaces the error.

Register the steps through `pipeline.lazy_group_step` and never import this module at pipeline
load. Its imports pull no sklearn, scipy or sqlalchemy (the image has none). They do load
`research_reports` and with it pandas, psycopg2, duckdb and the exit-policy and flow-timing
scripts (through `research_derive`), so an import failure in any of those fails every research
step, not only the one that needs it. Only matplotlib and `takeit_drift_monitor` are left to
the step that uses them.
"""

from __future__ import annotations

import csv
import logging
import shutil
from collections.abc import Iterator
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from time import monotonic

from research_reports import (
    IN_DIR,
    LOG_NAME,
    OUT_DIR,
    failure_detail,
    log_step,
    prepare_step_dir,
    publish,
    publish_log,
    run_script,
    script_env,
)
from research_store import RESEARCH_PREFIX, ResearchStore
from resources import connect_db
from steps import StepContext, StepResult

log = logging.getLogger(__name__)

TRACKING_STEP = "lottery-tracking"
QUALITY_SIM_STEP = "quality-sim"
DRIFT_STEP = "takeit-drift"
STEP_NAMES: frozenset[str] = frozenset({TRACKING_STEP, QUALITY_SIM_STEP, DRIFT_STEP})

# The tracking file the nightly keeps: the one object that outlives a run. Each night's
# snapshot sits beside the other dated outputs, at research/lottery-tracking/{session}/.
TRACKING_STATE_KEY = f"{RESEARCH_PREFIX}{TRACKING_STEP}/state/lottery-tracking.csv"
_TRACKING_FILE = "lottery-tracking.csv"
_TRACKING_SCRIPT = "scripts/daily_tracker.py"

# Fixed phrases: they are part of the `nightly step failed` fingerprint.
_STATE_MISSING_DETAIL = "tracking state missing"
_STATE_SHRANK_DETAIL = "tracking state shrank"
_HEADER_CHANGED_DETAIL = "tracking state header changed"
_NO_FIRES_DETAIL = "no scored fires"
_NO_METRICS_DETAIL = "no drift metrics"


class StateShrankError(Exception):
    """The file to store as the tracking state has fewer data rows than the state it grew from."""


def _csv_lines(path: Path) -> Iterator[list[str]]:
    """The rows of a CSV, a blank line skipped. A quoted newline stays inside its row, and a
    byte order mark does not become part of the first name."""
    with path.open(newline="", encoding="utf-8-sig", errors="replace") as handle:
        for row in csv.reader(handle):
            if row:
                yield row


def csv_rows(path: Path) -> int:
    """The data rows of a CSV: every row but its header. 0 for an empty file."""
    return max(0, sum(1 for _ in _csv_lines(path)) - 1)


def _csv_header(path: Path) -> list[str]:
    return next(_csv_lines(path), [])


def _extends(old: list[str], new: list[str]) -> bool:
    """Whether `new` is `old` with columns appended at the end, or equal to it.

    That is the one change the tracker's own contract allows (the comment on `COLUMNS` in
    scripts/daily_tracker.py: add a column at the end, never reorder). No `old` header (a
    zero-byte state) has nothing to extend, so it never matches.
    """
    return bool(old) and new[: len(old)] == old


def publish_state_csv(
    store: ResearchStore, state_key: str, snapshot_key: str, path: Path, rows_before: int
) -> int:
    """Store `path` as the dated snapshot, then as the state; the number of objects written.

    StateShrankError, before anything is written, when `path` has fewer data rows than
    `rows_before`. The snapshot goes first: a failure between the two puts leaves the old state
    (the next run reads it, redoes the day and overwrites the snapshot at the same key), where
    the other order would leave a state no snapshot backs.
    """
    if csv_rows(path) < rows_before:
        raise StateShrankError(snapshot_key)
    store.put_file(snapshot_key, path)
    store.put_file(state_key, path)
    return 2


def _snapshot_key(ctx: StepContext) -> str:
    return f"{RESEARCH_PREFIX}{TRACKING_STEP}/{ctx.last_session.isoformat()}/{_TRACKING_FILE}"


def _track(
    ctx: StepContext, store: ResearchStore, work: Path, counts: dict[str, int]
) -> StepResult:
    """The part of `run_tracking` that works on the downloaded state; fills `counts` as it goes."""
    state = work / IN_DIR / _TRACKING_FILE
    if not store.get_file(TRACKING_STATE_KEY, state):
        return StepResult("failed", counts, _STATE_MISSING_DETAIL)
    counts["rows_before"] = rows_before = csv_rows(state)
    header = _csv_header(state)
    run = run_script(
        _TRACKING_SCRIPT,
        ["--csv", str(state)],
        log_path=work / LOG_NAME,
        timeout=ctx.seconds_left(),
        env=script_env(ctx.settings, TRACKING_STEP),
    )
    # The log goes first: it is the evidence when anything after it fails.
    counts["log_uploaded"] = publish_log(store, work / LOG_NAME, ctx.last_session, TRACKING_STEP)
    detail = failure_detail(run, (), work / OUT_DIR)  # no output globs: the file is rewritten
    if detail:
        return StepResult("failed", counts, detail)
    counts["rows_after"] = csv_rows(state)
    if not _extends(header, _csv_header(state)):
        return StepResult("failed", counts, _HEADER_CHANGED_DETAIL)
    try:
        counts["files_uploaded"] = publish_state_csv(
            store, TRACKING_STATE_KEY, _snapshot_key(ctx), state, rows_before
        )
    except StateShrankError:
        return StepResult("failed", counts, _STATE_SHRANK_DETAIL)
    return StepResult("ok", counts)


def run_tracking(ctx: StepContext) -> StepResult:
    """Run the daily tracker on the stored tracking CSV and store the file it rewrote.

    Counts: `rows_before` (the data rows downloaded), `rows_after` (0 until the script has run
    and exited 0), `files_uploaded` (the snapshot and the state) and `log_uploaded`.
    """
    started = monotonic()
    store = ResearchStore(ctx.settings)
    counts: dict[str, int] = dict.fromkeys(
        ("rows_before", "rows_after", "files_uploaded", "log_uploaded"), 0
    )
    work = prepare_step_dir(TRACKING_STEP)
    try:
        result = _track(ctx, store, work, counts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    log_step(log, TRACKING_STEP, result, started)
    return result


@contextmanager
def _log_on_error(
    store: ResearchStore, log_path: Path, ctx: StepContext, step: str
) -> Iterator[None]:
    """On an Exception from the body, publish the step's log first, as the evidence for the
    failure, and then let the error propagate. An upload that fails then is logged by class
    name and never replaces it."""
    try:
        yield
    except Exception:
        try:
            publish_log(store, log_path, ctx.last_session, step)
        except Exception as upload_error:
            log.warning("%s: log upload failed (%s)", step, type(upload_error).__name__)
        raise


@contextmanager
def _captured(log_path: Path) -> Iterator[None]:
    """Send stdout and stderr to the end of the step's log file for the length of the block, and
    nowhere else. The research code's output is the only thing run inside one."""
    with (
        log_path.open("a", encoding="utf-8", errors="replace") as sink,
        redirect_stdout(sink),
        redirect_stderr(sink),
    ):
        yield


def _append_report_to_log(log_path: Path, report_path: Path) -> None:
    """Add the drift report's text to the step's log. A run with no metric publishes nothing
    under research/takeit-drift/, so the report, which says why, goes where the evidence goes."""
    text = report_path.read_text(encoding="utf-8", errors="replace")
    with log_path.open("a", encoding="utf-8", errors="replace") as sink:
        sink.write(f"\n--- {report_path.name} ---\n{text}\n")


def run_quality_sim(ctx: StepContext) -> StepResult:
    """Simulate the ticker-quality tiers over the last 90 days of fires and publish the CSV."""
    started = monotonic()
    store = ResearchStore(ctx.settings)
    counts: dict[str, int] = dict.fromkeys(("csv_rows", "files_uploaded", "log_uploaded"), 0)
    work = prepare_step_dir(QUALITY_SIM_STEP)
    log_path = work / LOG_NAME
    try:
        sim_csv = work / OUT_DIR / f"lottery-quality-sim-{ctx.last_session.isoformat()}.csv"
        with _log_on_error(store, log_path, ctx, QUALITY_SIM_STEP):
            with _captured(log_path):
                from enrich_lottery_outcomes import refit_ticker_inversion_stats

            # The connection is opened and closed outside the redirect: its retry lines name a
            # class only, and the job's log is where the owner looks when Neon is down.
            with connect_db(ctx.settings) as conn, _captured(log_path):
                refit_ticker_inversion_stats(conn, sim_csv_path=sim_csv)
        counts["log_uploaded"] = publish_log(store, log_path, ctx.last_session, QUALITY_SIM_STEP)
        counts["csv_rows"] = csv_rows(sim_csv)
        if counts["csv_rows"] == 0:  # the header alone is no result
            result = StepResult("failed", counts, _NO_FIRES_DETAIL)
        else:
            counts["files_uploaded"], _ = publish(
                store, work / OUT_DIR, QUALITY_SIM_STEP, ctx.last_session
            )
            result = StepResult("ok", counts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    log_step(log, QUALITY_SIM_STEP, result, started)
    return result


def run_takeit_drift(ctx: StepContext) -> StepResult:
    """Run the Take-It drift monitor for the last session; publish its report and plots."""
    started = monotonic()
    store = ResearchStore(ctx.settings)
    counts: dict[str, int] = dict.fromkeys(
        ("metrics_written", "plots_written", "files_uploaded", "log_uploaded"), 0
    )
    work = prepare_step_dir(DRIFT_STEP)
    log_path = work / LOG_NAME
    try:
        with _log_on_error(store, log_path, ctx, DRIFT_STEP):
            with _captured(log_path):
                # First use of matplotlib in this process (Agg, set by the image's MPLBACKEND and
                # by the module itself), so nothing here imports it before a step runs.
                import takeit_drift_monitor

            # The connection is opened and closed outside the redirect: its retry lines name a
            # class only, and the job's log is where the owner looks when Neon is down.
            with connect_db(ctx.settings) as conn:
                # connect_db's autocommit would commit each upsert as it ran; run_drift commits
                # once after the last, or rolls back on an error.
                conn.autocommit = False
                with _captured(log_path):
                    run = takeit_drift_monitor.run_drift(
                        conn, ctx.last_session, work / OUT_DIR, work / OUT_DIR
                    )
        counts["metrics_written"] = run.metrics_written
        counts["plots_written"] = len(run.plot_paths)
        no_metrics = run.metrics_written == 0  # a run with no metric is a failure, plots or not
        if no_metrics:
            _append_report_to_log(log_path, run.report_path)
        counts["log_uploaded"] = publish_log(store, log_path, ctx.last_session, DRIFT_STEP)
        if no_metrics:
            result = StepResult("failed", counts, _NO_METRICS_DETAIL)
        else:
            counts["files_uploaded"], _ = publish(
                store, work / OUT_DIR, DRIFT_STEP, ctx.last_session
            )
            result = StepResult("ok", counts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    log_step(log, DRIFT_STEP, result, started)
    return result


def run_step(name: str, ctx: StepContext) -> StepResult:
    """Run the step called `name`; KeyError for a name that is not in STEP_NAMES."""
    if name == TRACKING_STEP:
        return run_tracking(ctx)
    if name == QUALITY_SIM_STEP:
        return run_quality_sim(ctx)
    if name == DRIFT_STEP:
        return run_takeit_drift(ctx)
    raise KeyError(name)
