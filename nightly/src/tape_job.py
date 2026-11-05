"""Plan, land and re-land Full Tape days in R2, one day at a time.

A run lists R2 once and plans the newest missing trading days, up to CATCHUP_MAX_DAYS.
It lands the plan, then probes the newest few days of that listing for an upstream
rewrite and re-lands the rewritten ones. Each day downloads, converts, checks and
uploads inside its own work dir, which is removed whatever happens.

Failure isolation (review finding b6): each day catches `Exception`, so one bad day
never stops the rest. A BaseException that isn't an Exception (KeyboardInterrupt,
SystemExit) still propagates, after the day's work dir is removed.

`DayOutcome.detail` reaches Sentry, so it holds only an error kind, an exception class
name or a fixed phrase: never exception text, a URL, a key or any tape value.
`DayOutcome.reason` holds only text that is log-safe by contract (see DayOutcome). Logs
follow the same rule, except that a TapeDownloadError's `detail` is logged, since
uw_client builds it to be log-safe.

Days reach Sentry through the caller's `on_outcome` (monitoring.report_outcome). The
one Sentry call made here is the run's `nightly rewrite check unavailable` warning.
"""

from __future__ import annotations

import logging
import traceback
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from shutil import disk_usage, rmtree
from time import monotonic
from typing import Literal

import sentry_sdk
from botocore.exceptions import ClientError

from calendar_nyse import last_completed_session, trading_days
from config import Settings
from constants import (
    CATCHUP_MAX_DAYS,
    DAY_BUDGET_SECONDS,
    MAX_MARKERS_PER_RUN,
    MIN_FREE_DISK_BYTES,
    MIN_TAPE_ROWS,
    OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS,
    PLAUSIBLE_MIN_ROW_RATIO,
    PROBE_BUDGET_SECONDS,
    REWRITE_RECHECK_DAYS,
    RUN_DEADLINE_SECONDS,
    SCHEMA_VERSION,
    TAPE_START,
    UNAVAILABLE_AGE_TRADING_DAYS,
    WORK_DIR,
)
from r2_store import R2Store, R2VerifyError
from tape_convert import (
    ConvertResult,
    TapeValidationError,
    convert_zip,
    plausibility_warnings,
    session_window,
)
from uw_client import SourceInfo, TapeDownloadError, download_tape, probe_source

log = logging.getLogger(__name__)

DayStatus = Literal[
    "landed", "relanded", "not_posted", "unavailable", "failed", "skipped_disk", "skipped_deadline"
]

# A re-land's warning when its rows and source-bytes match the replaced object's: the
# same content under a new ETag suggests ETag churn rather than a rewrite.
RELAND_IDENTICAL = "re-land identical content: rows and source-bytes equal the replaced object's"
# The row-count check compares against the median of this many landed days nearest the
# target, on either side: PLAUSIBLE_MIN_ROW_RATIO was tuned on a 20-day window. Two-sided
# because a backfill lands newest first, so its days have landed days only after them.
_BASELINE_DAYS = 20
_SKIPPED_DISK = "free disk below the minimum"
_SKIPPED_DEADLINE = "less than a day's budget left before the run deadline"
_DISK_CHECK_FAILED = "disk check failed"
_SRC_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class DayOutcome:
    """What happened to one day. ``detail`` is a kind, a class name or a fixed phrase
    (empty on success); ``bytes`` is the uploaded Parquet's size.

    ``reason`` says more about a failure, and is set only where the text is log-safe
    by contract: a TapeValidationError's or R2VerifyError's message (names, counts and
    keys only), or a botocore ClientError's error code. It is None otherwise, so no
    other exception's text ever reaches it.
    """

    day: date
    status: DayStatus
    detail: str = ""
    rows: int | None = None
    warnings: tuple[str, ...] = ()
    bytes: int | None = None
    reason: str | None = None


