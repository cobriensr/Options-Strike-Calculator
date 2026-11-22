"""The research steps that work against Neon: lottery-tracking, quality-sim and takeit-drift.

Each publishes its dated outputs under `research/` in R2 and its log to `research/_logs/`, as
the report steps of `research_reports` do, and reuses that module's runner, environment and
publishers.

- `lottery-tracking` rewrites one CSV in R2 every night: a row for every enriched fire date, each
  as of its own date. The step downloads the stored file if there is one, runs
  `scripts/daily_tracker.py --csv` on it as a subprocess (D6: no R2, UW or Sentry secret in the
  child), and stores the rewritten file twice, the dated snapshot first and the state last. A
  missing, zero-byte or header-only state is not a failure: it has no header to extend and no
  dates, and the tracker writes a new file. Before the script runs, which rewrites the file in
  place, the step reads the old header and the old dates (the strict `YYYY-MM-DD` ones, as the
  tracker counts them; a file it cannot read as CSV counts as having none). Status:
  - `ok`: the new header is the old one with columns appended at the end (the tracker's own
    contract, `COLUMNS` in scripts/daily_tracker.py), and every old date has a row.
  - `partial`, `tracking dates dropped`: the snapshot and the state are published, but a date
    the old state had has no row tonight (its fires were deleted or lost their outcomes).
    `dates_dropped` counts them. The next night compares against the new state, so it alerts
    once; the lost row stays in the previous night's snapshot. Row counts cannot show it: a
    night that loses one date and gains another keeps the count.
  - `failed`, `script exited {code}` (plus ` ({class})` when the log names one) or `script timed
    out`: the script did not finish.
  - `failed`, `tracking state header changed`: there is an old header and the new header is
    anything but it with columns appended (reordered, renamed, shortened), or the new file has
    no header.
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
import re
import shutil
from collections.abc import Iterator
from contextlib import contextmanager, redirect_stderr, redirect_stdout, suppress
from datetime import date
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

# Fixed phrases: they are part of the `nightly step failed` / `partial` fingerprint.
_HEADER_CHANGED_DETAIL = "tracking state header changed"
_DATES_DROPPED_DETAIL = "tracking dates dropped"
_NO_FIRES_DETAIL = "no scored fires"
_NO_METRICS_DETAIL = "no drift metrics"

# What the tracker counts as a date of a tracking file: `_CSV_DATE` and `_csv_date` in
# scripts/daily_tracker.py, kept equal here (the step never imports the script). Only a strict
# YYYY-MM-DD that is a day of the calendar: not an ISO week date, a compact one, text or blank.
_TRACKING_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


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


def _is_tracking_date(text: str) -> bool:
    if not _TRACKING_DATE.fullmatch(text):
        return False
    try:
        date.fromisoformat(text)
    except ValueError:  # 2026-13-45
        return False
    return True


def _read_tracking_file(path: Path) -> tuple[list[str], set[str], int]:
    """The header, the set of dates and the number of data rows of a tracking CSV.

    The dates are those of the `date` column that the tracker would count (`_TRACKING_DATE`):
    a blank or malformed one is no date. An empty file has no header and no dates.
    """
    rows = _csv_lines(path)
    header = next(rows, [])
    column = header.index("date") if "date" in header else None
    dates: set[str] = set()
    data_rows = 0
    for row in rows:
        data_rows += 1
        if column is not None and column < len(row) and _is_tracking_date(row[column]):
            dates.add(row[column])
    return header, dates, data_rows


def _extends(old: list[str], new: list[str]) -> bool:
    """Whether `new` is `old` with columns appended at the end, or equal to it.

    That is the one change the tracker's own contract allows (the comment on `COLUMNS` in
    scripts/daily_tracker.py: add a column at the end, never reorder). No `old` header (a
    missing, zero-byte or unreadable state) has nothing to keep, so anything extends it.
    """
    return new[: len(old)] == old


def publish_state_csv(store: ResearchStore, state_key: str, snapshot_key: str, path: Path) -> int:
    """Store `path` as the dated snapshot, then as the state; the number of objects written.

    The snapshot goes first: a failure between the two puts leaves the old state (the next run
    reads it, redoes the night and overwrites the snapshot at the same key), where the other
    order would leave a state no snapshot backs.
    """
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
    header: list[str] = []
    old_dates: set[str] = set()
    if store.get_file(TRACKING_STATE_KEY, state):
        # Before the script runs: it rewrites this file in place. A file that cannot be read
        # as CSV has no header to keep and no dates to lose (the tracker replaces it too).
        with suppress(csv.Error):
            header, old_dates, counts["rows_before"] = _read_tracking_file(state)
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
    new_header, new_dates, counts["rows_after"] = _read_tracking_file(state)
    # A file with no header is no tracking file, whatever the old one was.
    if not new_header or not _extends(header, new_header):
        return StepResult("failed", counts, _HEADER_CHANGED_DETAIL)
    lost = old_dates - new_dates
    counts["dates_dropped"] = len(lost)
    counts["files_uploaded"] = publish_state_csv(
        store, TRACKING_STATE_KEY, _snapshot_key(ctx), state
    )
    if lost:
        return StepResult("partial", counts, _DATES_DROPPED_DETAIL)
    return StepResult("ok", counts)


def run_tracking(ctx: StepContext) -> StepResult:
    """Run the daily tracker on the stored tracking CSV and store the file it rewrote.

    Counts: `rows_before` (the data rows downloaded, 0 with no state), `rows_after` (0 until the
    script has run and exited 0), `dates_dropped` (the old dates with no row in the new file, 0
    until then too), `files_uploaded` (the snapshot and the state) and `log_uploaded`.
    """
    started = monotonic()
    store = ResearchStore(ctx.settings)
    counts: dict[str, int] = dict.fromkeys(
        ("rows_before", "rows_after", "dates_dropped", "files_uploaded", "log_uploaded"), 0
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
