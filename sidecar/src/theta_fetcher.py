"""Nightly EOD ingest orchestrator for Theta Data.

Pulls option-chain EOD rows from the co-resident Theta Terminal
(see theta_launcher.py) via theta_client and upserts them into
the theta_option_eod table (migration #70).

Two entry points:

  - ``run_nightly()``  — daily at 17:25 America/New_York via APScheduler.
                          Pulls prior trading day's EOD for every
                          configured root.
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
"""

from __future__ import annotations

import threading
import time
from datetime import date, timedelta
from typing import Any

import db
from config import settings
from logger_setup import log
from sentry_setup import capture_exception, capture_message
from theta_client import EodRow, ThetaClient, ThetaSubscriptionError

# Expiration horizon. Past window catches late settlements / corrections;
# future window covers all listed chains (SPXW goes out to ~1y forward).
EXP_HORIZON_PAST_DAYS = 7
EXP_HORIZON_FUTURE_DAYS = 180

# Memory bound for the batch buffer — tuples of 15 fields × 500 rows is
# still small (~1MB) but avoids pathological growth on large backfills.
BATCH_FLUSH_SIZE = 500

# If a job runs longer than this we fire a Sentry warning — the nightly
# should complete well inside 30min in steady state.
MAX_JOB_DURATION_S = 30 * 60

# Module-level scheduler handle (stopped via shutdown()). APScheduler's
# BackgroundScheduler runs jobs in its own thread pool, so this doesn't
# block the sidecar's main Databento loop.
_scheduler: Any = None  # apscheduler.BackgroundScheduler | None
_scheduler_lock = threading.Lock()


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
    import theta_launcher

    if not theta_launcher.is_running():
        log.info("Theta Terminal not running — scheduler disabled")
        return False

    with _scheduler_lock:
        if _scheduler is not None:
            return True

        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger

        _scheduler = BackgroundScheduler(timezone="America/New_York")
        _scheduler.add_job(
            run_nightly,
            CronTrigger(hour=17, minute=25),
            id="theta_nightly_eod",
            max_instances=1,
            # coalesce=True: if we miss a fire (container restart), run
            # once when we come back up rather than stacking multiple
            # pending jobs.
            coalesce=True,
        )
        _scheduler.start()
        log.info(
            "Theta scheduler started: nightly job at 17:25 America/New_York"
        )
    return True


def stop_scheduler() -> None:
    """Stop APScheduler. Called from the sidecar's shutdown handler."""
    global _scheduler
    with _scheduler_lock:
        if _scheduler is not None:
            try:
                _scheduler.shutdown(wait=False)
            except Exception as exc:
                log.debug("theta scheduler shutdown failed: %s", exc)
            _scheduler = None


def run_nightly() -> None:
    """Fetch prior trading day's EOD for every configured root.

    APScheduler calls this at 17:25 ET. Raises on unexpected failure
    so APScheduler logs + Sentry both record it; local callers should
    already be inside a try/except wrapper.
    """
    start = time.time()
    trade_day = _prior_trading_day(date.today())
    log.info("Theta nightly ingest starting (trade_day=%s)", trade_day)

    client = ThetaClient()
    total = 0
    try:
        for root in settings.theta_roots_list:
            total += _fetch_root_range(client, root, trade_day, trade_day)
    except Exception as exc:
        capture_exception(
            exc,
            context={
                "phase": "theta_nightly",
                "trade_day": trade_day.isoformat(),
                "rows_so_far": total,
            },
        )
        raise

    elapsed = time.time() - start
    log.info("Theta nightly complete: %d rows in %.1fs", total, elapsed)
    if elapsed > MAX_JOB_DURATION_S:
        capture_message(
            "Theta nightly job exceeded max duration",
            level="warning",
            context={
                "elapsed_s": round(elapsed, 1),
                "rows_written": total,
            },
        )


def run_backfill_if_needed() -> None:
    """One-time backfill for roots with no existing data.

    Meant to run once in a background daemon thread at startup. Safe
    to call multiple times — each root short-circuits when its
    theta_option_eod rows already exist.
    """
    trade_day_end = _prior_trading_day(date.today())
    trade_day_start = trade_day_end - timedelta(
        days=settings.theta_backfill_days
    )

    client = ThetaClient()
    for root in settings.theta_roots_list:
        try:
            if db.has_theta_option_eod_rows(root):
                log.info(
                    "Theta backfill skipping %s (data already present)", root
                )
                continue
            log.info(
                "Theta backfill starting: root=%s range=[%s, %s]",
                root,
                trade_day_start,
                trade_day_end,
            )
            count = _fetch_root_range(
                client, root, trade_day_start, trade_day_end
            )
            log.info("Theta backfill complete for %s: %d rows", root, count)
        except Exception as exc:
            # Log + Sentry but continue to the next root. One bad root
            # should never block the others.
            capture_exception(
                exc, context={"phase": "theta_backfill", "root": root}
            )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _fetch_root_range(
    client: ThetaClient,
    root: str,
    start_date: date,
    end_date: date,
) -> int:
    """Fetch and upsert every contract × day in the range for one root.

    Returns the total rows written. Never raises for per-contract
    failures — those go to Sentry and the loop continues. A
    ThetaSubscriptionError terminates the root early since that's a
    persistent condition, not a transient blip.
    """
    try:
        expirations = client.list_expirations(root)
    except ThetaSubscriptionError:
        capture_message(
            "Theta denied list_expirations — skipping root",
            level="error",
            context={"root": root},
        )
        return 0

    active = [
        e
        for e in expirations
        if start_date - timedelta(days=EXP_HORIZON_PAST_DAYS)
        <= e
        <= end_date + timedelta(days=EXP_HORIZON_FUTURE_DAYS)
    ]

    total = 0
    for exp in active:
        try:
            strikes = client.list_strikes(root, exp)
        except Exception as exc:
            capture_exception(
                exc,
                context={
                    "phase": "list_strikes",
                    "root": root,
                    "expiration": exp.isoformat(),
                },
            )
            continue

        rows_batch: list[EodRow] = []
        root_denied = False

        for strike in strikes:
            if root_denied:
                break
            for opt_type in ("C", "P"):
                try:
                    rows = client.fetch_eod(
                        root, exp, strike, opt_type, start_date, end_date
                    )
                except ThetaSubscriptionError:
                    capture_message(
                        "Theta denied fetch_eod — skipping root",
                        level="error",
                        context={
                            "root": root,
                            "expiration": exp.isoformat(),
                        },
                    )
                    root_denied = True
                    break
                except Exception as exc:
                    capture_exception(
                        exc,
                        context={
                            "phase": "fetch_eod",
                            "root": root,
                            "expiration": exp.isoformat(),
                            "strike": str(strike),
                            "right": opt_type,
                        },
                    )
                    continue

                rows_batch.extend(rows)
                if len(rows_batch) >= BATCH_FLUSH_SIZE:
                    total += _flush_batch(rows_batch)
                    rows_batch = []

        if rows_batch:
            total += _flush_batch(rows_batch)

        if root_denied:
            # Stop processing this root entirely — subscription denials
            # are persistent, not per-contract.
            return total

    return total


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
