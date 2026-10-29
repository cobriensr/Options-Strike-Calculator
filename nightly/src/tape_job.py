"""Plan, land and re-land Full Tape days in R2, one day at a time.

A run lists R2 once and plans the newest missing trading days, up to CATCHUP_MAX_DAYS.
It probes the newest few landed days for an upstream rewrite, then works through the
plan followed by the rewritten days. Each day downloads, converts and uploads inside
its own work dir, which is removed whatever happens.

Failure isolation (review finding b6): each day catches `Exception`, so one bad day
never stops the rest. A BaseException that isn't an Exception (KeyboardInterrupt,
SystemExit) still propagates, after the day's work dir is removed.

`DayOutcome.detail` reaches Sentry, so it holds only an error kind, an exception class
name or a fixed phrase: never exception text, a URL, a key or any tape value. Logs
follow the same rule, except that a TapeDownloadError's `detail` is logged, since
uw_client builds it to be log-safe.
"""

from __future__ import annotations

import logging
import traceback
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from pathlib import Path
from shutil import disk_usage, rmtree
from time import monotonic
from typing import Literal

from calendar_nyse import last_completed_session, trading_days
from config import Settings
from constants import (
    CATCHUP_MAX_DAYS,
    MIN_FREE_DISK_BYTES,
    REWRITE_RECHECK_DAYS,
    RUN_DEADLINE_SECONDS,
    SCHEMA_VERSION,
    TAPE_START,
    UNAVAILABLE_AGE_TRADING_DAYS,
    WORK_DIR,
)
from r2_store import R2Store
from tape_convert import ConvertResult, convert_zip, plausibility_warnings
from uw_client import SourceInfo, TapeDownloadError, download_tape, probe_source

log = logging.getLogger(__name__)

DayStatus = Literal[
    "landed", "relanded", "not_posted", "unavailable", "failed", "skipped_disk", "skipped_deadline"
]

# The row-count check compares against the median of this many landed days before the
# target: the trailing-20 window PLAUSIBLE_MIN_ROW_RATIO was tuned on.
_TRAILING_DAYS = 20
_SKIPPED_DISK = "free disk below the minimum"
_SKIPPED_DEADLINE = "run deadline passed"
_SRC_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class DayOutcome:
    """What happened to one day. ``detail`` is a kind, a class name or a fixed phrase
    (empty on success); ``bytes`` is the uploaded Parquet's size."""

    day: date
    status: DayStatus
    detail: str = ""
    rows: int | None = None
    warnings: tuple[str, ...] = ()
    bytes: int | None = None


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
    landed: Mapping[date, Mapping[str, str]], api_key: str, last_session: date
) -> list[date]:
    """Of the newest REWRITE_RECHECK_DAYS landed days (up to `last_session`) that carry
    a `source-etag`, those whose upstream ETag has since changed, newest first.

    A day whose probe fails or returns no ETag can't be compared, so it is skipped
    with a warning log; the next run checks it again.
    """
    etagged = sorted(
        (d for d, meta in landed.items() if d <= last_session and meta.get("source-etag")),
        reverse=True,
    )[:REWRITE_RECHECK_DAYS]
    changed: list[date] = []
    for day in etagged:
        try:
            etag = probe_source(day, api_key).etag
        except Exception as exc:
            log.warning("rewrite check %s skipped: probe failed (%s)", day, _error_name(exc))
            continue
        if etag is None:
            log.warning("rewrite check %s skipped: probe returned no ETag", day)
        elif etag != landed[day]["source-etag"]:
            changed.append(day)
    return changed


def land_day(
    day: date,
    store: R2Store,
    api_key: str,
    trailing_rows: list[int],
    relanding_etag: str | None = None,
    *,
    last_session: date,
) -> DayOutcome:
    """Download, convert and upload one day, in WORK_DIR/<day>, removed afterwards.

    With `relanding_etag` (the landed object's source ETag), the current object is
    first copied aside with `supersede`; if that fails, nothing is downloaded or put.
    A not-posted day at least UNAVAILABLE_AGE_TRADING_DAYS sessions before
    `last_session`, or one outside UW's window, is marked unavailable, except on a
    re-land, which never marks a landed day.
    """
    work = WORK_DIR / day.isoformat()
    try:
        outcome = _attempt(day, work, store, api_key, trailing_rows, relanding_etag, last_session)
    finally:
        # Logged here so an interrupted day's failed cleanup is still on record.
        cleanup_error = _remove(work)
        if cleanup_error is not None:
            log.warning("tape %s: work dir cleanup failed (%s)", day, cleanup_error)
    if cleanup_error is not None:
        warning = f"work dir cleanup failed ({cleanup_error})"
        outcome = replace(outcome, warnings=(*outcome.warnings, warning))
    return outcome


