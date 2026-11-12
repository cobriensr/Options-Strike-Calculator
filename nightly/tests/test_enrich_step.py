"""Tests for the enrichment step: the work set, the per-day loop, the stop rules and the result.

Everything below enrich_step is patched at its module boundary (R3): the two scripts'
`configure_archive`, `list_work_dates` and `enrich_one_date`, `open_reader`, `connect_db`
and `outcome_shares`. Nothing reaches a database, R2 or the network. The scripts keep their
archive configuration in module globals, so an autouse fixture starts every test
unconfigured and lets monkeypatch put the values back.

`night` records every call that matters for order in `night.events`. `clock` replaces the
monotonic clock `StepContext.seconds_left` reads, so a test spends run time by moving it.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from time import monotonic
from unittest.mock import DEFAULT, MagicMock, call, create_autospec

import _tape_reader
import enrich_lottery_outcomes
import enrich_silent_boom_outcomes
import psycopg2
import pytest
import sentry_sdk
from _tape_reader import FETCH_DEADLINE_SECONDS, TapeReader, TapeReadError

import enrich_step
import resources
import steps
from config import Settings, load_settings
from constants import (
    ENRICH_CACHE_DIR,
    ENRICH_DAY_BUDGET_SECONDS,
    ENRICH_MAX_DAY_FAILURES,
    ENRICH_UNPRICED_FLOOR,
    TAPE_START,
    WORK_DIR,
)
from monitoring import report_step
from outcome_check import OUTCOME_TABLES, DayShare, outcome_shares
from pipeline import STEPS
from steps import StepContext, StepOutcome, run_steps
from tape_job import DayOutcome

NIGHTLY_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = NIGHTLY_DIR.parent / "scripts"
NOW = datetime(2026, 11, 12, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 11)  # a Wednesday
DAYS = [
    date(2026, 11, 5),
    date(2026, 11, 6),
    date(2026, 11, 9),
    date(2026, 11, 10),
    date(2026, 11, 11),
]
LOTTERY = "lottery_finder_fires"
SILENT_BOOM = "silent_boom_alerts"
STEP_NAME = "enrich-outcomes"
FAILED_DETAIL = "a day failed or came back with no outcomes"
PARTIAL_DETAIL = "days left for the next night"
MISSING_MESSAGE = "landed tape missing from the enrich cache"

LotteryResult = enrich_lottery_outcomes.DayResult
SilentBoomResult = enrich_silent_boom_outcomes.DayResult
INVERSION_WORK = enrich_lottery_outcomes.INVERSION_WORK
# A day the old Vercel cron priced before the tape: the flow work set is only what it left.
LEFTOVERS = 430

COUNT_NAMES = {
    "days_processed",
    "days_waiting_tape",
    "days_left",
    "days_failed",
    "null_days",
    "unpriced_passes",
    "inversion_leftovers_unpriced",
    "low_days",
    "tape_markers_reset",
    "lottery_outcomes_written",
    "lottery_stamped_no_outcome",
    "lottery_inversion_written",
    "lottery_inversion_stamped",
    "lottery_inversion_input_missing",
    "lottery_outcomes_replaced",
    "lottery_outcomes_kept",
    "silent_boom_outcomes_written",
    "silent_boom_stamped_no_outcome",
    "silent_boom_outcomes_replaced",
    "silent_boom_outcomes_kept",
}


# --- harness --------------------------------------------------------------------------


@pytest.fixture
def settings() -> Settings:
    return load_settings()


@pytest.fixture(autouse=True)
def _unconfigured_scripts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both scripts as a fresh import leaves them (the Bot-EOD archive, no directory)."""
    for script in (enrich_lottery_outcomes, enrich_silent_boom_outcomes):
        monkeypatch.setattr(script, "PARQUET_DIR", None)
        monkeypatch.setattr(script, "PARQUET_FILE_PATTERN", script.PARQUET_FORMATS["trades"])
        monkeypatch.setattr(script, "SOURCE_TAG", script.ARCHIVE_SOURCES["trades"])


@dataclass
class Clock:
    now: float = 1_000.0

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(steps, "monotonic", lambda: fake.now)
    return fake