def plan_days(
    landed: set[date],
    unavailable: set[date],
    last_session: date,
    start: date = TAPE_START,
    cap: int = CATCHUP_MAX_DAYS,
) -> list[date]:
    """Trading days in [start, last_session] neither landed nor unavailable, newest
    first, at most `cap`."""
    done = landed | unavailable
    missing = [d for d in trading_days(start, last_session) if d not in done]
    return sorted(missing, reverse=True)[:cap]


def rewritten_days(
    landed: Mapping[date, Mapping[str, str]],
    api_key: str,
    last_session: date,
    *,
    deadline: float,
) -> list[date]:
    """Days among the newest REWRITE_RECHECK_DAYS landed days (up to `last_session`)
    whose upstream ETag has changed since they landed, newest first.

    Only the days in that window that carry a non-empty `source-etag` are probed;
    the window never reaches further back for more. A day whose probe fails or
    returns no ETag can't be compared, so it is skipped with a warning log and
    checked again next run. A probe starts only with PROBE_BUDGET_SECONDS left before
    the run's `deadline` (a `monotonic` time), so a stalled one ends inside the
    watchdog's grace; the remaining days are probed next run, since the newest days
    stay in the window. When there was a day to probe but none could be compared, it
    sends one Sentry warning, `nightly rewrite check unavailable`, with the day count:
    a rewrite would otherwise go unseen.
    """
    window = sorted((d for d in landed if d <= last_session), reverse=True)
    etagged = [d for d in window[:REWRITE_RECHECK_DAYS] if landed[d].get("source-etag")]
    changed: list[date] = []
    compared = 0
    for i, day in enumerate(etagged):
        if deadline - monotonic() < PROBE_BUDGET_SECONDS:
            log.warning(
                "rewrite check: less than the probe budget left before the run deadline;"
                " %d day(s) not probed",
                len(etagged) - i,
            )
            break
        try:
            etag = probe_source(day, api_key).etag
        except Exception as exc:
            log.warning("rewrite check %s skipped: probe failed (%s)", day, _error_name(exc))
            continue
        if etag is None:
            log.warning("rewrite check %s skipped: probe returned no ETag", day)
            continue
        compared += 1
        if etag != landed[day]["source-etag"]:
            changed.append(day)
    if etagged and compared == 0:
        log.warning("rewrite check unavailable: none of %d day(s) compared", len(etagged))
        sentry_sdk.capture_message(
            "nightly rewrite check unavailable", level="warning", extras={"days": len(etagged)}
        )
    return changed


def land_day(
    day: date,
    store: R2Store,
    api_key: str,
    baseline_rows: list[int],
    replacing: Mapping[str, str] | None = None,
    *,
    last_session: date,
    may_mark: bool = True,
) -> DayOutcome:
    """Download, convert, check and upload one day, in WORK_DIR/<day>, removed afterwards.

    Before anything in R2 changes, a tape with fewer than MIN_TAPE_ROWS rows is
    `failed` (`row floor`), and one whose every trade falls outside the session
    window is `failed` (`wrong-day tape`). Both are retried next night.

    `replacing` makes it a re-land: the landed object's metadata. A new tape with
    fewer than PLAUSIBLE_MIN_ROW_RATIO of the old `rows` is `failed` (`re-land row
    drop`). The old object is copied aside with `supersede` right before the put, so
    a re-land that fails earlier leaves R2 as it was, and a failed supersede means no
    put. When the new `rows` and `source-bytes` equal the old ones, the outcome
    carries the RELAND_IDENTICAL warning.

    A day is marked unavailable, permanently, only on UW's own evidence, and never
    on a re-land:
    - `outside_window` whose parsed `earliest` is after the day and at least
      OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS before `last_session`. A newer boundary is
      `failed` (`outside_window short-window`); no boundary, or a day on or after
      it, is `failed` (`outside_window`). Both are retried next night.
    - `not_posted` from GCS (UW redirected; no object) at least
      UNAVAILABLE_AGE_TRADING_DAYS sessions before `last_session`. An old one from UW
      itself is `failed`; a recent one is `not_posted` whatever its origin.
    With `may_mark` False (the run already wrote MAX_MARKERS_PER_RUN markers), a day
    that would be marked is `failed` (`marker cap`) instead, and retried next night.
    """
    work = WORK_DIR / day.isoformat()
    try:
        outcome = _attempt(
            day, work, store, api_key, baseline_rows, replacing, last_session, may_mark
        )
    finally:
        # Logged here so an interrupted day's failed cleanup is still on record.
        cleanup_error = _remove(work)
        if cleanup_error is not None:
            log.warning("tape %s: work dir cleanup failed (%s)", day, cleanup_error)
    if cleanup_error is not None:
        warning = f"work dir cleanup failed ({cleanup_error})"
        outcome = replace(outcome, warnings=(*outcome.warnings, warning))
    return outcome


