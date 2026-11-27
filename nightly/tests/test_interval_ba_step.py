"""Tests for the interval-ba-tape step: the work list, the per-day loop, the stop rules, the DuckDB
limits and the per-day health alerts.

Everything below interval_ba_step is patched at its module boundary (R3): `open_reader`,
`connect_db`, `read_covering_settings`, `replay_day`, `heal_day`, `ResearchStore` and
`duckdb.connect` (one test puts the real `duckdb.connect` back, to read the settings of the
connection the step opens). Nothing reaches a database, R2 or the network.

`night.markers` stands in for the `interval_ba_tape_days` rows: the fake cursor answers the
step's two statements from it, and the fake `heal_day` adds the day it heals, as the real one's
step 7 does. `night.puts` holds each day file the fake store was handed, read back at the time
of the put. `night.events` records every call that matters for order. `clock` replaces the
monotonic clock `StepContext.seconds_left` reads, so a test spends run time by moving it.
"""

from __future__ import annotations

import json
import logging
import re
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, call, create_autospec, patch

import boto3
import duckdb
import psycopg2
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import sentry_sdk
from _tape_reader import FETCH_DEADLINE_SECONDS, TapeReader, TapeReadError
from moto import mock_aws
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport

import interval_ba_step
import resources
import steps
from calendar_nyse import trading_days
from config import Settings, load_settings
from constants import (
    INTERVAL_BA_CACHE_DIR,
    INTERVAL_BA_DAY_BUDGET_SECONDS,
    INTERVAL_BA_DUCKDB_MEMORY,
    INTERVAL_BA_DUCKDB_THREADS,
    INTERVAL_BA_MAX_DAY_FAILURES,
    WORK_DIR,
)
from interval_ba_replay import (
    EXPORT_COLUMNS,
    INSERT_MISSED_FROM,
    DayPlan,
    Replay,
    TapeAlert,
    day_key,
    default_settings,
    export_table,
    heal_day,
    read_covering_settings,
    replay_day,
    rule,
)
from monitoring import init_sentry, report_step
from pipeline import STEPS
from research_store import ResearchStore
from steps import StepContext, StepOutcome, run_steps
from tape_job import DayOutcome
from tests._interval_ba_tape import _at, _chain

NOW = datetime(2026, 11, 5, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 4)  # a Wednesday
# The trading days from INSERT_MISSED_FROM (a Thursday) through LAST_SESSION: no weekend day.
WORK = [
    date(2026, 10, 29),
    date(2026, 10, 30),
    date(2026, 11, 2),
    date(2026, 11, 3),
    date(2026, 11, 4),
]
NEWEST_FIRST = WORK[::-1]
BEFORE_WORK = date(2026, 10, 28)  # healed by the one-off tool, never by the step
STEP_NAME = "interval-ba-tape"
FAILED_DETAIL = "a day failed"
PARTIAL_DETAIL = "days left for the next night"
HEALTH_TITLE = "nightly interval-ba live health: {}"
SETTINGS = [default_settings()]
REAL_DUCKDB_CONNECT = duckdb.connect

CLEAR_SQL = "DELETE FROM interval_ba_tape_days WHERE day = ANY(%(days)s::date[])"
MARKERS_SQL = "SELECT day FROM interval_ba_tape_days WHERE day >= %(first)s"

COUNT_NAMES = {
    "days_done",
    "days_failed",
    "days_left",
    "days_waiting_tape",
    "replay_days_written",
    "inserted",
    "flags_changed",
    "spot_filled",
    "root_label_mismatch",
    "health_alerts",
}
# The DayPlan counts a health message carries, in its `interval_ba_day` context.
HEALTH_CONTEXT = "interval_ba_day"
HEALTH_COUNTS = (
    "tape_alerts",
    "live_rows",
    "live_missed",
    "live_only",
    "matched",
    "value_mismatched",
    "inserted",
    "removed",
    "acknowledged_kept",
    "flags_changed",
    "flags_unmatched",
    "spot_filled",
    "root_label_mismatch",
)
HELD_REASONS = (
    "no live settings record",
    "live settings differ from the tape rule",
    "live detector off",
)


def _plan(day: date, **counts: Any) -> DayPlan:
    """A healthy day by default: the tape and live agree on 40 alerts."""
    values: dict[str, Any] = {
        "root_label_mismatch": 0,
        "tape_alerts": 40,
        "live_rows": 40,
        "live_missed": 0,
        "live_only": 0,
        "value_mismatched": 0,
        "inserted": 0,
        "inserts_held": None,
        "removed": 0,
        "acknowledged_kept": 0,
        "flags_changed": 0,
        "flags_unmatched": 0,
        "spot_filled": 0,
        "matched": 40,
        **counts,
    }
    return DayPlan(
        day=day,
        **values,
        inserts=(),
        removes=(),
        flag_updates=(),
        spot_updates=(),
        sha256="0" * 64,
    )


def _tape_alert(day: date, root: str, option_type: str, strike: int, clock: str) -> TapeAlert:
    start = _at(clock, day)
    return TapeAlert(
        option_chain=_chain(root, option_type, strike, day),
        ticker=root,
        option_type=option_type,
        strike=Decimal(strike).quantize(Decimal("0.001")),
        expiry=day,
        bucket_start=start,
        bucket_end=start + timedelta(seconds=300),
        fired_at=start + timedelta(seconds=1),
        ratio_pct=Decimal("100.00"),
        ask_premium=Decimal("250000.00"),
        total_premium=Decimal("250000.00"),
        trade_count=1,
        top_trade_premium=Decimal("250000.00"),
        top_trade_size=100,
        top_trade_executed_at=start + timedelta(seconds=1),
        top_trade_is_sweep=False,
        top_trade_is_floor=False,
        underlying_price=Decimal("6701.25") if root == "SPXW" else Decimal("670.00"),
        confluence_tickers=(),
    )


def _replay_of(day: date) -> Replay:
    """The day's replay as the fake replay_day gives it: one alert for each of the three
    tickers, so a file that left a ticker out shows."""
    return Replay(
        day=day,
        alerts=(
            _tape_alert(day, "SPXW", "C", 6700, "14:30:00"),
            _tape_alert(day, "SPY", "C", 670, "14:31:00"),
            _tape_alert(day, "QQQ", "P", 590, "14:32:00"),
        ),
        root_label_mismatch=0,
    )


@dataclass(frozen=True)
class Put:
    """A day file the fake store was handed: its key, the path it was read from, and the table
    and Parquet footer metadata read back from that path at the time of the put."""

    key: str
    path: Path
    table: pa.Table
    meta: dict[str, Any]


# --- harness --------------------------------------------------------------------------


@pytest.fixture
def settings() -> Settings:
    return load_settings()


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
    """The patched boundary of interval_ba_step, the marker table and the calls, in order."""

    events: list[str]
    conn: MagicMock
    cursor: MagicMock
    connect: MagicMock
    reader: MagicMock
    open_reader: MagicMock
    covering: MagicMock
    replay: MagicMock
    heal: MagicMock
    duckdb_connect: MagicMock
    duck: MagicMock
    store_class: MagicMock
    store: MagicMock
    cache_dir: Path
    # The days with an interval_ba_tape_days row.
    markers: set[date] = field(default_factory=set)
    # What heal_day returns, or raises, for a day. Absent: a healthy plan.
    plans: dict[date, DayPlan | BaseException] = field(default_factory=dict)
    # What replay_day returns, or raises, for a day. Absent: _replay_of(day).
    replays: dict[date, Replay | BaseException] = field(default_factory=dict)
    # What the store's put_file raises for a key, before it keeps anything.
    put_failures: dict[str, BaseException] = field(default_factory=dict)
    # The day files the store was handed, in order.
    puts: list[Put] = field(default_factory=list)

    def landed(self, days: list[date]) -> None:
        self.reader.landed_days.return_value = set(days)

    def puts_for(self, day: date) -> list[Put]:
        return [put for put in self.puts if put.key == day_key(day)]