@pytest.fixture
def capture_message(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    mock = create_autospec(sentry_sdk.capture_message)
    monkeypatch.setattr(sentry_sdk, "capture_message", mock)
    return mock


@pytest.fixture
def capture_exception(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    mock = create_autospec(sentry_sdk.capture_exception)
    monkeypatch.setattr(sentry_sdk, "capture_exception", mock)
    return mock


@dataclass
class Night:
    """The patched boundary of enrich_step, and what it was asked, in order."""

    events: list[str]
    conn: MagicMock
    cursor: MagicMock
    connect: MagicMock
    reader: MagicMock
    open_reader: MagicMock
    configure_lottery: MagicMock
    configure_silent_boom: MagicMock
    list_lottery: MagicMock
    list_silent_boom: MagicMock
    enrich_lottery: MagicMock
    enrich_silent_boom: MagicMock
    shares: MagicMock
    # What a script returns, or raises, for one ISO date. Absent: an empty DayResult.
    lottery_results: dict[str, LotteryResult | BaseException] = field(default_factory=dict)
    silent_boom_results: dict[str, SilentBoomResult | BaseException] = field(default_factory=dict)
    # What outcome_shares returns for one day. Absent: both tables fully enriched.
    share_rows: dict[date, list[DayShare]] = field(default_factory=dict)
    # The fires of one ISO date outside the flow work set, which the day's count query returns.
    # Absent: none, a day nothing had resolved.
    resolved: dict[str, int] = field(default_factory=dict)

    def fresh_day(self, day: date) -> None:
        """A day no inversion was resolved on before the pass: the flow pass is judged."""
        self.resolved[day.isoformat()] = 0

    def leftover_day(self, day: date, resolved: int = 14_000) -> None:
        """A day something priced earlier: the flow work set holds only what it left."""
        self.resolved[day.isoformat()] = resolved

    def work(self, lottery: list[date], silent_boom: list[date] | None = None) -> None:
        """The days the two list_work_dates calls return (ascending ISO strings, as the real ones)."""
        self.list_lottery.return_value = [d.isoformat() for d in sorted(lottery)]
        self.list_silent_boom.return_value = [d.isoformat() for d in sorted(silent_boom or [])]

    def landed(self, days: list[date]) -> None:
        self.reader.landed_days.return_value = set(days)

    def null_share(self, day: date, table: str = LOTTERY) -> None:
        self.share_rows[day] = [DayShare(table, day, 40, 0)]

    def low_share(self, day: date, table: str = LOTTERY) -> None:
        self.share_rows[day] = [DayShare(table, day, 100, 90)]


def _healthy_shares(day: date) -> list[DayShare]:
    return [DayShare(LOTTERY, day, 100, 100), DayShare(SILENT_BOOM, day, 5, 5)]


def _is_resolved_count(sql: str) -> bool:
    """The day's count of fires outside the flow work set, as against the marker reset."""
    return "lottery_finder_fires" in sql and "NOT (" in sql


@pytest.fixture
def night(monkeypatch: pytest.MonkeyPatch) -> Night:
    events: list[str] = []
    conn = MagicMock(name="conn")
    cursor = MagicMock(name="cursor")
    cursor.fetchone.return_value = (0,)  # the marker reset's one summed count
    conn.cursor.return_value.__enter__.return_value = cursor

    @contextmanager
    def fake_connect(_settings: Settings):
        events.append("connect")
        try:
            yield conn
        finally:
            events.append("close")

    reader = create_autospec(TapeReader, instance=True)
    reader.__enter__.return_value = reader
    reader.__exit__.return_value = False  # a truthy exit would swallow the step's exceptions
    reader.landed_days.return_value = set(DAYS)
    reader.fetch_day.side_effect = lambda day, deadline=None: (
        events.append(f"fetch {day}") or Path(f"/cache/{day}-fulltape.parquet")
    )
    reader.release.side_effect = lambda day: events.append(f"release {day}")

    def fake_open_reader(_settings: Settings, _cache_dir: Path) -> MagicMock:
        events.append("open_reader")
        return reader

    n = Night(
        events=events,
        conn=conn,
        cursor=cursor,
        connect=create_autospec(resources.connect_db, side_effect=fake_connect),
        reader=reader,
        open_reader=create_autospec(resources.open_reader, side_effect=fake_open_reader),
        configure_lottery=create_autospec(
            enrich_lottery_outcomes.configure_archive,
            side_effect=lambda *_: events.append("configure lottery"),
        ),
        configure_silent_boom=create_autospec(
            enrich_silent_boom_outcomes.configure_archive,
            side_effect=lambda *_: events.append("configure silent_boom"),
        ),
        list_lottery=create_autospec(
            enrich_lottery_outcomes.list_work_dates,
            side_effect=lambda *_: events.append("list lottery") or n.list_lottery.return_value,
        ),
        list_silent_boom=create_autospec(
            enrich_silent_boom_outcomes.list_work_dates,
            side_effect=lambda *_: (
                events.append("list silent_boom") or n.list_silent_boom.return_value
            ),
        ),
        enrich_lottery=create_autospec(enrich_lottery_outcomes.enrich_one_date),
        enrich_silent_boom=create_autospec(enrich_silent_boom_outcomes.enrich_one_date),
        shares=create_autospec(outcome_shares),
    )
    n.list_lottery.return_value = []
    n.list_silent_boom.return_value = []

    def record_execute(sql: str, params: tuple[str] | None = None) -> None:
        if _is_resolved_count(sql):
            events.append(f"resolved {params[0] if params else None}")

    def answer_fetchone() -> object:
        sql, params = cursor.execute.call_args.args
        if _is_resolved_count(sql):
            return (n.resolved.get(params[0], 0),)
        return DEFAULT  # the marker reset's one summed count: `fetchone.return_value`

    cursor.execute.side_effect = record_execute
    cursor.fetchone.side_effect = answer_fetchone

    def enrich(kind: str, results: dict, empty):
        def run(_conn: MagicMock, iso: str, *_args: object, **_kwargs: object):
            events.append(f"{kind} {iso}")
            outcome = results.get(iso, empty())
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        return run

    n.enrich_lottery.side_effect = enrich("lottery", n.lottery_results, LotteryResult)
    n.enrich_silent_boom.side_effect = enrich(
        "silent_boom", n.silent_boom_results, SilentBoomResult
    )

    def shares_for(_conn: MagicMock, days: list[date]) -> list[DayShare]:
        events.append(f"shares {days[0]}")
        return n.share_rows.get(days[0], _healthy_shares(days[0]))

    n.shares.side_effect = shares_for

    monkeypatch.setattr(enrich_step, "connect_db", n.connect)
    monkeypatch.setattr(enrich_step, "open_reader", n.open_reader)
    monkeypatch.setattr(enrich_step, "configure_lottery_archive", n.configure_lottery)
    monkeypatch.setattr(enrich_step, "configure_silent_boom_archive", n.configure_silent_boom)
    monkeypatch.setattr(enrich_step, "list_lottery_work_dates", n.list_lottery)
    monkeypatch.setattr(enrich_step, "list_silent_boom_work_dates", n.list_silent_boom)
    monkeypatch.setattr(enrich_step, "enrich_lottery_day", n.enrich_lottery)
    monkeypatch.setattr(enrich_step, "enrich_silent_boom_day", n.enrich_silent_boom)
    monkeypatch.setattr(enrich_step, "outcome_shares", n.shares)
    return n


def _ctx(
    settings: Settings,
    clock: Clock,
    *,
    left: float = 100_000.0,
    tape: tuple[DayOutcome, ...] = (),
) -> StepContext:
    return StepContext(settings, NOW, LAST_SESSION, deadline=clock.now + left, tape=tape)


def _isos(events: list[str], prefix: str) -> list[str]:
    return [e.removeprefix(f"{prefix} ") for e in events if e.startswith(f"{prefix} ")]


# --- the day loop ---------------------------------------------------------------------


def test_days_run_newest_first_with_one_fetch_each(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # The two tables list different days; the work set is their union, each day once.
    night.work(lottery=[DAYS[0], DAYS[1]], silent_boom=[DAYS[1], DAYS[2]])

    result = enrich_step.run(_ctx(settings, clock))

    newest_first = [DAYS[2], DAYS[1], DAYS[0]]
    assert night.reader.fetch_day.call_args_list == [
        call(day, deadline=clock.now + FETCH_DEADLINE_SECONDS) for day in newest_first
    ]
    assert _isos(night.events, "lottery") == [d.isoformat() for d in newest_first]
    assert _isos(night.events, "silent_boom") == [d.isoformat() for d in newest_first]
    # Both tables are enriched on the tape's work set, whatever else a writer left.
    for enrich in (night.enrich_lottery, night.enrich_silent_boom):
        assert [c.kwargs for c in enrich.call_args_list] == [{"select": "all"}] * 3
        assert [c.args[1] for c in enrich.call_args_list] == [d.isoformat() for d in newest_first]
        assert all(c.args[0] is night.conn for c in enrich.call_args_list)
    assert night.reader.release.call_args_list == [call(day) for day in newest_first]
    assert result.status == "ok"
    assert result.counts["days_processed"] == 3


def test_release_runs_even_when_an_enrich_raises(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.work(lottery=[DAYS[0], DAYS[1]], silent_boom=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = RuntimeError("boom")
    night.silent_boom_results[DAYS[0].isoformat()] = RuntimeError("boom")

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.release.call_args_list == [call(DAYS[1]), call(DAYS[0])]
    assert result.counts["days_failed"] == 2


def test_day_not_landed_waits_and_is_untouched(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=[DAYS[1], DAYS[2]], silent_boom=[DAYS[2]])
    night.landed([DAYS[1]])  # tonight's tape for DAYS[2] has not landed

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_args_list == [
        call(DAYS[1], deadline=clock.now + FETCH_DEADLINE_SECONDS)
    ]
    assert _isos(night.events, "lottery") == [DAYS[1].isoformat()]
    assert _isos(night.events, "silent_boom") == [DAYS[1].isoformat()]
    assert _isos(night.events, "shares") == [str(DAYS[1])]
    assert night.reader.release.call_args_list == [call(DAYS[1])]
    # Waiting for the tape is neither a failure nor work left for the budget.
    assert result.status == "ok"
    assert result.counts["days_waiting_tape"] == 1
    assert result.counts["days_processed"] == 1
    assert result.counts["days_left"] == 0
    assert night.connect.call_count == 2  # the setup connection and the one landed day


def test_deadline_leaves_days_for_the_next_night_as_partial(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=DAYS)
    # Room for two days: after the second, less than a day's budget is left.
    ctx = _ctx(settings, clock, left=2 * ENRICH_DAY_BUDGET_SECONDS + 1)
    night.enrich_lottery.side_effect = lambda *_a, **_k: (
        clock.advance(ENRICH_DAY_BUDGET_SECONDS) or LotteryResult()
    )

    result = enrich_step.run(ctx)

    assert night.reader.fetch_day.call_count == 2
    assert result.status == "partial"
    assert result.detail == PARTIAL_DETAIL
    assert result.counts["days_processed"] == 2
    assert result.counts["days_left"] == 3  # the three oldest days, tomorrow's work
    assert result.counts["days_failed"] == 0


def test_a_day_starts_with_exactly_its_budget_left(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=[DAYS[0]])

    result = enrich_step.run(_ctx(settings, clock, left=ENRICH_DAY_BUDGET_SECONDS))

    assert result.counts["days_processed"] == 1
    assert result.counts["days_left"] == 0


def test_a_day_does_not_start_without_its_budget(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=[DAYS[0]])

    result = enrich_step.run(_ctx(settings, clock, left=ENRICH_DAY_BUDGET_SECONDS - 1))

    night.reader.fetch_day.assert_not_called()
    assert result.status == "partial"
    assert result.counts["days_left"] == 1
    assert result.counts["days_processed"] == 0


def test_a_download_is_bounded_by_the_readers_deadline_from_now(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # The day budget assumes a download of at most FETCH_DEADLINE_SECONDS: a step deadline
    # hours away must not let one slow download spend all of it.
    night.work(lottery=DAYS[:2])
    night.enrich_lottery.side_effect = lambda *_a, **_k: clock.advance(100) or LotteryResult()
    ctx = _ctx(settings, clock, left=50_000)
    started = clock.now

    enrich_step.run(ctx)

    # "Now" is read for each day, on the clock the step's own deadline is on.
    assert night.reader.fetch_day.call_args_list == [
        call(DAYS[1], deadline=started + FETCH_DEADLINE_SECONDS),
        call(DAYS[0], deadline=started + 100 + FETCH_DEADLINE_SECONDS),
    ]
    assert started + 100 + FETCH_DEADLINE_SECONDS < ctx.deadline


def test_a_download_never_outlasts_the_step_deadline(
    night: Night, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    # With the real budget a day starts with more than FETCH_DEADLINE_SECONDS left, so the
    # step's own deadline is the nearer one only if the budget is smaller than that.
    monkeypatch.setattr(enrich_step, "ENRICH_DAY_BUDGET_SECONDS", 100)
    night.work(lottery=[DAYS[1]])
    ctx = _ctx(settings, clock, left=FETCH_DEADLINE_SECONDS - 100)

    enrich_step.run(ctx)

    night.reader.fetch_day.assert_called_once_with(DAYS[1], deadline=ctx.deadline)


def test_a_failing_day_does_not_stop_the_others(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.work(lottery=DAYS[:3])
    failure = ValueError("row 7 of ep-x.neon.tech")
    night.lottery_results[DAYS[1].isoformat()] = failure

    result = enrich_step.run(_ctx(settings, clock))

    assert _isos(night.events, "fetch") == [str(d) for d in (DAYS[2], DAYS[1], DAYS[0])]
    assert result.counts["days_processed"] == 2
    assert result.counts["days_failed"] == 1
    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    # One exception, tagged with the step and the day; run_steps scrubs its text.
    capture_exception.assert_called_once_with(
        failure, tags={"step": STEP_NAME, "day": DAYS[1].isoformat()}
    )


def test_day_failures_are_capped_at_three(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    assert ENRICH_MAX_DAY_FAILURES == 3
    night.work(lottery=DAYS)
    failures = {d.isoformat(): RuntimeError(f"day {d}") for d in DAYS}
    night.lottery_results.update(failures)

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 3  # not 4: a broken night costs 3 downloads
    assert capture_exception.call_count == 3
    assert [c.kwargs["tags"]["day"] for c in capture_exception.call_args_list] == [
        DAYS[4].isoformat(),
        DAYS[3].isoformat(),
        DAYS[2].isoformat(),
    ]
    assert result.status == "failed"
    assert result.counts["days_failed"] == 3
    assert result.counts["days_left"] == 2
    assert result.counts["days_processed"] == 0
    assert night.reader.release.call_count == 3


def test_null_days_count_toward_the_stop(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    # A broken layout or chain format enriches nothing and raises nothing: every day
    # comes back all-NULL, and each would cost a download.
    night.work(lottery=DAYS)
    for day in DAYS:
        night.null_share(day)

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 3
    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    assert result.counts["null_days"] == 3
    assert result.counts["days_processed"] == 3  # they were enriched, to nothing
    assert result.counts["days_failed"] == 0
    assert result.counts["days_left"] == 2
    capture_exception.assert_not_called()


def test_failed_and_null_days_share_one_cap(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.work(lottery=DAYS)
    night.lottery_results[DAYS[4].isoformat()] = RuntimeError("one")
    night.null_share(DAYS[3])
    night.null_share(DAYS[2])

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 3
    assert (result.counts["days_failed"], result.counts["null_days"]) == (1, 2)
    assert result.counts["days_left"] == 2


def test_null_days_are_counted_per_table_and_day(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # Task 12's convention: a day here is one (table, day) pair with rows.
    night.work(lottery=DAYS)
    night.share_rows[DAYS[4]] = [
        DayShare(LOTTERY, DAYS[4], 40, 0),
        DayShare(SILENT_BOOM, DAYS[4], 4, 0),
    ]
    night.null_share(DAYS[3])

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 2  # 2 + 1 pairs reach the cap of 3
    assert result.counts["null_days"] == 3
    assert result.counts["days_left"] == 3


def test_low_days_are_counted_and_do_not_fail_the_step(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=DAYS)
    for day in DAYS:
        night.low_share(day)

    result = enrich_step.run(_ctx(settings, clock))

    assert result.status == "ok"
    assert result.detail == ""
    assert result.counts["low_days"] == 5
    assert result.counts["null_days"] == 0
    assert result.counts["days_processed"] == 5  # low days never reach the stop


def test_the_step_sends_no_share_alerts(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_message: MagicMock,
    capture_exception: MagicMock,
) -> None:
    # The outcome check reports the last three sessions, so the latest session would be
    # reported twice, and a long backfill would send one email per day.
    night.work(lottery=DAYS[:3])
    night.null_share(DAYS[2])
    night.low_share(DAYS[1])

    result = enrich_step.run(_ctx(settings, clock))

    assert (result.counts["null_days"], result.counts["low_days"]) == (1, 1)
    capture_message.assert_not_called()
    capture_exception.assert_not_called()


def test_the_shares_are_read_from_the_day_connection_after_both_tables(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])

    enrich_step.run(_ctx(settings, clock))

    iso = DAYS[1].isoformat()
    day_events = night.events[night.events.index(f"fetch {DAYS[1]}") :]
    assert day_events == [
        f"fetch {DAYS[1]}",
        "connect",
        f"resolved {iso}",
        f"lottery {iso}",
        f"silent_boom {iso}",
        f"shares {DAYS[1]}",
        "close",
        f"release {DAYS[1]}",
    ]
    night.shares.assert_called_once_with(night.conn, [DAYS[1]])


def test_no_work_days_is_ok_and_opens_no_reader(
    night: Night, settings: Settings, clock: Clock
) -> None:
    result = enrich_step.run(_ctx(settings, clock))

    assert result.status == "ok"
    assert result.counts == dict.fromkeys(COUNT_NAMES, 0)
    night.open_reader.assert_not_called()
    assert night.connect.call_count == 1


# --- unpriced passes ------------------------------------------------------------------

# A pass is unpriced when it wrote nothing and tagged ENRICH_UNPRICED_FLOOR rows or more: a
# tape that prices nothing still leaves the shares near 100% where the fires hold a feed
# value, so these counts are the only sign of it. Each entry builds the two scripts' results
# for a day on which one pass tagged `tagged` rows and wrote `written`; the rest stay at 0.
# The outcome passes tag what they stamp plus what they keep, so each has a mixed entry too.


def _halves(n: int) -> tuple[int, int]:
    return n // 2, n - n // 2


PASSES = {
    "lottery-stamped": lambda tagged, written: (
        LotteryResult(outcomes_written=written, stamped_no_outcome=tagged),
        SilentBoomResult(),
    ),
    "lottery-kept": lambda tagged, written: (
        LotteryResult(outcomes_written=written, outcomes_kept=tagged),
        SilentBoomResult(),
    ),
    "lottery-kept-and-stamped": lambda tagged, written: (
        LotteryResult(
            outcomes_written=written,
            outcomes_kept=_halves(tagged)[0],
            stamped_no_outcome=_halves(tagged)[1],
        ),
        SilentBoomResult(),
    ),
    "lottery-flow": lambda tagged, written: (
        LotteryResult(flow_written=written, flow_stamped_undefined=tagged),
        SilentBoomResult(),
    ),
    "silent-boom-stamped": lambda tagged, written: (
        LotteryResult(),
        SilentBoomResult(outcomes_written=written, stamped_no_outcome=tagged),
    ),
    "silent-boom-kept": lambda tagged, written: (
        LotteryResult(),
        SilentBoomResult(outcomes_written=written, alerts_kept=tagged),
    ),
    "silent-boom-kept-and-stamped": lambda tagged, written: (
        LotteryResult(),
        SilentBoomResult(
            outcomes_written=written,
            alerts_kept=_halves(tagged)[0],
            stamped_no_outcome=_halves(tagged)[1],
        ),
    ),
}


@pytest.mark.parametrize("name", PASSES)
@pytest.mark.parametrize(
    ("tagged", "written", "unpriced"),
    [
        (ENRICH_UNPRICED_FLOOR, 0, 1),
        (ENRICH_UNPRICED_FLOOR + 1, 0, 1),
        (ENRICH_UNPRICED_FLOOR - 1, 0, 0),
        (ENRICH_UNPRICED_FLOOR, 1, 0),
        (10 * ENRICH_UNPRICED_FLOOR, 1, 0),
    ],
)
def test_a_pass_that_tags_the_floor_and_writes_nothing_is_unpriced(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    name: str,
    tagged: int,
    written: int,
    unpriced: int,
) -> None:
    assert ENRICH_UNPRICED_FLOOR == 20
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])
    night.fresh_day(DAYS[1])  # the flow pass is judged only on a day nothing had resolved
    night.lottery_results[iso], night.silent_boom_results[iso] = PASSES[name](tagged, written)

    result = enrich_step.run(_ctx(settings, clock))

    # The shares are healthy (the default), so the pass's own counts decide the status.
    assert result.counts["unpriced_passes"] == unpriced
    assert result.counts["inversion_leftovers_unpriced"] == 0
    assert result.status == ("failed" if unpriced else "ok")
    assert result.detail == (FAILED_DETAIL if unpriced else "")
    # Counted, not raised: the day is processed and the step sends nothing from inside.
    assert (result.counts["days_processed"], result.counts["days_failed"]) == (1, 0)
    assert result.counts["null_days"] == 0
    capture_exception.assert_not_called()


@pytest.mark.parametrize(
    ("lottery", "silent_boom"),
    [
        (LotteryResult(fires_selected=40), SilentBoomResult()),
        (LotteryResult(), SilentBoomResult(alerts_selected=40)),
        (LotteryResult(flow_selected=40), SilentBoomResult()),
    ],
    ids=["lottery-outcome", "silent-boom", "lottery-flow"],
)
def test_fires_selected_but_not_tagged_are_not_unpriced(
    night: Night,
    settings: Settings,
    clock: Clock,
    lottery: LotteryResult,
    silent_boom: SilentBoomResult,
) -> None:
    # Tagging is what locks a fire out of the work set, so it is what counts: a pass that
    # selected fires and changed none (another writer got there first) did no damage.
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])
    night.fresh_day(DAYS[1])
    night.lottery_results[iso], night.silent_boom_results[iso] = lottery, silent_boom

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["unpriced_passes"] == 0
    assert result.status == "ok"


def test_a_day_whose_fires_all_keep_a_feed_value_fails_the_step(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # The feed's values keep the shares at 100%, so null_days sees nothing; the tape
    # priced none of the 40 fires, and each was marked examined.
    night.work(lottery=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(fires_selected=40, outcomes_kept=40)

    result = enrich_step.run(_ctx(settings, clock))

    assert night.shares.call_count == 1  # read, and healthy
    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    assert result.counts["unpriced_passes"] == 1
    assert result.counts["lottery_outcomes_kept"] == 40
    assert (result.counts["null_days"], result.counts["days_failed"]) == (0, 0)


def test_a_flow_pass_that_only_waits_for_net_flow_is_not_unpriced(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # A day whose net flow is missing leaves its fires as flow_input_missing, untagged: it
    # selected plenty, wrote nothing and tagged fewer than the floor.
    night.work(lottery=[DAYS[1]])
    night.fresh_day(DAYS[1])
    stamped = ENRICH_UNPRICED_FLOOR - 1
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(
        flow_selected=100, flow_stamped_undefined=stamped, flow_input_missing=100 - stamped
    )

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["unpriced_passes"] == 0
    assert result.counts["lottery_inversion_input_missing"] == 100 - stamped
    assert result.status == "ok"


def test_an_unpriced_pass_and_two_null_pairs_share_the_cap(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=DAYS)
    night.lottery_results[DAYS[4].isoformat()] = LotteryResult(fires_selected=40, outcomes_kept=40)
    night.share_rows[DAYS[3]] = [
        DayShare(LOTTERY, DAYS[3], 40, 0),
        DayShare(SILENT_BOOM, DAYS[3], 4, 0),
    ]

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 2  # 1 + 2 reach the cap of 3
    counts = result.counts
    assert (counts["days_failed"], counts["null_days"], counts["unpriced_passes"]) == (0, 2, 1)
    assert counts["days_left"] == 3
    assert result.status == "failed"


def test_a_total_break_stops_the_step_after_its_first_day(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # Three passes can come back unpriced on one day, which reaches the cap by itself: a
    # tape that prices nothing stamps one day's fires, not three days'.
    night.work(lottery=DAYS, silent_boom=DAYS)
    for day in DAYS:
        night.fresh_day(day)
        night.lottery_results[day.isoformat()] = LotteryResult(
            outcomes_kept=ENRICH_UNPRICED_FLOOR, flow_stamped_undefined=ENRICH_UNPRICED_FLOOR
        )
        night.silent_boom_results[day.isoformat()] = SilentBoomResult(
            alerts_kept=ENRICH_UNPRICED_FLOOR
        )

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 1
    assert result.status == "failed"
    assert result.counts["unpriced_passes"] == 3
    assert result.counts["days_processed"] == 1
    assert result.counts["days_left"] == 4


def test_a_pass_that_returned_unpriced_counts_when_a_later_pass_raises(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    # The lottery pass returned before the silent boom pass raised, like its other counts,
    # and the flag feeds the cap: 1 unpriced + 1 failed on the first day, 1 null on the next.
    night.work(lottery=DAYS[2:], silent_boom=DAYS[2:])
    night.lottery_results[DAYS[4].isoformat()] = LotteryResult(outcomes_kept=ENRICH_UNPRICED_FLOOR)
    night.silent_boom_results[DAYS[4].isoformat()] = RuntimeError("boom")
    night.null_share(DAYS[3])

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["unpriced_passes"] == 1
    assert result.counts["days_failed"] == 1
    assert result.counts["null_days"] == 1
    assert night.reader.fetch_day.call_count == 2  # the cap of 3 stopped it before DAYS[2]
    assert result.counts["days_left"] == 1


def test_a_pass_that_raised_before_returning_is_not_unpriced(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = RuntimeError("boom")
    night.silent_boom_results[DAYS[1].isoformat()] = SilentBoomResult(
        alerts_kept=ENRICH_UNPRICED_FLOOR
    )

    result = enrich_step.run(_ctx(settings, clock))

    night.enrich_silent_boom.assert_not_called()  # the lottery pass raised first
    assert result.counts["unpriced_passes"] == 0
    assert result.counts["days_failed"] == 1


def test_a_missing_file_is_not_an_unpriced_pass(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.work(lottery=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(archive_missing=True)

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["unpriced_passes"] == 0
    assert result.counts["days_failed"] == 1


# --- leftover days: the flow pass is judged only where nothing had resolved -----------

# The flow pass's work set is the fires still without an inversion. On a day the old Vercel
# cron priced first, that is only the cron's leftovers, which the tape correctly prices none
# of (2026-11-03..05: 244, 322 and 430 fires stamped, none written, and the cap stopped the
# step with 177 days left). So the pass is judged only on a day whose count of fires outside
# its work set, taken before it runs, is 0. A leftover day is counted and logged, not failed.


def _flow_priced_none(stamped: int = LEFTOVERS) -> LotteryResult:
    return LotteryResult(flow_selected=stamped, flow_stamped_undefined=stamped)


def test_a_fresh_days_flow_pass_that_prices_none_fails_the_step(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]])
    night.fresh_day(DAYS[1])
    night.lottery_results[iso] = _flow_priced_none()

    with caplog.at_level(logging.INFO, logger="enrich_step"):
        result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["unpriced_passes"] == 1
    assert result.counts["inversion_leftovers_unpriced"] == 0
    assert (result.status, result.detail) == ("failed", FAILED_DETAIL)
    (record,) = [r for r in caplog.records if r.name == "enrich_step"]
    assert record.levelno == logging.WARNING
    assert re.fullmatch(
        rf"enrich {iso} priced none unpriced_passes=1 "
        rf"lottery_inversion_stamped={LEFTOVERS} in \d+\.\ds",
        record.getMessage(),
    )


@pytest.mark.parametrize(
    ("stamped", "written", "leftover"),
    [
        (ENRICH_UNPRICED_FLOOR, 0, 1),
        (LEFTOVERS, 0, 1),
        (ENRICH_UNPRICED_FLOOR - 1, 0, 0),
        (ENRICH_UNPRICED_FLOOR, 1, 0),
        (LEFTOVERS, 5, 0),
    ],
)
def test_a_leftover_days_flow_pass_is_counted_and_never_fails_the_step(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    stamped: int,
    written: int,
    leftover: int,
) -> None:
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]])
    night.leftover_day(DAYS[1])
    night.lottery_results[iso] = LotteryResult(
        flow_selected=stamped + written, flow_written=written, flow_stamped_undefined=stamped
    )

    result = enrich_step.run(_ctx(settings, clock))

    # The same pass that fails a fresh day: only a pass the floor would flag is a leftover.
    assert result.counts["unpriced_passes"] == 0
    assert result.counts["inversion_leftovers_unpriced"] == leftover
    assert (result.status, result.detail) == ("ok", "")
    assert (result.counts["days_processed"], result.counts["days_failed"]) == (1, 0)
    capture_exception.assert_not_called()


def test_a_leftover_day_is_logged_ok_at_info_with_its_count(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]])
    night.leftover_day(DAYS[1])
    night.lottery_results[iso] = _flow_priced_none()

    with caplog.at_level(logging.INFO, logger="enrich_step"):
        enrich_step.run(_ctx(settings, clock))

    (record,) = [r for r in caplog.records if r.name == "enrich_step"]
    assert record.levelno == logging.INFO
    assert re.fullmatch(
        rf"enrich {iso} ok inversion_leftovers_unpriced=1 "
        rf"lottery_inversion_stamped={LEFTOVERS} in \d+\.\ds",
        record.getMessage(),
    )


def test_leftover_days_do_not_use_up_the_failure_cap(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # The first production run stopped on three of these with 177 days left. More than the
    # cap, in a row, must all be worked.
    assert len(DAYS) > ENRICH_MAX_DAY_FAILURES
    night.work(lottery=DAYS)
    for day in DAYS:
        night.leftover_day(day)
        night.lottery_results[day.isoformat()] = _flow_priced_none()

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == len(DAYS)
    assert (result.counts["days_processed"], result.counts["days_left"]) == (len(DAYS), 0)
    assert result.counts["inversion_leftovers_unpriced"] == len(DAYS)
    assert result.counts["unpriced_passes"] == 0
    assert (result.status, result.detail) == ("ok", "")


def test_a_total_break_on_leftover_days_trips_two_passes_a_day(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # The cap arithmetic: a fresh day trips all three passes and stops the step after one
    # day; on a leftover day the flow pass is not one of them, so it takes two days.
    night.work(lottery=DAYS, silent_boom=DAYS)
    for day in DAYS:
        night.leftover_day(day)
        night.lottery_results[day.isoformat()] = LotteryResult(
            outcomes_kept=ENRICH_UNPRICED_FLOOR,
            flow_selected=ENRICH_UNPRICED_FLOOR,
            flow_stamped_undefined=ENRICH_UNPRICED_FLOOR,
        )
        night.silent_boom_results[day.isoformat()] = SilentBoomResult(
            alerts_kept=ENRICH_UNPRICED_FLOOR
        )

    result = enrich_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 2  # 2 after the first day, 4 after the second
    assert result.counts["unpriced_passes"] == 4
    assert result.counts["inversion_leftovers_unpriced"] == 2
    assert result.counts["days_left"] == 3
    assert result.status == "failed"


@pytest.mark.parametrize("name", [n for n in PASSES if n != "lottery-flow"])
def test_a_leftover_days_outcome_passes_are_still_judged(
    night: Night, settings: Settings, clock: Clock, name: str
) -> None:
    # Only the flow pass has a work set that another writer shrinks: an outcome pass that
    # stamps or keeps the floor and writes nothing is a real break on any day.
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])
    night.leftover_day(DAYS[1])
    night.lottery_results[iso], night.silent_boom_results[iso] = PASSES[name](LEFTOVERS, 0)

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["unpriced_passes"] == 1
    assert result.counts["inversion_leftovers_unpriced"] == 0
    assert (result.status, result.detail) == ("failed", FAILED_DETAIL)


def test_a_leftover_day_with_an_unpriced_outcome_pass_still_counts_its_flow_leftovers(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]])
    night.leftover_day(DAYS[1])
    night.lottery_results[iso] = LotteryResult(
        outcomes_kept=ENRICH_UNPRICED_FLOOR,
        flow_selected=LEFTOVERS,
        flow_stamped_undefined=LEFTOVERS,
    )

    with caplog.at_level(logging.INFO, logger="enrich_step"):
        result = enrich_step.run(_ctx(settings, clock))

    # One unpriced pass (the outcome pass) toward the cap; the flow pass is only logged.
    assert result.counts["unpriced_passes"] == 1
    assert result.counts["inversion_leftovers_unpriced"] == 1
    assert result.status == "failed"
    (record,) = [r for r in caplog.records if r.name == "enrich_step"]
    assert record.levelno == logging.WARNING
    assert " priced none unpriced_passes=1 inversion_leftovers_unpriced=1 " in record.getMessage()


def test_the_count_is_taken_for_each_day(night: Night, settings: Settings, clock: Clock) -> None:
    # A leftover day must not excuse the fresh day after it.
    night.work(lottery=[DAYS[3], DAYS[4]])
    night.leftover_day(DAYS[4])
    night.fresh_day(DAYS[3])
    for day in (DAYS[3], DAYS[4]):
        night.lottery_results[day.isoformat()] = _flow_priced_none()

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["inversion_leftovers_unpriced"] == 1  # DAYS[4], run first
    assert result.counts["unpriced_passes"] == 1  # DAYS[3]
    assert result.status == "failed"


def test_the_count_runs_on_the_day_connection_before_the_lottery_pass(
    night: Night, settings: Settings, clock: Clock
) -> None:
    iso = DAYS[1].isoformat()
    night.work(lottery=[DAYS[1]])

    enrich_step.run(_ctx(settings, clock))

    # No tape landed tonight, so the setup ran no statement: this is the day's one.
    ((sql, params),) = [c.args for c in night.cursor.execute.call_args_list]
    assert " ".join(sql.split()) == (
        f"SELECT count(*) FROM lottery_finder_fires WHERE date = %s AND NOT ({INVERSION_WORK})"
    )
    assert params == (iso,)  # a parameter, never formatted into the SQL
    assert iso not in sql
    day_connect = max(i for i, event in enumerate(night.events) if event == "connect")
    assert night.events[day_connect : day_connect + 3] == [
        "connect",
        f"resolved {iso}",
        f"lottery {iso}",
    ]
    assert night.conn.cursor.call_count == 1


def test_inversions_resolved_is_the_count_the_query_returns(night: Night) -> None:
    night.leftover_day(DAYS[1], 7)

    assert enrich_step.inversions_resolved(night.conn, DAYS[1].isoformat()) == 7
    assert enrich_step.inversions_resolved(night.conn, DAYS[2].isoformat()) == 0


def test_a_failing_count_fails_that_day_before_either_pass(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    failing, after = DAYS[4], DAYS[3]  # newest first: `failing` runs first
    night.work(lottery=[after, failing], silent_boom=[after, failing])
    failure = psycopg2.OperationalError("fixture")

    def execute(sql: str, params: tuple[str] | None = None) -> None:
        if _is_resolved_count(sql) and params == (failing.isoformat(),):
            raise failure

    night.cursor.execute.side_effect = execute

    result = enrich_step.run(_ctx(settings, clock))

    capture_exception.assert_called_once_with(
        failure, tags={"step": STEP_NAME, "day": failing.isoformat()}
    )
    assert (result.status, result.detail) == ("failed", FAILED_DETAIL)
    assert (result.counts["days_failed"], result.counts["days_processed"]) == (1, 1)
    # Neither script touched the failing day, which the next night retries; the next day ran.
    for enrich in (night.enrich_lottery, night.enrich_silent_boom):
        assert [c.args[1] for c in enrich.call_args_list] == [after.isoformat()]
    assert night.reader.release.call_args_list == [call(failing), call(after)]


# --- the archive layout ---------------------------------------------------------------


@pytest.mark.parametrize("trigger", ["no-object", "lottery", "silent-boom"])
def test_a_landed_day_without_its_file_is_a_day_failure(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    trigger: str,
) -> None:
    # The cache layout and PARQUET_FILE_PATTERN disagree, or the object vanished: the
    # "broken layout" the cap exists for, so it fails the day instead of passing as a skip.
    night.work(lottery=DAYS)
    if trigger == "no-object":
        night.reader.fetch_day.side_effect = lambda day, deadline=None: None
    elif trigger == "lottery":
        night.lottery_results.update(
            {d.isoformat(): LotteryResult(archive_missing=True) for d in DAYS}
        )
    else:
        night.silent_boom_results.update(
            {d.isoformat(): SilentBoomResult(archive_missing=True) for d in DAYS}
        )

    result = enrich_step.run(_ctx(settings, clock))

    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    assert result.counts["days_failed"] == 3  # it counts toward the stop
    assert result.counts["days_processed"] == 0
    assert result.counts["days_left"] == 2
    assert capture_exception.call_count == 3
    error = capture_exception.call_args_list[0].args[0]
    assert isinstance(error, RuntimeError)
    assert str(error) == MISSING_MESSAGE  # fixed: no path, no date
    assert night.reader.release.call_count == 3


def test_a_missing_lottery_file_skips_the_silent_boom_pass(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(archive_missing=True)

    enrich_step.run(_ctx(settings, clock))

    night.enrich_silent_boom.assert_not_called()
    night.shares.assert_not_called()


def test_the_cache_layout_matches_the_scripts_archive_path(
    night: Night,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    clock: Clock,
    tmp_path: Path,
) -> None:
    # The real configure_archive on both scripts, against the real reader's file name.
    monkeypatch.setattr(enrich_step, "ENRICH_CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        enrich_step, "configure_lottery_archive", enrich_lottery_outcomes.configure_archive
    )
    monkeypatch.setattr(
        enrich_step, "configure_silent_boom_archive", enrich_silent_boom_outcomes.configure_archive
    )
    monkeypatch.setattr(_tape_reader.boto3, "client", MagicMock())  # builds no real client
    reader = TapeReader(
        endpoint_url="https://example.invalid",
        access_key_id="a",
        secret_access_key="b",
        bucket="c",
        cache_dir=tmp_path,
    )
    night.work(lottery=[DAYS[1]])

    enrich_step.run(_ctx(settings, clock))

    iso = DAYS[1].isoformat()
    assert enrich_lottery_outcomes.day_archive_path(iso) == reader.path(DAYS[1])
    assert enrich_silent_boom_outcomes.day_archive_path(iso) == reader.path(DAYS[1])


# --- setup: order, work set, cache dir ------------------------------------------------


def test_cache_dir_is_the_enrich_dir(night: Night, settings: Settings, clock: Clock) -> None:
    assert ENRICH_CACHE_DIR == WORK_DIR / "enrich"
    night.work(lottery=[DAYS[1]])

    enrich_step.run(_ctx(settings, clock))

    night.open_reader.assert_called_once_with(settings, ENRICH_CACHE_DIR)
    night.configure_lottery.assert_called_once_with(ENRICH_CACHE_DIR, "fulltape")
    night.configure_silent_boom.assert_called_once_with(ENRICH_CACHE_DIR, "fulltape")


def test_enrich_budget_is_within_the_cap() -> None:
    # The cap is a literal on purpose: it is D2's budget table, not a constant.
    assert 900 <= ENRICH_DAY_BUDGET_SECONDS <= 1_800


def test_archives_are_configured_before_the_work_days_are_listed(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # list_work_dates reads SOURCE_TAG when it runs: unconfigured, it lists the Bot-EOD set.
    night.work(lottery=[DAYS[1]])

    enrich_step.run(_ctx(settings, clock))

    setup = night.events[: night.events.index("open_reader")]
    assert setup == [
        "configure lottery",
        "configure silent_boom",
        "connect",
        "list lottery",
        "list silent_boom",
        "close",
    ]


def test_work_days_are_listed_under_the_tape_work_set(
    night: Night, settings: Settings, monkeypatch: pytest.MonkeyPatch, clock: Clock
) -> None:
    # The real scripts, the real SQL: what each lists depends on the module's SOURCE_TAG.
    for name in ("list_lottery_work_dates", "list_silent_boom_work_dates"):
        script = enrich_lottery_outcomes if "lottery" in name else enrich_silent_boom_outcomes
        monkeypatch.setattr(enrich_step, name, script.list_work_dates)
    for name in ("configure_lottery_archive", "configure_silent_boom_archive"):
        script = enrich_lottery_outcomes if "lottery" in name else enrich_silent_boom_outcomes
        monkeypatch.setattr(enrich_step, name, script.configure_archive)
    listing = night.conn.cursor.return_value  # cursor() used without `with`, as the scripts do
    listing.fetchall.return_value = []
    since, through = TAPE_START.isoformat(), LAST_SESSION.isoformat()

    enrich_step.run(_ctx(settings, clock))

    lottery_call, silent_boom_call = listing.execute.call_args_list
    for sql_call in (lottery_call, silent_boom_call):
        assert "outcome_tape_version" in sql_call.args[0]  # the tape's work, not Bot-EOD's
        assert sql_call.args[1][0] == enrich_lottery_outcomes.OUTCOME_VERSION
    assert lottery_call.args[1] == (1, since, through, since, through)
    assert silent_boom_call.args[1] == (1, since, through)


def test_work_is_bounded_by_tape_start_and_last_session(
    night: Night, settings: Settings, clock: Clock
) -> None:
    enrich_step.run(_ctx(settings, clock))

    since, through = TAPE_START.isoformat(), LAST_SESSION.isoformat()
    night.list_lottery.assert_called_once_with(night.conn, "all", since, through)
    night.list_silent_boom.assert_called_once_with(night.conn, "all", since, through)


def test_work_days_is_the_union_of_both_tables_newest_first(night: Night) -> None:
    night.work(lottery=[DAYS[0], DAYS[2], DAYS[1]], silent_boom=[DAYS[1], DAYS[4], DAYS[0]])

    assert enrich_step.work_days(night.conn, LAST_SESSION) == [
        DAYS[4],
        DAYS[2],
        DAYS[1],
        DAYS[0],
    ]


def test_the_setup_connection_closes_before_the_reader_opens(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=[DAYS[1]])

    enrich_step.run(_ctx(settings, clock))

    assert night.events.index("close") < night.events.index("open_reader")
    assert night.events.count("connect") == 2  # setup, then the one day
    assert night.events.count("close") == 2


def test_the_download_comes_before_the_day_connection(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # The Neon connection never idles through a download (up to FETCH_DEADLINE_SECONDS).
    night.work(lottery=DAYS[:2])

    enrich_step.run(_ctx(settings, clock))

    after_setup = night.events[night.events.index("open_reader") + 1 :]
    assert after_setup == [
        f"fetch {DAYS[1]}",
        "connect",
        f"resolved {DAYS[1]}",
        f"lottery {DAYS[1]}",
        f"silent_boom {DAYS[1]}",
        f"shares {DAYS[1]}",
        "close",
        f"release {DAYS[1]}",
        f"fetch {DAYS[0]}",
        "connect",
        f"resolved {DAYS[0]}",
        f"lottery {DAYS[0]}",
        f"silent_boom {DAYS[0]}",
        f"shares {DAYS[0]}",
        "close",
        f"release {DAYS[0]}",
    ]


# --- re-landed days -------------------------------------------------------------------


# One statement, so both tables clear or neither does: a data-modifying CTE per table,
# summed in the one row it returns.
_UPDATE = (
    "UPDATE {table} SET outcome_tape_version = NULL "
    "WHERE date = ANY(%(days)s::date[]) AND outcome_tape_version IS NOT NULL RETURNING 1"
)
RESET_SQL = (
    f"WITH t0 AS ({_UPDATE.format(table=LOTTERY)}), "
    f"t1 AS ({_UPDATE.format(table=SILENT_BOOM)}) "
    "SELECT (SELECT count(*) FROM t0) + (SELECT count(*) FROM t1)"
)


def test_a_relanded_day_has_its_marker_reset_before_the_work_is_listed(
    night: Night, settings: Settings, clock: Clock
) -> None:
    relanded = DayOutcome(DAYS[3], "relanded", rows=10, bytes=100)
    night.cursor.execute.side_effect = lambda sql, params: (
        night.events.append("reset") if sql == RESET_SQL else None
    )
    night.work(lottery=[DAYS[3]])

    enrich_step.run(_ctx(settings, clock, tape=(relanded,)))

    # Named parameter, and a list: a tuple would adapt as a row, not as the date[]. The day
    # that follows runs its own count query on the cursor, so look at the reset alone.
    resets = [c for c in night.cursor.execute.call_args_list if c.args[0] == RESET_SQL]
    assert resets == [call(RESET_SQL, {"days": [DAYS[3]]})]
    assert night.cursor.execute.call_args_list[0] == resets[0]  # before anything is listed
    assert night.events[: night.events.index("close")] == [
        "configure lottery",
        "configure silent_boom",
        "connect",
        "reset",
        "list lottery",
        "list silent_boom",
    ]
    # The same connection, one setup: the reset needs no connection of its own.
    assert night.list_lottery.call_args.args[0] is night.conn


def test_the_reset_is_one_statement_over_every_outcome_table(
    night: Night, settings: Settings, clock: Clock
) -> None:
    tape = (DayOutcome(DAYS[3], "relanded", rows=10, bytes=100),)

    enrich_step.run(_ctx(settings, clock, tape=tape))

    ((sql, _params),) = [c.args for c in night.cursor.execute.call_args_list]  # exactly one
    for table in OUTCOME_TABLES:
        assert _UPDATE.format(table=table) in sql
    assert sql.count("UPDATE ") == len(OUTCOME_TABLES)
    assert sql.count("%(days)s") == len(OUTCOME_TABLES)
    assert sql.count("outcome_tape_version IS NOT NULL") == len(OUTCOME_TABLES)


def test_the_rows_reset_are_counted_from_the_statements_one_row(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.cursor.fetchone.return_value = (10,)
    night.cursor.rowcount = 99  # a SELECT's rowcount: not the number of rows cleared

    result = enrich_step.run(
        _ctx(settings, clock, tape=(DayOutcome(DAYS[3], "relanded", rows=10, bytes=100),))
    )

    assert result.counts["tape_markers_reset"] == 10


def test_a_day_landed_afresh_is_reset_too(night: Night, settings: Settings, clock: Clock) -> None:
    # Deleting a day's R2 object to force a re-land makes the tape job report it as
    # `landed`, not `relanded`; its rows still carry the replaced tape's marker.
    tape = (DayOutcome(DAYS[3], "landed", rows=10, bytes=100),)
    night.cursor.fetchone.return_value = (4,)

    result = enrich_step.run(_ctx(settings, clock, tape=tape))

    night.cursor.execute.assert_called_once_with(RESET_SQL, {"days": [DAYS[3]]})
    assert result.counts["tape_markers_reset"] == 4


def test_every_day_landed_or_relanded_tonight_is_reset_in_one_statement(
    night: Night, settings: Settings, clock: Clock
) -> None:
    tape = (
        DayOutcome(DAYS[4], "relanded", rows=10, bytes=100),
        DayOutcome(DAYS[3], "landed", rows=10, bytes=100),
        DayOutcome(DAYS[2], "relanded", rows=10, bytes=100),
        DayOutcome(DAYS[1], "failed", detail="download"),
    )

    enrich_step.run(_ctx(settings, clock, tape=tape))

    # The three days that landed, in the tape's order; the failed day is not in it.
    night.cursor.execute.assert_called_once_with(RESET_SQL, {"days": [DAYS[4], DAYS[3], DAYS[2]]})


@pytest.mark.parametrize(
    "status",
    ["not_posted", "unavailable", "failed", "skipped_disk", "skipped_deadline"],
)
def test_a_day_that_did_not_land_is_not_reset(
    night: Night, settings: Settings, clock: Clock, status: str
) -> None:
    tape = (DayOutcome(DAYS[3], status, rows=10, bytes=100),)  # type: ignore[arg-type]

    result = enrich_step.run(_ctx(settings, clock, tape=tape))

    night.conn.cursor.assert_not_called()
    night.cursor.execute.assert_not_called()
    assert result.counts["tape_markers_reset"] == 0


def test_no_tape_days_means_no_update(night: Night, settings: Settings, clock: Clock) -> None:
    enrich_step.run(_ctx(settings, clock))

    night.cursor.execute.assert_not_called()


def test_a_failed_reset_propagates_for_the_runner_to_report(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    failure = RuntimeError("update failed")
    night.cursor.execute.side_effect = failure
    tape = (DayOutcome(DAYS[3], "relanded", rows=10, bytes=100),)

    with pytest.raises(RuntimeError) as raised:
        enrich_step.run(_ctx(settings, clock, tape=tape))

    assert raised.value is failure
    night.list_lottery.assert_not_called()  # nothing is enriched over a marker it could not clear
    night.open_reader.assert_not_called()


# --- counts ---------------------------------------------------------------------------


def test_each_script_count_maps_to_its_own_step_count(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])
    # A distinct prime per field, so a swapped or dropped mapping cannot sum to the same.
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(
        outcomes_written=2,
        stamped_no_outcome=3,
        flow_written=5,
        flow_stamped_undefined=7,
        flow_input_missing=11,
        outcomes_replaced=13,
        outcomes_kept=17,
    )
    night.silent_boom_results[DAYS[1].isoformat()] = SilentBoomResult(
        outcomes_written=19,
        stamped_no_outcome=23,
        alerts_replaced=29,
        alerts_kept=31,
    )

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts == {
        "days_processed": 1,
        "days_waiting_tape": 0,
        "days_left": 0,
        "days_failed": 0,
        "null_days": 0,
        "unpriced_passes": 0,
        "inversion_leftovers_unpriced": 0,
        "low_days": 0,
        "tape_markers_reset": 0,
        "lottery_outcomes_written": 2,
        "lottery_stamped_no_outcome": 3,
        "lottery_inversion_written": 5,
        "lottery_inversion_stamped": 7,
        "lottery_inversion_input_missing": 11,
        "lottery_outcomes_replaced": 13,
        "lottery_outcomes_kept": 17,
        "silent_boom_outcomes_written": 19,
        "silent_boom_stamped_no_outcome": 23,
        "silent_boom_outcomes_replaced": 29,
        "silent_boom_outcomes_kept": 31,
    }
    assert set(result.counts) == COUNT_NAMES


def test_counts_add_up_over_the_days(night: Night, settings: Settings, clock: Clock) -> None:
    night.work(lottery=DAYS[:3], silent_boom=DAYS[:3])
    for day, n in zip(DAYS[:3], (1, 10, 100), strict=True):
        night.lottery_results[day.isoformat()] = LotteryResult(outcomes_written=n)
        night.silent_boom_results[day.isoformat()] = SilentBoomResult(outcomes_written=n * 2)

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["lottery_outcomes_written"] == 111
    assert result.counts["silent_boom_outcomes_written"] == 222
    assert result.counts["days_processed"] == 3


def test_writes_made_before_a_failure_still_count(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    # The lottery pass committed its rows before the silent boom pass raised: the counts
    # are what the database was given, not what the day finished.
    night.work(lottery=[DAYS[1]], silent_boom=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(outcomes_written=5)
    night.silent_boom_results[DAYS[1].isoformat()] = RuntimeError("boom")

    result = enrich_step.run(_ctx(settings, clock))

    assert result.counts["lottery_outcomes_written"] == 5
    assert result.counts["days_failed"] == 1
    assert result.counts["days_processed"] == 0


# --- pass 3 ---------------------------------------------------------------------------


def test_never_runs_pass_3(
    night: Night, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The ticker EMA is retired (owner decision): the refit must not run, at the end of
    # a night or anywhere else.
    refit = MagicMock(side_effect=AssertionError("pass 3 ran"))
    monkeypatch.setattr(enrich_lottery_outcomes, "refit_ticker_inversion_stats", refit)
    night.work(lottery=DAYS[:2], silent_boom=DAYS[:2])

    result = enrich_step.run(_ctx(settings, clock))

    refit.assert_not_called()
    assert result.status == "ok"
    # Not even reachable by name from this module, whatever the script patch sees.
    assert not hasattr(enrich_step, "refit_ticker_inversion_stats")


# --- failures that are not the step's to swallow --------------------------------------


@pytest.mark.parametrize("stage", ["connect", "list", "landed_days", "open_reader"])
def test_a_setup_failure_propagates_for_the_runner_to_report(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    capture_message: MagicMock,
    stage: str,
) -> None:
    failure = RuntimeError(stage)
    night.work(lottery=[DAYS[1]])
    if stage == "connect":
        night.connect.side_effect = failure
    elif stage == "list":
        night.list_lottery.side_effect = failure
    elif stage == "landed_days":
        night.reader.landed_days.side_effect = failure
    else:
        night.open_reader.side_effect = failure

    with pytest.raises(RuntimeError) as raised:
        enrich_step.run(_ctx(settings, clock))

    assert raised.value is failure
    # run_steps sends it once, scrubbed; a second capture here would be unscrubbed.
    capture_exception.assert_not_called()
    capture_message.assert_not_called()
    night.enrich_lottery.assert_not_called()


@pytest.mark.parametrize("stage", ["fetch", "connect", "shares"])
def test_a_failure_at_any_stage_of_a_day_is_that_days_alone(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    stage: str,
) -> None:
    # The fetch is the likeliest real failure (R2 refuses a read, the disk is full, the
    # deadline passes); the day's own connection and its shares query are Neon's. Each
    # raises, not returns None, and each must stay inside the day.
    failing, after = DAYS[4], DAYS[3]  # newest first: `failing` runs first
    night.work(lottery=[after, failing])
    if stage == "fetch":
        failure: Exception = TapeReadError("fixture")
        fetch = night.reader.fetch_day.side_effect

        def fetch_day(day: date, deadline: float | None = None) -> Path:
            if day == failing:
                raise failure
            return fetch(day, deadline)

        night.reader.fetch_day.side_effect = fetch_day
    elif stage == "connect":
        failure = psycopg2.OperationalError("fixture")
        connect = night.connect.side_effect
        opened: list[None] = []

        def failing_connect(settings: Settings):
            opened.append(None)
            if len(opened) == 2:  # the first is the setup connection, the second is the day's
                raise failure
            return connect(settings)

        night.connect.side_effect = failing_connect
    else:
        failure = psycopg2.OperationalError("fixture")
        shares = night.shares.side_effect

        def failing_shares(conn: MagicMock, days: list[date]) -> list[DayShare]:
            if days == [failing]:
                raise failure
            return shares(conn, days)

        night.shares.side_effect = failing_shares

    result = enrich_step.run(_ctx(settings, clock))

    capture_exception.assert_called_once_with(
        failure, tags={"step": STEP_NAME, "day": failing.isoformat()}
    )
    assert result.status == "failed"
    assert (result.counts["days_failed"], result.counts["days_processed"]) == (1, 1)
    assert night.reader.release.call_args_list == [call(failing), call(after)]
    assert night.reader.fetch_day.call_count == 2
    assert _isos(night.events, "lottery")[-1] == after.isoformat()  # the next day still worked
    assert _isos(night.events, "silent_boom")[-1] == after.isoformat()
    if stage == "fetch":
        # Nothing was opened or run for the day whose download failed.
        assert night.connect.call_count == 2  # the setup connection and `after`'s
        assert _isos(night.events, "lottery") == [after.isoformat()]
        assert _isos(night.events, "silent_boom") == [after.isoformat()]
    elif stage == "connect":
        assert _isos(night.events, "lottery") == [after.isoformat()]
    else:
        assert _isos(night.events, "lottery") == [failing.isoformat(), after.isoformat()]


def test_a_base_exception_ends_the_step_after_the_day_is_released(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.work(lottery=DAYS[:3])
    night.lottery_results[DAYS[2].isoformat()] = SystemExit(143)  # SIGTERM

    with pytest.raises(SystemExit):
        enrich_step.run(_ctx(settings, clock))

    assert night.reader.release.call_args_list == [call(DAYS[2])]
    assert night.reader.fetch_day.call_count == 1  # it did not go on to the next day
    capture_exception.assert_not_called()
    assert night.events[-2:] == ["close", f"release {DAYS[2]}"]
    night.reader.__exit__.assert_called_once()  # the reader still closes


# --- logs -----------------------------------------------------------------------------


def test_one_log_line_per_day_with_counts_and_seconds(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    night.work(lottery=[DAYS[1], DAYS[2]], silent_boom=[DAYS[2]])
    night.landed([DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(outcomes_written=5)

    with caplog.at_level(logging.INFO, logger="enrich_step"):
        enrich_step.run(_ctx(settings, clock))

    records = [r for r in caplog.records if r.name == "enrich_step"]
    waiting, done = (r.getMessage() for r in records)  # newest first
    assert waiting == f"enrich {DAYS[2].isoformat()} waiting for the tape"
    # Date, the day's non-zero counts, seconds: nothing else.
    assert re.fullmatch(
        rf"enrich {DAYS[1].isoformat()} ok lottery_outcomes_written=5 in \d+\.\ds", done
    )
    assert [r.levelno for r in records] == [logging.INFO, logging.INFO]


def test_logs_and_the_result_carry_no_exception_text(
    night: Night,
    settings: Settings,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    capture_exception: MagicMock,
) -> None:
    night.work(lottery=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = ValueError("host ep-x.neon.tech row 7")

    with caplog.at_level(logging.DEBUG):
        result = enrich_step.run(_ctx(settings, clock))

    assert "ValueError" in caplog.text
    assert "ep-x.neon.tech" not in caplog.text
    assert "row 7" not in caplog.text
    assert "ep-x.neon.tech" not in result.detail
    assert all(isinstance(n, int) for n in result.counts.values())


def test_a_failed_day_is_logged_as_a_warning(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    night.work(lottery=[DAYS[1], DAYS[2]])
    night.lottery_results[DAYS[2].isoformat()] = ValueError("x")
    night.null_share(DAYS[1])

    with caplog.at_level(logging.INFO, logger="enrich_step"):
        enrich_step.run(_ctx(settings, clock))

    failed, null = [r for r in caplog.records if r.name == "enrich_step"]
    assert (failed.levelno, null.levelno) == (logging.WARNING, logging.WARNING)
    # The status word is ok | no outcomes | failed (<Class>): a day that fails the step
    # (all-NULL shares) is never "ok".
    assert re.fullmatch(
        rf"enrich {DAYS[2].isoformat()} failed \(ValueError\) in \d+\.\ds", failed.getMessage()
    )
    assert re.fullmatch(
        rf"enrich {DAYS[1].isoformat()} no outcomes null_days=1 in \d+\.\ds", null.getMessage()
    )


def test_a_day_with_an_unpriced_pass_is_logged_priced_none_as_a_warning(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    night.work(lottery=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(outcomes_kept=ENRICH_UNPRICED_FLOOR)

    with caplog.at_level(logging.INFO, logger="enrich_step"):
        enrich_step.run(_ctx(settings, clock))

    (record,) = [r for r in caplog.records if r.name == "enrich_step"]
    assert record.levelno == logging.WARNING
    assert re.fullmatch(
        rf"enrich {DAYS[1].isoformat()} priced none unpriced_passes=1 "
        rf"lottery_outcomes_kept={ENRICH_UNPRICED_FLOOR} in \d+\.\ds",
        record.getMessage(),
    )


def test_priced_none_outranks_no_outcomes_and_failed_outranks_both(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    # failed (<Class>), then priced none, then no outcomes, then ok.
    night.work(lottery=[DAYS[1], DAYS[2]], silent_boom=[DAYS[2]])
    unpriced = LotteryResult(outcomes_kept=ENRICH_UNPRICED_FLOOR)
    night.lottery_results[DAYS[1].isoformat()] = unpriced  # also all-NULL (below)
    night.null_share(DAYS[1])
    night.lottery_results[DAYS[2].isoformat()] = unpriced  # then the silent boom pass raises
    night.silent_boom_results[DAYS[2].isoformat()] = ValueError("x")

    with caplog.at_level(logging.INFO, logger="enrich_step"):
        enrich_step.run(_ctx(settings, clock))

    failed, priced_none = (r.getMessage() for r in caplog.records if r.name == "enrich_step")
    assert re.fullmatch(
        rf"enrich {DAYS[2].isoformat()} failed \(ValueError\) unpriced_passes=1 "
        rf"lottery_outcomes_kept={ENRICH_UNPRICED_FLOOR} in \d+\.\ds",
        failed,
    )
    assert re.fullmatch(
        rf"enrich {DAYS[1].isoformat()} priced none null_days=1 unpriced_passes=1 "
        rf"lottery_outcomes_kept={ENRICH_UNPRICED_FLOOR} in \d+\.\ds",
        priced_none,
    )


# --- the registered step, under the real runner ---------------------------------------


def _run_registered(settings: Settings, tape: tuple[DayOutcome, ...] = ()) -> StepOutcome:
    (step,) = (s for s in STEPS if s.name == STEP_NAME)
    (outcome,) = run_steps(
        [step],
        settings=settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=monotonic() + 2 * ENRICH_DAY_BUDGET_SECONDS,
        tape=tape,
        on_outcome=report_step,
    )
    return outcome


def test_the_step_tag_is_the_registered_name(
    night: Night, settings: Settings, capture_exception: MagicMock, capture_message: MagicMock
) -> None:
    night.work(lottery=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = RuntimeError("x")

    outcome = _run_registered(settings)

    # The day's own exception (not run_steps's, which carries the step tag alone): its
    # `step` tag is the name the pipeline registered.
    assert outcome.status == "failed"
    assert outcome.error is None
    capture_exception.assert_called_once()
    assert capture_exception.call_args.kwargs["tags"] == {
        "step": STEP_NAME,
        "day": DAYS[1].isoformat(),
    }


def test_a_null_day_reports_one_step_failure_and_no_share_alert(
    night: Night, settings: Settings, capture_message: MagicMock
) -> None:
    night.work(lottery=[DAYS[1]])
    night.null_share(DAYS[1])

    outcome = _run_registered(settings)

    assert outcome.status == "failed"
    assert outcome.error is None
    assert outcome.detail == FAILED_DETAIL
    assert set(outcome.counts) == COUNT_NAMES  # a valid StepResult: names and ints
    capture_message.assert_called_once()
    assert capture_message.call_args.args == ("nightly step failed",)
    assert capture_message.call_args.kwargs["fingerprint"] == [
        "nightly-step",
        STEP_NAME,
        "failed",
        FAILED_DETAIL,
    ]


def test_an_unpriced_pass_reports_one_step_failure_and_no_share_alert(
    night: Night, settings: Settings, capture_message: MagicMock
) -> None:
    night.work(lottery=[DAYS[1]])
    night.lottery_results[DAYS[1].isoformat()] = LotteryResult(fires_selected=40, outcomes_kept=40)

    outcome = _run_registered(settings)

    assert outcome.status == "failed"
    assert outcome.error is None
    assert outcome.detail == FAILED_DETAIL
    assert outcome.counts["unpriced_passes"] == 1
    assert set(outcome.counts) == COUNT_NAMES  # a valid StepResult: names and ints
    capture_message.assert_called_once()
    assert capture_message.call_args.args == ("nightly step failed",)
    assert capture_message.call_args.kwargs["fingerprint"] == [
        "nightly-step",
        STEP_NAME,
        "failed",
        FAILED_DETAIL,
    ]


def test_a_leftover_day_reports_nothing_under_the_real_runner(
    night: Night, settings: Settings, capture_message: MagicMock, capture_exception: MagicMock
) -> None:
    night.work(lottery=[DAYS[1]])
    night.leftover_day(DAYS[1])
    night.lottery_results[DAYS[1].isoformat()] = _flow_priced_none()

    outcome = _run_registered(settings)

    assert outcome.status == "ok"
    assert outcome.detail == ""
    assert outcome.counts["inversion_leftovers_unpriced"] == 1
    assert outcome.counts["unpriced_passes"] == 0
    assert set(outcome.counts) == COUNT_NAMES  # a valid StepResult: names and ints
    capture_message.assert_not_called()
    capture_exception.assert_not_called()


def test_work_left_reports_a_partial_step_as_a_warning(
    night: Night, settings: Settings, capture_message: MagicMock, clock: Clock
) -> None:
    # The first day spends the whole budget: the step starts with exactly its minimum,
    # leaves the other two days for tomorrow, and the runner reports it as partial.
    night.work(lottery=DAYS[:3])
    night.enrich_lottery.side_effect = lambda *_a, **_k: (
        clock.advance(ENRICH_DAY_BUDGET_SECONDS) or LotteryResult()
    )
    (step,) = (s for s in STEPS if s.name == STEP_NAME)

    (outcome,) = run_steps(
        [step],
        settings=settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=clock.now + ENRICH_DAY_BUDGET_SECONDS,
        tape=(),
        on_outcome=report_step,
    )

    assert (outcome.status, outcome.detail) == ("partial", PARTIAL_DETAIL)
    assert outcome.counts["days_processed"] == 1
    assert outcome.counts["days_left"] == 2
    capture_message.assert_called_once()
    assert capture_message.call_args.args == ("nightly step partial",)
    assert capture_message.call_args.kwargs["level"] == "warning"
    assert capture_message.call_args.kwargs["fingerprint"] == [
        "nightly-step",
        STEP_NAME,
        "partial",
        PARTIAL_DETAIL,
    ]


def test_a_clean_night_reports_nothing(
    night: Night, settings: Settings, capture_message: MagicMock
) -> None:
    night.work(lottery=DAYS[:2], silent_boom=DAYS[:2])

    outcome = _run_registered(settings)

    assert outcome.status == "ok"
    assert outcome.detail == ""
    assert outcome.counts["days_processed"] == 2
    assert outcome.counts["unpriced_passes"] == 0  # present, and zero
    capture_message.assert_not_called()


def test_the_shared_lottery_script_wins_over_the_older_ml_copy() -> None:
    # The silent boom script puts ml/src at the front of sys.path, and ml/src holds an
    # older enrich_lottery_outcomes.py: enrich_step must import the lottery script first.
    # A fresh interpreter, because this process imported both long ago.
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(NIGHTLY_DIR / "src"), str(SCRIPTS_DIR)]),
    }
    code = "import enrich_step, enrich_lottery_outcomes as m; print(m.__file__)"

    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=NIGHTLY_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()) == SCRIPTS_DIR / "enrich_lottery_outcomes.py"
