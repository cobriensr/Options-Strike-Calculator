"""Nightly EOD ingest orchestrator for Theta Data.

Pulls option-chain EOD rows from the co-resident Theta Terminal
(see theta_launcher.py) via theta_client and upserts them into
the theta_option_eod table (migration #70).

Two entry points:

  - ``run_nightly()``  — daily at 17:25 America/New_York via APScheduler.
                          Pulls prior trading day's EOD for every
                          configured root. Roots are independent: a root
                          that fails is captured, classified, and the
                          loop moves on; the run raises a single
                          ThetaNightlyRootsFailedError at the end.
  - ``run_backfill_if_needed()`` — fired once from main.py startup in a
                          background thread. For every root with an
                          empty theta_option_eod, pulls the last
                          THETA_BACKFILL_DAYS of EOD history.

Both paths short-circuit without raising when Theta's HTTP server
isn't up, when credentials are missing, or when a root returns a
subscription-denied response — the sidecar's Databento relay must
continue to run independently. Every unexpected exception is captured
via sentry_setup.capture_exception for visibility.

Design notes:
  - Per-contract iteration, NOT bulk: the free tier doesn't expose
    /v2/bulk_hist endpoints. Nightly loop shape is
    ``root × expiration × strike × {C,P}``, one fetch each. Slow but
    unbounded by subscription.
  - Idempotent via ``ON CONFLICT DO UPDATE`` (see db.upsert_theta_option_eod_batch).
  - Batch flushes every 500 rows to bound memory on the Railway container.
  - NOT resumable. The nightly is a ~100 minute per-contract crawl, and
    nothing re-attempts a trade day it did not finish: a container
    restart mid-run (deploy, watchdog exit, Railway platform event)
    leaves a permanent hole, because ``run_backfill_if_needed`` only
    fires for roots whose table is entirely EMPTY. Two such holes exist
    (trade dates 2026-08-18 and 2026-08-19, SPXW-only). Per-root
    isolation below bounds in-process failures; it cannot bound a
    process death. A gap-repair pass is the open follow-up.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import sentry_sdk

import db
from config import settings
from logger_setup import log
from sentry_setup import capture_exception, capture_message
from theta_client import EodRow, ThetaClient, ThetaSubscriptionError

# Sentry tags applied to every Theta-sourced event so operators can
# filter this feature independently from Databento / the Vercel backend.
_THETA_TAGS = {"component": "theta"}

# Per-root outcome statuses for one nightly pass. "wrote nothing" and
# "blew up" are deliberately separate: on trade dates 2026-08-18 and
# 2026-08-19 the nightly landed SPXW only, and the absence of VIX /
# VIXW / NDXP rows was indistinguishable from those roots legitimately
# having no data. See ThetaNightlyRootsFailedError.
ROOT_OK = "ok"
ROOT_NO_DATA = "no_data"
ROOT_ERROR = "error"

# Sentry cron monitor for the nightly job. The monitor is declared IN
# CODE via `monitor_config` on the @sentry_sdk.monitor decorator (Sentry
# upserts the Monitor from the first check-in that carries a config), so
# the schedule ships with the sidecar instead of living only in the UI.
#
# The crontab MUST match the APScheduler trigger in start_scheduler():
# 17:25 America/New_York (= 21:25Z during EDT, 22:25Z during EST — hence
# the explicit IANA zone rather than a UTC crontab, which would drift by
# an hour across DST). Sentry pages when no in-progress check-in arrives
# within `checkin_margin` minutes of 17:25 ET, and marks the run failed
# when it hasn't finished within `max_runtime` minutes. max_runtime is
# kept equal to MAX_JOB_DURATION_S below so Sentry's "timed out" and our
# own "exceeded max duration" warning agree on what "too slow" means.
_NIGHTLY_MONITOR_SLUG = "theta-nightly-eod"
_NIGHTLY_MONITOR_CONFIG: dict[str, Any] = {
    "schedule": {"type": "crontab", "value": "25 17 * * *"},
    "timezone": "America/New_York",
    "checkin_margin": 10,  # minutes late before "missed"
    "max_runtime": 180,  # minutes running before "timed out"
    "failure_issue_threshold": 1,
    "recovery_threshold": 1,
}

# Expiration horizon. Expirations that expired before the fetch window
# start are skipped entirely — EOD for post-expiry trade dates is
# guaranteed NO_DATA (HTTP 472), so probing them wastes requests. The
# future window covers all listed chains (SPXW goes out to ~1y forward).
EXP_HORIZON_FUTURE_DAYS = 180

# Memory bound for the batch buffer — tuples of 15 fields × 500 rows is
# still small (~1MB) but avoids pathological growth on large backfills.
BATCH_FLUSH_SIZE = 500

# If a job runs longer than this we fire a Sentry warning. The per-contract
# (non-bulk) loop is slow: the 2026-08-18 nightly took ~99 min end to end
# (SPXW ~55 min + VIX/VIXW + NDXP ~25 min), so the old 30 min cap tripped
# on every healthy run. 3h leaves headroom above steady state while still
# flagging a stuck Terminal / runaway chain well before the next fire.
# Keep in sync with _NIGHTLY_MONITOR_CONFIG["max_runtime"] (minutes).
MAX_JOB_DURATION_S = 3 * 60 * 60

# Module-level scheduler handle (stopped via shutdown()). APScheduler's
# BackgroundScheduler runs jobs in its own thread pool, so this doesn't
# block the sidecar's main Databento loop.
_scheduler: Any = None  # apscheduler.BackgroundScheduler | None
_scheduler_lock = threading.Lock()


class ThetaNightlyRootsFailedError(RuntimeError):
    """Raised at the END of run_nightly when one or more roots failed.

    Deliberately raised after every configured root has been attempted,
    not at the first failure. Before 2026-08-21 the root loop lived
    inside a single try/except that re-raised immediately, so ONE
    exception anywhere in the first root silently dropped every root
    after it — which is exactly what produced the SPXW-only trade dates
    2026-08-18 and 2026-08-19 (VIX / VIXW / NDXP were never attempted,
    and nothing in the data said so).

    Still a RuntimeError so nothing downstream changes shape:
    APScheduler logs it, and the Sentry cron monitor (see
    _NIGHTLY_MONITOR_CONFIG) still marks the check-in failed. The
    message names every failed root so the alert is actionable without
    opening the logs.
    """


@dataclass(frozen=True)
class RootOutcome:
    """What one root did during one nightly pass.

    ``status`` is one of ROOT_OK / ROOT_NO_DATA / ROOT_ERROR. The
    no-data-vs-error split is the point of this type: a holiday, a
    delisted root and a crashed root all write zero rows, and the
    operator needs to tell them apart from the summary alone.

    Note: a Theta entitlement denial (HTTP 471) is absorbed inside
    :func:`_fetch_root_range`, which already emits its own
    "Theta denied ..." Sentry error, and surfaces here as ROOT_NO_DATA
    (or ROOT_OK for a mid-root denial that had already written rows).
    """

    root: str
    rows: int
    status: str
    error: str | None = None


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def start_scheduler() -> bool:
    """Start APScheduler with the nightly 17:25 ET job.

    Idempotent: a second call while the scheduler is already running
    is a no-op. Returns True when the scheduler was started or already
    running, False when Theta isn't up and we can't usefully run it.
    """
    global _scheduler

    # Late import: avoid hard circular between theta_launcher and
    # theta_fetcher during pytest collection.
    import theta_launcher  # noqa: PLC0415 — see comment

    if not theta_launcher.is_running():
        log.info("Theta Terminal not running — scheduler disabled")
        return False

    with _scheduler_lock:
        if _scheduler is not None:
            return True

        # Lazy: APScheduler is only needed once Theta is actually up.
        from apscheduler.schedulers.background import BackgroundScheduler  # noqa: PLC0415
        from apscheduler.triggers.cron import CronTrigger  # noqa: PLC0415

        _scheduler = BackgroundScheduler(timezone="America/New_York")
        _scheduler.add_job(
            run_nightly,
            # timezone MUST be on the trigger itself. The scheduler-level
            # default above only applies to triggers add_job builds from
            # kwargs; a pre-built CronTrigger freezes its zone at
            # construction — falling back to the container's local zone
            # (UTC on Railway) — and add_job never retrofits the default
            # (verified on apscheduler 3.11.3). Without this, the
            # "nightly" fired at 17:25 UTC = 1:25 PM ET and ran a
            # 2.1-hour EOD pull mid-session (observed 2026-08-17).
            CronTrigger(hour=17, minute=25, timezone="America/New_York"),
            id="theta_nightly_eod",
            max_instances=1,
            # coalesce=True: if we miss a fire (container restart), run
            # once when we come back up rather than stacking multiple
            # pending jobs.
            coalesce=True,
        )
        _scheduler.start()
        log.info("Theta scheduler started: nightly job at 17:25 America/New_York")
    return True


def stop_scheduler() -> None:
    """Stop APScheduler. Called from the sidecar's shutdown handler."""
    global _scheduler
    with _scheduler_lock:
        if _scheduler is not None:
            try:
                _scheduler.shutdown(wait=False)
            except Exception as exc:  # noqa: BLE001 — best-effort stop during shutdown
                log.debug("theta scheduler shutdown failed: %s", exc)
            _scheduler = None


