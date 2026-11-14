"""Per-minute pipeline line: flush timing, queue high-waters, loop lag, pool use.

When trades land in Neon late (24 to 44 s at every :x0 and :x5 minute on
2026-11-13) there are three suspects that look alike from outside: a slow Neon
write, an exhausted connection pool and a blocked event loop. This task writes
one ``uw-stream pipeline minute`` log line a minute that tells them apart.

Two loops share one ``_Sampled`` accumulator:

* The sampler wakes every ``SAMPLE_INTERVAL_S``. The time it actually slept,
  beyond what it asked for, is how long the event loop was unable to run it
  (loop lag). It also reads the DB pool's size and how much of it is checked
  out. Both are kept as per-minute maxima.
* The reporter sleeps to each UTC minute boundary, wall clock, so a line joins
  Neon's per-minute data, and logs. Per handler it gives the flush counts and
  times (``HandlerMetrics.flushes``, ``flush_rows``, ``flush_seconds``) as
  deltas since the last line, and the high-waters the handlers and the router
  keep (``interval_*``, ``State.receive_queue_hwm``) since the last line. Per
  shard it gives the frame counts, the widest gap between trade frames and the
  silences the connector's ``SocketStats`` counted in the minute
  (``interval_*``, see ``socket_stats``), under ``sockets``.

This task is the only thing that resets an interval field. ``_report`` reads
them all and builds the line, logs it, and only then moves the baselines and
sets the interval fields back to 0, in one block. It does not await, and every
writer runs on the same event loop, so nothing can raise a high-water mark
between the read and the reset. A report that fails before the reset consumes
nothing, and its minute folds into the next line. The cumulative counters are
never reset: /metrics shows them.

A minute with no activity still logs, with an empty ``handlers``: the line is
also the heartbeat, and it shows loop lag through the quiet hours. There is no
final pass on cancel; the next deploy's first line starts a fresh interval.

Diagnostics must never take the ingest daemon down. ``main`` treats the death of
any background task as fatal (it restarts the container and drops every socket),
so each loop guards one pass: a sample or a report that raises is logged, at
error level and rate limited, and the loop carries on. Only a cancel ends it.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import db
import socket_stats
from logger_setup import log, rate_limited_log
from state import HandlerMetrics, state

# Loop-lag and pool sampler period.
SAMPLE_INTERVAL_S = 0.25
# A lag sample at or over this counts in ``loop_lag_over_1s``.
LOOP_LAG_FLAG_S = 1.0


@dataclass
class _Sampled:
    """The sampler's maxima since the last line; ``_report`` resets them.

    The pool fields stay None until the pool has been read, so a line can tell
    "never sampled" from "sampled, and nothing was in use".
    """

    loop_lag_max_s: float = 0.0
    loop_lag_over_1s: int = 0
    pool_size_max: int | None = None
    pool_in_use_max: int | None = None

    def record_lag(self, elapsed_s: float) -> None:
        """Record one wake-up that took ``elapsed_s`` for a sleep of SAMPLE_INTERVAL_S.

        A wake a hair before its time (timer granularity) gives a negative lag.
        That counts as 0: the maximum starts at 0 and the flag is positive.
        """
        lag = elapsed_s - SAMPLE_INTERVAL_S
        self.loop_lag_max_s = max(self.loop_lag_max_s, lag)
        if lag >= LOOP_LAG_FLAG_S:
            self.loop_lag_over_1s += 1

    def record_pool(self) -> None:
        """Record the pool's size and checked-out connections; nothing if it has no pool.

        ``db.get_pool`` raises RuntimeError before ``init_pool`` and again after
        ``close_pool``. Both are expected, so the sampler skips the sample.
        """
        try:
            pool = db.get_pool()
        except RuntimeError:
            return
        size = pool.get_size()
        in_use = size - pool.get_idle_size()
        self.pool_size_max = size if self.pool_size_max is None else max(self.pool_size_max, size)
        self.pool_in_use_max = (
            in_use if self.pool_in_use_max is None else max(self.pool_in_use_max, in_use)
        )

    def reset(self) -> None:
        self.loop_lag_max_s = 0.0
        self.loop_lag_over_1s = 0
        self.pool_size_max = None
        self.pool_in_use_max = None


@dataclass
class _Baseline:
    """One handler's cumulative counters as of the last line, so each line gives the delta."""

    flushes: int = 0
    flush_rows: int = 0
    flush_seconds: float = 0.0
    dropped: int = 0
    filtered: int = 0


