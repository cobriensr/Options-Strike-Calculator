"""Per-minute pipeline line, event-loop lag and DB pool use (pipeline diagnostics, Task 3).

On 2026-11-13 trades landed 24 to 44 s late at every :x0 and :x5 minute. A slow
Neon write, an exhausted pool and a blocked event loop all look the same from
the outside. ``run_pipeline_stats`` writes one log line a minute that tells them
apart: per-handler flush timing, the receive and handler queue high-waters, the
longest the loop stalled, and how much of the pool was in use.

Two loops share one ``_Sampled`` accumulator. The sampler wakes every
``SAMPLE_INTERVAL_S`` and records loop lag and pool use. The reporter sleeps to
each UTC minute boundary and logs. Each test replaces the clock, the sleep or
the pool at the module boundary (``monkeypatch.setattr(pipeline_stats, ...)``,
``patch("db.get_pool")``), the way test_drop_reporter.py and test_flush_stats.py
do, and ends the loop with a CancelledError from the scripted sleep.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import pipeline_stats
from logger_setup import RateLimitedLogger
from pipeline_stats import (
    LOOP_LAG_FLAG_S,
    SAMPLE_INTERVAL_S,
    _next_minute,
    _Reported,
    _run_reporter,
    _run_sampler,
    _Sampled,
    run_pipeline_stats,
)
from state import State

_MESSAGE = "uw-stream pipeline minute"
_SAMPLE_FAILED = "pipeline stats sample failed"
_REPORT_FAILED = "pipeline stats report failed"


@pytest.fixture
def fresh(monkeypatch) -> State:
    """A fresh State in place of the module singleton, so no test shares counters."""
    s = State()
    monkeypatch.setattr(pipeline_stats, "state", s)
    return s


@pytest.fixture
def lines(monkeypatch) -> list[tuple[str, dict]]:
    """Every ``log.info`` the module makes, as (message, extra).

    The project logger sets ``propagate=False``, so ``caplog`` never sees it.
    """
    out: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        pipeline_stats.log, "info", lambda msg, *_a, **kw: out.append((msg, kw["extra"]))
    )
    return out


@pytest.fixture
def errors(monkeypatch) -> list[tuple[str, dict]]:
    """Every error the module logs through ``rate_limited_log``, as (message, extra).

    A fresh limiter per test: the module-level one keeps its windows for the
    whole process, so an error logged by an earlier test would silence the first
    error of this one.
    """
    out: list[tuple[str, dict]] = []
    monkeypatch.setattr(pipeline_stats, "rate_limited_log", RateLimitedLogger())
    monkeypatch.setattr(
        pipeline_stats.log, "error", lambda msg, *_a, **kw: out.append((msg, kw["extra"]))
    )
    return out


class _FakePool:
    """The two asyncpg.Pool methods the sampler reads."""

    def __init__(self, size: int = 0, idle: int = 0) -> None:
        self.size = size
        self.idle = idle

    def get_size(self) -> int:
        return self.size

    def get_idle_size(self) -> int:
        return self.idle


def _script_sleep(monkeypatch, steps: list[Callable[[], None]]) -> list[float]:
    """Replace asyncio.sleep: call N runs ``steps[N]``; the call after the last raises
    CancelledError, which ends the loop. Returns the requested durations.
    """
    sleeps: list[float] = []

    async def _sleep(seconds: float) -> None:
        sleeps.append(seconds)
        i = len(sleeps) - 1
        if i >= len(steps):
            raise asyncio.CancelledError()
        steps[i]()

    monkeypatch.setattr(pipeline_stats.asyncio, "sleep", _sleep)
    return sleeps


def _script_monotonic(monkeypatch, *ticks: float) -> None:
    """Make pipeline_stats read these monotonic values, one per call.

    Replaces only this module's ``time`` name, so asyncio's own clock is untouched.
    """
    values = iter(ticks)
    monkeypatch.setattr(pipeline_stats, "time", SimpleNamespace(monotonic=lambda: next(values)))


def _script_wall_clock(monkeypatch, *nows: datetime) -> None:
    """Make ``datetime.now(UTC)`` in pipeline_stats return these values, one per call."""
    values = iter(nows)

    class _FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return next(values)

    monkeypatch.setattr(pipeline_stats, "datetime", _FakeDatetime)


def _noop() -> None:
    return None


def _noop_step(_s: State) -> None:
    return None


# ----------------------------------------------------------------------
# Sampler: loop lag
# ----------------------------------------------------------------------


async def test_loop_lag_is_the_elapsed_time_beyond_the_sample_interval(monkeypatch):
    # One (start, end) pair per sample, then the start of the sample the script
    # cancels. Exact binary fractions, so the lag arithmetic has no float noise
    # and the 1.0 s case lands on the flag exactly. Each sample's lag:
    #   0.5 -> 0.25    0.25 -> 0.0    1.25 -> 1.0 (flagged)
    #   0.125 -> woke early, floored at 0
    #   2.25 -> 2.0 (flagged)    1.0 -> 0.75 (just under the flag)
    _script_monotonic(
        monkeypatch,
        0.0,
        0.5,
        0.5,
        0.75,
        0.75,
        2.0,
        2.0,
        2.125,
        2.125,
        4.375,
        4.375,
        5.375,
        5.375,
    )
    sleeps = _script_sleep(monkeypatch, [_noop] * 6)
    sampled = _Sampled()

    with (
        patch("db.get_pool", side_effect=RuntimeError("Pool not initialized")),
        pytest.raises(asyncio.CancelledError),
    ):
        await _run_sampler(sampled)

    assert (SAMPLE_INTERVAL_S, LOOP_LAG_FLAG_S) == (0.25, 1.0)
    assert sleeps == [SAMPLE_INTERVAL_S] * 7
    assert sampled.loop_lag_max_s == 2.0
    assert sampled.loop_lag_over_1s == 2  # 1.0 counts (at or over), 0.75 does not


async def test_an_early_wake_is_not_negative_lag(monkeypatch):
    _script_monotonic(monkeypatch, 0.0, 0.125, 0.125)
    _script_sleep(monkeypatch, [_noop])
    sampled = _Sampled()

    with (
        patch("db.get_pool", side_effect=RuntimeError("Pool not initialized")),
        pytest.raises(asyncio.CancelledError),
    ):
        await _run_sampler(sampled)

    assert sampled.loop_lag_max_s == 0.0
    assert sampled.loop_lag_over_1s == 0


# ----------------------------------------------------------------------
# Sampler: pool use
# ----------------------------------------------------------------------


async def test_pool_size_and_in_use_keep_independent_maxima(monkeypatch):
    pool = _FakePool()

    def _sample(size: int, idle: int) -> Callable[[], None]:
        def _apply() -> None:
            pool.size, pool.idle = size, idle

        return _apply

    # The sampler reads the pool after each sleep: in use is 2, then 4, then 0.
    _script_sleep(monkeypatch, [_sample(10, 8), _sample(4, 0), _sample(6, 6)])
    sampled = _Sampled()

    with patch("db.get_pool", return_value=pool), pytest.raises(asyncio.CancelledError):
        await _run_sampler(sampled)

    assert sampled.pool_size_max == 10  # from the first sample
    assert sampled.pool_in_use_max == 4  # from the second: size - idle


async def test_an_uninitialized_pool_records_nothing_and_never_stops_the_sampler(
    monkeypatch, errors
):
    # db.get_pool raises RuntimeError until init_pool has run. The lag samples
    # must still be taken, and the pool fields must stay None (not 0, which would
    # read as "pool seen, nothing in use"). It is an expected state, not a failed
    # pass, so nothing is logged as an error.
    _script_monotonic(monkeypatch, 0.0, 1.25, 1.25, 1.5, 1.5, 1.75, 1.75)
    sleeps = _script_sleep(monkeypatch, [_noop] * 3)
    sampled = _Sampled()

    with (
        patch(
            "db.get_pool",
            side_effect=RuntimeError("Pool not initialized. Call init_pool() first."),
        ),
        pytest.raises(asyncio.CancelledError),
    ):
        await _run_sampler(sampled)

    assert len(sleeps) == 4  # it kept sampling after the first RuntimeError
    assert sampled.pool_size_max is None
    assert sampled.pool_in_use_max is None
    assert sampled.loop_lag_max_s == 1.0
    assert sampled.loop_lag_over_1s == 1
    assert errors == []


async def test_a_pool_closed_mid_run_keeps_the_earlier_maxima(monkeypatch, errors):
    # Shutdown's close_pool sets the pool back to None: get_pool raises again.
    _script_sleep(monkeypatch, [_noop, _noop])
    sampled = _Sampled()
    pool = _FakePool(size=7, idle=3)

    with (
        patch("db.get_pool", side_effect=[pool, RuntimeError("Pool not initialized")]),
        pytest.raises(asyncio.CancelledError),
    ):
        await _run_sampler(sampled)

    assert (sampled.pool_size_max, sampled.pool_in_use_max) == (7, 4)
    assert errors == []


# ----------------------------------------------------------------------
# Minute alignment
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("now", "boundary"),
    [
        # Mid-minute: the next minute starts in 39.5 s.
        (
            datetime(2026, 11, 13, 12, 34, 20, 500_000, tzinfo=UTC),
            datetime(2026, 11, 13, 12, 35, tzinfo=UTC),
        ),
        # Exactly on a boundary: the next one, a whole minute away, not this one.
        (datetime(2026, 11, 13, 12, 34, tzinfo=UTC), datetime(2026, 11, 13, 12, 35, tzinfo=UTC)),
        # One microsecond before a boundary.
        (
            datetime(2026, 11, 13, 12, 34, 59, 999_999, tzinfo=UTC),
            datetime(2026, 11, 13, 12, 35, tzinfo=UTC),
        ),
        # Across the hour and the day.
        (datetime(2026, 11, 13, 12, 59, 30, tzinfo=UTC), datetime(2026, 11, 13, 13, 0, tzinfo=UTC)),
        (datetime(2026, 11, 13, 23, 59, 30, tzinfo=UTC), datetime(2026, 11, 14, 0, 0, tzinfo=UTC)),
    ],
)
def test_next_minute_is_the_first_boundary_after_now(now, boundary):
    assert _next_minute(now) == boundary


async def _drive_reporter(
    monkeypatch,
    fresh: State,
    steps: list[Callable[[State], None]],
    sampled: _Sampled | None = None,
    reported: _Reported | None = None,
) -> tuple[list[float], _Sampled, _Reported]:
    """Run the reporter through ``len(steps)`` minute boundaries, 12:35 onward.

    It starts at 12:34:30, so the first line reports 12:34. ``steps[i]`` runs
    during the i-th sleep to a boundary, before that boundary's report. After
    each boundary the reporter makes one zero-second sleep (its yield to the
    sampler, see ``_run_reporter``): the script gives it a no-op step, and the
    returned sleeps list shows it as a 0.0. The sleep after the last step raises
    CancelledError.
    """
    nows = [datetime(2026, 11, 13, 12, 34, 30, tzinfo=UTC)] + [
        datetime(2026, 11, 13, 12, 35 + k, 0, 1_000, tzinfo=UTC) for k in range(len(steps))
    ]
    _script_wall_clock(monkeypatch, *nows)
    scripted: list[Callable[[], None]] = []
    for step in steps:
        scripted.append(lambda step=step: step(fresh))
        scripted.append(_noop)
    sleeps = _script_sleep(monkeypatch, scripted)
    sampled = _Sampled() if sampled is None else sampled
    reported = _Reported() if reported is None else reported
    with pytest.raises(asyncio.CancelledError):
        await _run_reporter(sampled, reported)
    return sleeps, sampled, reported


async def test_the_reporter_sleeps_to_each_boundary_and_labels_the_minute_it_ended(
    monkeypatch, fresh, lines
):
    sleeps, _, _ = await _drive_reporter(monkeypatch, fresh, [lambda _s: None, lambda _s: None])

    # 12:34:30 -> 12:35:00 is 30 s. After each boundary comes the reporter's
    # zero-second yield. The next sleep starts at 12:35:00.001 and runs to
    # 12:36:00. The last sleep is the one the script cancels.
    assert sleeps == pytest.approx([30.0, 0.0, 59.999, 0.0, 59.999])
    assert [extra["minute_utc"] for _msg, extra in lines] == [
        "2026-11-13T12:34:00+00:00",
        "2026-11-13T12:35:00+00:00",
    ]
    assert {msg for msg, _extra in lines} == {_MESSAGE}


async def test_waking_before_the_boundary_sleeps_the_remainder_instead_of_reporting_twice(
    monkeypatch, fresh, lines
):
    # asyncio's timers run on the monotonic clock and the boundary is wall
    # clock, so a sleep can end a fraction of a millisecond before it. Reporting
    # on that wake would send a second line for the same minute.
    _script_wall_clock(
        monkeypatch,
        datetime(2026, 11, 13, 12, 34, 20, tzinfo=UTC),
        datetime(2026, 11, 13, 12, 34, 59, 999_600, tzinfo=UTC),  # woke 0.4 ms early
        datetime(2026, 11, 13, 12, 35, 0, 100, tzinfo=UTC),
    )
    sleeps = _script_sleep(monkeypatch, [_noop, _noop, _noop])

    with pytest.raises(asyncio.CancelledError):
        await _run_reporter(_Sampled(), _Reported())

    # The short sleep, then the one zero-second yield before the single report.
    assert sleeps == pytest.approx([40.0, 0.0004, 0.0, 59.9999])
    assert [extra["minute_utc"] for _msg, extra in lines] == ["2026-11-13T12:34:00+00:00"]


async def test_the_reporter_yields_once_after_the_boundary_so_the_sampler_runs_first(
    monkeypatch, lines
):
    # When a stall spans a boundary, the reporter's timer and the sampler's both
    # expire, and the reporter can wake first. The sampler's wake-up, which holds
    # the stall's lag, is already queued behind it. One zero-second sleep before
    # the report lets it run: here the sampler records 1.5 s of lag during it.
    _script_wall_clock(
        monkeypatch,
        datetime(2026, 11, 13, 12, 34, 30, tzinfo=UTC),
        datetime(2026, 11, 13, 12, 35, 0, 1_000, tzinfo=UTC),
    )
    sampled = _Sampled()
    sleeps = _script_sleep(monkeypatch, [_noop, lambda: sampled.record_lag(1.75)])

    with pytest.raises(asyncio.CancelledError):
        await _run_reporter(sampled, _Reported())

    assert sleeps == pytest.approx([30.0, 0.0, 59.999])
    assert len(lines) == 1
    assert lines[0][1]["minute_utc"] == "2026-11-13T12:34:00+00:00"
    assert lines[0][1]["loop_lag_max_s"] == 1.5
    assert lines[0][1]["loop_lag_over_1s"] == 1


async def test_a_stall_across_a_boundary_is_attributed_to_the_minute_that_just_ended(
    monkeypatch, fresh, lines
):
    # Real tasks and real timers. Both timers are armed, the reporter's due 20 ms
    # out and the sampler's 50 ms out, and then the loop is blocked for 300 ms, so
    # both expire inside the stall with the reporter's first in line. Without the
    # reporter's yield it logs 12:34 before the sampler can record the stall, and
    # the lag lands on the next minute's line.
    monkeypatch.setattr(pipeline_stats, "SAMPLE_INTERVAL_S", 0.05)
    monkeypatch.setattr(pipeline_stats, "LOOP_LAG_FLAG_S", 0.2)
    _script_wall_clock(
        monkeypatch,
        datetime(2026, 11, 13, 12, 34, 59, 980_000, tzinfo=UTC),
        datetime(2026, 11, 13, 12, 35, 0, 1_000, tzinfo=UTC),
    )
    sampled = _Sampled()
    before = asyncio.all_tasks()

    sampler = asyncio.create_task(_run_sampler(sampled))
    reporter = asyncio.create_task(_run_reporter(sampled, _Reported()))
    await asyncio.sleep(0)  # both tasks start and arm their timers
    time.sleep(0.3)  # the stall: nothing else runs on the loop meanwhile
    async with asyncio.timeout(5):
        while not lines:
            await asyncio.sleep(0.005)
    sampler.cancel()
    reporter.cancel()
    await asyncio.gather(sampler, reporter, return_exceptions=True)

    extra = lines[0][1]
    assert extra["minute_utc"] == "2026-11-13T12:34:00+00:00"
    assert extra["loop_lag_max_s"] >= 0.2  # 300 ms stall minus the 50 ms sleep
    assert extra["loop_lag_over_1s"] == 1  # the flag is 0.2 s in this test
    assert asyncio.all_tasks() == before


# ----------------------------------------------------------------------
# The line: fields, deltas, reset, idle handlers
# ----------------------------------------------------------------------


def _set(name: str, **fields) -> Callable[[State], None]:
    """Set cumulative totals or interval fields on one handler's metrics."""

    def _apply(s: State) -> None:
        metrics = s.handler(name)
        for key, value in fields.items():
            setattr(metrics, key, value)

    return _apply