@sentry_sdk.monitor(
    monitor_slug=_NIGHTLY_MONITOR_SLUG,
    monitor_config=_NIGHTLY_MONITOR_CONFIG,
)
def run_nightly() -> None:
    """Fetch prior trading day's EOD for every configured root.

    APScheduler calls this at 17:25 ET. Raises on unexpected failure
    so APScheduler logs + Sentry both record it; local callers should
    already be inside a try/except wrapper.

    The @sentry_sdk.monitor decorator sends an in-progress check-in
    on entry and ok/error on exit, each carrying _NIGHTLY_MONITOR_CONFIG
    so Sentry knows the expected schedule without UI setup. A missing
    check-in at the scheduled time (container crashed before 17:25 ET,
    Railway outage, scheduler dead) triggers a Sentry alert — this is
    the only signal for the "scheduler never fired" failure mode that
    exception-capture misses. When SENTRY_DSN is unset the decorator is
    a cheap no-op.

    Roots are INDEPENDENT: each one is attempted regardless of what its
    siblings did, and failures are aggregated into a single
    ThetaNightlyRootsFailedError raised once the loop is done. See that
    exception's docstring for the incident this shape prevents.
    """
    start = time.time()
    # DTZ011: local-clock date on purpose. The container runs in UTC and the
    # trigger fires at 17:25 ET, so the UTC and ET calendar dates agree at
    # fire time; pinning an explicit zone would shift trade_day for manual
    # late-evening runs, which is a behaviour change we do not want here.
    trade_day = _prior_trading_day(date.today())  # noqa: DTZ011
    log.info("Theta nightly ingest starting (trade_day=%s)", trade_day)

    client = ThetaClient()
    outcomes = [_run_root_nightly(client, root, trade_day) for root in settings.theta_roots_list]

    elapsed = time.time() - start
    _report_nightly_outcomes(outcomes, trade_day=trade_day, elapsed_s=elapsed)

    failed = [o for o in outcomes if o.status == ROOT_ERROR]
    if failed:
        detail = "; ".join(f"{o.root}: {o.error}" for o in failed)
        raise ThetaNightlyRootsFailedError(
            f"Theta nightly {trade_day.isoformat()}: "
            f"{len(failed)} of {len(outcomes)} roots failed — {detail}"
        )