@pytest.fixture
def night(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Night:
    events: list[str] = []
    cache_dir = tmp_path / "interval-ba"
    cache_dir.mkdir()
    conn = MagicMock(name="conn")
    cursor = MagicMock(name="cursor")
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
    reader.landed_days.return_value = {BEFORE_WORK, *WORK}
    reader.fetch_day.side_effect = lambda day, deadline=None: (
        events.append(f"fetch {day}") or Path(f"/cache/{day}-fulltape.parquet")
    )
    reader.release.side_effect = lambda day: events.append(f"release {day}")

    def fake_open_reader(_settings: Settings, _cache_dir: Path) -> MagicMock:
        events.append("open_reader")
        return reader

    duck = MagicMock(name="duck")
    duck.__enter__.return_value = duck
    duck.__exit__.side_effect = lambda *_exc: events.append("duck close") or False

    def fake_duckdb_connect(*_args: object, **_kwargs: object) -> MagicMock:
        events.append("duck open")
        return duck

    store = create_autospec(ResearchStore, instance=True)
    store_class = create_autospec(ResearchStore, return_value=store)

    n = Night(
        events=events,
        conn=conn,
        cursor=cursor,
        connect=create_autospec(resources.connect_db, side_effect=fake_connect),
        reader=reader,
        open_reader=create_autospec(resources.open_reader, side_effect=fake_open_reader),
        covering=create_autospec(
            read_covering_settings,
            side_effect=lambda _conn, day: events.append(f"settings {day}") or SETTINGS,
        ),
        replay=create_autospec(replay_day),
        heal=create_autospec(heal_day),
        duckdb_connect=MagicMock(name="duckdb.connect", side_effect=fake_duckdb_connect),
        duck=duck,
        store_class=store_class,
        store=store,
        cache_dir=cache_dir,
        markers={BEFORE_WORK},
    )

    def fake_replay(_con: object, _tape: str, day: date) -> Replay:
        events.append(f"replay {day}")
        outcome = n.replays.get(day, _replay_of(day))
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    n.replay.side_effect = fake_replay

    def fake_put_file(key: str, path: Path) -> int:
        events.append(f"put {key}")
        if key in n.put_failures:
            raise n.put_failures[key]
        table = pq.read_table(path)
        meta = json.loads(pq.read_schema(path).metadata[b"interval_ba"])
        n.puts.append(Put(key, path, table, meta))
        return path.stat().st_size

    store.put_file.side_effect = fake_put_file

    def execute(sql: str, params: dict[str, Any]) -> None:
        if sql == CLEAR_SQL:
            # A list, never a tuple: psycopg2 adapts a tuple as a row, which `::date[]` rejects.
            assert isinstance(params["days"], list)
            events.append(f"clear {' '.join(d.isoformat() for d in params['days'])}")
            cursor.rowcount = len(n.markers & set(params["days"]))
            n.markers.difference_update(params["days"])
        elif sql == MARKERS_SQL:
            events.append("markers")
            cursor.fetchall.return_value = [(d,) for d in sorted(n.markers) if d >= params["first"]]
        else:
            raise AssertionError(f"unexpected statement: {sql}")

    cursor.execute.side_effect = execute

    def fake_heal(
        _conn: object,
        _con: object,
        _tape: str,
        day: date,
        _settings: object,
        *,
        insert_missed: bool,
        apply: bool,
        expect_sha256: str | None = None,
        replay: Replay | None = None,
    ) -> DayPlan:
        events.append(f"heal {day}")
        outcome = n.plans.get(day, _plan(day))
        if isinstance(outcome, BaseException):
            raise outcome
        n.markers.add(day)  # heal_day's step 7, committed with the day's writes
        return outcome

    n.heal.side_effect = fake_heal

    monkeypatch.setattr(interval_ba_step, "connect_db", n.connect)
    monkeypatch.setattr(interval_ba_step, "open_reader", n.open_reader)
    monkeypatch.setattr(interval_ba_step, "read_covering_settings", n.covering)
    monkeypatch.setattr(interval_ba_step, "replay_day", n.replay)
    monkeypatch.setattr(interval_ba_step, "heal_day", n.heal)
    monkeypatch.setattr(interval_ba_step, "ResearchStore", n.store_class)
    # The day file is written under the cache directory; open_reader, which makes it, is patched.
    monkeypatch.setattr(interval_ba_step, "INTERVAL_BA_CACHE_DIR", cache_dir)
    monkeypatch.setattr(interval_ba_step.duckdb, "connect", n.duckdb_connect)
    return n


def _ctx(
    settings: Settings,
    clock: Clock,
    *,
    left: float = 100_000.0,
    tape: tuple[DayOutcome, ...] = (),
) -> StepContext:
    return StepContext(settings, NOW, LAST_SESSION, deadline=clock.now + left, tape=tape)


def _days(events: list[str], prefix: str) -> list[date]:
    return [
        date.fromisoformat(e.removeprefix(f"{prefix} "))
        for e in events
        if e.startswith(f"{prefix} ")
    ]


def _health_calls(capture_message: MagicMock) -> list[Any]:
    return [
        c
        for c in capture_message.call_args_list
        if c.kwargs.get("fingerprint", [""])[0] == "interval-ba-live-health"
    ]


# --- the work list --------------------------------------------------------------------


def test_work_list_is_trading_days_from_insert_missed_from_newest_first(
    night: Night, settings: Settings, clock: Clock
) -> None:
    assert WORK[0] == INSERT_MISSED_FROM
    # BEFORE_WORK has a tape too, and no marker: the step still never works it.
    night.markers.clear()

    result = interval_ba_step.run(_ctx(settings, clock))

    assert _days(night.events, "heal") == NEWEST_FIRST
    assert night.reader.fetch_day.call_args_list == [
        call(day, deadline=clock.now + FETCH_DEADLINE_SECONDS) for day in NEWEST_FIRST
    ]
    assert night.reader.release.call_args_list == [call(day) for day in NEWEST_FIRST]
    assert result.status == "ok"
    assert result.detail == ""
    assert result.counts == {
        **dict.fromkeys(COUNT_NAMES, 0),
        "days_done": len(WORK),
        "replay_days_written": len(WORK),
    }


def test_the_work_list_skips_exchange_holidays(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # Thanksgiving (2026-11-26) is a weekday with no session, so no tape and no work.
    thanksgiving_week = [date(2026, 11, d) for d in (23, 24, 25, 26, 27)]
    # Every day before that week was healed on an earlier night.
    night.markers.update(date(2026, 10, d) for d in range(29, 32))
    night.markers.update(date(2026, 11, d) for d in range(1, 23))
    night.landed(thanksgiving_week)
    ctx = StepContext(settings, NOW, date(2026, 11, 27), deadline=clock.now + 100_000.0, tape=())

    result = interval_ba_step.run(ctx)

    assert _days(night.events, "heal") == [
        date(2026, 11, 27),
        date(2026, 11, 25),
        date(2026, 11, 24),
        date(2026, 11, 23),
    ]
    assert result.counts["days_waiting_tape"] == 0


def test_heal_day_runs_on_the_downloaded_file_with_inserts_on_and_applied(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.landed([WORK[4]])

    interval_ba_step.run(_ctx(settings, clock))

    # The day is replayed once, on the downloaded file, and that replay goes to heal_day. The
    # covering settings are read on the day's own connection, then handed to heal_day with that
    # connection and the day's DuckDB connection. Every work day is on or after
    # INSERT_MISSED_FROM, so inserts are on; nothing here passes an expected sha.
    tape = str(Path(f"/cache/{WORK[4]}-fulltape.parquet"))
    night.replay.assert_called_once_with(night.duck, tape, WORK[4])
    night.covering.assert_called_once_with(night.conn, WORK[4])
    night.heal.assert_called_once_with(
        night.conn,
        night.duck,
        tape,
        WORK[4],
        SETTINGS,
        insert_missed=True,
        apply=True,
        replay=_replay_of(WORK[4]),
    )


def test_skips_days_with_a_marker(night: Night, settings: Settings, clock: Clock) -> None:
    night.markers.update({WORK[1], WORK[3]})

    result = interval_ba_step.run(_ctx(settings, clock))

    assert _days(night.events, "heal") == [WORK[4], WORK[2], WORK[0]]
    assert [c.args[0] for c in night.reader.fetch_day.call_args_list] == [
        WORK[4],
        WORK[2],
        WORK[0],
    ]
    assert result.counts["days_done"] == 3
    assert result.counts["days_waiting_tape"] == 0
    assert result.counts["days_left"] == 0
    # The markers are read once, bounded below by the first work day.
    assert night.events.count("markers") == 1
    assert night.cursor.execute.call_args_list == [call(MARKERS_SQL, {"first": INSERT_MISSED_FROM})]


def test_day_without_tape_waits_without_alert(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_message: MagicMock,
    capture_exception: MagicMock,
) -> None:
    night.landed(WORK[:4])  # the last session's tape has not landed yet

    result = interval_ba_step.run(_ctx(settings, clock))

    assert WORK[4] not in [c.args[0] for c in night.reader.fetch_day.call_args_list]
    assert WORK[4] not in _days(night.events, "heal")
    assert WORK[4] not in night.markers  # it is tomorrow's work
    # Waiting for the tape is neither a failure, nor work left for the budget, nor an alert.
    assert result.status == "ok"
    assert result.counts["days_waiting_tape"] == 1
    assert result.counts["days_done"] == 4
    assert result.counts["days_left"] == 0
    capture_message.assert_not_called()
    capture_exception.assert_not_called()


def test_relanded_day_marker_cleared_and_redone(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # Review Focus 4: every work day was healed on an earlier night. Tonight one day re-landed
    # under a new ETag and one landed again after its object was deleted by hand; a third
    # failed to land and keeps its marker.
    night.markers.update(WORK)
    tape = (
        DayOutcome(WORK[3], "relanded", rows=10, bytes=100),
        DayOutcome(WORK[4], "landed", rows=10, bytes=100),
        DayOutcome(WORK[2], "failed", detail="download"),
    )

    result = interval_ba_step.run(_ctx(settings, clock, tape=tape))

    # Cleared in one statement on the setup connection, before the markers are read.
    assert night.events[: night.events.index("open_reader")] == [
        "connect",
        f"clear {WORK[3]} {WORK[4]}",
        "markers",
        "close",
    ]
    assert _days(night.events, "heal") == [WORK[4], WORK[3]]  # redone, newest first
    assert night.markers == {BEFORE_WORK, *WORK}  # each redo wrote its marker back
    assert result.counts["days_done"] == 2


def test_a_relanded_day_before_insert_missed_from_keeps_its_marker(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # The one-off tool healed it; the step never works a day before INSERT_MISSED_FROM, so
    # clearing its marker would only lose the record.
    night.markers.update(WORK)
    tape = (DayOutcome(BEFORE_WORK, "relanded", rows=10, bytes=100),)

    interval_ba_step.run(_ctx(settings, clock, tape=tape))

    assert night.cursor.execute.call_args_list == [call(MARKERS_SQL, {"first": INSERT_MISSED_FROM})]
    assert BEFORE_WORK in night.markers
    night.heal.assert_not_called()


@pytest.mark.parametrize(
    "status", ["not_posted", "unavailable", "failed", "skipped_disk", "skipped_deadline"]
)
def test_a_day_that_did_not_land_tonight_keeps_its_marker(
    night: Night, settings: Settings, clock: Clock, status: str
) -> None:
    night.markers.update(WORK)
    tape = (DayOutcome(WORK[4], status, detail="x"),)  # type: ignore[arg-type]

    interval_ba_step.run(_ctx(settings, clock, tape=tape))

    assert night.cursor.execute.call_args_list == [call(MARKERS_SQL, {"first": INSERT_MISSED_FROM})]
    night.heal.assert_not_called()


def test_held_day_keeps_its_marker(
    night: Night, settings: Settings, clock: Clock, capture_message: MagicMock
) -> None:
    # A retry would hold again: the day keeps the marker heal_day wrote, and its one alert asks
    # the owner to fix the settings or change the constants, then delete the marker.
    night.landed([WORK[4]])
    night.plans[WORK[4]] = _plan(WORK[4], inserts_held="live settings differ from the tape rule")

    interval_ba_step.run(_ctx(settings, clock))
    second = interval_ba_step.run(_ctx(settings, clock))

    assert WORK[4] in night.markers
    assert _days(night.events, "heal") == [WORK[4]]  # the second night skips it
    assert second.counts["days_done"] == 0
    assert all(c.args[0] != CLEAR_SQL for c in night.cursor.execute.call_args_list)
    assert len(_health_calls(capture_message)) == 1  # one alert, not one a night


def test_no_work_days_is_ok_and_opens_no_reader(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.markers.update(WORK)

    result = interval_ba_step.run(_ctx(settings, clock))

    assert result.status == "ok"
    assert result.counts == dict.fromkeys(COUNT_NAMES, 0)
    night.open_reader.assert_not_called()
    assert night.connect.call_count == 1


@pytest.mark.parametrize(
    "stage", ["connect", "clear", "markers", "open_reader", "research_store", "landed_days"]
)
def test_a_setup_failure_propagates_for_the_runner_to_report(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    capture_message: MagicMock,
    stage: str,
) -> None:
    failure = RuntimeError(stage)
    tape = (DayOutcome(WORK[4], "relanded", rows=10, bytes=100),)
    if stage == "connect":
        night.connect.side_effect = failure
    elif stage in ("clear", "markers"):
        execute = night.cursor.execute.side_effect
        failing_sql = CLEAR_SQL if stage == "clear" else MARKERS_SQL

        def failing_execute(sql: str, params: dict[str, Any]) -> None:
            if sql == failing_sql:
                raise failure
            execute(sql, params)

        night.cursor.execute.side_effect = failing_execute
    elif stage == "open_reader":
        night.open_reader.side_effect = failure
    elif stage == "research_store":
        night.store_class.side_effect = failure
    else:
        night.reader.landed_days.side_effect = failure

    with pytest.raises(RuntimeError) as raised:
        interval_ba_step.run(_ctx(settings, clock, tape=tape))

    assert raised.value is failure
    # run_steps sends it once, scrubbed; a second capture here would be unscrubbed.
    capture_exception.assert_not_called()
    capture_message.assert_not_called()
    night.replay.assert_not_called()  # no day was tried: no replay, no file, no heal
    night.store.put_file.assert_not_called()
    night.heal.assert_not_called()


# --- the loop -------------------------------------------------------------------------


def test_one_connection_per_day_after_download(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # Neon never idles through a download, a replay or the day file's put: each day opens its
    # DuckDB connection after its tape is on disk, replays and writes the day file, and only then
    # opens its Neon connection. Both close before the tape is released.
    night.landed(WORK[3:])

    interval_ba_step.run(_ctx(settings, clock))

    assert night.events[: night.events.index("open_reader")] == ["connect", "markers", "close"]
    after_setup = night.events[night.events.index("open_reader") + 1 :]
    assert after_setup == [
        event
        for day in (WORK[4], WORK[3])
        for event in (
            f"fetch {day}",
            "duck open",
            f"replay {day}",
            f"put {day_key(day)}",
            "connect",
            f"settings {day}",
            f"heal {day}",
            "close",
            "duck close",
            f"release {day}",
        )
    ]
    assert night.duckdb_connect.call_count == 2  # a fresh DuckDB connection per day


def test_duckdb_limits_and_temp_dir_set(
    night: Night, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The real duckdb.connect: the day's connection reports the settings it runs with.
    monkeypatch.setattr(interval_ba_step.duckdb, "connect", REAL_DUCKDB_CONNECT)
    night.landed([WORK[4]])
    seen: list[tuple[str, int, str]] = []

    def reading_heal(
        _conn: object, con: duckdb.DuckDBPyConnection, *_args: object, **_kwargs: object
    ) -> DayPlan:
        seen.append(
            con.execute(
                "SELECT current_setting('memory_limit'), current_setting('threads'),"
                " current_setting('temp_directory')"
            ).fetchone()
        )
        return _plan(WORK[4])

    night.heal.side_effect = reading_heal

    interval_ba_step.run(_ctx(settings, clock))

    ((memory, threads, temp_directory),) = seen
    with REAL_DUCKDB_CONNECT() as reference:
        reference.execute(f"SET memory_limit = '{INTERVAL_BA_DUCKDB_MEMORY}'")
        (expected_memory,) = reference.execute("SELECT current_setting('memory_limit')").fetchone()
    assert memory == expected_memory  # DuckDB's own default is 80% of the machine's memory
    assert threads == INTERVAL_BA_DUCKDB_THREADS == 2
    # DuckDB creates only the last level of temp_directory, so it sits directly in the step's
    # cache directory (the fixture's, in place of the real one), which open_reader creates (and
    # empties, spill a killed run left included).
    assert Path(temp_directory).resolve() == (night.cache_dir / "duckdb-tmp").resolve()
    assert INTERVAL_BA_CACHE_DIR == WORK_DIR / "interval-ba"
    # A quarter of the Railway nightly service's 8,000,000,000-byte limit, below 2000MiB.
    # DuckDB's GB is 10**9 bytes.
    assert INTERVAL_BA_DUCKDB_MEMORY == "2GB"


def test_failing_day_does_not_stop_others(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    capture_message: MagicMock,
) -> None:
    failure = psycopg2.OperationalError("fixture")
    night.plans[WORK[3]] = failure

    result = interval_ba_step.run(_ctx(settings, clock))

    assert _days(night.events, "heal") == NEWEST_FIRST
    assert night.reader.release.call_args_list == [call(day) for day in NEWEST_FIRST]
    assert (result.counts["days_done"], result.counts["days_failed"]) == (4, 1)
    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    # One exception, tagged with the step and the day; monitoring.scrub_event cuts its text.
    capture_exception.assert_called_once_with(
        failure, tags={"step": STEP_NAME, "day": WORK[3].isoformat()}
    )
    assert WORK[3] not in night.markers  # rolled back: tomorrow retries it
    capture_message.assert_not_called()  # a failed day has no plan to judge


@pytest.mark.parametrize(
    "stage", ["fetch", "missing", "duckdb", "connect", "settings", "no-tape-rows"]
)
def test_a_failure_at_any_stage_of_a_day_is_that_days_alone(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    capture_message: MagicMock,
    stage: str,
) -> None:
    # R2 refuses the read or the object vanished after the listing; DuckDB or Neon will not
    # open; the settings read fails; the tape holds no 0DTE rows for the day (replay_day's
    # ValueError: a broken tape, never a day with no alerts).
    failing, after = WORK[4], WORK[3]
    night.landed([after, failing])
    failure: Exception = RuntimeError("landed tape missing from R2")
    if stage == "fetch":
        failure = TapeReadError("fixture")
    if stage in ("fetch", "missing"):
        fetch = night.reader.fetch_day.side_effect

        def fetch_day(day: date, deadline: float | None = None) -> Path | None:
            if day != failing:
                return fetch(day, deadline)
            if stage == "fetch":
                raise failure
            return None  # R2 has no such object

        night.reader.fetch_day.side_effect = fetch_day
    elif stage == "duckdb":
        failure = duckdb.IOException("fixture")
        night.duckdb_connect.side_effect = [failure, night.duck]
    elif stage == "connect":
        failure = psycopg2.OperationalError("fixture")
        connect = night.connect.side_effect
        opened: list[None] = []

        def failing_connect(settings: Settings):
            opened.append(None)
            if len(opened) == 2:  # the first is the setup connection, the second the day's
                raise failure
            return connect(settings)

        night.connect.side_effect = failing_connect
    elif stage == "settings":
        failure = psycopg2.OperationalError("fixture")
        night.covering.side_effect = [failure, SETTINGS]
    else:
        failure = ValueError("no 0DTE SPXW/SPY/QQQ rows: wrong day or broken tape")
        night.replays[failing] = failure

    result = interval_ba_step.run(_ctx(settings, clock))

    if stage == "missing":
        ((raised,), kwargs) = capture_exception.call_args
        assert isinstance(raised, RuntimeError)
        assert str(raised) == "landed tape missing from R2"  # fixed: no key, path or date
        assert kwargs == {"tags": {"step": STEP_NAME, "day": failing.isoformat()}}
    else:
        capture_exception.assert_called_once_with(
            failure, tags={"step": STEP_NAME, "day": failing.isoformat()}
        )
    assert capture_exception.call_count == 1
    assert result.status == "failed"
    assert (result.counts["days_failed"], result.counts["days_done"]) == (1, 1)
    assert night.reader.release.call_args_list == [call(failing), call(after)]
    assert _days(night.events, "heal")[-1] == after  # the next day still ran
    assert failing not in night.markers
    capture_message.assert_not_called()
    if stage == "no-tape-rows":
        # A broken tape is no day with no alerts: no day file, and no heal on it.
        assert night.puts_for(failing) == []
        assert failing not in _days(night.events, "heal")
    if stage in ("fetch", "missing"):
        # Nothing was opened for the day whose download failed.
        assert night.duckdb_connect.call_count == 1
        assert night.connect.call_count == 2  # setup and `after`


def test_failure_cap_of_three_fails_the_step(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    assert INTERVAL_BA_MAX_DAY_FAILURES == 3
    for day in WORK:
        night.plans[day] = RuntimeError(f"day {day}")

    result = interval_ba_step.run(_ctx(settings, clock))

    assert night.reader.fetch_day.call_count == 3  # not 4: a broken night costs 3 downloads
    assert [c.kwargs["tags"]["day"] for c in capture_exception.call_args_list] == [
        d.isoformat() for d in NEWEST_FIRST[:3]
    ]
    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    assert result.counts["days_failed"] == 3
    assert result.counts["days_left"] == 2
    assert result.counts["days_done"] == 0
    assert night.reader.release.call_count == 3


def test_deadline_leaves_partial_with_days_left(
    night: Night, settings: Settings, clock: Clock
) -> None:
    # Room for two days: after the second, less than a day's budget is left.
    healthy = night.heal.side_effect
    night.heal.side_effect = lambda *a, **k: (
        clock.advance(INTERVAL_BA_DAY_BUDGET_SECONDS) or healthy(*a, **k)
    )

    result = interval_ba_step.run(
        _ctx(settings, clock, left=2 * INTERVAL_BA_DAY_BUDGET_SECONDS + 1)
    )

    assert _days(night.events, "heal") == NEWEST_FIRST[:2]
    assert result.status == "partial"
    assert result.detail == PARTIAL_DETAIL
    assert result.counts["days_done"] == 2
    assert result.counts["days_left"] == 3  # the three oldest days, tomorrow's work
    assert result.counts["days_failed"] == 0


def test_a_day_starts_with_exactly_its_budget_left(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.markers.update(WORK[:4])  # one day of work

    started = interval_ba_step.run(_ctx(settings, clock, left=INTERVAL_BA_DAY_BUDGET_SECONDS))
    night.markers.discard(WORK[4])
    not_started = interval_ba_step.run(
        _ctx(settings, clock, left=INTERVAL_BA_DAY_BUDGET_SECONDS - 1)
    )

    assert started.counts["days_done"] == 1
    assert (not_started.status, not_started.counts["days_left"]) == ("partial", 1)
    assert night.reader.fetch_day.call_count == 1


def test_a_download_never_outlasts_the_step_deadline(
    night: Night, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The download gets FETCH_DEADLINE_SECONDS from the day's start, or the step's deadline if
    # that is nearer (only possible with a budget below FETCH_DEADLINE_SECONDS).
    monkeypatch.setattr(interval_ba_step, "INTERVAL_BA_DAY_BUDGET_SECONDS", 100)
    night.landed([WORK[4]])
    ctx = _ctx(settings, clock, left=FETCH_DEADLINE_SECONDS - 100)

    interval_ba_step.run(ctx)

    night.reader.fetch_day.assert_called_once_with(WORK[4], deadline=ctx.deadline)


def test_counts_add_up_over_the_days(night: Night, settings: Settings, clock: Clock) -> None:
    night.markers.update(WORK[:3])
    night.plans[WORK[4]] = _plan(
        WORK[4], inserted=2, flags_changed=7, spot_filled=3, root_label_mismatch=11
    )
    night.plans[WORK[3]] = _plan(
        WORK[3], inserted=1, flags_changed=1, spot_filled=4, root_label_mismatch=5
    )

    result = interval_ba_step.run(_ctx(settings, clock))

    assert result.counts == {
        **dict.fromkeys(COUNT_NAMES, 0),
        "days_done": 2,
        "replay_days_written": 2,
        "inserted": 3,
        "flags_changed": 8,
        "spot_filled": 7,
        "root_label_mismatch": 16,
    }
    assert all(type(n) is int for n in result.counts.values())


def test_a_base_exception_ends_the_step_after_the_day_is_released(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.plans[WORK[4]] = SystemExit(143)  # SIGTERM

    with pytest.raises(SystemExit):
        interval_ba_step.run(_ctx(settings, clock))

    # Both connections closed, then the tape released, and nothing after.
    assert night.events[-3:] == ["close", "duck close", f"release {WORK[4]}"]
    assert night.reader.release.call_args_list == [call(WORK[4])]
    assert night.reader.fetch_day.call_count == 1  # it did not go on to the next day
    capture_exception.assert_not_called()
    night.reader.__exit__.assert_called_once()  # the reader still closes


# --- the day files --------------------------------------------------------------------


def test_the_step_writes_the_day_file_before_the_heal_commits(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    capture_message: MagicMock,
) -> None:
    # The file goes first. A put that fails leaves no marker (heal_day, which commits it, never
    # runs), so the day is retried the next night; the failure is the day's own, sent once.
    night.landed(WORK[3:])
    failure = RuntimeError("put refused")
    night.put_failures[day_key(WORK[4])] = failure

    result = interval_ba_step.run(_ctx(settings, clock))

    assert WORK[4] not in night.markers
    assert WORK[4] not in _days(night.events, "heal")
    assert night.puts_for(WORK[4]) == []
    capture_exception.assert_called_once_with(
        failure, tags={"step": STEP_NAME, "day": WORK[4].isoformat()}
    )
    assert (result.status, result.detail) == ("failed", FAILED_DETAIL)
    assert (result.counts["days_failed"], result.counts["days_done"]) == (1, 1)
    assert result.counts["replay_days_written"] == 1  # the other day's
    capture_message.assert_not_called()
    # And on the good day the file came first, then Neon, then the heal that writes its marker.
    events = night.events
    assert events.index(f"put {day_key(WORK[3])}") < events.index(f"settings {WORK[3]}")
    assert events.index(f"put {day_key(WORK[3])}") < events.index(f"heal {WORK[3]}")
    # The failed day opened no Neon connection: setup, and the other day's.
    assert night.connect.call_count == 2
    assert night.reader.release.call_args_list == [call(WORK[4]), call(WORK[3])]


def test_the_heal_gets_the_replay_the_file_was_written_from(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.landed([WORK[4]])
    replay = replace(_replay_of(WORK[4]), alerts=_replay_of(WORK[4]).alerts[:2])
    night.replays[WORK[4]] = replay

    interval_ba_step.run(_ctx(settings, clock))

    (put,) = night.puts_for(WORK[4])
    assert put.table.num_rows == 2
    (heal_call,) = night.heal.call_args_list
    assert heal_call.kwargs["replay"] is replay
    assert night.replay.call_count == 1  # the day is replayed once, not once more by the heal


def test_each_day_file_carries_its_day_rows_rule_and_time(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.landed(WORK[3:])

    interval_ba_step.run(_ctx(settings, clock))

    assert [put.key for put in night.puts] == [
        f"research/interval-ba/replay/{day}.parquet" for day in (WORK[4], WORK[3])
    ]
    for put in night.puts:
        day = date.fromisoformat(put.key.rsplit("/", 1)[1].removesuffix(".parquet"))
        assert put.meta == {
            "day": day.isoformat(),
            "rows": 3,
            "rule": rule(),
            "created_at": NOW.isoformat(),
        }
        assert put.table.num_rows == 3
        assert [(f.name, f.type) for f in put.table.schema] == list(EXPORT_COLUMNS)
        assert put.table.column("ticker").to_pylist() == ["SPXW", "SPY", "QQQ"]
        assert put.table.column("expiry").to_pylist() == [day] * 3
        assert put.path == night.cache_dir / f"replay-{day}.parquet"


def test_a_quiet_day_writes_a_zero_row_file(night: Night, settings: Settings, clock: Clock) -> None:
    # "No alerts" and "not written" stay apart: the day still gets its file, with its schema.
    night.landed([WORK[4]])
    night.replays[WORK[4]] = Replay(day=WORK[4], alerts=(), root_label_mismatch=0)

    result = interval_ba_step.run(_ctx(settings, clock))

    (put,) = night.puts_for(WORK[4])
    assert put.table.num_rows == 0
    assert [(f.name, f.type) for f in put.table.schema] == list(EXPORT_COLUMNS)
    assert put.meta["rows"] == 0
    assert put.meta["day"] == WORK[4].isoformat()
    assert result.counts["replay_days_written"] == 1
    assert WORK[4] in night.markers  # and the heal went on


def test_a_replay_that_fires_nothing_alerts_even_when_live_wrote_nothing(
    night: Night, settings: Settings, clock: Clock, capture_message: MagicMock
) -> None:
    # Every session fires at least 19 alerts, so zero on both sides is a replay or tape fault
    # (a column that casts to NULL after a layout change), not a quiet day. The day still gets
    # its file, of zero rows, and its marker.
    night.landed([WORK[4]])
    night.replays[WORK[4]] = Replay(day=WORK[4], alerts=(), root_label_mismatch=0)
    night.plans[WORK[4]] = _plan(WORK[4], tape_alerts=0, live_rows=0, matched=0)

    result = interval_ba_step.run(_ctx(settings, clock))

    (health,) = _health_calls(capture_message)
    assert health.args == (HEALTH_TITLE.format("tape fired no alerts"),)
    assert health.kwargs["fingerprint"] == [
        "interval-ba-live-health",
        "tape fired no alerts",
        WORK[4].isoformat(),
    ]
    assert result.counts["health_alerts"] == 1
    assert (result.status, result.detail) == ("ok", "")
    (put,) = night.puts_for(WORK[4])
    assert put.table.num_rows == 0
    assert WORK[4] in night.markers


def test_a_held_day_whose_replay_fired_nothing_reports_the_tape_not_the_hold(
    night: Night, settings: Settings, clock: Clock, capture_message: MagicMock
) -> None:
    # The replay that fired nothing is the more urgent fault, so it is the one phrase sent, ahead
    # of the hold. The held day keeps its marker (the step never clears one it just wrote), and
    # its zero-row file stands for what the replay fired.
    night.landed([WORK[4]])
    night.replays[WORK[4]] = Replay(day=WORK[4], alerts=(), root_label_mismatch=0)
    night.plans[WORK[4]] = _plan(
        WORK[4], inserts_held="live detector off", tape_alerts=0, live_rows=0, matched=0
    )

    result = interval_ba_step.run(_ctx(settings, clock))

    (health,) = _health_calls(capture_message)
    assert health.args == (HEALTH_TITLE.format(NO_ALERTS),)
    assert health.kwargs["fingerprint"] == [
        "interval-ba-live-health",
        NO_ALERTS,
        WORK[4].isoformat(),
    ]
    assert result.counts["health_alerts"] == 1
    assert WORK[4] in night.markers
    (put,) = night.puts_for(WORK[4])
    assert put.table.num_rows == 0


@pytest.mark.parametrize(
    ("day", "assumed"),
    [
        (INSERT_MISSED_FROM, True),
        (date(2026, 11, 20), True),
        (date(2026, 11, 24), True),
        # uw-stream's first settings row covers 11-25: from there, no row is real.
        (date(2026, 11, 25), False),
        (date(2026, 11, 27), False),
    ],
)
def test_a_day_before_the_first_settings_row_heals_on_the_code_defaults(
    night: Night, settings: Settings, clock: Clock, day: date, assumed: bool
) -> None:
    # Live ran the code's rule on every day before the first settings row, so a re-landed one
    # with no covering row is not "no live settings record": it heals with inserts on. From the
    # first row's day on, an empty read stays empty and heal_day holds the inserts.
    assert date(2026, 11, 25) == interval_ba_step.FIRST_SETTINGS_DAY
    night.markers.update(trading_days(INSERT_MISSED_FROM, day))
    night.markers.discard(day)
    night.landed([day])
    night.covering.side_effect = lambda _conn, d: night.events.append(f"settings {d}") or []
    ctx = StepContext(settings, NOW, day, deadline=clock.now + 100_000.0, tape=())

    interval_ba_step.run(ctx)

    night.covering.assert_called_once_with(night.conn, day)
    (heal_call,) = night.heal.call_args_list
    assert heal_call.args[4] == ([default_settings()] if assumed else [])
    assert heal_call.kwargs["insert_missed"] is True


def test_a_settings_row_that_covers_the_day_is_never_replaced_by_the_defaults(
    night: Night, settings: Settings, clock: Clock
) -> None:
    other = replace(default_settings(), window_sec=60)
    night.landed([WORK[4]])
    night.covering.side_effect = lambda _conn, d: night.events.append(f"settings {d}") or [other]

    interval_ba_step.run(_ctx(settings, clock))

    assert night.heal.call_args.args[4] == [other]


def test_replay_days_written_is_counted(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    # Newest first: a day whose tape has not landed waits (no file); the next day's put fails
    # (no file, no heal); the next writes its file and then its heal fails (the file is in R2, so
    # it counts); the next writes and heals; the oldest already has its marker.
    night.markers.add(WORK[0])
    night.landed([WORK[1], WORK[2], WORK[3]])  # WORK[4] has no tape yet
    night.put_failures[day_key(WORK[3])] = RuntimeError("put refused")
    night.plans[WORK[2]] = RuntimeError("heal failed")

    result = interval_ba_step.run(_ctx(settings, clock))

    assert [put.key for put in night.puts] == [day_key(WORK[2]), day_key(WORK[1])]
    assert result.counts["replay_days_written"] == 2
    assert (result.counts["days_done"], result.counts["days_failed"]) == (1, 2)
    assert result.counts["days_waiting_tape"] == 1
    assert all(type(n) is int for n in result.counts.values())


def test_a_relanded_day_rewrites_its_file(night: Night, settings: Settings, clock: Clock) -> None:
    # Night one writes every day. On night two a re-landed tape clears one marker, so the step
    # redoes that day and puts its key again, from the new tape's replay; no other key is put.
    first = interval_ba_step.run(_ctx(settings, clock))
    assert first.counts["replay_days_written"] == len(WORK)
    assert [len(night.puts_for(day)) for day in WORK] == [1] * len(WORK)
    newer = Replay(day=WORK[3], alerts=_replay_of(WORK[3]).alerts[:1], root_label_mismatch=0)
    night.replays[WORK[3]] = newer
    tape = (DayOutcome(WORK[3], "relanded", rows=10, bytes=100),)

    second = interval_ba_step.run(_ctx(settings, clock, tape=tape))

    assert second.counts["replay_days_written"] == 1
    assert [len(night.puts_for(day)) for day in WORK] == [1, 1, 1, 2, 1]
    old, new = night.puts_for(WORK[3])
    assert (old.table.num_rows, new.table.num_rows) == (3, 1)
    assert new.meta["rows"] == 1


def test_the_day_file_is_the_code_rule_not_live_settings(
    night: Night, settings: Settings, clock: Clock, capture_message: MagicMock
) -> None:
    # Live ran another rule that day and had two tickers off, so heal_day holds the day's
    # inserts. The day file is still the code's rule for all three tickers: it is built from the
    # replay alone, and written before the settings are even read.
    night.landed([WORK[4]])
    other_rule = replace(
        default_settings(), enabled=False, tickers=("SPY",), window_sec=60, premium_floor=1
    )
    night.covering.side_effect = lambda _conn, day: (
        night.events.append(f"settings {day}") or [other_rule]
    )
    night.plans[WORK[4]] = _plan(
        WORK[4], inserts_held="live settings differ from the tape rule", live_rows=0, matched=0
    )

    result = interval_ba_step.run(_ctx(settings, clock))

    (put,) = night.puts_for(WORK[4])
    assert put.table.column("ticker").to_pylist() == ["SPXW", "SPY", "QQQ"]
    assert put.meta["rule"] == rule()
    assert put.meta["rule"]["window-sec"] == "300"
    assert night.events.index(f"put {day_key(WORK[4])}") < night.events.index(f"settings {WORK[4]}")
    # The held day kept the marker heal_day wrote, and the step counted the file.
    assert WORK[4] in night.markers
    assert result.counts["replay_days_written"] == 1
    assert night.heal.call_args.args[4] == [other_rule]  # heal_day alone applies the settings


def test_the_local_day_file_is_removed_after_the_put(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.landed(WORK[3:])
    night.put_failures[day_key(WORK[4])] = RuntimeError("put refused")

    interval_ba_step.run(_ctx(settings, clock))

    # The good day's file was there at the put, and neither it nor the failed day's is left.
    (kept,) = night.puts
    assert kept.key == day_key(WORK[3])
    assert night.puts_for(WORK[3])[0].path.parent == night.cache_dir
    assert list(night.cache_dir.glob("replay-*")) == []


def test_a_failed_day_file_write_is_logged_by_class_alone(
    night: Night,
    settings: Settings,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    capture_exception: MagicMock,
) -> None:
    night.landed([WORK[4]])
    night.put_failures[day_key(WORK[4])] = ConnectionError("https://ep-x.r2.example/bucket key 7")

    with caplog.at_level(logging.DEBUG, logger="interval_ba_step"):
        interval_ba_step.run(_ctx(settings, clock))

    lines = [r.getMessage() for r in caplog.records if r.name == "interval_ba_step"]
    # The stage, then the day's own line; the older days wait for their tapes.
    assert lines[0] == f"interval-ba {WORK[4]} day file write failed (ConnectionError)"
    assert re.fullmatch(rf"interval-ba {WORK[4]} failed \(ConnectionError\) in \d+\.\ds", lines[1])
    assert "ep-x.r2.example" not in caplog.text
    assert "key 7" not in caplog.text


def test_the_day_file_reaches_the_bucket_under_its_key_and_reads_back(
    settings: Settings, clock: Clock, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The one test with the real ResearchStore, on moto: the key passes its research/ check, the
    # put is verified against the file, and what is stored is the table the step built.
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setattr(interval_ba_step, "INTERVAL_BA_CACHE_DIR", tmp_path)
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    config = settings.model_copy(
        update={"r2_endpoint_url": "https://s3.amazonaws.com", "r2_bucket_fulltape": "test-bucket"}
    )
    replay = _replay_of(WORK[4])

    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-bucket")
        interval_ba_step._put_day_file(_ctx(config, clock), ResearchStore(config), replay)
        stored = s3.get_object(Bucket="test-bucket", Key=day_key(WORK[4]))

    body = stored["Body"].read()
    assert stored["ContentType"] == "application/vnd.apache.parquet"
    table = pq.read_table(pa.BufferReader(body))
    assert table.equals(
        export_table(replay.alerts, json.loads(table.schema.metadata[b"interval_ba"]))
    )
    assert table.num_rows == 3
    assert list(tmp_path.glob("replay-*")) == []


def test_the_research_store_is_built_once_and_only_for_a_night_with_work(
    night: Night, settings: Settings, clock: Clock
) -> None:
    night.markers.update(WORK)
    interval_ba_step.run(_ctx(settings, clock))
    night.store_class.assert_not_called()

    night.markers.difference_update(WORK[3:])
    interval_ba_step.run(_ctx(settings, clock))

    night.store_class.assert_called_once_with(settings)


# --- the health alerts ----------------------------------------------------------------

NO_ALERTS = "tape fired no alerts"
# Alerts the fake replay fires on a day (one a ticker), and how many a phrase's case has: none for
# the replay that fired nothing, three for every other.
FIRED = 3


def _fired_for(phrase: str | None) -> int:
    return 0 if phrase == NO_ALERTS else FIRED


# Each case meets its own phrase's condition and every later one's, so the first in the table
# must win: (counts, phrase). `tape_alerts` is the plan's, over the tickers live had on; the
# replay's own count is `_fired_for(phrase)`.
PRECEDENCE = [
    *(
        # A replay that fired nothing outranks a hold: the more urgent fault.
        ({"inserts_held": reason, "tape_alerts": 0, "matched": 0, "live_only": 40}, NO_ALERTS)
        for reason in HELD_REASONS
    ),
    *(
        # Held (each reason is the phrase as heal_day gives it). The replay fired alerts, but the
        # plan's count is 0, as it is on every day live's detector was off; live had rows too.
        ({"inserts_held": reason, "tape_alerts": 0, "matched": 0, "live_only": 40}, reason)
        for reason in HELD_REASONS
    ),
    # The replay or the tape read broke; live_only (every live row) also disagrees.
    ({"tape_alerts": 0, "matched": 0, "live_only": 40}, NO_ALERTS),
    # Live was dark for the on tickers; it missed every tape alert too.
    ({"live_rows": 0, "matched": 0, "live_missed": 40}, "live wrote no alerts"),
    # 5 missed of 40 tape alerts, and 5 live-only of 40 live rows as well.
    ({"live_missed": 5, "live_only": 5, "matched": 35}, "live missed alerts"),
    # 2 of 20 matched keys differ.
    ({"matched": 20, "value_mismatched": 2}, "live and tape rows disagree"),
    # 5 of 40 live rows have no tape alert.
    ({"live_only": 5, "matched": 35, "tape_alerts": 35}, "live and tape rows disagree"),
]


@pytest.mark.parametrize(("counts", "phrase"), PRECEDENCE)
def test_one_health_message_per_day_by_precedence(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_message: MagicMock,
    counts: dict[str, Any],
    phrase: str,
) -> None:
    night.landed([WORK[4]])
    plan = _plan(WORK[4], **counts)
    night.plans[WORK[4]] = plan
    fired = _fired_for(phrase)
    night.replays[WORK[4]] = replace(_replay_of(WORK[4]), alerts=_replay_of(WORK[4]).alerts[:fired])

    result = interval_ba_step.run(_ctx(settings, clock))

    iso = WORK[4].isoformat()
    capture_message.assert_called_once_with(
        HEALTH_TITLE.format(phrase),
        level="error",
        tags={"service": "nightly", "step": STEP_NAME, "day": iso},
        contexts={HEALTH_CONTEXT: {name: getattr(plan, name) for name in HEALTH_COUNTS}},
        fingerprint=["interval-ba-live-health", phrase, iso],
    )
    assert result.counts["health_alerts"] == 1
    # The health of live is its own alert: the step itself is fine.
    assert (result.status, result.detail) == ("ok", "")


@pytest.mark.parametrize(
    ("counts", "phrase"),
    [
        ({}, None),  # healthy
        # No quiet day: every session fires at least 19 alerts, so a replay that fired nothing is
        # a fault whether or not live wrote rows.
        ({"tape_alerts": 0, "live_rows": 0, "matched": 0}, NO_ALERTS),
        ({"tape_alerts": 0, "live_rows": 3, "matched": 0, "live_only": 3}, NO_ALERTS),
        # live missed: at least 5, and more than 10% of the tape's alerts.
        ({"live_missed": 4, "tape_alerts": 4, "live_rows": 1, "matched": 0}, None),
        ({"live_missed": 5, "tape_alerts": 50, "live_rows": 45, "matched": 45}, None),
        (
            {"live_missed": 5, "tape_alerts": 49, "live_rows": 44, "matched": 44},
            "live missed alerts",
        ),
        # value mismatches: at least 20 matched keys, and more than 5% of them.
        ({"matched": 19, "value_mismatched": 19}, None),
        ({"matched": 20, "value_mismatched": 1}, None),
        ({"matched": 39, "value_mismatched": 2}, "live and tape rows disagree"),
        # live-only rows: at least 5, and more than 10% of the live rows.
        ({"live_only": 4, "live_rows": 4, "matched": 0}, None),
        ({"live_only": 5, "live_rows": 50, "matched": 45}, None),
        ({"live_only": 5, "live_rows": 49, "matched": 44}, "live and tape rows disagree"),
    ],
)
def test_health_thresholds(
    capture_message: MagicMock, counts: dict[str, Any], phrase: str | None
) -> None:
    sent = interval_ba_step._report_health(WORK[4], _plan(WORK[4], **counts), _fired_for(phrase))

    assert sent is (phrase is not None)
    if phrase is None:
        capture_message.assert_not_called()
    else:
        assert capture_message.call_args.args == (HEALTH_TITLE.format(phrase),)
        assert capture_message.call_args.kwargs["fingerprint"][1] == phrase


def test_a_day_whose_live_tickers_fired_nothing_is_not_a_tape_fault(
    capture_message: MagicMock,
) -> None:
    # The plan's tape_alerts counts only the tickers live had on, so it is 0 when the replay
    # fired on the others. That is not a replay that fired nothing: no alert on its own.
    plan = _plan(WORK[4], tape_alerts=0, live_rows=0, matched=0)

    assert interval_ba_step._report_health(WORK[4], plan, FIRED) is False
    capture_message.assert_not_called()


class _MemoryTransport(Transport):
    """Keeps each envelope item's wire bytes instead of sending them (as test_monitoring's)."""

    def __init__(self, options: dict[str, Any] | None = None) -> None:
        super().__init__(options)
        self.payloads: list[bytes] = []

    def capture_envelope(self, envelope: Envelope) -> None:
        self.payloads.extend(item.get_bytes() for item in envelope.items)


@pytest.fixture
def sdk_transport() -> Iterator[_MemoryTransport]:
    """A real Client built from init_sentry's own options (its before_send scrubber included),
    bound to an isolation scope, sending nowhere. `default_integrations=False` keeps the SDK
    from patching httpx, http.client and threading for the rest of the session. The global
    `service` tag is stubbed out, so an event that carries it set the tag itself."""
    with (
        patch.object(sentry_sdk, "init", autospec=True) as init,
        patch.object(sentry_sdk, "set_tag", autospec=True),
    ):
        init_sentry("https://public@sentry.invalid/1")
    options = {**init.call_args.kwargs, "default_integrations": False}
    with warnings.catch_warnings():
        # 2.73 deprecates send_default_pii (still honored); older 2.x in the pin don't.
        warnings.filterwarnings("ignore", "The send_default_pii option", DeprecationWarning)
        client = sentry_sdk.Client(transport=_MemoryTransport, **options)
    transport = client.transport
    assert isinstance(transport, _MemoryTransport)
    with sentry_sdk.isolation_scope() as scope:
        scope.set_client(client)
        yield transport
    client.close()


def test_every_health_count_reaches_sentry(sdk_transport: _MemoryTransport) -> None:
    # The SDK trims `extra` to its first 10 keys (MAX_DATABAG_BREADTH), so 13 counts there
    # lose 3 on the wire while a mocked capture_message still sees all of them. Every count is
    # distinct and non-zero, so a dropped or swapped one shows.
    counts = dict(zip(HEALTH_COUNTS, range(101, 101 + len(HEALTH_COUNTS)), strict=True))
    counts["tape_alerts"] = 140  # live missed 103 of them: "live missed alerts"
    plan = _plan(WORK[4], **counts)
    iso = WORK[4].isoformat()

    assert interval_ba_step._report_health(WORK[4], plan, FIRED) is True
    sentry_sdk.get_client().flush(timeout=5)

    (event,) = [e for e in map(json.loads, sdk_transport.payloads) if "level" in e]
    assert event["contexts"][HEALTH_CONTEXT] == {
        name: getattr(plan, name) for name in HEALTH_COUNTS
    }
    assert event["message"] == HEALTH_TITLE.format("live missed alerts")
    assert event["level"] == "error"
    assert event["tags"] == {"service": "nightly", "step": STEP_NAME, "day": iso}
    assert event["fingerprint"] == ["interval-ba-live-health", "live missed alerts", iso]
    assert event["server_name"] == "nightly"
    assert not set(HEALTH_COUNTS) & set(event.get("extra", {}))  # not split across the two


def _run_registered(settings: Settings, clock: Clock, run_seconds: float) -> StepOutcome:
    (step,) = (s for s in STEPS if s.name == STEP_NAME)
    (outcome,) = run_steps(
        [step],
        settings=settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=clock.now + run_seconds,
        tape=(),
        on_outcome=report_step,
    )
    return outcome


@pytest.mark.parametrize("status", ["failed", "partial"])
def test_health_message_sent_even_when_days_left_or_a_day_failed(
    night: Night,
    settings: Settings,
    clock: Clock,
    capture_message: MagicMock,
    capture_exception: MagicMock,
    status: str,
) -> None:
    # The step's own report carries one detail, which a failed day or days left would hide:
    # the health message is sent for its day whatever the step ends as.
    night.plans[WORK[4]] = _plan(WORK[4], live_missed=12, live_rows=28, matched=28)
    if status == "failed":
        night.plans[WORK[3]] = RuntimeError("fixture")
        run_seconds = 100_000.0
    else:
        healthy = night.heal.side_effect
        night.heal.side_effect = lambda *a, **k: (
            clock.advance(INTERVAL_BA_DAY_BUDGET_SECONDS) or healthy(*a, **k)
        )
        run_seconds = INTERVAL_BA_DAY_BUDGET_SECONDS  # room for the newest day only

    outcome = _run_registered(settings, clock, run_seconds)

    assert outcome.status == status
    assert outcome.counts["health_alerts"] == 1
    (health,) = _health_calls(capture_message)
    assert health.kwargs["fingerprint"] == [
        "interval-ba-live-health",
        "live missed alerts",
        WORK[4].isoformat(),
    ]
    assert health.kwargs["contexts"][HEALTH_CONTEXT]["live_missed"] == 12
    # ...and the step's own report is a separate message.
    step_reports = [
        c for c in capture_message.call_args_list if c not in _health_calls(capture_message)
    ]
    assert [c.args for c in step_reports] == [(f"nightly step {status}",)]
    assert step_reports[0].kwargs["fingerprint"] == [
        "nightly-step",
        STEP_NAME,
        status,
        FAILED_DETAIL if status == "failed" else PARTIAL_DETAIL,
    ]


def test_no_exception_text_in_detail(
    night: Night,
    settings: Settings,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    capture_exception: MagicMock,
) -> None:
    night.landed([WORK[4]])
    night.plans[WORK[4]] = ValueError("host ep-x.neon.tech row 7")

    with caplog.at_level(logging.DEBUG):
        result = interval_ba_step.run(_ctx(settings, clock))

    assert result.detail == FAILED_DETAIL
    assert "ValueError" in caplog.text
    assert "ep-x.neon.tech" not in caplog.text
    assert "row 7" not in caplog.text
    assert "ep-x.neon.tech" not in result.detail
    assert all(type(n) is int for n in result.counts.values())


# --- logs and the registered step -----------------------------------------------------


def test_one_log_line_per_day_with_its_status_counts_and_seconds(
    night: Night, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    night.markers.add(WORK[0])
    night.landed(WORK[1:4])  # WORK[4] waits for its tape
    night.plans[WORK[3]] = _plan(WORK[3], live_missed=6, live_rows=34, matched=34, inserted=6)
    night.plans[WORK[2]] = RuntimeError("fixture")

    with caplog.at_level(logging.INFO, logger="interval_ba_step"):
        interval_ba_step.run(_ctx(settings, clock))

    records = [r for r in caplog.records if r.name == "interval_ba_step"]
    waiting, missed, failed, ok = (r.getMessage() for r in records)
    assert waiting == f"interval-ba {WORK[4]} waiting for the tape"
    assert re.fullmatch(
        rf"interval-ba {WORK[3]} live missed alerts tape_alerts=40 live_rows=34 live_missed=6"
        rf" matched=34 inserted=6 in \d+\.\ds",
        missed,
    )
    assert re.fullmatch(rf"interval-ba {WORK[2]} failed \(RuntimeError\) in \d+\.\ds", failed)
    assert re.fullmatch(
        rf"interval-ba {WORK[1]} ok tape_alerts=40 live_rows=40 matched=40 in \d+\.\ds", ok
    )
    assert [r.levelno for r in records] == [
        logging.INFO,
        logging.WARNING,
        logging.WARNING,
        logging.INFO,
    ]


def test_the_step_tag_is_the_registered_name(
    night: Night, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    night.landed([WORK[4]])
    night.plans[WORK[4]] = RuntimeError("fixture")

    outcome = _run_registered(settings, clock, 100_000.0)

    # The day's own exception (not run_steps's, which carries the step tag alone).
    assert (outcome.status, outcome.error) == ("failed", None)
    assert set(outcome.counts) == COUNT_NAMES  # a valid StepResult: names and ints
    capture_exception.assert_called_once()
    assert capture_exception.call_args.kwargs["tags"] == {
        "step": STEP_NAME,
        "day": WORK[4].isoformat(),
    }


def test_a_clean_night_reports_nothing(
    night: Night, settings: Settings, clock: Clock, capture_message: MagicMock
) -> None:
    outcome = _run_registered(settings, clock, 100_000.0)

    assert (outcome.status, outcome.detail) == ("ok", "")
    assert outcome.counts["days_done"] == len(WORK)
    capture_message.assert_not_called()