def _receive(*, hwm: int, drops: int) -> Callable[[State], None]:
    def _apply(s: State) -> None:
        s.receive_queue_hwm = hwm
        s.receive_queue_drops = drops

    return _apply


def _together(*appliers: Callable[[State], None]) -> Callable[[State], None]:
    def _apply(s: State) -> None:
        for applier in appliers:
            applier(s)

    return _apply


_BUSY_MINUTE = _together(
    _set(
        "option_trades",
        flushes=3,
        flush_rows=1_500,
        flush_seconds=1.23456,
        interval_flush_max_s=0.8004,
        interval_batch_max=600,
        interval_queue_hwm=900,
        drop_count=2,
    ),
    _receive(hwm=1_234, drops=5),
)


async def test_the_line_carries_every_documented_field(monkeypatch, fresh, lines):
    sampled = _Sampled(
        loop_lag_max_s=0.31234, loop_lag_over_1s=1, pool_size_max=10, pool_in_use_max=7
    )

    await _drive_reporter(monkeypatch, fresh, [_BUSY_MINUTE], sampled=sampled)

    assert lines == [
        (
            _MESSAGE,
            {
                "minute_utc": "2026-11-13T12:34:00+00:00",
                "loop_lag_max_s": 0.312,
                "loop_lag_over_1s": 1,
                "pool_size_max": 10,
                "pool_in_use_max": 7,
                "receive_queue_hwm": 1_234,
                "receive_queue_dropped": 5,
                "handlers": {
                    "option_trades": {
                        "flushes": 3,
                        "rows": 1_500,
                        "flush_s": 1.235,
                        "flush_max_s": 0.8,
                        "batch_max": 600,
                        "queue_hwm": 900,
                        "dropped": 2,
                        "filtered": 0,
                    }
                },
            },
        )
    ]