def run_backfill_if_needed() -> None:
    """One-time backfill for roots with no existing data.

    Meant to run once in a background daemon thread at startup. Safe
    to call multiple times — each root short-circuits when its
    theta_option_eod rows already exist.
    """
    trade_day_end = _prior_trading_day(date.today())  # noqa: DTZ011 — see run_nightly
    trade_day_start = trade_day_end - timedelta(days=settings.theta_backfill_days)

    client = ThetaClient()
    for root in settings.theta_roots_list:
        try:
            if db.has_theta_option_eod_rows(root):
                log.info("Theta backfill skipping %s (data already present)", root)
                continue
            log.info(
                "Theta backfill starting: root=%s range=[%s, %s]",
                root,
                trade_day_start,
                trade_day_end,
            )
            count = _fetch_root_range(client, root, trade_day_start, trade_day_end)
            log.info("Theta backfill complete for %s: %d rows", root, count)
        except Exception as exc:  # noqa: BLE001 — see comment below
            # Log + Sentry but continue to the next root. One bad root
            # should never block the others.
            capture_exception(
                exc,
                context={"phase": "theta_backfill", "root": root},
                tags=_THETA_TAGS,
            )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _run_root_nightly(client: ThetaClient, root: str, trade_day: date) -> RootOutcome:
    """Fetch one root's EOD for `trade_day`, classified, never raising.

    Isolates the root: any ``Exception`` is captured to Sentry with the
    root in context and returned as ROOT_ERROR so the caller can move on
    to the next root. ``BaseException`` (KeyboardInterrupt, SystemExit)
    is deliberately NOT caught — a shutdown signal must stop the job, not
    be filed as a per-root data problem.

    Zero rows without an exception is ROOT_NO_DATA, not a failure: the
    prior trading day can be a market holiday (``_prior_trading_day`` is
    holiday-unaware by design) and a root can legitimately have nothing
    listed.
    """
    try:
        rows = _fetch_root_range(client, root, trade_day, trade_day)
    except Exception as exc:  # noqa: BLE001 — isolation is the point; captured below
        capture_exception(
            exc,
            context={
                "phase": "theta_nightly",
                "root": root,
                "trade_day": trade_day.isoformat(),
            },
            tags=_THETA_TAGS,
        )
        return RootOutcome(root=root, rows=0, status=ROOT_ERROR, error=str(exc))

    status = ROOT_OK if rows > 0 else ROOT_NO_DATA
    log.info("Theta nightly root %s: %d rows (%s)", root, rows, status)
    return RootOutcome(root=root, rows=rows, status=status)


