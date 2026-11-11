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
from unittest.mock import MagicMock, call, create_autospec

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

COUNT_NAMES = {
    "days_processed",
    "days_waiting_tape",
    "days_left",
    "days_failed",
    "null_days",
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
        f"lottery {DAYS[1]}",
        f"silent_boom {DAYS[1]}",
        f"shares {DAYS[1]}",
        "close",
        f"release {DAYS[1]}",
        f"fetch {DAYS[0]}",
        "connect",
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
    landed = DayOutcome(DAYS[4], "landed", rows=10, bytes=100)
    night.cursor.execute.side_effect = lambda sql, params: night.events.append("reset")
    night.work(lottery=[DAYS[3]])

    enrich_step.run(_ctx(settings, clock, tape=(landed, relanded)))

    # Named parameter, and a list: a tuple would adapt as a row, not as the date[].
    night.cursor.execute.assert_called_once_with(RESET_SQL, {"days": [DAYS[3]]})
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


def test_only_the_relanded_days_are_reset(night: Night, settings: Settings, clock: Clock) -> None:
    tape = (
        DayOutcome(DAYS[4], "relanded", rows=10, bytes=100),
        DayOutcome(DAYS[3], "landed", rows=10, bytes=100),
        DayOutcome(DAYS[2], "relanded", rows=10, bytes=100),
    )

    enrich_step.run(_ctx(settings, clock, tape=tape))

    # Both re-landed days in the one statement, the landed one not in it.
    night.cursor.execute.assert_called_once_with(RESET_SQL, {"days": [DAYS[4], DAYS[2]]})


@pytest.mark.parametrize(
    "status",
    ["landed", "not_posted", "unavailable", "failed", "skipped_disk", "skipped_deadline"],
)
def test_a_day_that_was_not_relanded_is_not_reset(
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