async def test_an_unsampled_pool_is_none_in_the_line_not_zero(monkeypatch, fresh, lines):
    await _drive_reporter(monkeypatch, fresh, [_noop_step])

    extra = lines[0][1]
    assert extra["pool_size_max"] is None
    assert extra["pool_in_use_max"] is None


async def test_the_second_line_reports_deltas_not_running_totals(monkeypatch, fresh, lines):
    second_minute = _together(
        _set(
            "option_trades",
            flushes=5,
            flush_rows=2_200,
            flush_seconds=1.73456,
            interval_flush_max_s=0.25,
            interval_batch_max=400,
            interval_queue_hwm=120,
            drop_count=3,
            filtered=4,
        ),
        _receive(hwm=77, drops=8),
    )

    await _drive_reporter(monkeypatch, fresh, [_BUSY_MINUTE, second_minute])

    extra = lines[1][1]
    assert extra["receive_queue_hwm"] == 77
    assert extra["receive_queue_dropped"] == 3  # 8 total - 5 already reported
    assert extra["handlers"]["option_trades"] == {
        "flushes": 2,  # 5 - 3
        "rows": 700,  # 2,200 - 1,500
        "flush_s": 0.5,  # 1.73456 - 1.23456
        "flush_max_s": 0.25,
        "batch_max": 400,
        "queue_hwm": 120,
        "dropped": 1,  # 3 - 2
        "filtered": 4,  # 4 - 0
    }