def _report_nightly_outcomes(
    outcomes: list[RootOutcome],
    *,
    trade_day: date,
    elapsed_s: float,
) -> None:
    """Log the per-root summary and raise the two non-fatal Sentry alarms.

    Two things get their own warning because both are silent in the data:

      - roots that completed with zero rows (ROOT_NO_DATA). One event
        listing them all, not one per root — a market holiday empties
        every root at once and must not page four times.
      - a run that blew past MAX_JOB_DURATION_S.

    Failed roots are NOT alarmed here; each already went to Sentry with
    its own exception inside :func:`_run_root_nightly`, and the caller
    raises ThetaNightlyRootsFailedError so the cron monitor marks the run
    failed.
    """
    total = sum(o.rows for o in outcomes)
    summary = ", ".join(f"{o.root}={o.rows}/{o.status}" for o in outcomes)
    log.info(
        "Theta nightly complete: %d rows in %.1fs (trade_day=%s) [%s]",
        total,
        elapsed_s,
        trade_day,
        summary,
    )

    empty = [o.root for o in outcomes if o.status == ROOT_NO_DATA]
    if empty:
        capture_message(
            "Theta nightly: root(s) completed with no rows",
            level="warning",
            context={
                "trade_day": trade_day.isoformat(),
                "empty_roots": ",".join(empty),
                "summary": summary,
            },
            tags=_THETA_TAGS,
        )

    if elapsed_s > MAX_JOB_DURATION_S:
        capture_message(
            "Theta nightly job exceeded max duration",
            level="warning",
            context={
                "elapsed_s": round(elapsed_s, 1),
                "rows_written": total,
                "summary": summary,
            },
            tags=_THETA_TAGS,
        )


def _fetch_root_range(
    client: ThetaClient,
    root: str,
    start_date: date,
    end_date: date,
) -> int:
    """Fetch and upsert every contract × day in the range for one root.

    Returns the total rows written. Never raises for per-contract
    failures — those go to Sentry and the loop continues. A
    ThetaSubscriptionError (HTTP 471 entitlement denial) terminates the
    root early since that's a persistent condition, not a transient
    blip. Plain no-data responses (HTTP 472 / ":No data" body) are NOT
    denials — the client returns [] and the loop continues.
    """
    try:
        expirations = client.list_expirations(root)
    except ThetaSubscriptionError:
        capture_message(
            "Theta denied list_expirations — skipping root",
            level="error",
            context={"root": root},
            tags=_THETA_TAGS,
        )
        return 0

    # exp < start_date means the contract expired before the fetch
    # window opened — its data lies wholly outside [start_date,
    # end_date], and requesting post-expiry dates is guaranteed
    # NO_DATA. Skip those expirations entirely.
    active = [
        e
        for e in expirations
        if start_date <= e <= end_date + timedelta(days=EXP_HORIZON_FUTURE_DAYS)
    ]

    total = 0
    for exp in active:
        # Clamp the fetch range to the expiration — trade dates after
        # expiry are guaranteed NO_DATA, so never request past exp.
        exp_end_date = min(end_date, exp)
        try:
            strikes = client.list_strikes(root, exp)
        except Exception as exc:  # noqa: BLE001 — captured to Sentry; one bad expiry must not stop the chain
            capture_exception(
                exc,
                context={
                    "phase": "list_strikes",
                    "root": root,
                    "expiration": exp.isoformat(),
                },
                tags=_THETA_TAGS,
            )
            continue

        rows_batch: list[EodRow] = []
        root_denied = False

        for strike in strikes:
            pair_rows, denied = _fetch_strike_pair(
                client, root, exp, strike, start_date, exp_end_date
            )
            rows_batch.extend(pair_rows)
            if len(rows_batch) >= BATCH_FLUSH_SIZE:
                total += _flush_batch(rows_batch)
                rows_batch = []
            if denied:
                root_denied = True
                break

        if rows_batch:
            total += _flush_batch(rows_batch)

        if root_denied:
            # Stop processing this root entirely — subscription denials
            # are persistent, not per-contract.
            return total

    return total