def run_tape(
    settings: Settings,
    now_utc: datetime,
    on_outcome: Callable[[DayOutcome], None] | None = None,
) -> list[DayOutcome]:
    """Land the planned days, then probe for rewrites and re-land the rewritten days;
    one outcome per day.

    Before each day it checks the run time left and free disk in WORK_DIR. Less than
    DAY_BUDGET_SECONDS before the deadline, too little disk, or the disk check itself
    failing marks that day and every later one skipped. A day that starts can finish
    inside its budget, so the run ends by its deadline.

    The probes come after the planned days, so a slow probe never costs a missing
    day. They cover the newest days of the run's one listing, never a day this run
    landed, and stop once less than PROBE_BUDGET_SECONDS is left (see rewritten_days).
    A run whose planned days were skipped probes nothing; the next run probes again.
    Each day this run lands joins the row baseline of the days after it, and a run
    writes at most MAX_MARKERS_PER_RUN unavailable markers (see land_day).

    `on_outcome` gets each day's outcome as soon as it is decided, skipped days
    included, so a run killed mid-way has already reported its finished days. An
    Exception from it is logged by class name and the run goes on.

    It raises, with no outcomes, only before the first day:
    - ValueError for a naive `now_utc`, and CalendarExhausted when the NYSE holiday
      table doesn't cover a needed year;
    - an OSError setting up WORK_DIR (scanning it for stale day dirs, or mkdir);
    - any R2 error listing the landed or unavailable days, since with no listing no
      day can be planned.
    Once days start, every failure is a day's outcome.
    """
    deadline = monotonic() + RUN_DEADLINE_SECONDS
    last_session = last_completed_session(now_utc)
    _clear_stale_work_dirs()
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    api_key = settings.uw_api_key.get_secret_value()
    store = R2Store(settings)
    listed = store.landed()
    planned = plan_days(set(listed), store.unavailable(), last_session)
    log.info("tape run: last session %s, %d planned", last_session, len(planned))
    # The row baselines' source, which grows as this run lands days. `listed` stays as
    # listed: the probes' window and each replaced object's metadata.
    landed = dict(listed)
    outcomes: list[DayOutcome] = []
    markers = 0

    def record(outcome: DayOutcome) -> None:
        outcomes.append(outcome)
        if on_outcome is not None:
            _notify(on_outcome, outcome)

    def land_all(queue: list[tuple[date, Mapping[str, str] | None]]) -> bool:
        """Land each queued day in order; False once the run's limits skip the rest."""
        nonlocal markers
        for i, (day, replacing) in enumerate(queue):
            skip = _skip_status(deadline)
            if skip is not None:
                status, detail = skip
                log.warning("tape run: %s; %d day(s) skipped", detail, len(queue) - i)
                for skipped_day, _ in queue[i:]:
                    record(DayOutcome(skipped_day, status, detail))
                return False
            outcome = land_day(
                day,
                store,
                api_key,
                _baseline_rows(landed, day),
                replacing,
                last_session=last_session,
                may_mark=markers < MAX_MARKERS_PER_RUN,
            )
            if outcome.status == "unavailable":  # a marker was written
                markers += 1
            if outcome.rows is not None:  # landed or relanded: later days' baselines
                landed[day] = {"rows": str(outcome.rows)}
            _log_outcome(outcome)
            record(outcome)
        return True

    if land_all([(d, None) for d in planned]):
        relands = rewritten_days(listed, api_key, last_session, deadline=deadline)
        log.info("tape run: %d to re-land", len(relands))
        land_all([(d, listed[d]) for d in relands])
    return outcomes