async def test_a_report_resets_every_interval_field_it_read(monkeypatch, fresh, lines):
    sampled = _Sampled(loop_lag_max_s=2.5, loop_lag_over_1s=3, pool_size_max=10, pool_in_use_max=10)

    _, sampled, _ = await _drive_reporter(
        monkeypatch, fresh, [_BUSY_MINUTE, _noop_step], sampled=sampled
    )

    metrics = fresh.handler("option_trades")
    assert (metrics.interval_flush_max_s, metrics.interval_batch_max) == (0.0, 0)
    assert metrics.interval_queue_hwm == 0
    assert fresh.receive_queue_hwm == 0
    assert sampled == _Sampled()
    # The cumulative counters are not reset: /metrics keeps the running totals.
    assert (metrics.flushes, metrics.flush_rows, metrics.drop_count) == (3, 1_500, 2)
    assert fresh.receive_queue_drops == 5
    # And the line after it starts from zero.
    assert lines[1][1]["loop_lag_max_s"] == 0.0
    assert lines[1][1]["loop_lag_over_1s"] == 0
    assert lines[1][1]["pool_size_max"] is None
    assert lines[1][1]["receive_queue_hwm"] == 0


async def test_a_quiet_minute_still_emits_a_line_with_no_handlers(monkeypatch, fresh, lines):
    # The line is also the heartbeat: it shows the loop was alive overnight.
    await _drive_reporter(monkeypatch, fresh, [_BUSY_MINUTE, _noop_step, _noop_step])

    assert len(lines) == 3
    for _msg, extra in lines[1:]:
        assert extra["handlers"] == {}
        assert extra["receive_queue_dropped"] == 0
        assert extra["receive_queue_hwm"] == 0