def run_tape(settings: Settings, now_utc: datetime) -> list[DayOutcome]:
    """Land the planned days, then re-land rewritten ones; one outcome per day.

    Before each day it checks the run deadline and free disk in WORK_DIR. Failing
    either marks that day and every later one skipped. The deadline is only checked
    between days, so one slow day can overrun it by its own duration.

    An error listing R2 at the start propagates: with no listing, no day can be
    planned, so there is no per-day outcome to report it in.
    """
    deadline = monotonic() + RUN_DEADLINE_SECONDS
    last_session = last_completed_session(now_utc)
    api_key = settings.uw_api_key.get_secret_value()
    store = R2Store(settings)
    landed = store.landed()
    planned = plan_days(set(landed), store.unavailable(), last_session)
    relands = rewritten_days(landed, api_key, last_session)
    queue: list[tuple[date, str | None]] = [(d, None) for d in planned]
    queue += [(d, landed[d]["source-etag"]) for d in relands]
    log.info(
        "tape run: last session %s, %d planned, %d to re-land",
        last_session,
        len(planned),
        len(relands),
    )
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    outcomes: list[DayOutcome] = []
    for i, (day, relanding_etag) in enumerate(queue):
        skip = _skip_status(deadline)
        if skip is not None:
            status, detail = skip
            outcomes += [DayOutcome(d, status, detail) for d, _ in queue[i:]]
            log.warning("tape run: %s; %d day(s) skipped", detail, len(queue) - i)
            break
        trailing = _trailing_rows(landed, day)
        outcome = land_day(day, store, api_key, trailing, relanding_etag, last_session=last_session)
        if outcome.rows is not None:  # landed or relanded: later days' trailing window
            landed[day] = {"rows": str(outcome.rows)}
        _log_outcome(outcome)
        outcomes.append(outcome)
    return outcomes


def _attempt(
    day: date,
    work: Path,
    store: R2Store,
    api_key: str,
    trailing_rows: list[int],
    relanding_etag: str | None,
    last_session: date,
) -> DayOutcome:
    """The day's outcome. Every Exception becomes one; only BaseException escapes."""
    try:
        try:
            return _land(day, work, store, api_key, trailing_rows, relanding_etag)
        except TapeDownloadError as exc:
            return _download_failed(day, exc, store, relanding_etag, last_session)
    except Exception as exc:
        log.warning("tape %s failed: %s at %s", day, type(exc).__name__, _raised_at(exc))
        return DayOutcome(day, "failed", type(exc).__name__)


def _land(
    day: date,
    work: Path,
    store: R2Store,
    api_key: str,
    trailing_rows: list[int],
    relanding_etag: str | None,
) -> DayOutcome:
    if relanding_etag is not None:
        store.supersede(day, relanding_etag)
    work.mkdir(parents=True, exist_ok=True)
    zip_path = work / f"{day.isoformat()}-fulltape.zip"
    out_path = work / f"{day.isoformat()}-fulltape.parquet"
    source = download_tape(day, zip_path, api_key)
    ingested_at = datetime.now(UTC)
    result = convert_zip(zip_path, out_path, day, ingested_at)
    warnings = plausibility_warnings(
        result.rows, trailing_rows, result.min_executed_at, result.max_executed_at, day
    )
    store.put_tape(out_path, day, _metadata(result, source, ingested_at))
    return DayOutcome(
        day,
        "landed" if relanding_etag is None else "relanded",
        rows=result.rows,
        warnings=tuple(warnings),
        bytes=result.bytes,
    )


def _download_failed(
    day: date,
    exc: TapeDownloadError,
    store: R2Store,
    relanding_etag: str | None,
    last_session: date,
) -> DayOutcome:
    log.warning("tape %s download: %s (%s)", day, exc.kind, exc.detail)
    if relanding_etag is not None:
        return DayOutcome(day, "failed", exc.kind)
    sessions_since = sum(1 for d in trading_days(day, last_session) if d > day)
    old = sessions_since >= UNAVAILABLE_AGE_TRADING_DAYS
    if exc.kind == "outside_window" or (exc.kind == "not_posted" and old):
        store.mark_unavailable(day, f"{exc.kind}: {exc.detail}")
        return DayOutcome(day, "unavailable", exc.kind)
    if exc.kind == "not_posted":
        return DayOutcome(day, "not_posted", exc.kind)
    return DayOutcome(day, "failed", exc.kind)


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


def _trailing_rows(landed: Mapping[date, Mapping[str, str]], day: date) -> list[int]:
    """`rows` of the nearest _TRAILING_DAYS landed days before `day`, newest first.

    Legacy days carry no metadata, so they take a slot but add no value.
    """
    nearest = sorted((d for d in landed if d < day), reverse=True)[:_TRAILING_DAYS]
    counts = (landed[d].get("rows", "") for d in nearest)
    return [int(c) for c in counts if c.isdecimal()]


def _skip_status(deadline: float) -> tuple[DayStatus, str] | None:
    if monotonic() >= deadline:
        return "skipped_deadline", _SKIPPED_DEADLINE
    free = disk_usage(WORK_DIR).free
    if free < MIN_FREE_DISK_BYTES:
        log.warning("tape run: %d bytes free, need %d", free, MIN_FREE_DISK_BYTES)
        return "skipped_disk", _SKIPPED_DISK
    return None


def _remove(work: Path) -> str | None:
    """Delete the day's work dir; the error class name if that fails, else None.

    It runs in a `finally`, so it must not raise: that would replace an exception
    already propagating, such as a KeyboardInterrupt.
    """
    try:
        rmtree(work, ignore_errors=False)
    except FileNotFoundError:
        pass  # nothing was created (an early failure, or a supersede that failed)
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
        "tape %s %s%s rows=%s bytes=%s",
        outcome.day,
        outcome.status,
        f" ({outcome.detail})" if outcome.detail else "",
        outcome.rows,
        outcome.bytes,
    )
    for warning in outcome.warnings:
        log.warning("tape %s: %s", outcome.day, warning)