@dataclass
class _Reported:
    """What earlier lines already counted."""

    # Keyed by handler name: bounded by the closed set of handlers built at boot.
    handlers: dict[str, _Baseline] = field(default_factory=dict)
    receive_drops: int = 0


def _next_minute(now: datetime) -> datetime:
    """The first UTC minute boundary after ``now``; a whole minute on a boundary."""
    return now.replace(second=0, microsecond=0) + timedelta(minutes=1)


def _handler_entry(metrics: HandlerMetrics, base: _Baseline) -> dict[str, int | float]:
    """One handler's numbers for the minute: deltas of the totals, plus its interval fields."""
    return {
        "flushes": metrics.flushes - base.flushes,
        "rows": metrics.flush_rows - base.flush_rows,
        "flush_s": round(metrics.flush_seconds - base.flush_seconds, 3),
        "flush_max_s": round(metrics.interval_flush_max_s, 3),
        "batch_max": metrics.interval_batch_max,
        "queue_hwm": metrics.interval_queue_hwm,
        "dropped": metrics.drop_count - base.dropped,
        "filtered": metrics.filtered - base.filtered,
    }


def _had_activity(entry: dict[str, int | float]) -> bool:
    """Any flush, any queue depth, or a new drop or filtered payload."""
    return (
        entry["flushes"] > 0
        or entry["queue_hwm"] > 0
        or entry["dropped"] > 0
        or entry["filtered"] > 0
    )


def _socket_entry(stats: socket_stats.SocketStats) -> dict[str, int | float]:
    """One shard's numbers for the minute: its interval fields, the gap rounded."""
    return {
        "frames": stats.interval_frames,
        "trade_frames": stats.interval_trade_frames,
        "max_trade_gap_s": round(stats.interval_max_trade_gap_s, 3),
        "silences": stats.interval_silences,
    }


def _report(sampled: _Sampled, reported: _Reported, minute_start: datetime) -> None:
    """Log the line for the minute that began at ``minute_start``, then consume what it read.

    Synchronous on purpose: see the module docstring. It runs in three steps:

    1. Build the whole line and the new baselines, changing nothing.
    2. Log the line.
    3. Apply every baseline update and reset, in one block.

    So a failure in step 1 or 2 consumes nothing, and everything folds into the
    next line. Every handler's baseline moves each time, so ``reported.handlers``
    holds one entry per handler.
    """
    handlers: dict[str, dict[str, int | float]] = {}
    baselines: dict[str, _Baseline] = {}
    for name, metrics in state.handlers.items():
        entry = _handler_entry(metrics, reported.handlers.get(name, _Baseline()))
        if _had_activity(entry):
            handlers[name] = entry
        baselines[name] = _Baseline(
            flushes=metrics.flushes,
            flush_rows=metrics.flush_rows,
            flush_seconds=metrics.flush_seconds,
            dropped=metrics.drop_count,
            filtered=metrics.filtered,
        )
    # Every registered shard is listed, idle or not: a shard missing from the line
    # would read as "no data" where its zeros say "nothing arrived".
    shard_stats = socket_stats.all_stats()
    sockets = {name: _socket_entry(stats) for name, stats in shard_stats.items()}

    log.info(
        "uw-stream pipeline minute",
        extra={
            "minute_utc": minute_start.isoformat(),
            "loop_lag_max_s": round(sampled.loop_lag_max_s, 3),
            "loop_lag_over_1s": sampled.loop_lag_over_1s,
            "pool_size_max": sampled.pool_size_max,
            "pool_in_use_max": sampled.pool_in_use_max,
            "receive_queue_hwm": state.receive_queue_hwm,
            "receive_queue_dropped": state.receive_queue_drops - reported.receive_drops,
            "handlers": handlers,
            "sockets": sockets,
        },
    )

    # Nothing below can raise or await: attribute stores and a dict update.
    reported.handlers.update(baselines)
    for metrics in state.handlers.values():
        metrics.interval_flush_max_s = 0.0
        metrics.interval_batch_max = 0
        metrics.interval_queue_hwm = 0
    for stats in shard_stats.values():
        stats.interval_frames = 0
        stats.interval_trade_frames = 0
        stats.interval_max_trade_gap_s = 0.0
        stats.interval_silences = 0
    reported.receive_drops = state.receive_queue_drops
    state.receive_queue_hwm = 0
    sampled.reset()