async def test_a_minute_with_nothing_registered_still_reports_the_loop_lag(
    monkeypatch, fresh, lines
):
    # Overnight, with every handler idle, the lag numbers are the whole point of the line.
    sampled = _Sampled(loop_lag_max_s=0.4, loop_lag_over_1s=0, pool_size_max=2, pool_in_use_max=0)

    await _drive_reporter(monkeypatch, fresh, [_noop_step], sampled=sampled)

    assert len(lines) == 1
    extra = lines[0][1]
    assert extra["handlers"] == {}
    assert extra["loop_lag_max_s"] == 0.4
    assert (extra["pool_size_max"], extra["pool_in_use_max"]) == (2, 0)


async def test_only_handlers_with_activity_are_listed(monkeypatch, fresh, lines):
    minute = _together(
        _set("idle"),  # registered, nothing happened
        _set("queue_only", interval_queue_hwm=3),
        _set("drop_only", drop_count=2),
        _set("filtered_only", filtered=6),
        _set("flush_only", flushes=1, flush_rows=10, flush_seconds=0.01, interval_batch_max=10),
    )

    await _drive_reporter(monkeypatch, fresh, [minute, _noop_step])

    assert set(lines[0][1]["handlers"]) == {
        "queue_only",
        "drop_only",
        "filtered_only",
        "flush_only",
    }
    # Their cumulative totals stay above zero, but nothing changed in the next
    # minute, so none of them is listed again.
    assert lines[1][1]["handlers"] == {}