def _fetch_strike_pair(
    client: ThetaClient,
    root: str,
    exp: date,
    strike: Any,
    start_date: date,
    end_date: date,
) -> tuple[list[EodRow], bool]:
    """Fetch EOD rows for one strike's call+put pair.

    Returns ``(rows, denied)`` where ``denied`` is True iff a
    ThetaSubscriptionError (HTTP 471) fired — the caller should mark
    the whole root denied and stop iterating its strikes. A no-data
    response (HTTP 472 / ":No data" body) surfaces as an empty fetch
    result, not an exception — it never trips ``denied``. Per-contract
    non-subscription errors are captured to Sentry and the loop
    continues onto the other side (C or P), matching the prior inline
    behavior.

    Extracted from `_fetch_root_range` so the per-contract retry/skip
    branches are unit-testable in isolation. The orchestrator now
    reads as a 2-deep ``exp × strike`` loop with one helper call per
    strike, instead of a 3-deep ``exp × strike × {C,P}`` loop with
    inline error handling.
    """
    rows: list[EodRow] = []
    for opt_type in ("C", "P"):
        try:
            fetched = client.fetch_eod(root, exp, strike, opt_type, start_date, end_date)
        except ThetaSubscriptionError:
            capture_message(
                "Theta denied fetch_eod — skipping root",
                level="error",
                context={
                    "root": root,
                    "expiration": exp.isoformat(),
                },
                tags=_THETA_TAGS,
            )
            return rows, True
        except Exception as exc:  # noqa: BLE001 — captured to Sentry; one bad contract must not stop the chain
            capture_exception(
                exc,
                context={
                    "phase": "fetch_eod",
                    "root": root,
                    "expiration": exp.isoformat(),
                    "strike": str(strike),
                    "right": opt_type,
                },
                tags=_THETA_TAGS,
            )
            continue

        rows.extend(fetched)

    return rows, False


def _flush_batch(rows: list[EodRow]) -> int:
    """Convert a batch of EodRows to tuples and upsert them."""
    if not rows:
        return 0
    tuples = [_row_to_tuple(r) for r in rows]
    db.upsert_theta_option_eod_batch(tuples)
    return len(rows)


def _row_to_tuple(r: EodRow) -> tuple:
    """Shape one EodRow for the db upsert's column order."""
    return (
        r.symbol,
        r.expiration,
        r.strike,
        r.option_type,
        r.trade_date,
        r.open,
        r.high,
        r.low,
        r.close,
        r.volume,
        r.trade_count,
        r.bid,
        r.ask,
        r.bid_size,
        r.ask_size,
    )


def _prior_trading_day(today: date) -> date:
    """Return the most recent weekday strictly before `today`.

    Holiday-unaware by design: Theta will return "No data" for a
    holiday Friday and the fetcher will log zero rows, which is the
    correct observable behavior. We don't ship a NYSE holiday
    calendar here — the cron_check-in in Sentry will surface real
    outages (missed fire), and intermittent holiday-zero days are
    expected.
    """
    d = today - timedelta(days=1)
    while d.weekday() >= 5:  # Saturday=5, Sunday=6
        d -= timedelta(days=1)
    return d
