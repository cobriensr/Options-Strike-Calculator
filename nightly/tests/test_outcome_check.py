"""Tests for the outcome check: the one share query, the null/low classification, the Sentry
alerts and the step result.

The connection is a MagicMock whose cursor hands back canned rows, and `connect_db` is
patched at outcome_check's module boundary, so nothing reaches a database. Sentry is
patched on the sentry_sdk module (as in test_monitoring). Rows are what psycopg2 returns:
a `datetime.date` for the DATE column and plain ints for the counts.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from time import monotonic
from types import SimpleNamespace
from unittest.mock import MagicMock, create_autospec

import psycopg2
import psycopg2.errors
import pytest
import sentry_sdk

import outcome_check
from config import Settings, load_settings
from constants import LOW_OUTCOME_SHARE, OUTCOME_CHECK_SESSIONS
from monitoring import report_step
from outcome_check import (
    OUTCOME_TABLES,
    DayShare,
    classify_share,
    outcome_shares,
    recent_sessions,
    report_shares,
    run,
)
from pipeline import STEPS
from steps import StepContext, StepOutcome, run_steps

NOW = datetime(2026, 11, 7, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 6)  # a Friday
SESSIONS = [date(2026, 11, 4), date(2026, 11, 5), date(2026, 11, 6)]
LOTTERY = "lottery_finder_fires"
SILENT_BOOM = "silent_boom_alerts"
FAILED_DETAIL = "a recent session has no outcomes"
NULL_TITLE = "nightly outcomes all null"
LOW_TITLE = "nightly outcomes mostly null"


@pytest.fixture
def settings() -> Settings:
    return load_settings()


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


def _ctx(settings: Settings, last_session: date = LAST_SESSION) -> StepContext:
    return StepContext(settings, NOW, last_session, deadline=1_300.0, tape=())


def _share(
    table: str = LOTTERY, day: date = SESSIONS[0], rows: int = 100, with_outcome: int = 100
) -> DayShare:
    return DayShare(table, day, rows, with_outcome)


def _conn(rows: list[tuple[str, date, int, int]]) -> tuple[MagicMock, MagicMock]:
    """A connection whose cursor (used as a context manager) fetches `rows`."""
    cursor = MagicMock()
    cursor.fetchall.return_value = rows
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    return conn, cursor


def _patch_db(monkeypatch: pytest.MonkeyPatch, rows: list[tuple[str, date, int, int]]):
    """Patch outcome_check.connect_db to yield a connection that fetches `rows`."""
    conn, cursor = _conn(rows)
    connect = MagicMock()
    connect.return_value.__enter__.return_value = conn
    monkeypatch.setattr(outcome_check, "connect_db", connect)
    return SimpleNamespace(connect=connect, conn=conn, cursor=cursor)


def _all_pairs(with_outcome: int, rows: int = 100) -> list[tuple[str, date, int, int]]:
    return [(table, day, rows, with_outcome) for table in OUTCOME_TABLES for day in SESSIONS]


# --- the step -------------------------------------------------------------------------


def test_null_day_is_an_error_and_fails_the_step(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    db = _patch_db(
        monkeypatch,
        [
            (LOTTERY, date(2026, 11, 4), 120, 120),
            (LOTTERY, date(2026, 11, 5), 40, 0),
            (SILENT_BOOM, date(2026, 11, 5), 6, 6),
        ],
    )

    result = run(_ctx(settings))

    assert result.status == "failed"
    assert result.counts == {"days_checked": 3, "null_days": 1, "low_days": 0}
    # A fixed phrase: it is part of the `nightly step failed` fingerprint.
    assert result.detail == FAILED_DETAIL
    capture_message.assert_called_once_with(
        NULL_TITLE,
        level="error",
        tags={"table": LOTTERY, "day": "2026-11-05"},
        extras={"rows": 40, "with_outcome": 0},
        fingerprint=["nightly-outcomes", "null", LOTTERY, "2026-11-05"],
    )
    db.connect.assert_called_once_with(settings)


def test_healthy_sessions_pass_quietly(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    _patch_db(monkeypatch, _all_pairs(with_outcome=100))

    result = run(_ctx(settings))

    assert result.status == "ok"
    # Every count is in (table, day) pairs with rows: 2 tables x 3 sessions.
    assert result.counts == {"days_checked": 6, "null_days": 0, "low_days": 0}
    assert result.detail == ""
    capture_message.assert_not_called()


def test_low_days_alone_warn_but_do_not_fail_the_step(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    _patch_db(monkeypatch, [(SILENT_BOOM, SESSIONS[2], 100, 90)])

    result = run(_ctx(settings))

    assert result.status == "ok"
    assert result.counts == {"days_checked": 1, "null_days": 0, "low_days": 1}
    assert result.detail == ""
    capture_message.assert_called_once()
    assert capture_message.call_args.args == (LOW_TITLE,)
    assert capture_message.call_args.kwargs["level"] == "warning"


def test_run_checks_the_recent_sessions_in_one_query(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    db = _patch_db(monkeypatch, [])

    result = run(_ctx(settings, last_session=date(2026, 11, 27)))

    assert result.status == "ok"
    assert result.counts == {"days_checked": 0, "null_days": 0, "low_days": 0}  # no rows, no pairs
    db.cursor.execute.assert_called_once()
    (_sql, params) = db.cursor.execute.call_args.args
    assert params == {"days": [date(2026, 11, 24), date(2026, 11, 25), date(2026, 11, 27)]}


def test_a_failed_connect_propagates_for_the_runner_to_report(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    # run_steps turns the raise into `failed` with the class name and sends the exception,
    # scrubbed; this step must neither swallow it nor report a second, unscrubbed event.
    failure = psycopg2.OperationalError('connection to server at "ep-x.neon.tech" failed')
    connect = MagicMock()
    connect.return_value.__enter__.side_effect = failure
    monkeypatch.setattr(outcome_check, "connect_db", connect)

    with pytest.raises(psycopg2.OperationalError) as raised:
        run(_ctx(settings))

    assert raised.value is failure
    capture_message.assert_not_called()


def test_a_failed_query_propagates_for_the_runner_to_report(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    db = _patch_db(monkeypatch, [])
    failure = psycopg2.errors.QueryCanceled("canceling statement due to statement timeout")
    db.cursor.execute.side_effect = failure

    with pytest.raises(psycopg2.errors.QueryCanceled) as raised:
        run(_ctx(settings))

    assert raised.value is failure
    capture_message.assert_not_called()


def _run_registered_step(settings: Settings) -> StepOutcome:
    """The registered outcome check under the real runner, reported as main reports it."""
    (step,) = (s for s in STEPS if s.name == "outcome-check")
    (outcome,) = run_steps(
        [step],
        settings=settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=monotonic() + 1_000,
        tape=(),
        on_outcome=report_step,
    )
    return outcome


def test_a_null_day_alerts_with_the_day_error_and_the_step_failure(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    # Both are wanted: the step issue stays one issue, the day errors name the day.
    _patch_db(monkeypatch, [(LOTTERY, SESSIONS[1], 40, 0)])

    outcome = _run_registered_step(settings)

    assert outcome.status == "failed"
    assert outcome.error is None
    assert outcome.detail == FAILED_DETAIL
    assert outcome.counts == {"days_checked": 1, "null_days": 1, "low_days": 0}
    titles = [c.args[0] for c in capture_message.call_args_list]
    assert titles == [NULL_TITLE, "nightly step failed"]
    step_alert = capture_message.call_args_list[1]
    assert step_alert.kwargs["fingerprint"] == [
        "nightly-step",
        "outcome-check",
        "failed",
        FAILED_DETAIL,
    ]


def test_the_runner_reports_a_failed_connect_once_with_its_class_name(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    capture_message: MagicMock,
    capture_exception: MagicMock,
) -> None:
    failure = psycopg2.OperationalError('connection to server at "ep-x.neon.tech" failed')
    connect = MagicMock()
    connect.return_value.__enter__.side_effect = failure
    monkeypatch.setattr(outcome_check, "connect_db", connect)

    outcome = _run_registered_step(settings)

    assert (outcome.status, outcome.error) == ("failed", "OperationalError")
    capture_exception.assert_called_once_with(failure, tags={"step": "outcome-check"})
    capture_message.assert_not_called()  # report_step skips a step that raised


def test_alerts_are_sent_after_the_connection_closes(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    db = _patch_db(monkeypatch, [(LOTTERY, SESSIONS[0], 10, 0)])
    closes_at_each_alert: list[int] = []
    capture_message.side_effect = lambda *args, **kwargs: closes_at_each_alert.append(
        db.connect.return_value.__exit__.call_count
    )

    run(_ctx(settings))

    assert closes_at_each_alert == [1]  # a slow Sentry never holds a Neon connection open


# --- classification -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rows", "with_outcome", "kind"),
    [
        (100, 0, "null"),
        (1, 0, "null"),
        (100, 1, "low"),
        (100, 94, "low"),  # 0.94
        (100, 95, "ok"),  # 0.95 exactly is the floor, not below it
        (10_000, 9_926, "ok"),  # 0.9926, the share a healthy night shows
        (100, 100, "ok"),
        (1, 1, "ok"),
    ],
)
def test_low_share_classifies_at_the_threshold(rows: int, with_outcome: int, kind: str) -> None:
    assert classify_share(_share(rows=rows, with_outcome=with_outcome)) == kind


def test_the_threshold_is_the_owners_95_percent() -> None:
    assert LOW_OUTCOME_SHARE == 0.95


def test_classify_share_sends_nothing(capture_message: MagicMock) -> None:
    for with_outcome in (0, 50, 100):
        classify_share(_share(with_outcome=with_outcome))

    capture_message.assert_not_called()


# --- the alerts -----------------------------------------------------------------------


def test_low_days_send_one_summary_per_run(capture_message: MagicMock) -> None:
    d4, d5, d6 = SESSIONS
    # Out of order on purpose: the summary and its fingerprint list the pairs sorted.
    low = [
        _share(SILENT_BOOM, d5, with_outcome=80),
        _share(LOTTERY, d6, with_outcome=94),
        _share(LOTTERY, d4, with_outcome=50),
        _share(SILENT_BOOM, d4, with_outcome=1),
        _share(LOTTERY, d5, with_outcome=90),
    ]
    null = _share(SILENT_BOOM, d6, with_outcome=0)

    assert report_shares([*low, null]) == (1, 5)

    titles = [c.args[0] for c in capture_message.call_args_list]
    assert titles == [NULL_TITLE, LOW_TITLE]  # the five low pairs make one message
    summary = next(c for c in capture_message.call_args_list if c.args[0] == LOW_TITLE)
    days = [
        f"{LOTTERY}:2026-11-04",
        f"{LOTTERY}:2026-11-05",
        f"{LOTTERY}:2026-11-06",
        f"{SILENT_BOOM}:2026-11-04",
        f"{SILENT_BOOM}:2026-11-05",
    ]
    assert summary.kwargs == {
        "level": "warning",
        "extras": {"count": 5, "days": days},
        "fingerprint": ["nightly-outcomes", "low", *days],
    }
    # The null pair still sends its own error.
    error = next(c for c in capture_message.call_args_list if c.args[0] == NULL_TITLE)
    assert error.kwargs["level"] == "error"
    assert error.kwargs["tags"] == {"table": SILENT_BOOM, "day": "2026-11-06"}


def test_a_summary_fingerprint_follows_the_set_of_low_days(capture_message: MagicMock) -> None:
    report_shares([_share(LOTTERY, SESSIONS[0], with_outcome=90)])
    report_shares([_share(LOTTERY, SESSIONS[0], with_outcome=91)])
    report_shares([_share(LOTTERY, SESSIONS[1], with_outcome=90)])

    first, again, other = (c.kwargs["fingerprint"] for c in capture_message.call_args_list)
    assert first == again  # the same pair at a different share: one issue
    assert first != other  # a different pair: its own issue


def test_null_alerts_are_bounded_by_tables_times_sessions(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    _patch_db(monkeypatch, _all_pairs(with_outcome=0))

    result = run(_ctx(settings))

    bound = len(OUTCOME_TABLES) * OUTCOME_CHECK_SESSIONS
    assert bound == 6
    assert capture_message.call_count == bound
    assert {c.args[0] for c in capture_message.call_args_list} == {NULL_TITLE}
    assert {c.kwargs["level"] for c in capture_message.call_args_list} == {"error"}
    assert result.status == "failed"
    assert result.counts == {"days_checked": bound, "null_days": bound, "low_days": 0}


def test_day_without_rows_is_not_alerted(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, capture_message: MagicMock
) -> None:
    # Only one table has fires, on two of the three days: no row, no share, no alert.
    rows = [(LOTTERY, SESSIONS[0], 80, 80), (LOTTERY, SESSIONS[2], 75, 75)]
    conn, _cursor = _conn(rows)

    assert outcome_shares(conn, SESSIONS) == [
        _share(day=SESSIONS[0], rows=80, with_outcome=80),
        _share(day=SESSIONS[2], rows=75, with_outcome=75),
    ]

    _patch_db(monkeypatch, rows)
    result = run(_ctx(settings))

    assert result.status == "ok"
    assert result.counts == {"days_checked": 2, "null_days": 0, "low_days": 0}
    capture_message.assert_not_called()


def test_null_fingerprint_is_per_table_and_day(capture_message: MagicMock) -> None:
    d4, d5, _ = SESSIONS
    shares = [
        _share(LOTTERY, d4, with_outcome=0),
        _share(SILENT_BOOM, d4, with_outcome=0),
        _share(LOTTERY, d5, with_outcome=0),
    ]

    assert report_shares(shares) == (3, 0)
    assert report_shares(shares) == (3, 0)  # a second night reports the same pairs

    prints = [c.kwargs["fingerprint"] for c in capture_message.call_args_list]
    assert prints[:3] == [
        ["nightly-outcomes", "null", LOTTERY, "2026-11-04"],
        ["nightly-outcomes", "null", SILENT_BOOM, "2026-11-04"],
        ["nightly-outcomes", "null", LOTTERY, "2026-11-05"],
    ]
    assert prints[3:] == prints[:3]  # a repeat adds events to the same three issues


def test_a_clean_report_sends_nothing(capture_message: MagicMock) -> None:
    assert report_shares([]) == (0, 0)
    assert report_shares([_share(with_outcome=100), _share(with_outcome=95)]) == (0, 0)

    capture_message.assert_not_called()


# --- the query ------------------------------------------------------------------------


def test_outcome_tables_are_the_two_fire_tables() -> None:
    assert OUTCOME_TABLES == (LOTTERY, SILENT_BOOM)


def test_outcome_shares_queries_both_tables_by_date_any() -> None:
    conn, cursor = _conn([(LOTTERY, SESSIONS[1], 100, 99), (SILENT_BOOM, SESSIONS[1], 4, 0)])

    shares = outcome_shares(conn, SESSIONS)

    # Columns map by position: rows then with_outcome, never swapped.
    assert shares == [
        DayShare(LOTTERY, SESSIONS[1], rows=100, with_outcome=99),
        DayShare(SILENT_BOOM, SESSIONS[1], rows=4, with_outcome=0),
    ]
    # One statement for both tables: it is bounded by a single statement timeout.
    conn.cursor.assert_called_once_with()
    cursor.execute.assert_called_once()
    sql, params = cursor.execute.call_args.args
    assert " UNION ALL " in sql
    assert re.findall(r"\bFROM (\w+)", sql) == list(OUTCOME_TABLES)
    assert sql.count("date = ANY(%(days)s::date[])") == len(OUTCOME_TABLES)
    assert sql.count("count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL)") == len(OUTCOME_TABLES)
    assert sql.count("GROUP BY date") == len(OUTCOME_TABLES)
    # Dates, not strings or datetimes: psycopg2 sends a date[] the `date` column compares to.
    assert params == {"days": SESSIONS}
    assert all(type(day) is date for day in params["days"])


def test_outcome_shares_sends_the_days_as_a_list() -> None:
    conn, cursor = _conn([])
    days = (date(2026, 11, 5), date(2026, 11, 6))  # a tuple would adapt as a row, not an array

    assert outcome_shares(conn, days) == []

    assert cursor.execute.call_args.args[1] == {"days": [date(2026, 11, 5), date(2026, 11, 6)]}


# --- the calendar ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("last_session", "expected"),
    [
        # The clocks go back on 2026-11-01; the weekend is skipped.
        (date(2026, 11, 3), [date(2026, 10, 30), date(2026, 11, 2), date(2026, 11, 3)]),
        # Thanksgiving, 2026-11-26, is skipped.
        (date(2026, 11, 27), [date(2026, 11, 24), date(2026, 11, 25), date(2026, 11, 27)]),
        (date(2026, 11, 2), [date(2026, 10, 29), date(2026, 10, 30), date(2026, 11, 2)]),
        # Labor Day, 2026-09-07.
        (date(2026, 9, 8), [date(2026, 9, 3), date(2026, 9, 4), date(2026, 9, 8)]),
    ],
)
def test_recent_sessions_across_dst_and_holidays(last_session: date, expected: list[date]) -> None:
    assert recent_sessions(last_session, 3) == expected


def test_recent_sessions_counts_n_ascending_and_ends_on_the_session() -> None:
    assert recent_sessions(LAST_SESSION, 1) == [LAST_SESSION]
    assert recent_sessions(LAST_SESSION, 0) == []
    five = recent_sessions(LAST_SESSION, 5)
    assert len(five) == 5
    assert five == sorted(five)
    assert five[-1] == LAST_SESSION