async def test_a_handler_first_seen_after_the_first_report_starts_from_zero(
    monkeypatch, fresh, lines
):
    await _drive_reporter(
        monkeypatch,
        fresh,
        [_noop_step, _set("late", flushes=4, flush_rows=40, drop_count=1)],
    )

    assert lines[0][1]["handlers"] == {}
    assert lines[1][1]["handlers"]["late"]["flushes"] == 4
    assert lines[1][1]["handlers"]["late"]["rows"] == 40
    assert lines[1][1]["handlers"]["late"]["dropped"] == 1


async def test_the_baselines_hold_one_entry_per_handler_however_many_minutes_pass(
    monkeypatch, fresh, lines
):
    steps = [_together(_set("a", flushes=1), _set("b"))] + [
        _set("a", flushes=n) for n in range(2, 8)
    ]

    _, _, reported = await _drive_reporter(monkeypatch, fresh, steps)

    assert len(lines) == 7
    assert set(reported.handlers) == {"a", "b"}


# ----------------------------------------------------------------------
# run_pipeline_stats: both loops, one accumulator, clean cancel
# ----------------------------------------------------------------------


async def test_run_pipeline_stats_reports_what_the_sampler_saw_and_cancels_cleanly(
    monkeypatch, fresh, lines
):
    # Real tasks and real timers, with the sample period cut to 10 ms and the
    # wall clock pinned 50 ms before a minute boundary, so the first line comes
    # after about five samples. The sampler's first timer is due before the
    # reporter's, so at least one sample is in the accumulator when it reports.
    monkeypatch.setattr(pipeline_stats, "SAMPLE_INTERVAL_S", 0.01)
    _script_wall_clock(
        monkeypatch,
        datetime(2026, 11, 13, 12, 34, 59, 950_000, tzinfo=UTC),
        datetime(2026, 11, 13, 12, 35, 0, 1_000, tzinfo=UTC),
    )
    before = asyncio.all_tasks()

    with patch("db.get_pool", return_value=_FakePool(size=6, idle=2)):
        task = asyncio.create_task(run_pipeline_stats())
        async with asyncio.timeout(5):
            while not lines:
                await asyncio.sleep(0.005)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    extra = lines[0][1]
    assert extra["minute_utc"] == "2026-11-13T12:34:00+00:00"
    assert extra["pool_size_max"] == 6
    assert extra["pool_in_use_max"] == 4
    assert task.cancelled()
    assert asyncio.all_tasks() == before  # the sampler and the reporter went with it