def _notify(on_outcome: Callable[[DayOutcome], None], outcome: DayOutcome) -> None:
    """Hand `outcome` to the caller's callback; a failing report never stops the run."""
    try:
        on_outcome(outcome)
    except Exception as exc:
        log.warning("tape %s: outcome report failed (%s)", outcome.day, type(exc).__name__)


def _attempt(
    day: date,
    work: Path,
    store: R2Store,
    api_key: str,
    baseline_rows: list[int],
    replacing: Mapping[str, str] | None,
    last_session: date,
    may_mark: bool,
) -> DayOutcome:
    """The day's outcome. Every Exception becomes one; only BaseException escapes."""
    try:
        try:
            return _land(day, work, store, api_key, baseline_rows, replacing)
        except TapeDownloadError as exc:
            return _download_failed(day, exc, store, replacing, last_session, may_mark)
    except Exception as exc:
        log.warning("tape %s failed: %s at %s", day, type(exc).__name__, _raised_at(exc))
        return DayOutcome(day, "failed", type(exc).__name__, reason=_safe_reason(exc))


def _safe_reason(exc: Exception) -> str | None:
    """DayOutcome.reason for `exc`: text only from the classes whose messages are
    log-safe by contract, and only a ClientError's code (its message can quote a URL)."""
    if isinstance(exc, TapeValidationError | R2VerifyError):
        return str(exc)
    if isinstance(exc, ClientError):
        error = exc.response.get("Error")
        code = error.get("Code") if isinstance(error, dict) else None
        return code if isinstance(code, str) and code else None
    return None


def _land(
    day: date,
    work: Path,
    store: R2Store,
    api_key: str,
    baseline_rows: list[int],
    replacing: Mapping[str, str] | None,
) -> DayOutcome:
    work.mkdir(parents=True, exist_ok=True)
    zip_path = work / f"{day.isoformat()}-fulltape.zip"
    out_path = work / f"{day.isoformat()}-fulltape.parquet"
    source = download_tape(day, zip_path, api_key)
    ingested_at = datetime.now(UTC)
    # By keyword: two Paths, and two timestamps beside the rows, would swap silently.
    result = convert_zip(zip_path=zip_path, out_path=out_path, session=day, ingested_at=ingested_at)
    # Hard checks, before anything in R2 changes: the day fails and is retried.
    if result.rows < MIN_TAPE_ROWS:
        log.warning("tape %s: %d rows, below the %d-row floor", day, result.rows, MIN_TAPE_ROWS)
        return DayOutcome(day, "failed", "row floor")
    if _wrong_day(result, day):
        return DayOutcome(day, "failed", "wrong-day tape")
    if replacing is not None and _row_drop(day, result.rows, replacing):
        return DayOutcome(day, "failed", "re-land row drop")
    warnings = plausibility_warnings(
        rows=result.rows,
        baseline_rows=baseline_rows,
        min_executed_at=result.min_executed_at,
        max_executed_at=result.max_executed_at,
        session=day,
    )
    if replacing is not None:
        if _same_content(result, source, replacing):
            warnings.append(RELAND_IDENTICAL)
        # Right before the put, so a re-land that failed above left R2 as it was.
        store.supersede(day, replacing["source-etag"])
    store.put_tape(out_path, day, _metadata(result, source, ingested_at))
    return DayOutcome(
        day,
        "landed" if replacing is None else "relanded",
        rows=result.rows,
        warnings=tuple(warnings),
        bytes=result.bytes,
    )