def _log_failed_pass(kind: str, exc: Exception) -> None:
    """Log a sample or report pass that raised.

    Error level, so a diagnostics bug is not silent. Rate limited per kind: the
    sampler runs four times a second and would otherwise log four errors a
    second for as long as it kept failing.
    """
    rate_limited_log.error(
        scope="pipeline_stats",
        kind=kind,
        message=f"pipeline stats {kind} failed",
        extra={"err_type": type(exc).__name__, "err": str(exc)},
    )


async def _run_sampler(sampled: _Sampled) -> None:
    """Sample loop lag and pool use every SAMPLE_INTERVAL_S, forever.

    A sample that raises is logged and skipped. The guard is ``except
    Exception``, so a cancel (a BaseException) still ends the loop. It does not
    cover the sleep, where a cancel arrives.
    """
    while True:
        started = time.monotonic()
        await asyncio.sleep(SAMPLE_INTERVAL_S)
        try:
            sampled.record_lag(time.monotonic() - started)
            sampled.record_pool()
        except Exception as exc:
            _log_failed_pass("sample", exc)


async def _run_reporter(sampled: _Sampled, reported: _Reported) -> None:
    """Log one line at every UTC minute boundary, forever.

    The minute a line names comes from the boundary it waited for, not from the
    clock when it woke. asyncio's timers run on the monotonic clock and the
    boundary is wall clock, so a sleep can end a little early: the inner loop
    sleeps the remainder rather than reporting the same minute twice. If the
    loop is blocked past a boundary the line comes late and a minute label is
    missing; the lag numbers on that line say why.

    One zero-second sleep comes between the wait and the report. If the loop
    was blocked across the boundary, this timer and the sampler's have both
    expired and this task may wake first; the sampler's wake-up, which carries
    the stall's lag, is already queued behind it. Yielding once lets it run, so
    the lag lands on the line for the minute that just ended, not on the next
    one's. The yield stays out of ``_report``, which must not await.

    A report that raises is logged and the loop moves on to the next boundary.
    ``_report`` consumes nothing until its line is logged, so a failed pass
    leaves every baseline and interval field as it was, and the next line
    carries both minutes. Nothing here retries or waits on the failed pass, so
    one failure cannot hold up the minutes after it.
    """
    now = datetime.now(UTC)
    while True:
        boundary = _next_minute(now)
        while now < boundary:
            await asyncio.sleep((boundary - now).total_seconds())
            now = datetime.now(UTC)
        await asyncio.sleep(0)
        try:
            _report(sampled, reported, boundary - timedelta(minutes=1))
        except Exception as exc:
            _log_failed_pass("report", exc)


async def run_pipeline_stats() -> None:
    """Run the sampler and the reporter until cancelled.

    A TaskGroup, so a cancel stops both. A TaskGroup also cancels one child when
    the other raises, but neither loop raises: each guards its own pass (see
    ``_run_sampler`` and ``_run_reporter``), so the group never sees an exception
    and one loop's failure cannot stop the other. What is left unguarded is
    stdlib clock arithmetic and the sleeps, which raise only a cancel.
    """
    sampled = _Sampled()
    reported = _Reported()
    async with asyncio.TaskGroup() as group:
        group.create_task(_run_sampler(sampled), name="pipeline_stats:sampler")
        group.create_task(_run_reporter(sampled, reported), name="pipeline_stats:reporter")