# ----------------------------------------------------------------------
# Failures: a bad pass is logged and the loop carries on; only a cancel ends it
# ----------------------------------------------------------------------
#
# main treats the death of any background task as fatal and restarts the
# container, so a bug in a diagnostics pass must not end its loop.


async def test_a_sample_that_raises_is_logged_and_sampling_continues(monkeypatch, errors):
    pool = _FakePool(size=5, idle=1)
    sleeps = _script_sleep(monkeypatch, [_noop] * 3)
    sampled = _Sampled()

    # An error that is not the expected "pool not initialized" RuntimeError.
    with (
        patch("db.get_pool", side_effect=[ValueError("pool state corrupt"), pool, pool]),
        pytest.raises(asyncio.CancelledError),
    ):
        await _run_sampler(sampled)

    assert errors == [
        (
            _SAMPLE_FAILED,
            {
                "scope": "pipeline_stats",
                "kind": "sample",
                "err_type": "ValueError",
                "err": "pool state corrupt",
            },
        )
    ]
    assert len(sleeps) == 4  # it went on to take the next three samples
    assert (sampled.pool_size_max, sampled.pool_in_use_max) == (5, 4)


async def test_a_sampler_that_keeps_failing_logs_once_per_window_not_four_times_a_second(
    monkeypatch, errors
):
    sleeps = _script_sleep(monkeypatch, [_noop] * 6)

    with (
        patch("db.get_pool", side_effect=ValueError("still broken")),
        pytest.raises(asyncio.CancelledError),
    ):
        await _run_sampler(_Sampled())

    assert len(sleeps) == 7  # six failed samples, and the loop never stopped
    assert [msg for msg, _extra in errors] == [_SAMPLE_FAILED]