def _download_failed(
    day: date,
    exc: TapeDownloadError,
    store: R2Store,
    replacing: Mapping[str, str] | None,
    last_session: date,
    may_mark: bool,
) -> DayOutcome:
    log.warning("tape %s download: %s (%s)", day, exc.kind, exc.detail)
    if replacing is not None:
        return DayOutcome(day, "failed", exc.kind)
    if exc.kind == "outside_window":
        # Only UW's own boundary proves the day is gone, and only an old one: the 403
        # states this token's window, so a recent boundary means the entitlement
        # shrank. Anything else may be one odd night, and a marker would stop
        # ingestion while the job reported green.
        cutoff = last_session - timedelta(days=OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS)
        if exc.earliest is not None and exc.earliest > cutoff:
            return DayOutcome(day, "failed", f"{exc.kind} short-window")
        if exc.earliest is not None and day < exc.earliest:
            return _mark_unavailable(day, exc, store, may_mark)
        return DayOutcome(day, "failed", exc.kind)
    if exc.kind == "not_posted":
        sessions_since = sum(1 for d in trading_days(day, last_session) if d > day)
        if sessions_since < UNAVAILABLE_AGE_TRADING_DAYS:
            return DayOutcome(day, "not_posted", exc.kind)
        # Documented as UW redirecting to GCS, which has no object. A 404 from UW's
        # own API isn't that evidence, so it stays loud and is retried.
        if exc.origin == "gcs":
            return _mark_unavailable(day, exc, store, may_mark)
        return DayOutcome(day, "failed", f"not_posted {exc.origin or 'unknown'}")
    return DayOutcome(day, "failed", exc.kind)


def _mark_unavailable(
    day: date, exc: TapeDownloadError, store: R2Store, may_mark: bool
) -> DayOutcome:
    if not may_mark:
        log.warning("tape %s: %d marker(s) already written this run", day, MAX_MARKERS_PER_RUN)
        return DayOutcome(day, "failed", "marker cap")
    store.mark_unavailable(day, f"{exc.kind}: {exc.detail}")
    return DayOutcome(day, "unavailable", exc.kind)


def _wrong_day(result: ConvertResult, day: date) -> bool:
    """Every trade falls outside the day's `session_window`, so the tape is another
    day's. A partial overlap is only a plausibility warning. Logs name the window
    edges, never an observed timestamp."""
    start, end = session_window(day)
    low, high = result.min_executed_at, result.max_executed_at
    if (low is not None and low >= end) or (high is not None and high < start):
        log.warning(
            "tape %s: every trade falls outside the session window [%s, %s)",
            day,
            start.isoformat(timespec="minutes"),
            end.isoformat(timespec="minutes"),
        )
        return True
    return False


def _row_drop(day: date, rows: int, replacing: Mapping[str, str]) -> bool:
    """The re-land has fewer than PLAUSIBLE_MIN_ROW_RATIO of the replaced object's rows."""
    old = replacing.get("rows", "")
    if not old.isdecimal() or rows >= PLAUSIBLE_MIN_ROW_RATIO * int(old):
        return False
    log.warning(
        "tape %s: re-land has %d rows, below %s x the replaced object's %s",
        day,
        rows,
        PLAUSIBLE_MIN_ROW_RATIO,
        old,
    )
    return True


def _same_content(result: ConvertResult, source: SourceInfo, replacing: Mapping[str, str]) -> bool:
    """The new tape's rows and source bytes both equal the replaced object's."""
    same_rows = replacing.get("rows") == str(result.rows)
    return same_rows and replacing.get("source-bytes") == str(source.bytes)


def _metadata(result: ConvertResult, source: SourceInfo, ingested_at: datetime) -> dict[str, str]:
    """Every metadata key in the Global Constraints. A header UW didn't send is ""."""
    return {
        "rows": str(result.rows),
        "sha256": result.sha256,
        "schema-version": SCHEMA_VERSION,
        "source-etag": source.etag or "",
        "source-last-modified": source.last_modified or "",
        "source-bytes": str(source.bytes),
        "ingested-at": ingested_at.isoformat(),
    }


