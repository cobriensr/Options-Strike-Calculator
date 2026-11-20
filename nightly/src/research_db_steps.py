"""The research steps that work against Neon: lottery-tracking, quality-sim and takeit-drift.

Each publishes its dated outputs under `research/` in R2 and its log to `research/_logs/`, as
the report steps of `research_reports` do, and reuses that module's runner, environment and
publishers.

- `lottery-tracking` keeps one growing CSV in R2. The step downloads it, runs
  `scripts/daily_tracker.py --csv` on it as a subprocess (D6: no R2, UW or Sentry secret in the
  child), and stores the rewritten file twice, the dated snapshot first and the state last. The
  state never shrinks: a header that changed, or fewer data rows than the step downloaded,
  fails the step before either object is written. A missing state fails too, and never starts a
  new file.
- `quality-sim` runs `enrich_lottery_outcomes.refit_ticker_inversion_stats`, which only reads,
  in this process, and publishes the simulation CSV it writes. No scored fire fails the step.
- `takeit-drift` runs `takeit_drift_monitor.run_drift` in this process and publishes the report
  and the reliability plots. The connection is the step's own and autocommit is turned off on
  it: `run_drift` upserts a day's metrics and commits once after the last, or rolls back and
  raises, and under the autocommit `connect_db` hands over a failed upsert would leave part of
  a day. No metric written fails the step, even when the plots exist. The monitor's own `main`
  is never called.

Isolation. The two in-process steps run research code that prints (counts, tickers, a rollback
note) and warns (pandas, matplotlib). Their stdout and stderr go to the step's log file for the
length of the run, and that file is published, so none of it reaches the job's logs or Sentry.
The tracker's output goes to its log through `run_script`. What the step reports is a name, a
status, counts and a fixed phrase: at most an exit code or an exception class, never a ticker,
a strike, a price, a date or an exception's text. An exception (R2, the database, the research
code) propagates to `run_steps`, which reports the step failed by class name; the log is
published first, as the evidence, and an upload that fails then never replaces the error.

Register the steps through `pipeline.lazy_group_step` and never import this module at pipeline
load. Its imports pull no sklearn, scipy or sqlalchemy (the image has none), and the research
code, matplotlib and pandas among it, is imported when a step runs.
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
    _IN,
    _LOG,
    _OUT,
    _failure_detail,
    _log_step,
    _prepare,
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
    state = work / _IN / _TRACKING_FILE
    if not store.get_file(TRACKING_STATE_KEY, state):
        return StepResult("failed", counts, _STATE_MISSING_DETAIL)
    counts["rows_before"] = rows_before = csv_rows(state)
    header = _csv_header(state)
    run = run_script(
        _TRACKING_SCRIPT,
        ["--csv", str(state)],
        log_path=work / _LOG,
        timeout=ctx.seconds_left(),
        env=script_env(ctx.settings, TRACKING_STEP),
    )
    # The log goes first: it is the evidence when anything after it fails.
    counts["log_uploaded"] = publish_log(store, work / _LOG, ctx.last_session, TRACKING_STEP)
    detail = _failure_detail(run, (), work / _OUT)  # no output globs: the file is rewritten
    if detail:
        return StepResult("failed", counts, detail)
    counts["rows_after"] = csv_rows(state)
    if _csv_header(state) != header:
        return StepResult("failed", counts, _STATE_SHRANK_DETAIL)
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
    counts = dict.fromkeys(("rows_before", "rows_after", "files_uploaded", "log_uploaded"), 0)
    work = _prepare(TRACKING_STEP)
    try:
        result = _track(ctx, store, work, counts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _log_step(TRACKING_STEP, result, started)
    return result


@contextmanager
def _in_process(
    store: ResearchStore, log_path: Path, ctx: StepContext, step: str
) -> Iterator[None]:
    """Run research code with stdout and stderr in the step's log file, and nowhere else.

    An Exception from the body publishes the log first, as the evidence for the failure, and
    then propagates; an upload that fails then is logged by class name and never replaces it.
    """
    try:
        with (
            log_path.open("w", encoding="utf-8", errors="replace") as sink,
            redirect_stdout(sink),
            redirect_stderr(sink),
        ):
            yield
    except Exception:
        try:
            publish_log(store, log_path, ctx.last_session, step)
        except Exception as upload_error:
            log.warning("%s: log upload failed (%s)", step, type(upload_error).__name__)
        raise


def run_quality_sim(ctx: StepContext) -> StepResult:
    """Simulate the ticker-quality tiers over the last 90 days of fires and publish the CSV."""
    started = monotonic()
    store = ResearchStore(ctx.settings)
    counts = dict.fromkeys(("csv_rows", "files_uploaded", "log_uploaded"), 0)
    work = _prepare(QUALITY_SIM_STEP)
    try:
        sim_csv = work / _OUT / f"lottery-quality-sim-{ctx.last_session.isoformat()}.csv"
        with _in_process(store, work / _LOG, ctx, QUALITY_SIM_STEP):
            from enrich_lottery_outcomes import refit_ticker_inversion_stats

            with connect_db(ctx.settings) as conn:
                refit_ticker_inversion_stats(conn, sim_csv_path=sim_csv)
        counts["log_uploaded"] = publish_log(store, work / _LOG, ctx.last_session, QUALITY_SIM_STEP)
        counts["csv_rows"] = csv_rows(sim_csv)
        if counts["csv_rows"] == 0:  # the header alone is no result
            result = StepResult("failed", counts, _NO_FIRES_DETAIL)
        else:
            counts["files_uploaded"], _ = publish(
                store, work / _OUT, QUALITY_SIM_STEP, ctx.last_session
            )
            result = StepResult("ok", counts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _log_step(QUALITY_SIM_STEP, result, started)
    return result


def run_takeit_drift(ctx: StepContext) -> StepResult:
    """Run the Take-It drift monitor for the last session; publish its report and plots."""
    started = monotonic()
    store = ResearchStore(ctx.settings)
    counts = dict.fromkeys(
        ("metrics_written", "plots_written", "files_uploaded", "log_uploaded"), 0
    )
    work = _prepare(DRIFT_STEP)
    try:
        with _in_process(store, work / _LOG, ctx, DRIFT_STEP):
            # First use of matplotlib in this process (Agg, set by the image's MPLBACKEND and by
            # the module itself), so nothing here imports it before a step runs.
            import takeit_drift_monitor

            with connect_db(ctx.settings) as conn:
                # connect_db's autocommit would commit each upsert as it ran; run_drift commits
                # once after the last, or rolls back on an error.
                conn.autocommit = False
                run = takeit_drift_monitor.run_drift(
                    conn, ctx.last_session, work / _OUT, work / _OUT
                )
        counts["metrics_written"] = run.metrics_written
        counts["plots_written"] = len(run.plot_paths)
        counts["log_uploaded"] = publish_log(store, work / _LOG, ctx.last_session, DRIFT_STEP)
        if run.metrics_written == 0:  # a run with no metric is a failure, plots or not
            result = StepResult("failed", counts, _NO_METRICS_DETAIL)
        else:
            counts["files_uploaded"], _ = publish(store, work / _OUT, DRIFT_STEP, ctx.last_session)
            result = StepResult("ok", counts)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _log_step(DRIFT_STEP, result, started)
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