async def test_a_report_that_raises_is_logged_and_the_next_minute_still_reports(
    monkeypatch, fresh, errors
):
    delivered: list[dict] = []
    attempts: list[None] = []

    def _info_that_fails_once(_msg, *_a, **kw) -> None:
        attempts.append(None)
        if len(attempts) == 1:
            raise OSError("stdout closed")
        delivered.append(kw["extra"])

    monkeypatch.setattr(pipeline_stats.log, "info", _info_that_fails_once)
    sampled = _Sampled(loop_lag_max_s=0.5, loop_lag_over_1s=1, pool_size_max=10, pool_in_use_max=6)
    # The second minute adds to the cumulative totals only, so every interval
    # value in the delivered line can only have come from the minute whose line
    # failed.
    second_minute = _together(
        _set("option_trades", flushes=5, flush_rows=2_200, flush_seconds=1.73456, drop_count=3),
        lambda s: setattr(s, "receive_queue_drops", 8),
    )

    sleeps, sampled, _ = await _drive_reporter(
        monkeypatch, fresh, [_BUSY_MINUTE, second_minute], sampled=sampled
    )

    assert errors == [
        (
            _REPORT_FAILED,
            {
                "scope": "pipeline_stats",
                "kind": "report",
                "err_type": "OSError",
                "err": "stdout closed",
            },
        )
    ]
    # The failed pass consumed nothing, so the next line carries both minutes:
    # the deltas of the totals (3 + 2 flushes, 5 + 3 receive drops) and the
    # high-waters and maxima the first minute set.
    assert delivered == [
        {
            "minute_utc": "2026-11-13T12:35:00+00:00",
            "loop_lag_max_s": 0.5,
            "loop_lag_over_1s": 1,
            "pool_size_max": 10,
            "pool_in_use_max": 6,
            "receive_queue_hwm": 1_234,
            "receive_queue_dropped": 8,
            "handlers": {
                "option_trades": {
                    "flushes": 5,
                    "rows": 2_200,
                    "flush_s": 1.735,
                    "flush_max_s": 0.8,
                    "batch_max": 600,
                    "queue_hwm": 900,
                    "dropped": 3,
                    "filtered": 0,
                }
            },
        }
    ]
    # That line is the one that consumes: the pass after it starts from zero.
    assert sampled == _Sampled()
    assert fresh.handler("option_trades").interval_queue_hwm == 0
    assert fresh.receive_queue_hwm == 0
    assert len(sleeps) == 5  # two boundaries, a yield after each, and the third sleep


async def test_a_reporter_that_keeps_failing_still_reaches_every_boundary(
    monkeypatch, fresh, errors
):
    def _info_always_fails(*_a, **_kw) -> None:
        raise OSError("stdout closed")

    monkeypatch.setattr(pipeline_stats.log, "info", _info_always_fails)

    sleeps, _, _ = await _drive_reporter(monkeypatch, fresh, [_noop_step] * 3)

    # Three failed reports, each after a boundary and its yield, and a sleep to a fourth.
    assert len(sleeps) == 7
    assert [msg for msg, _extra in errors] == [_REPORT_FAILED]  # once per window


async def test_a_cancel_inside_a_sample_ends_the_sampler_instead_of_being_logged(
    monkeypatch, errors
):
    # A cancel is a BaseException, not an Exception: the guard must let it through.
    sleeps = _script_sleep(monkeypatch, [_noop] * 3)

    with (
        patch("db.get_pool", side_effect=asyncio.CancelledError()),
        pytest.raises(asyncio.CancelledError),
    ):
        await _run_sampler(_Sampled())

    assert len(sleeps) == 1  # it ended at the first sample
    assert errors == []


async def test_a_cancel_inside_a_report_ends_the_reporter_instead_of_being_logged(
    monkeypatch, fresh, errors
):
    def _info_is_cancelled(*_a, **_kw) -> None:
        raise asyncio.CancelledError()

    monkeypatch.setattr(pipeline_stats.log, "info", _info_is_cancelled)

    sleeps, _, _ = await _drive_reporter(monkeypatch, fresh, [_noop_step] * 3)

    assert len(sleeps) == 2  # it ended at the first report: the boundary and its yield
    assert errors == []


async def test_a_failing_sampler_does_not_stop_the_reporter_or_the_task(
    monkeypatch, fresh, lines, errors
):
    # Real tasks, as in the test above. The sampler fails on every pass; the
    # TaskGroup must not read that as a crash and cancel the reporter.
    monkeypatch.setattr(pipeline_stats, "SAMPLE_INTERVAL_S", 0.01)
    _script_wall_clock(
        monkeypatch,
        datetime(2026, 11, 13, 12, 34, 59, 950_000, tzinfo=UTC),
        datetime(2026, 11, 13, 12, 35, 0, 1_000, tzinfo=UTC),
    )
    before = asyncio.all_tasks()

    with patch("db.get_pool", side_effect=ValueError("pool state corrupt")):
        task = asyncio.create_task(run_pipeline_stats())
        async with asyncio.timeout(5):
            while not lines:
                await asyncio.sleep(0.005)
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert lines[0][1]["minute_utc"] == "2026-11-13T12:34:00+00:00"
    assert [msg for msg, _extra in errors] == [_SAMPLE_FAILED]
    assert asyncio.all_tasks() == before