def _baseline_rows(landed: Mapping[date, Mapping[str, str]], day: date) -> list[int]:
    """`rows` of the _BASELINE_DAYS landed days nearest `day` that carry them, before
    or after it, nearest first (the earlier of two equally near days first); never
    `day` itself.

    Legacy days carry no metadata, so they are skipped rather than given a slot: a
    day beside the legacy run still gets its full baseline from the days beyond it.
    """
    valued = (d for d in landed if d != day and landed[d].get("rows", "").isdecimal())
    nearest = sorted(valued, key=lambda d: (abs(d - day), d))[:_BASELINE_DAYS]
    return [int(landed[d]["rows"]) for d in nearest]


def _skip_status(deadline: float) -> tuple[DayStatus, str] | None:
    if deadline - monotonic() < DAY_BUDGET_SECONDS:
        return "skipped_deadline", _SKIPPED_DEADLINE
    try:
        free = disk_usage(WORK_DIR).free
    except OSError as exc:
        log.warning("tape run: disk check failed (%s)", type(exc).__name__)
        return "skipped_disk", _DISK_CHECK_FAILED
    if free < MIN_FREE_DISK_BYTES:
        log.warning("tape run: %d bytes free, need %d", free, MIN_FREE_DISK_BYTES)
        return "skipped_disk", _SKIPPED_DISK
    return None


def _clear_stale_work_dirs() -> None:
    """Remove the day dirs a hard-killed run left in WORK_DIR, best effort.

    Only directories named exactly as `date.isoformat()` writes them are touched,
    never anything else. Whatever can't be removed is left for the disk check.
    """
    if not WORK_DIR.is_dir():
        return
    stale = [path for path in WORK_DIR.iterdir() if _is_day_dir(path)]
    for path in stale:
        rmtree(path, ignore_errors=True)
    if stale:
        left = sum(1 for path in stale if path.exists())
        log.warning(
            "tape run: removed %d stale day dir(s) from WORK_DIR; %d could not be removed",
            len(stale) - left,
            left,
        )


def _is_day_dir(path: Path) -> bool:
    if path.is_symlink() or path.is_junction() or not path.is_dir():
        return False
    try:
        # fromisoformat also takes 20261028 and 2026-W44-3; only the canonical form counts.
        return date.fromisoformat(path.name).isoformat() == path.name
    except ValueError:
        return False


def _remove(work: Path) -> str | None:
    """Delete the day's work dir; the error class name if that fails, else None.

    It runs in a `finally`, so it must not raise: that would replace an exception
    already propagating, such as a KeyboardInterrupt.
    """
    try:
        rmtree(work, ignore_errors=False)
    except FileNotFoundError:
        pass  # nothing was created (the work dir's own mkdir failed)
    except Exception as exc:
        return type(exc).__name__
    return None


def _error_name(exc: Exception) -> str:
    return exc.kind if isinstance(exc, TapeDownloadError) else type(exc).__name__


def _raised_at(exc: Exception) -> str:
    """`file:line` of the innermost traceback frame in this service's code (else the
    innermost frame): a location for the logs that quotes no exception text."""
    frames = traceback.extract_tb(exc.__traceback__)
    ours = [f for f in frames if Path(f.filename).resolve().parent == _SRC_DIR] or frames
    if not ours:
        return "unknown"
    return f"{Path(ours[-1].filename).name}:{ours[-1].lineno}"


def _log_outcome(outcome: DayOutcome) -> None:
    level = logging.INFO if outcome.status in ("landed", "relanded") else logging.WARNING
    log.log(
        level,
        "tape %s %s%s rows=%s bytes=%s%s",
        outcome.day,
        outcome.status,
        f" ({outcome.detail})" if outcome.detail else "",
        outcome.rows,
        outcome.bytes,
        f" reason: {outcome.reason}" if outcome.reason else "",
    )
    for warning in outcome.warnings:
        log.warning("tape %s: %s", outcome.day, warning)
