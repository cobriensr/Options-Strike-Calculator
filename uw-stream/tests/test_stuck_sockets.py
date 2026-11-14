"""Tests for stuck_sockets: alert on and reconnect a trade socket that is up but silent (Task 6),
alert when every copy of a trade feed is silent in market hours (Task 7), and reconnect every
copy of a silent feed (Task 8).

Each option_trades:<TICKER> channel is joined on two sockets, a twin pair. A
socket that stays connected and never receives another trade frame raised
nothing before Task 6: the twin-silence warning needs a trade frame to end a
gap. ``socket_stats.find_stuck`` is the pure test; these tests cover what
``stuck_sockets`` does with it: one Sentry event per incident, at most one per
shard per cooldown (the alert floor), a forced reconnect bounded by a cooldown,
one escalation, recovery, and a loop that a failing shard, a failing pass or a
loop stall cannot kill.

Task 7 covers what the twin comparison cannot see: every copy of a trade feed
silent at once (or no twins at all). That rule needs the wall clock, for the
trade window. The ``wall_clock`` fixture replaces the module's ``datetime``; it
is a Saturday unless a test moves it into the window, so a Task 6 test never
meets the group rule.

Task 8 acts on the same group incident: while one is open it forces a reconnect of
each connected copy (reason ``silent_trade_feed``), under the per-shard cooldown it
shares with Task 6, and escalates once if the feed is still silent a minute after
the first forced reconnect.

Most tests call ``_check`` with a synthetic monotonic ``now``. ``_NOW`` and the
offsets are exact in binary, so a gap of 60.0 is exactly ``STUCK_S``. The loop
tests replace the module's clock and sleep, as test_pipeline_stats.py does, and
end the loop with a CancelledError from the scripted sleep.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import socket_stats
import stuck_sockets
from connector import Connector
from logger_setup import RateLimitedLogger
from pipeline_stats import LOOP_LAG_FLAG_S
from state import state
from stuck_sockets import (
    FORCED_REASON,
    FORCED_REASON_SILENT_FEED,
    FORCED_RECONNECT_COOLDOWN_S,
    GROUP_SILENT_S,
    STUCK_CHECK_INTERVAL_S,
    _check,
    _Watch,
    run_stuck_socket_watchdog,
)

_NOW = 1_100.5

# Wall-clock instants for the trade window (2026-11-13 is a Friday; EST, UTC-5).
_IN_WINDOW = datetime(2026, 11, 13, 15, 0, tzinfo=UTC)  # 10:00 ET
_AFTER_CLOSE = datetime(2026, 11, 13, 21, 0, tzinfo=UTC)  # 16:00 ET
_NEXT_SESSION = datetime(2026, 11, 16, 15, 0, tzinfo=UTC)  # Monday 10:00 ET
_WEEKEND = datetime(2026, 11, 14, 15, 0, tzinfo=UTC)  # Saturday 10:00 ET
_JUST_BEFORE_THE_OPEN = datetime(2026, 11, 13, 14, 30, 30, tzinfo=UTC)  # 09:30:30 ET
_AT_THE_OPEN = datetime(2026, 11, 13, 14, 31, 0, tzinfo=UTC)  # 09:31:00 ET

# A real option_trades frame (socket_stats ignores short, ack-sized frames).
TRADE = (
    '["option_trades:SPY",{"id":"8f8a2c3b-1234-4567-89ab-cdef01234567","underlying_symbol":"SPY",'
    '"option_chain":"SPY261113C00600000","executed_at":1777663500000,"price":"0.55","size":25,'
    '"underlying_price":"600.85","implied_volatility":"0.412","delta":"0.182","open_interest":1450,'
    '"canceled":false,"exchange":"BATS","tags":["ask_side","bullish"]}]'
)

_STUCK = "uw-stream trade socket stuck"
_STILL_STUCK = "uw-stream trade socket still stuck after a forced reconnect"
_FORCING = "forcing reconnect of a stuck trade socket"
_RECOVERED = "stuck trade socket recovered"
_HELD = "stuck trade socket alert held back"
_CHECK_FAILED = "stuck-socket check failed"
_REASON = "stuck_trade_socket"
_SILENT = "uw-stream option trades silent on every copy"
_SILENT_LOG = "option trades silent on every copy"
_SILENT_HELD = "option trades silent alert held back"
_RESUMED = "option trades resumed"
_STUCK_ENDED = "stuck trade socket incident ended by the trade window"
_SILENT_ENDED = "option trades silent incident ended by the trade window"
_STILL_SILENT = "uw-stream option trades still silent after a forced reconnect"
_FORCING_SILENT = "forcing reconnect of a silent trade feed"
_SILENT_REASON = "silent_trade_feed"


class _Clock:
    """The module's ``datetime``: ``now`` returns ``utc``, which a test moves."""

    def __init__(self) -> None:
        self.utc = _WEEKEND

    def now(self, _tz=None) -> datetime:
        return self.utc


@pytest.fixture(autouse=True)
def wall_clock(monkeypatch) -> _Clock:
    """The wall clock the trade window reads, outside the window until a test moves it."""
    clock = _Clock()
    monkeypatch.setattr(stuck_sockets, "datetime", clock)
    return clock


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    """An empty socket registry, no twins and no connections, so no test sees another's."""
    monkeypatch.setattr(socket_stats, "_registry", {})
    monkeypatch.setattr(socket_stats, "_twins", {})
    monkeypatch.setattr(state, "connections", {})


@pytest.fixture
def events(monkeypatch) -> MagicMock:
    """The module's ``capture_message``: every Sentry event it sends."""
    mock = MagicMock()
    monkeypatch.setattr(stuck_sockets, "capture_message", mock)
    return mock


@pytest.fixture
def logs(monkeypatch) -> dict[str, list[tuple[str, dict]]]:
    """Every ``log.info`` and ``log.warning`` the module makes, as (message, extra).

    The project logger sets ``propagate=False``, so ``caplog`` never sees it.
    """
    out: dict[str, list[tuple[str, dict]]] = {"info": [], "warning": []}
    for level, sink in out.items():
        monkeypatch.setattr(
            stuck_sockets.log,
            level,
            lambda msg, *_a, _sink=sink, **kw: _sink.append((msg, kw["extra"])),
        )
    return out


@pytest.fixture
def errors(monkeypatch) -> list[tuple[str, dict]]:
    """Every error the module logs through ``rate_limited_log``, as (message, extra).

    A fresh limiter per test: the module-level one keeps its windows for the
    whole process.
    """
    out: list[tuple[str, dict]] = []
    monkeypatch.setattr(stuck_sockets, "rate_limited_log", RateLimitedLogger())
    monkeypatch.setattr(
        stuck_sockets.log, "error", lambda msg, *_a, **kw: out.append((msg, kw["extra"]))
    )
    return out


def _pair(first: str = "conn0", second: str = "conn1"):
    """Two registered, connected twins."""
    socket_stats.set_twins({**socket_stats._twins, first: second, second: first})
    state.set_connection(first, True)
    state.set_connection(second, True)
    return socket_stats.get(first), socket_stats.get(second)


def _feed(stats: socket_stats.SocketStats, times: list[float]) -> None:
    for t in times:
        stats.on_frame(TRADE, t)


def _connectors(*names: str, non_trade: tuple[str, ...] = ()) -> dict[str, MagicMock]:
    """Mock connectors by name. Each joins trade channels unless it is named in ``non_trade``.

    ``force_reconnect`` returns True, "acted": the receive loop was running and the
    abort was issued. A test of the no-op sets ``return_value = False``.
    """
    connectors = {}
    for name in names or ("conn0", "conn1"):
        connector = MagicMock(spec=Connector)
        connector.channels = (
            ["net_flow:SPY"] if name in non_trade else ["option_trades:SPY", "option_trades:QQQ"]
        )
        connector.force_reconnect.return_value = True
        connectors[name] = connector
    return connectors


def _stuck_at_now(quiet_gap: float = 60.0):
    """conn0 quiet for ``quiet_gap`` s at ``_NOW`` while its twin conn1 received 150 trades."""
    quiet, twin = _pair()
    quiet.on_frame(TRADE, _NOW - quiet_gap)
    _feed(twin, [_NOW - 30.25] * 150)
    return quiet, twin


def _calls(events: MagicMock) -> list[str]:
    return [c.args[0] for c in events.call_args_list]


# --- the constants -------------------------------------------------------------


def test_the_check_constants_are_the_spec_values():
    assert STUCK_CHECK_INTERVAL_S == 5.0
    assert FORCED_RECONNECT_COOLDOWN_S == 300.0
    assert GROUP_SILENT_S == 60.0
    assert FORCED_REASON == "stuck_trade_socket"
    assert FORCED_REASON_SILENT_FEED == "silent_trade_feed"


# --- an incident: the event, the forced reconnect -----------------------------


class TestOpeningAnIncident:
    def test_a_stuck_shard_sends_one_warning_event_with_what_was_measured(self, events):
        _stuck_at_now(quiet_gap=60.0)
        wall = datetime(2026, 11, 14, 15, 0, 0, tzinfo=UTC)

        with patch.object(stuck_sockets, "datetime") as dt:
            dt.now.return_value = wall
            _check(_Watch(), _connectors(), _NOW)

        events.assert_called_once()
        assert events.call_args.args == (_STUCK,)
        assert events.call_args.kwargs == {
            "level": "warning",
            "tags": {"component": "stuck_sockets"},
            "context": {
                "shard": "conn0",
                "twin": "conn1",
                "gap_s": 60.0,
                "twin_trade_frames": 150,
                "last_trade_utc": (wall - timedelta(seconds=60.0)).isoformat(),
                "forced_reconnects": 0,
            },
        }

    def test_a_shard_stuck_since_its_session_start_has_no_last_trade(self, events):
        quiet, twin = _pair()
        quiet.session_start(_NOW - 60.0)
        _feed(twin, [_NOW - 30.25] * 150)

        _check(_Watch(), _connectors(), _NOW)

        assert events.call_args.kwargs["context"]["last_trade_utc"] is None
        assert events.call_args.kwargs["context"]["gap_s"] == 60.0

    def test_the_gap_in_the_event_is_rounded_to_three_places(self, events):
        quiet, twin = _pair()
        quiet.on_frame(TRADE, _NOW - 60.1234567)
        _feed(twin, [_NOW - 30.25] * 150)

        _check(_Watch(), _connectors(), _NOW)

        assert events.call_args.kwargs["context"]["gap_s"] == 60.123

    def test_it_forces_a_reconnect_of_the_stuck_shard_only_and_logs_it_once(self, events, logs):
        _stuck_at_now()
        connectors = _connectors()

        _check(_Watch(), connectors, _NOW)

        connectors["conn0"].force_reconnect.assert_called_once_with(_REASON)
        connectors["conn1"].force_reconnect.assert_not_called()
        assert logs["warning"] == [
            (
                _FORCING,
                {
                    "shard": "conn0",
                    "twin": "conn1",
                    "gap_s": 60.0,
                    "twin_trade_frames": 150,
                    "forced_reconnect_number": 1,
                },
            )
        ]

    def test_the_event_goes_out_before_the_reconnect(self, events):
        _stuck_at_now()
        order: list[str] = []
        events.side_effect = lambda *_a, **_k: order.append("event")
        connectors = _connectors()
        connectors["conn0"].force_reconnect.side_effect = lambda _r: order.append("force") or True

        _check(_Watch(), connectors, _NOW)

        assert order == ["event", "force"]

    def test_nothing_is_stuck_so_nothing_is_sent_or_forced(self, events, logs):
        quiet, twin = _pair()
        quiet.on_frame(TRADE, _NOW - 59.5)  # just under STUCK_S
        _feed(twin, [_NOW - 30.25] * 150)
        connectors = _connectors()

        _check(_Watch(), connectors, _NOW)

        events.assert_not_called()
        assert logs == {"info": [], "warning": []}
        assert connectors["conn0"].force_reconnect.call_count == 0

    def test_with_no_twins_the_watchdog_does_nothing(self, events):
        _stuck_at_now()
        socket_stats.set_twins({})  # WS_REDUNDANT_OPTION_TRADES=false
        connectors = _connectors()

        _check(_Watch(), connectors, _NOW)

        events.assert_not_called()
        assert connectors["conn0"].force_reconnect.call_count == 0

    def test_two_stuck_shards_each_get_their_own_event_and_reconnect(self, events):
        for first, second in (("conn0", "conn1"), ("conn2", "conn3")):
            quiet, twin = _pair(first, second)
            quiet.on_frame(TRADE, _NOW - 90.0)
            _feed(twin, [_NOW - 30.25] * 150)
        connectors = _connectors("conn0", "conn1", "conn2", "conn3")

        _check(_Watch(), connectors, _NOW)

        assert [c.kwargs["context"]["shard"] for c in events.call_args_list] == ["conn0", "conn2"]
        assert connectors["conn0"].force_reconnect.call_count == 1
        assert connectors["conn2"].force_reconnect.call_count == 1
        assert connectors["conn1"].force_reconnect.call_count == 0


# --- the cooldown and the escalation --------------------------------------------


class TestForcingAndEscalating:
    def test_a_shard_still_stuck_at_the_next_check_has_its_escalation_held_back_and_logged_once(
        self, events, logs
    ):
        _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)

        _check(watch, connectors, _NOW + 5.0)  # still stuck: a forced reconnect did not help
        _check(watch, connectors, _NOW + 10.0)
        _check(watch, connectors, _NOW + 15.0)

        # The alert floor: the opening event was 5 s ago, so the escalation waits.
        assert _calls(events) == [_STUCK]
        assert [m for m, _extra in logs["warning"]] == [_FORCING, _HELD]  # one held line, not 3
        assert logs["warning"][1][1] == {
            "shard": "conn0",
            "twin": "conn1",
            "event": _STILL_STUCK,
            "gap_s": 65.0,  # at the second check, 5 s after the first
            "twin_trade_frames": 150,
            "forced_reconnects": 1,
            "since_last_alert_s": 5.0,
        }
        # Inside the cooldown: the one forced reconnect is the only one.
        assert connectors["conn0"].force_reconnect.call_count == 1

    def test_the_held_back_escalation_goes_out_once_the_floor_lifts(self, events, logs):
        _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        _check(watch, connectors, _NOW + 5.0)  # held back
        # The twin keeps receiving, in the window of the later checks.
        _feed(socket_stats.get("conn1"), [_NOW + 280.25] * 150)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S - 1.0)
        assert _calls(events) == [_STUCK]
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S + 5.0)

        assert _calls(events) == [_STUCK, _STILL_STUCK]
        assert events.call_args.kwargs["level"] == "error"
        assert events.call_args.kwargs["tags"] == {"component": "stuck_sockets"}
        context = events.call_args.kwargs["context"]
        assert (context["shard"], context["twin"]) == ("conn0", "conn1")
        assert context["forced_reconnects"] == 1  # the second one is made after the event
        assert context["gap_s"] == 360.0
        # The same pass forced the shard again: the cooldown ended with the floor.
        assert connectors["conn0"].force_reconnect.call_count == 2
        # Held back once, not once per check.
        assert [m for m, _extra in logs["warning"]].count(_HELD) == 1

    def test_the_cooldown_ends_at_exactly_forced_reconnect_cooldown_s(self, events):
        _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        # The twin keeps receiving, in the window of both later checks.
        _feed(socket_stats.get("conn1"), [_NOW + 280.25] * 150)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S - 1.0)
        assert connectors["conn0"].force_reconnect.call_count == 1
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        assert connectors["conn0"].force_reconnect.call_count == 2

    def test_a_second_forced_reconnect_in_the_incident_sends_no_third_event(self, events, logs):
        _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        _check(watch, connectors, _NOW + 5.0)
        _feed(socket_stats.get("conn1"), [_NOW + 280.25] * 150)

        _check(watch, connectors, _NOW + 300.0)
        _check(watch, connectors, _NOW + 305.0)

        assert connectors["conn0"].force_reconnect.call_count == 2
        assert [m for m, _extra in logs["warning"]] == [_FORCING, _HELD, _FORCING]
        assert _calls(events) == [_STUCK, _STILL_STUCK]

    def test_a_force_that_raises_is_logged_and_still_counts_against_the_cooldown(
        self, events, errors, logs, monkeypatch
    ):
        # The error reaches Sentry through ``capture_message``, which would log
        # through the captured ``log.warning``; stub it out.
        monkeypatch.setattr("sentry_setup.capture_message", MagicMock())
        _stuck_at_now()
        connectors = _connectors()
        connectors["conn0"].force_reconnect.side_effect = RuntimeError("abort failed")
        watch = _Watch()

        _check(watch, connectors, _NOW)
        # The next pass: the failed call is not retried.
        _check(watch, connectors, _NOW + 5.0)

        assert connectors["conn0"].force_reconnect.call_count == 1
        # The cooldown is stamped; a raise is no forced reconnect, so none is counted or logged.
        assert watch.last_forced_at == {"conn0": _NOW}
        assert watch.incidents["conn0"].forced == 0
        assert _FORCING not in [m for m, _extra in logs["warning"]]
        # The event was sent before the call raised; no escalation is due: nothing was forced.
        assert _calls(events) == [_STUCK]
        ((message, extra),) = errors
        assert message == _CHECK_FAILED
        assert (extra["scope"], extra["kind"], extra["shard"]) == (
            "stuck_sockets",
            "check",
            "conn0",
        )
        assert (extra["err_type"], extra["err"]) == ("RuntimeError", "abort failed")

    def test_a_shard_missing_from_the_connectors_is_logged(self, events, errors):
        _stuck_at_now()

        _check(_Watch(), _connectors("conn1"), _NOW)

        ((message, extra),) = errors
        assert message == _CHECK_FAILED
        assert (extra["shard"], extra["err_type"]) == ("conn0", "KeyError")


class TestAForceThatDidNothing:
    """``force_reconnect`` returns False when it did nothing: the socket's receive loop
    is not running, as in the seconds after a server-started close, before ``run`` marks
    the shard down. The watchdog must leave no trace of a forced reconnect: no log
    line, no count, no cooldown, so the next pass that finds the shard stuck and
    receiving forces it.
    """

    def test_it_logs_no_forcing_line_counts_no_forced_reconnect_and_starts_no_cooldown(
        self, events, logs
    ):
        _stuck_at_now()
        connectors = _connectors()
        connectors["conn0"].force_reconnect.return_value = False
        watch = _Watch()

        _check(watch, connectors, _NOW)

        connectors["conn0"].force_reconnect.assert_called_once_with(_REASON)
        assert _FORCING not in [m for m, _extra in logs["warning"]]
        assert watch.incidents["conn0"].forced == 0
        assert "conn0" not in watch.last_forced_at
        # The opening event does not depend on the force.
        assert _calls(events) == [_STUCK]
        assert events.call_args.kwargs["context"]["forced_reconnects"] == 0

    def test_the_next_pass_forces_once_the_socket_is_receiving(self, events, logs):
        _stuck_at_now()
        connectors = _connectors()
        force = connectors["conn0"].force_reconnect
        force.return_value = False
        watch = _Watch()
        _check(watch, connectors, _NOW)  # the call does nothing

        force.return_value = True  # run has reconnected; the receive loop is running again
        _check(watch, connectors, _NOW + 5.0)

        assert force.call_count == 2
        forcing = [extra for m, extra in logs["warning"] if m == _FORCING]
        assert [e["forced_reconnect_number"] for e in forcing] == [1]
        assert watch.incidents["conn0"].forced == 1
        assert watch.last_forced_at == {"conn0": _NOW + 5.0}

    def test_every_pass_that_does_nothing_is_retried_with_no_cooldown_between(self, events):
        _stuck_at_now()
        connectors = _connectors()
        connectors["conn0"].force_reconnect.return_value = False
        watch = _Watch()

        for offset in (0.0, 5.0, 10.0):
            _check(watch, connectors, _NOW + offset)

        assert connectors["conn0"].force_reconnect.call_count == 3

    def test_no_still_stuck_escalation_follows_a_reconnect_that_was_never_forced(
        self, events, logs
    ):
        _stuck_at_now()
        connectors = _connectors()
        connectors["conn0"].force_reconnect.return_value = False
        watch = _Watch()
        _check(watch, connectors, _NOW)
        # The twin keeps receiving; the floor has lifted by the later check.
        _feed(socket_stats.get("conn1"), [_NOW + 280.25] * 150)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        # Nothing was forced, so there is no "still stuck after a forced reconnect".
        assert _calls(events) == [_STUCK]
        assert watch.incidents["conn0"].forced == 0
        assert _HELD not in [m for m, _extra in logs["warning"]]


class TestOneShardsFailure:
    """Each stuck shard is handled on its own: a raise for one leaves the rest of the pass."""

    @staticmethod
    def _two_stuck_pairs():
        for first, second in (("conn0", "conn1"), ("conn2", "conn3")):
            quiet, twin = _pair(first, second)
            quiet.on_frame(TRADE, _NOW - 90.0)
            _feed(twin, [_NOW - 30.25] * 150)
        return _connectors("conn0", "conn1", "conn2", "conn3")

    def test_the_shards_after_a_failing_one_are_still_handled(self, events, errors):
        connectors = self._two_stuck_pairs()
        connectors["conn0"].force_reconnect.side_effect = RuntimeError("abort failed")

        _check(_Watch(), connectors, _NOW)

        assert [c.kwargs["context"]["shard"] for c in events.call_args_list] == ["conn0", "conn2"]
        assert connectors["conn2"].force_reconnect.call_count == 1
        assert [extra["shard"] for _message, extra in errors] == ["conn0"]

    def test_every_failing_shard_is_logged_under_its_own_key(self, events, errors):
        connectors = self._two_stuck_pairs()
        connectors["conn0"].force_reconnect.side_effect = RuntimeError("first")
        connectors["conn2"].force_reconnect.side_effect = RuntimeError("second")

        _check(_Watch(), connectors, _NOW)

        # One shared window would log the first and suppress the second.
        assert [(extra["shard"], extra["err"]) for _message, extra in errors] == [
            ("conn0", "first"),
            ("conn2", "second"),
        ]


class TestAlertFloor:
    """At most one Sentry event per shard per FORCED_RECONNECT_COOLDOWN_S, opening or escalation."""

    def test_a_socket_that_flaps_alerts_at_most_once_per_cooldown(self, events, logs):
        # conn0 delivers one trade frame every 65 s, so it is quiet for 60 s at a
        # time and each quiet spell is a new incident. Without the floor that is a
        # warning every 65 s: 55 in the hour. The twin never stops.
        quiet, twin = _pair()
        connectors = _connectors()
        watch = _Watch()
        base = 2_000.5
        for t in range(0, 3_601, 5):
            now = base + t
            _feed(twin, [now - 2.25] * 150)
            if t % 65 == 0:
                quiet.on_frame(TRADE, now - 0.25)
            _check(watch, connectors, now)

        sent = len(_calls(events))
        held = [m for m, _extra in logs["warning"]].count(_HELD)
        assert sent == 11  # at 60 s, then the first spell that opens 300 s or more later, ...
        assert sent <= 3_600 / FORCED_RECONNECT_COOLDOWN_S
        assert sent + held == 55  # every spell that opened was either sent or logged held back

    def test_a_held_back_opening_event_is_logged_with_what_would_have_been_sent(self, events, logs):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)
        quiet.on_frame(TRADE, _NOW + 10.0)
        _check(watch, connectors, _NOW + 15.0)  # recovered
        _feed(twin, [_NOW + 40.25] * 150)

        _check(watch, connectors, _NOW + 70.0)  # stuck again, 70 s after the last event

        assert _calls(events) == [_STUCK]
        assert logs["warning"][-1] == (
            _HELD,
            {
                "shard": "conn0",
                "twin": "conn1",
                "event": _STUCK,
                "gap_s": 60.0,
                "twin_trade_frames": 150,
                "forced_reconnects": 0,
                "since_last_alert_s": 70.0,
            },
        )
        assert list(watch.incidents) == ["conn0"]  # the incident is open all the same

    def test_the_floor_is_per_shard(self, events):
        # conn0 is stuck at _NOW; conn2 only reaches 60 s of quiet 10 s later.
        for first, second, last_trade in (
            ("conn0", "conn1", _NOW - 60.0),
            ("conn2", "conn3", _NOW - 50.0),
        ):
            quiet, twin = _pair(first, second)
            quiet.on_frame(TRADE, last_trade)
            _feed(twin, [_NOW - 30.25] * 150)
        connectors = _connectors("conn0", "conn1", "conn2", "conn3")
        watch = _Watch()
        _check(watch, connectors, _NOW)

        _check(watch, connectors, _NOW + 10.0)

        assert [c.kwargs["context"]["shard"] for c in events.call_args_list] == ["conn0", "conn2"]


class TestAHeldOpeningEventStaysDue:
    """An opening event the floor holds back goes out once the floor lifts, if the shard is
    still stuck then (ruling R32), as a held escalation does.
    """

    @staticmethod
    def _held_opening(events):
        """A first incident at ``_NOW``, recovered, and a second one at ``_NOW + 70`` held back."""
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)
        quiet.on_frame(TRADE, _NOW + 10.0)
        _check(watch, connectors, _NOW + 15.0)  # recovered
        _feed(twin, [_NOW + 40.25] * 150)
        _check(watch, connectors, _NOW + 70.0)  # stuck again, 70 s after the last event
        assert _calls(events) == [_STUCK]
        return quiet, twin, connectors, watch

    def test_it_goes_out_at_the_first_check_after_the_floor_lifts(self, events, logs):
        _quiet, twin, connectors, watch = self._held_opening(events)
        _feed(twin, [_NOW + 270.25] * 150)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S - 0.5)  # still held
        assert _calls(events) == [_STUCK]
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)  # the floor lifts

        assert _calls(events) == [_STUCK, _STUCK]
        assert events.call_args.args == (_STUCK,)
        assert events.call_args.kwargs["context"]["forced_reconnects"] == 0
        # Held back and logged once, not once per check.
        assert [m for m, _extra in logs["warning"]].count(_HELD) == 1

    def test_it_is_sent_once(self, events):
        _quiet, twin, connectors, watch = self._held_opening(events)
        _feed(twin, [_NOW + 270.25] * 150)
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S + 5.0)
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S + 10.0)

        # The escalation is next, and the floor holds it back for another 300 s.
        assert _calls(events) == [_STUCK, _STUCK]

    def test_it_is_not_sent_if_the_incident_ended_first(self, events):
        quiet, _twin, connectors, watch = self._held_opening(events)
        quiet.on_frame(TRADE, _NOW + 100.0)
        _check(watch, connectors, _NOW + 105.0)  # recovered: the incident ends
        assert watch.incidents == {}
        quiet.on_frame(TRADE, _NOW + 290.0)

        # The floor has lifted, the shard is not stuck, and the incident is gone.
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        assert _calls(events) == [_STUCK]

    def test_it_waits_while_the_shard_is_not_found_stuck(self, events):
        quiet, twin, connectors, watch = self._held_opening(events)
        # A forced reconnect's fresh session is not stuck yet at the next check.
        quiet.session_start(_NOW + 290.0)
        _feed(twin, [_NOW + 290.25] * 150)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        assert _calls(events) == [_STUCK]
        assert list(watch.incidents) == ["conn0"]


class TestRecovery:
    def test_a_trade_frame_after_the_incident_began_ends_it(self, events, logs):
        quiet, _twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)  # the forced reconnect's new session
        quiet.on_frame(TRADE, _NOW + 3.25)

        _check(watch, connectors, _NOW + 5.0)

        # The incident opened at _NOW and the check that saw the trade is 5 s later.
        assert logs["info"] == [
            (_RECOVERED, {"shard": "conn0", "duration_s": 5.0, "forced_reconnects": 1})
        ]
        assert watch.incidents == {}
        assert _calls(events) == [_STUCK]

    def test_a_trade_frame_at_the_instant_it_began_does_not_end_it(self, events, logs):
        quiet, _twin = _stuck_at_now()
        watch = _Watch()
        _check(watch, _connectors(), _NOW)
        quiet.session_start(_NOW + 2.0)
        quiet.on_frame(TRADE, _NOW)  # not later than the incident's start

        _check(watch, _connectors(), _NOW + 5.0)

        assert logs["info"] == []
        assert list(watch.incidents) == ["conn0"]

    def test_a_reconnect_with_no_trade_frame_yet_does_not_end_it(self, events, logs):
        quiet, _twin = _stuck_at_now()
        watch = _Watch()
        _check(watch, _connectors(), _NOW)
        quiet.session_start(_NOW + 2.0)  # connected again, nothing received yet

        _check(watch, _connectors(), _NOW + 5.0)

        assert logs["info"] == []
        assert list(watch.incidents) == ["conn0"]
        # It is not stuck again yet, so it is not escalated either.
        assert _calls(events) == [_STUCK]

    def test_a_later_stick_opens_a_new_incident_whose_event_waits_for_the_alert_floor(self, events):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)
        quiet.on_frame(TRADE, _NOW + 10.0)
        _check(watch, connectors, _NOW + 15.0)  # recovered
        # 60 s after that last trade frame it is stuck again, the twin still streaming.
        _feed(twin, [_NOW + 40.25] * 150)

        _check(watch, connectors, _NOW + 70.0)

        # 70 s after the last event: inside the floor, so no second event yet.
        assert _calls(events) == [_STUCK]
        # The cooldown runs across incidents: 70 s after the last forced reconnect.
        assert connectors["conn0"].force_reconnect.call_count == 1
        assert list(watch.incidents) == ["conn0"]

    def test_a_later_stick_after_the_floor_has_lifted_sends_its_own_event(self, events):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)
        quiet.on_frame(TRADE, _NOW + 10.0)
        _check(watch, connectors, _NOW + 15.0)  # recovered
        # Quiet from _NOW + 10.0 on, and still quiet when the floor lifts.
        _feed(twin, [_NOW + 290.25] * 150)

        _check(watch, connectors, _NOW + 310.0)

        assert _calls(events) == [_STUCK, _STUCK]
        assert events.call_args.kwargs["context"]["forced_reconnects"] == 0  # a new incident
        assert connectors["conn0"].force_reconnect.call_count == 2

    def test_a_new_incident_does_not_escalate_before_it_has_forced_a_reconnect(self, events):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)
        quiet.on_frame(TRADE, _NOW + 10.0)
        _check(watch, connectors, _NOW + 15.0)  # recovered
        _feed(twin, [_NOW + 40.25] * 150)
        _check(watch, connectors, _NOW + 70.0)  # new incident, inside the cooldown
        events.reset_mock()

        _check(watch, connectors, _NOW + 75.0)

        events.assert_not_called()

    def test_a_new_incident_forces_once_the_cooldown_has_passed(self, events):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)
        quiet.on_frame(TRADE, _NOW + 10.0)
        _check(watch, connectors, _NOW + 15.0)  # recovered
        # Quiet again from 10.0 on; the twin is streaming when the cooldown ends.
        _feed(twin, [_NOW + 340.25] * 150)

        _check(watch, connectors, _NOW + 350.0)

        assert connectors["conn0"].force_reconnect.call_count == 2


class TestEscalationNeedsAStuckSocket:
    """The escalation means "stuck again after a forced reconnect": the shard must be
    found stuck at the check. An open incident with a forced reconnect is not enough.
    """

    def test_a_fresh_session_is_not_escalated_until_it_is_stuck_itself(self, events, logs):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)  # the opening event and a forced reconnect
        quiet.session_start(_NOW + 2.0)  # reconnected; the twin keeps streaming
        _feed(twin, [_NOW + 30.25] * 150)

        _check(watch, connectors, _NOW + 5.0)
        _check(watch, connectors, _NOW + 60.0)  # the new session is 58 s old

        assert _calls(events) == [_STUCK]
        assert _HELD not in [m for m, _extra in logs["warning"]]  # not even attempted

        # At 62 s the new session has had no trade frame for exactly STUCK_S: it is
        # stuck again, and only now is the escalation due. The floor holds it back.
        _check(watch, connectors, _NOW + 62.0)

        assert _calls(events) == [_STUCK]
        assert logs["warning"][-1] == (
            _HELD,
            {
                "shard": "conn0",
                "twin": "conn1",
                "event": _STILL_STUCK,
                "gap_s": 60.0,
                "twin_trade_frames": 150,
                "forced_reconnects": 1,
                "since_last_alert_s": 62.0,
            },
        )

    def test_the_escalation_of_a_fresh_session_has_no_last_trade_and_goes_out_when_the_floor_lifts(
        self, events
    ):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        quiet.session_start(_NOW + 2.0)
        _feed(twin, [_NOW + 270.25] * 150)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        assert _calls(events) == [_STUCK, _STILL_STUCK]
        context = events.call_args.kwargs["context"]
        assert context["last_trade_utc"] is None
        assert context["gap_s"] == 298.0  # from the new session's start, 2 s after the first event
        assert context["forced_reconnects"] == 1

    def test_a_reconnect_after_the_floor_lifted_is_not_escalated_before_it_is_stuck(self, events):
        quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)  # the opening event and a forced reconnect
        # 299 s on, a second reconnect starts a session that is only 1 s old at the
        # next check, with the incident open, a forced reconnect on record and the
        # floor lifted. It is not stuck, so it is not escalated.
        quiet.session_start(_NOW + 299.0)
        _feed(twin, [_NOW + 270.25] * 150)

        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        assert _calls(events) == [_STUCK]


# --- Task 7: every copy of a trade feed silent ------------------------------------

_T0 = 5_000.5  # the first pass: it seeds each group's high-water mark
_GROUP_CONTEXT = {
    "shards": ["conn0", "conn6"],
    "connected": {"conn0": True, "conn6": True},
    "since_last_trade_s": 60.0,
    "twins_enabled": True,
    "forced_reconnects": 0,  # the event goes out before the forced reconnects of the same pass
}


def _silent_setup(wall_clock: _Clock, *pairs: tuple[str, str]):
    """Connected twin pairs (conn0 and conn6 by default), the clock in the window, one pass at ``_T0``.

    Returns the watch and the connectors. Nothing has traded, so each group's
    silence runs from that first pass.
    """
    pairs = pairs or (("conn0", "conn6"),)
    for first, second in pairs:
        _pair(first, second)
    wall_clock.utc = _IN_WINDOW
    connectors = _connectors(*(name for pair in pairs for name in pair))
    watch = _Watch()
    _check(watch, connectors, _T0)
    return watch, connectors


class TestGroupSilence:
    """No trade frame on any copy of a trade feed for GROUP_SILENT_S, inside the window."""

    def test_the_first_pass_only_starts_the_clock(self, wall_clock, events, logs):
        _silent_setup(wall_clock)

        events.assert_not_called()
        assert logs == {"info": [], "warning": []}

    def test_a_silent_group_sends_one_error_event_at_exactly_the_threshold(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + GROUP_SILENT_S - 0.5)
        events.assert_not_called()

        _check(watch, connectors, _T0 + GROUP_SILENT_S)

        events.assert_called_once()
        assert events.call_args.args == (_SILENT,)
        assert events.call_args.kwargs == {
            "level": "error",
            "tags": {"component": "stuck_sockets"},
            "context": _GROUP_CONTEXT,
        }
        # The opening line, then one forcing line per copy: nothing else is logged.
        assert [m for m, _extra in logs["warning"]] == [
            _SILENT_LOG,
            _FORCING_SILENT,
            _FORCING_SILENT,
        ]
        assert logs["warning"][0] == (_SILENT_LOG, {"group": "conn0", **_GROUP_CONTEXT})

    def test_one_incident_sends_one_opening_event_however_long_it_lasts(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)

        for offset in (60.0, 65.0, 125.0, 305.0, 3_600.0):
            _check(watch, connectors, _T0 + offset)

        # The one escalation (Task 8) is the only other event.
        assert _calls(events) == [_SILENT, _STILL_SILENT]
        # +60: the opening line and a forcing line per copy. +125: the escalation is due and the
        # floor holds it, logged once (+305 is held too, silently). +3600: it goes out, and the
        # cooldown has lapsed, so each copy is forced again.
        assert [m for m, _extra in logs["warning"]] == [
            _SILENT_LOG,
            _FORCING_SILENT,
            _FORCING_SILENT,
            _SILENT_HELD,
            _FORCING_SILENT,
            _FORCING_SILENT,
        ]
        assert list(watch.group_incidents) == ["conn0"]

    @pytest.mark.parametrize("copy", ["conn0", "conn6"])
    def test_a_trade_on_either_copy_keeps_the_group_healthy(self, copy, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        socket_stats.get(copy).on_frame(TRADE, _T0 + 40.0)
        _check(watch, connectors, _T0 + 50.0)

        _check(watch, connectors, _T0 + 99.5)  # 59.5 s after the trade
        events.assert_not_called()
        _check(watch, connectors, _T0 + 100.0)

        events.assert_called_once()
        assert events.call_args.kwargs["context"]["since_last_trade_s"] == 60.0

    def test_the_high_water_is_carried_across_a_reconnect(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        quiet, twin = socket_stats.get("conn0"), socket_stats.get("conn6")
        quiet.on_frame(TRADE, _T0 + 8.0)
        _check(watch, connectors, _T0 + 10.0)  # the pass sees that trade
        # Both sockets reconnect: session_start clears last_trade_at.
        quiet.session_start(_T0 + 12.0)
        twin.session_start(_T0 + 12.0)

        # The silence is counted from the last trade, not from the first pass
        # (which would be 65 s) nor from the reconnect (which would be 53 s).
        _check(watch, connectors, _T0 + 65.0)
        events.assert_not_called()
        _check(watch, connectors, _T0 + 68.0)

        events.assert_called_once()
        assert events.call_args.kwargs["context"]["since_last_trade_s"] == 60.0

    def test_the_event_says_which_copies_were_connected(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        state.set_connection("conn6", False)

        _check(watch, connectors, _T0 + 60.0)

        assert events.call_args.kwargs["context"]["connected"] == {"conn0": True, "conn6": False}

    def test_a_trade_after_the_incident_began_ends_it_and_logs_the_duration(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # the incident opens
        socket_stats.get("conn6").on_frame(TRADE, _T0 + 64.0)

        _check(watch, connectors, _T0 + 65.0)

        assert logs["info"] == [
            (
                _RESUMED,
                {
                    "group": "conn0",
                    "shards": ["conn0", "conn6"],
                    "duration_s": 5.0,
                    "forced_reconnects": 2,  # both copies were forced at the opening pass
                },
            )
        ]
        assert watch.group_incidents == {}
        assert _calls(events) == [_SILENT]


class TestGroupsFollowTheTwinMap:
    def test_with_no_twins_each_trade_shard_is_a_group_of_its_own(self, wall_clock, events):
        wall_clock.utc = _IN_WINDOW
        state.set_connection("conn0", True)
        state.set_connection("conn1", True)
        connectors = _connectors("conn0", "conn1")  # no twins: the mirror sockets are off
        watch = _Watch()
        _check(watch, connectors, _T0)
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 30.0)
        _check(watch, connectors, _T0 + 35.0)

        _check(watch, connectors, _T0 + 60.0)

        # conn0 traded 30 s ago; conn1 never did, so only its group is silent.
        events.assert_called_once()
        assert events.call_args.kwargs["context"] == {
            "shards": ["conn1"],
            "connected": {"conn1": True},
            "since_last_trade_s": 60.0,
            "twins_enabled": False,
            "forced_reconnects": 0,
        }

    def test_two_pairs_are_two_groups(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock, ("conn0", "conn6"), ("conn1", "conn7"))
        socket_stats.get("conn7").on_frame(TRADE, _T0 + 30.0)
        _check(watch, connectors, _T0 + 35.0)

        _check(watch, connectors, _T0 + 60.0)

        # Only the first pair has been silent for 60 s; its sibling pair traded.
        assert [c.kwargs["context"]["shards"] for c in events.call_args_list] == [
            ["conn0", "conn6"]
        ]

    def test_a_non_trade_shard_is_not_a_group(self, wall_clock, events):
        wall_clock.utc = _IN_WINDOW
        connectors = _connectors("conn2", "conn3", non_trade=("conn2", "conn3"))
        watch = _Watch()
        _check(watch, connectors, _T0)

        _check(watch, connectors, _T0 + 600.0)

        events.assert_not_called()

    def test_a_non_trade_shard_next_to_a_trade_pair_is_left_out(self, wall_clock, events):
        wall_clock.utc = _IN_WINDOW
        _pair("conn0", "conn6")
        connectors = _connectors("conn0", "conn6", "conn2", non_trade=("conn2",))
        watch = _Watch()
        _check(watch, connectors, _T0)

        _check(watch, connectors, _T0 + 60.0)

        assert [c.kwargs["context"]["shards"] for c in events.call_args_list] == [
            ["conn0", "conn6"]
        ]


class TestOnlyInsideTheWindow:
    @pytest.mark.parametrize(
        "instant",
        [
            datetime(2026, 11, 14, 15, 0, tzinfo=UTC),  # Saturday
            datetime(2026, 11, 26, 15, 0, tzinfo=UTC),  # Thanksgiving
            datetime(2026, 11, 13, 14, 30, 59, tzinfo=UTC),  # 09:30:59 ET
            datetime(2026, 11, 13, 20, 59, tzinfo=UTC),  # 15:59 ET
            datetime(2026, 11, 27, 18, 0, tzinfo=UTC),  # 13:00 ET on the early-close day
        ],
    )
    def test_a_silent_group_outside_the_window_sends_and_forces_nothing(
        self, instant, wall_clock, events
    ):
        watch, connectors = _silent_setup(wall_clock)
        wall_clock.utc = instant

        _check(watch, connectors, _T0 + 600.0)

        events.assert_not_called()
        assert _forced(connectors) == {"conn0": 0, "conn6": 0}

    def test_a_group_silent_since_before_the_open_alerts_on_the_first_pass_in_the_window(
        self, wall_clock, events
    ):
        watch, connectors = _silent_setup(wall_clock)
        wall_clock.utc = _AFTER_CLOSE
        _check(watch, connectors, _T0 + 600.0)
        events.assert_not_called()

        assert _forced(connectors) == {"conn0": 0, "conn6": 0}

        wall_clock.utc = _NEXT_SESSION
        _check(watch, connectors, _T0 + 605.0)

        assert _calls(events) == [_SILENT]
        assert _forced(connectors) == {"conn0": 1, "conn6": 1}


class TestGroupAlertFloor:
    """At most one Sentry event per group per FORCED_RECONNECT_COOLDOWN_S (ruling R30)."""

    def test_a_feed_that_leaks_one_trade_between_silences_alerts_at_most_once_per_cooldown(
        self, wall_clock, events, logs
    ):
        # Both copies deliver one trade every 65 s, so the group is silent for 60 s
        # at a time and each silence is a new incident. Without the floor that is an
        # error event every 65 s: 55 in the hour.
        wall_clock.utc = _IN_WINDOW
        quiet, _twin = _pair("conn0", "conn6")
        connectors = _connectors("conn0", "conn6")
        watch = _Watch()
        base = 2_000.5
        for t in range(0, 3_601, 5):
            now = base + t
            if t % 65 == 0:
                quiet.on_frame(TRADE, now - 0.25)
            _check(watch, connectors, now)

        sent = len(_calls(events))
        held = [m for m, _extra in logs["warning"]].count(_SILENT_HELD)
        assert sent == 11  # at 60 s, then the first incident opening 300 s or more later, ...
        assert sent <= 3_600 / FORCED_RECONNECT_COOLDOWN_S
        assert sent + held == 55  # every incident that opened was either sent or held back

    def test_a_held_back_event_is_logged_with_what_would_have_been_sent(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # sent
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 64.0)
        _check(watch, connectors, _T0 + 65.0)  # resumed

        _check(watch, connectors, _T0 + 124.0)  # silent again, 64 s after the last event

        assert _calls(events) == [_SILENT]
        assert logs["warning"][-1] == (
            _SILENT_HELD,
            {
                "group": "conn0",
                "shards": ["conn0", "conn6"],
                "event": _SILENT,
                "since_last_trade_s": 60.0,
                "since_last_alert_s": 64.0,
            },
        )
        assert list(watch.group_incidents) == ["conn0"]  # the incident is open all the same

    @pytest.mark.parametrize(
        ("opens_at", "events_sent"),
        [
            (FORCED_RECONNECT_COOLDOWN_S + 59.5, 1),  # 299.5 s after the last event: held back
            (FORCED_RECONNECT_COOLDOWN_S + 60.0, 2),  # exactly the cooldown: sent
        ],
    )
    def test_the_floor_lifts_at_exactly_the_cooldown(
        self, opens_at, events_sent, wall_clock, events
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # sent
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 64.0)
        _check(watch, connectors, _T0 + 65.0)  # resumed

        _check(watch, connectors, _T0 + opens_at)  # silent again, a new incident

        assert len(_calls(events)) == events_sent

    @staticmethod
    def _held_incident(wall_clock):
        """An event at +60, the feed back at +64, and silent again at +124: held back."""
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # sent
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 64.0)
        _check(watch, connectors, _T0 + 65.0)  # resumed
        _check(watch, connectors, _T0 + 124.0)  # silent again, 64 s after the last event: held
        return watch, connectors

    def test_a_held_back_event_stays_due_and_goes_out_once_the_floor_lifts(
        self, wall_clock, events, logs
    ):
        watch, connectors = self._held_incident(wall_clock)
        assert _calls(events) == [_SILENT]

        _check(watch, connectors, _T0 + 200.0)  # still held
        _check(watch, connectors, _T0 + 60.0 + FORCED_RECONNECT_COOLDOWN_S - 0.5)
        assert _calls(events) == [_SILENT]
        _check(watch, connectors, _T0 + 60.0 + FORCED_RECONNECT_COOLDOWN_S)  # the floor lifts

        assert _calls(events) == [_SILENT, _SILENT]
        assert events.call_args.kwargs["context"]["since_last_trade_s"] == 296.0
        # Held back and logged once, not once per check, and sent once.
        _check(watch, connectors, _T0 + 60.0 + FORCED_RECONNECT_COOLDOWN_S + 5.0)
        assert _calls(events) == [_SILENT, _SILENT]
        assert [m for m, _extra in logs["warning"]].count(_SILENT_HELD) == 1
        assert [m for m, _extra in logs["warning"]].count(_SILENT_LOG) == 2  # one per incident

    def test_a_held_back_event_is_not_sent_if_the_incident_ended_first(self, wall_clock, events):
        watch, connectors = self._held_incident(wall_clock)
        socket_stats.get("conn6").on_frame(TRADE, _T0 + 200.0)
        _check(watch, connectors, _T0 + 205.0)  # resumed: the incident is gone
        assert watch.group_incidents == {}
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 340.0)

        # The floor has lifted and the feed is not silent: nothing is owed.
        _check(watch, connectors, _T0 + 60.0 + FORCED_RECONNECT_COOLDOWN_S)

        assert _calls(events) == [_SILENT]

    def test_the_floor_is_per_group(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock, ("conn0", "conn6"), ("conn1", "conn7"))
        socket_stats.get("conn1").on_frame(TRADE, _T0 + 30.0)  # the second pair is silent later
        _check(watch, connectors, _T0 + 35.0)
        _check(watch, connectors, _T0 + 60.0)  # the first pair alerts

        _check(watch, connectors, _T0 + 90.0)  # the second pair, 30 s after that event

        assert [c.kwargs["context"]["shards"] for c in events.call_args_list] == [
            ["conn0", "conn6"],
            ["conn1", "conn7"],
        ]

    def test_it_is_separate_from_the_stuck_shards_floor(self, wall_clock, events):
        # conn0 is stuck at _T0 (its twin streamed, then stopped), which sends the
        # Task 6 event under the key "conn0". The group "conn0" goes silent 60 s later,
        # 60 s inside that shard's floor, and still sends its own event.
        wall_clock.utc = _IN_WINDOW
        quiet, twin = _pair("conn0", "conn6")
        quiet.on_frame(TRADE, _T0 - 60.0)
        _feed(twin, [_T0 - 30.25] * 150)
        connectors = _connectors("conn0", "conn6")
        watch = _Watch()
        _check(watch, connectors, _T0)
        assert _calls(events) == [_STUCK]

        _check(watch, connectors, _T0 + 60.0)

        assert _calls(events) == [_STUCK, _SILENT]


class TestTheWindowClosing:
    """A trade-window change ends silent-feed incidents either way, and stuck-socket incidents only at the open."""

    def test_the_close_ends_an_open_silent_incident(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # the incident opens

        wall_clock.utc = _AFTER_CLOSE
        _check(watch, connectors, _T0 + 65.0)

        assert logs["info"] == [
            (
                _SILENT_ENDED,
                {
                    "group": "conn0",
                    "duration_s": 5.0,
                    "forced_reconnects": 2,  # both copies were forced at the opening pass
                    "window": "closed",
                },
            )
        ]
        assert watch.group_incidents == {}
        assert _calls(events) == [_SILENT]

    def test_a_feed_still_silent_next_session_alerts_afresh(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)
        wall_clock.utc = _AFTER_CLOSE
        _check(watch, connectors, _T0 + 65.0)

        wall_clock.utc = _NEXT_SESSION
        _check(watch, connectors, _T0 + 72_000.0)

        assert _calls(events) == [_SILENT, _SILENT]

    def test_the_close_leaves_a_stuck_socket_incident_alone(self, wall_clock, events, logs):
        wall_clock.utc = _IN_WINDOW
        _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        assert list(watch.incidents) == ["conn0"]

        # 40 s on the twin has gone quiet, as the equity options do at the close.
        wall_clock.utc = _AFTER_CLOSE
        _check(watch, connectors, _NOW + 40.0)

        assert logs["info"] == []
        assert list(watch.incidents) == ["conn0"]

    def test_a_socket_stuck_all_afternoon_sends_nothing_at_the_close(self, wall_clock, events):
        # conn0 is stuck from the first check; its twin keeps streaming through the
        # close and past it (the index options trade to 16:15 ET).
        wall_clock.utc = _IN_WINDOW
        _quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        _feed(twin, [_NOW + 270.25] * 150)
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)
        assert _calls(events) == [_STUCK, _STILL_STUCK]

        # An hour on, the floor has long lifted. Ending the incident at the close
        # would find the shard stuck again in the same pass and send a second pair.
        close = _NOW + 3_600.0
        wall_clock.utc = _AFTER_CLOSE
        _feed(twin, [close - 30.25] * 150)
        _check(watch, connectors, close)
        _feed(twin, [close + 270.25] * 150)
        _check(watch, connectors, close + FORCED_RECONNECT_COOLDOWN_S)

        assert _calls(events) == [_STUCK, _STILL_STUCK]

    def test_a_socket_stuck_through_the_close_alerts_again_next_session(
        self, wall_clock, events, logs
    ):
        wall_clock.utc = _IN_WINDOW
        _quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        assert _calls(events) == [_STUCK]
        wall_clock.utc = _AFTER_CLOSE
        _check(watch, connectors, _NOW + 5.0)  # the close changes nothing
        assert _calls(events) == [_STUCK]
        assert list(watch.incidents) == ["conn0"]

        # That incident would carry overnight, and the next session would start
        # with it open and send nothing. The open ends it, and the stick alerts afresh.
        wall_clock.utc = _NEXT_SESSION
        later = _NOW + 72_000.0
        _feed(twin, [later - 30.25] * 150)
        _check(watch, connectors, later)

        assert _calls(events) == [_STUCK, _STUCK]
        assert events.call_args.kwargs["context"]["forced_reconnects"] == 0  # a new incident
        assert [(msg, extra["window"], extra["duration_s"]) for msg, extra in logs["info"]] == [
            (_STUCK_ENDED, "opened", 72_000.0)
        ]

    @pytest.mark.parametrize(
        ("age", "ended"),
        [(30.0, False), (59.5, False), (60.0, False), (60.5, True)],  # older than STUCK_S ends
    )
    def test_the_open_ends_only_a_stuck_incident_older_than_stuck_s(
        self, age, ended, wall_clock, events, logs
    ):
        # An incident opened at 09:30:30 ET is part of this session. One that began
        # before the previous close is left over from it.
        wall_clock.utc = _JUST_BEFORE_THE_OPEN
        _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)
        assert list(watch.incidents) == ["conn0"]

        wall_clock.utc = _AT_THE_OPEN
        _check(watch, connectors, _NOW + age)

        assert (_STUCK_ENDED in [msg for msg, _extra in logs["info"]]) is ended

    def test_an_incident_opened_in_the_minute_before_the_open_keeps_its_escalation(
        self, wall_clock, events
    ):
        wall_clock.utc = _JUST_BEFORE_THE_OPEN
        _quiet, twin = _stuck_at_now()
        connectors = _connectors()
        watch = _Watch()
        _check(watch, connectors, _NOW)  # opens at 09:30:30 ET
        wall_clock.utc = _AT_THE_OPEN
        _check(watch, connectors, _NOW + 30.0)  # 09:31:00 ET: the window opens

        _feed(twin, [_NOW + 270.25] * 150)
        _check(watch, connectors, _NOW + FORCED_RECONNECT_COOLDOWN_S)

        assert _calls(events) == [_STUCK, _STILL_STUCK]

    def test_a_silent_incident_found_open_at_the_open_ends_too(self, wall_clock, events, logs):
        # Group incidents open only inside the window, so one is normally gone at the
        # close. If the close pass failed (the window read raised), the open ends it.
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # the incident opens

        stuck_sockets._end_for_window(watch, _T0 + 65.0, True)

        assert logs["info"] == [
            (
                _SILENT_ENDED,
                {
                    "group": "conn0",
                    "duration_s": 5.0,
                    "forced_reconnects": 2,
                    "window": "opened",
                },
            )
        ]
        assert watch.group_incidents == {}

    def test_a_pass_that_changes_nothing_ends_nothing(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)

        _check(watch, connectors, _T0 + 65.0)
        _check(watch, connectors, _T0 + 70.0)

        assert logs["info"] == []
        assert list(watch.group_incidents) == ["conn0"]


class TestOneGroupsFailure:
    def test_a_failing_group_is_logged_and_the_next_group_is_still_checked(
        self, wall_clock, events, errors
    ):
        watch, connectors = _silent_setup(wall_clock, ("conn0", "conn6"), ("conn1", "conn7"))
        events.side_effect = [RuntimeError("sentry down"), None]

        _check(watch, connectors, _T0 + 60.0)

        assert events.call_count == 2
        ((message, extra),) = errors
        assert message == _CHECK_FAILED
        assert (extra["scope"], extra["kind"], extra["group"]) == (
            "stuck_sockets",
            "check",
            "conn0",
        )
        assert (extra["err_type"], extra["err"]) == ("RuntimeError", "sentry down")


class TestTheWindowReadFailing:
    """A fault in the trade-window code costs only the group rule, never the stuck-shard checks."""

    @staticmethod
    def _raising(*_args, **_kwargs):
        raise RuntimeError("calendar broke")

    def test_a_failing_window_read_is_logged_and_the_stuck_shard_checks_still_run(
        self, wall_clock, events, errors, monkeypatch
    ):
        _stuck_at_now()
        connectors = _connectors()
        monkeypatch.setattr(stuck_sockets.market_calendar, "in_trade_window", self._raising)

        _check(_Watch(), connectors, _NOW)

        assert _calls(events) == [_STUCK]
        connectors["conn0"].force_reconnect.assert_called_once_with(_REASON)
        ((message, extra),) = errors
        assert message == "trade-window check failed"
        assert (extra["scope"], extra["kind"]) == ("stuck_sockets", "window")
        assert (extra["err_type"], extra["err"]) == ("RuntimeError", "calendar broke")

    def test_the_group_check_is_skipped_and_the_window_state_kept_then_it_recovers(
        self, wall_clock, events, errors, monkeypatch
    ):
        watch, connectors = _silent_setup(wall_clock)  # in the window, the groups seeded
        assert watch.in_window is True
        real = stuck_sockets.market_calendar.in_trade_window
        monkeypatch.setattr(stuck_sockets.market_calendar, "in_trade_window", self._raising)

        _check(watch, connectors, _T0 + 60.0)  # a silent group, but the window is unknown

        events.assert_not_called()
        assert watch.in_window is True
        assert len(errors) == 1
        monkeypatch.setattr(stuck_sockets.market_calendar, "in_trade_window", real)

        _check(watch, connectors, _T0 + 65.0)

        assert _calls(events) == [_SILENT]

    def test_no_group_is_checked_while_the_window_is_unknown(
        self, wall_clock, events, logs, errors, monkeypatch
    ):
        # The error reaches Sentry through ``capture_message``, which would log
        # through the captured ``log.warning``; stub it out.
        monkeypatch.setattr("sentry_setup.capture_message", MagicMock())
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # an incident opens
        socket_stats.get("conn6").on_frame(TRADE, _T0 + 62.0)
        real = stuck_sockets.market_calendar.in_trade_window
        monkeypatch.setattr(stuck_sockets.market_calendar, "in_trade_window", self._raising)

        _check(watch, connectors, _T0 + 65.0)  # the feed is back, but the groups are not looked at

        assert logs["info"] == []
        assert list(watch.group_incidents) == ["conn0"]
        monkeypatch.setattr(stuck_sockets.market_calendar, "in_trade_window", real)

        _check(watch, connectors, _T0 + 70.0)

        assert [m for m, _extra in logs["info"]] == [_RESUMED]

    def test_a_failing_window_change_leaves_the_state_alone_and_is_retried(
        self, wall_clock, events, errors, monkeypatch
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # an incident opens
        wall_clock.utc = _AFTER_CLOSE
        ended: list[tuple[str, dict]] = []
        failing = {"on": True}

        def _info(message, *_args, **kwargs):
            if failing["on"]:
                raise RuntimeError("log down")
            ended.append((message, kwargs["extra"]))

        monkeypatch.setattr(stuck_sockets.log, "info", _info)

        _check(watch, connectors, _T0 + 65.0)  # the close: ending the incident raises

        assert len(errors) == 1
        assert errors[0][1]["kind"] == "window"
        assert watch.in_window is True  # not moved, so the next pass sees the change again
        assert list(watch.group_incidents) == ["conn0"]
        failing["on"] = False

        _check(watch, connectors, _T0 + 70.0)

        assert watch.in_window is False
        assert watch.group_incidents == {}
        assert [(m, e["window"]) for m, e in ended] == [(_SILENT_ENDED, "closed")]


# --- Task 8: reconnect every copy of a silent trade feed ---------------------------


def _forced(connectors: dict[str, MagicMock]) -> dict[str, int]:
    """How many times each connector's ``force_reconnect`` was called."""
    return {name: c.force_reconnect.call_count for name, c in connectors.items()}


def _forcing_lines(logs: dict[str, list[tuple[str, dict]]]) -> list[dict]:
    """The extras of every "forcing reconnect of a silent trade feed" line."""
    return [extra for message, extra in logs["warning"] if message == _FORCING_SILENT]


class TestForcingASilentFeed:
    """While a group incident is open, every connected copy is forced, once per cooldown."""

    def test_the_opening_pass_forces_each_connected_shard_once_and_logs_a_line_per_shard(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)

        _check(watch, connectors, _T0 + 60.0)

        for connector in connectors.values():
            connector.force_reconnect.assert_called_once_with(_SILENT_REASON)
        assert _forcing_lines(logs) == [
            {
                "group": "conn0",
                "shard": "conn0",
                "since_last_trade_s": 60.0,
                "forced_reconnect_number": 1,
            },
            {
                "group": "conn0",
                "shard": "conn6",
                "since_last_trade_s": 60.0,
                "forced_reconnect_number": 2,
            },
        ]
        assert watch.group_incidents["conn0"].forced == 2
        assert watch.last_forced_at == {"conn0": _T0 + 60.0, "conn6": _T0 + 60.0}

    def test_nothing_is_forced_before_the_group_is_silent(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)

        _check(watch, connectors, _T0 + 59.5)

        assert _forced(connectors) == {"conn0": 0, "conn6": 0}
        assert _forcing_lines(logs) == []

    def test_the_event_goes_out_before_the_reconnects(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        order: list[str] = []
        events.side_effect = lambda *_a, **_k: order.append("event")
        for name, connector in connectors.items():
            connector.force_reconnect.side_effect = lambda _reason, _n=name: (
                order.append(_n) or True
            )

        _check(watch, connectors, _T0 + 60.0)

        assert order == ["event", "conn0", "conn6"]

    def test_a_shard_that_is_not_connected_is_skipped_and_the_other_is_still_forced(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)
        state.set_connection("conn6", False)  # its run loop is already reconnecting it

        _check(watch, connectors, _T0 + 60.0)

        connectors["conn0"].force_reconnect.assert_called_once_with(_SILENT_REASON)
        connectors["conn6"].force_reconnect.assert_not_called()
        assert [line["shard"] for line in _forcing_lines(logs)] == ["conn0"]
        assert watch.last_forced_at == {"conn0": _T0 + 60.0}
        assert watch.group_incidents["conn0"].forced == 1

    def test_a_skipped_shard_is_forced_on_the_first_pass_that_finds_it_connected(
        self, wall_clock, events
    ):
        watch, connectors = _silent_setup(wall_clock)
        state.set_connection("conn6", False)
        _check(watch, connectors, _T0 + 60.0)
        state.set_connection("conn6", True)

        _check(watch, connectors, _T0 + 65.0)

        connectors["conn6"].force_reconnect.assert_called_once_with(_SILENT_REASON)
        assert connectors["conn0"].force_reconnect.call_count == 1  # still cooling down

    @pytest.mark.parametrize(("later", "calls"), [(299.5, 1), (300.0, 2)])
    def test_it_forces_again_at_exactly_the_cooldown_while_the_feed_stays_silent(
        self, later, calls, wall_clock, events
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)

        _check(watch, connectors, _T0 + 60.0 + later)

        assert _forced(connectors) == {"conn0": calls, "conn6": calls}

    def test_nothing_is_forced_once_the_feed_has_resumed(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)
        socket_stats.get("conn6").on_frame(TRADE, _T0 + 64.0)
        _check(watch, connectors, _T0 + 65.0)  # resumed: the incident is over
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 400.0)

        _check(watch, connectors, _T0 + 405.0)  # the cooldown has lapsed, the feed is healthy

        assert _forced(connectors) == {"conn0": 1, "conn6": 1}

    def test_nothing_is_forced_after_the_window_closes(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)
        wall_clock.utc = _AFTER_CLOSE
        _check(watch, connectors, _T0 + 65.0)  # the close ends the incident
        assert watch.group_incidents == {}
        # The line that ends it carries the forced reconnects it made.
        ended = [extra for m, extra in logs["info"] if m == _SILENT_ENDED]
        assert [e["forced_reconnects"] for e in ended] == [2]

        _check(watch, connectors, _T0 + 400.0)  # the cooldown has lapsed, the feed is still silent

        assert _forced(connectors) == {"conn0": 1, "conn6": 1}

    def test_nothing_is_forced_while_the_window_cannot_be_read(
        self, wall_clock, events, errors, monkeypatch
    ):
        watch, connectors = _silent_setup(wall_clock)

        def _raising(*_args, **_kwargs):
            raise RuntimeError("calendar broke")

        monkeypatch.setattr(stuck_sockets.market_calendar, "in_trade_window", _raising)

        _check(watch, connectors, _T0 + 60.0)

        assert _forced(connectors) == {"conn0": 0, "conn6": 0}

    def test_with_no_twins_a_lone_silent_shard_is_forced(self, wall_clock, events, logs):
        wall_clock.utc = _IN_WINDOW
        state.set_connection("conn0", True)
        state.set_connection("conn1", True)
        connectors = _connectors("conn0", "conn1")  # no twins: the mirror sockets are off
        watch = _Watch()
        _check(watch, connectors, _T0)
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 30.0)
        _check(watch, connectors, _T0 + 35.0)

        _check(watch, connectors, _T0 + 60.0)

        # conn1's feed is silent and conn0's is not.
        connectors["conn1"].force_reconnect.assert_called_once_with(_SILENT_REASON)
        connectors["conn0"].force_reconnect.assert_not_called()
        assert _forcing_lines(logs) == [
            {
                "group": "conn1",
                "shard": "conn1",
                "since_last_trade_s": 60.0,
                "forced_reconnect_number": 1,
            }
        ]


class TestTheCooldownIsSharedWithTheStuckRule:
    """One forced reconnect per shard per 5 min across both rules (ruling R36)."""

    def test_a_shard_the_stuck_rule_forced_is_not_forced_by_the_group_rule(
        self, wall_clock, events
    ):
        wall_clock.utc = _IN_WINDOW
        quiet, twin = _pair("conn0", "conn6")
        quiet.on_frame(TRADE, _T0 - 60.0)
        _feed(twin, [_T0 - 30.25] * 150)
        connectors = _connectors("conn0", "conn6")
        watch = _Watch()
        _check(watch, connectors, _T0)  # conn0 is stuck: the stuck rule forces it
        connectors["conn0"].force_reconnect.assert_called_once_with(_REASON)

        _check(watch, connectors, _T0 + 60.0)  # the whole feed is silent now

        assert connectors["conn0"].force_reconnect.call_count == 1  # 60 s into its cooldown
        connectors["conn6"].force_reconnect.assert_called_once_with(_SILENT_REASON)

    def test_a_shard_the_group_rule_forced_is_not_forced_by_the_stuck_rule(
        self, wall_clock, events
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # the group rule forces both copies
        quiet, twin = socket_stats.get("conn0"), socket_stats.get("conn6")
        # Both reconnect. The twin streams again and conn0's fresh session delivers nothing.
        quiet.session_start(_T0 + 62.0)
        twin.session_start(_T0 + 62.0)
        _feed(twin, [_T0 + 100.25] * 150)

        _check(watch, connectors, _T0 + 125.0)  # conn0: 63 s quiet against 150 twin frames

        assert _STUCK in _calls(events)  # the stuck rule did find it stuck...
        assert connectors["conn0"].force_reconnect.call_count == 1  # ...and left it alone
        assert watch.last_forced_at["conn0"] == _T0 + 60.0


class TestTheEscalation:
    """One more error per incident when the fresh sessions joined and still got no trade (R37)."""

    @pytest.mark.parametrize(("after_first_force", "due"), [(59.5, False), (60.0, True)])
    def test_it_is_due_exactly_group_silent_s_after_the_first_forced_reconnect(
        self, after_first_force, due, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)  # the opening event and the first forced reconnects

        _check(watch, connectors, _T0 + 60.0 + after_first_force)

        # The floor holds the escalation back for 300 s, so "due" shows as its held line.
        held = [extra for message, extra in logs["warning"] if message == _SILENT_HELD]
        assert _calls(events) == [_SILENT]
        if due:
            assert held == [
                {
                    "group": "conn0",
                    "shards": ["conn0", "conn6"],
                    "event": _STILL_SILENT,
                    "since_last_trade_s": 120.0,
                    "since_last_alert_s": 60.0,
                }
            ]
        else:
            assert held == []

    def test_the_floor_holds_it_back_and_it_goes_out_when_the_floor_lifts(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)

        for offset in (120.0, 125.0, 300.0, 359.5):
            _check(watch, connectors, _T0 + offset)

        assert _calls(events) == [_SILENT]
        assert [m for m, _extra in logs["warning"]].count(_SILENT_HELD) == 1  # once, not per check
        _check(watch, connectors, _T0 + 360.0)

        assert _calls(events) == [_SILENT, _STILL_SILENT]
        assert events.call_args.kwargs == {
            "level": "error",
            "tags": {"component": "stuck_sockets"},
            "context": {
                "shards": ["conn0", "conn6"],
                "connected": {"conn0": True, "conn6": True},
                "since_last_trade_s": 360.0,
                "twins_enabled": True,
                "forced_reconnects": 2,  # the second round is forced after the event
            },
        }
        assert _forced(connectors) == {"conn0": 2, "conn6": 2}
        assert watch.group_incidents["conn0"].forced == 4

    def test_it_is_sent_once_per_incident(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)

        for offset in range(60, 1_201, 5):
            _check(watch, connectors, _T0 + float(offset))

        assert _calls(events) == [_SILENT, _STILL_SILENT]

    def test_it_is_not_sent_if_the_incident_ended_first(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        _check(watch, connectors, _T0 + 60.0)
        _check(watch, connectors, _T0 + 125.0)  # due, held back
        socket_stats.get("conn6").on_frame(TRADE, _T0 + 200.0)
        _check(watch, connectors, _T0 + 205.0)  # resumed: the incident is gone
        assert watch.group_incidents == {}
        socket_stats.get("conn0").on_frame(TRADE, _T0 + 340.0)

        _check(watch, connectors, _T0 + 360.0)  # the floor has lifted and nothing is owed

        assert _calls(events) == [_SILENT]

    def test_it_waits_while_no_shard_has_been_forced_and_counts_from_the_first_force(
        self, wall_clock, events, logs
    ):
        watch, connectors = _silent_setup(wall_clock)
        state.set_connection("conn0", False)
        state.set_connection("conn6", False)
        for offset in (60.0, 125.0, 400.0):
            _check(watch, connectors, _T0 + offset)

        # The opening event went out, nothing could be forced, and no escalation is due.
        assert _calls(events) == [_SILENT]
        assert watch.group_incidents["conn0"].forced == 0
        assert _SILENT_HELD not in [m for m, _extra in logs["warning"]]
        state.set_connection("conn0", True)

        _check(watch, connectors, _T0 + 400.0 + 5.0)  # the first forced reconnect
        _check(watch, connectors, _T0 + 400.0 + 5.0 + 59.5)
        # 404.5 s into the incident, but only 59.5 s after the first forced reconnect.
        assert _calls(events) == [_SILENT]
        _check(watch, connectors, _T0 + 400.0 + 5.0 + 60.0)

        assert _calls(events) == [_SILENT, _STILL_SILENT]  # the floor lifted at +360

    def test_it_counts_from_the_first_forced_reconnect_not_the_latest(self, wall_clock, events):
        watch, connectors = _silent_setup(wall_clock)
        state.set_connection("conn0", False)
        state.set_connection("conn6", False)
        _check(watch, connectors, _T0 + 60.0)  # the event; nothing to force
        state.set_connection("conn0", True)
        _check(watch, connectors, _T0 + 100.0)  # conn0 is forced: the incident's first
        state.set_connection("conn6", True)
        _check(watch, connectors, _T0 + 310.0)  # conn6 is forced, later still
        assert _calls(events) == [_SILENT]

        _check(watch, connectors, _T0 + 360.0)  # 260 s after the first force, 50 s after the last

        assert _calls(events) == [_SILENT, _STILL_SILENT]

    def test_it_waits_behind_a_held_opening_event(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)
        state.set_connection("conn0", False)
        state.set_connection("conn6", False)
        _check(watch, connectors, _T0 + 60.0)  # incident 1: the event, nothing to force
        socket_stats.get("conn6").on_frame(TRADE, _T0 + 64.0)
        _check(watch, connectors, _T0 + 65.0)  # resumed
        state.set_connection("conn0", True)
        state.set_connection("conn6", True)
        _check(watch, connectors, _T0 + 124.0)  # incident 2: held back by the floor, both forced
        assert _calls(events) == [_SILENT]
        assert _forced(connectors) == {"conn0": 1, "conn6": 1}

        _check(watch, connectors, _T0 + 190.0)  # the escalation is due, behind the held opening
        assert _calls(events) == [_SILENT]
        held = [extra["event"] for m, extra in logs["warning"] if m == _SILENT_HELD]
        assert held == [_SILENT]  # the opening's held line only: the escalation is not tried yet
        _check(watch, connectors, _T0 + 360.0)  # the floor lifts: the opening goes first

        assert _calls(events) == [_SILENT, _SILENT]
        # It goes out with the forced reconnects the incident has made by then.
        assert events.call_args.kwargs["context"]["forced_reconnects"] == 2
        _check(watch, connectors, _T0 + 365.0)  # the escalation waits for the floor again
        assert _calls(events) == [_SILENT, _SILENT]
        _check(watch, connectors, _T0 + 660.0)

        assert _calls(events) == [_SILENT, _SILENT, _STILL_SILENT]


class TestCadence:
    """The same cadence as the stuck rule: once per shard per 5 min while silent, no cap (R35)."""

    @staticmethod
    def _run_an_hour(*pairs: tuple[str, str], wall_clock: _Clock):
        watch, connectors = _silent_setup(wall_clock, *pairs)
        for offset in range(60, 3_601, 5):
            _check(watch, connectors, _T0 + float(offset))
        return connectors

    def test_one_silent_group_makes_24_forced_reconnects_an_hour_and_two_events(
        self, wall_clock, events
    ):
        connectors = self._run_an_hour(wall_clock=wall_clock)

        assert _forced(connectors) == {"conn0": 12, "conn6": 12}
        assert _calls(events) == [_SILENT, _STILL_SILENT]

    def test_both_groups_silent_make_48_an_hour_over_the_storm_alerts_40(self, wall_clock, events):
        connectors = self._run_an_hour(
            ("conn0", "conn6"), ("conn1", "conn7"), wall_clock=wall_clock
        )

        assert _forced(connectors) == {"conn0": 12, "conn6": 12, "conn1": 12, "conn7": 12}
        assert sum(_forced(connectors).values()) == 48
        assert _calls(events) == [_SILENT, _SILENT, _STILL_SILENT, _STILL_SILENT]


class TestAForceThatRaisesInAGroup:
    def test_the_group_guard_logs_it_and_it_counts_against_the_cooldown_only(
        self, wall_clock, events, errors, logs, monkeypatch
    ):
        # The error reaches Sentry through ``capture_message``, which would log
        # through the captured ``log.warning``; stub it out.
        monkeypatch.setattr("sentry_setup.capture_message", MagicMock())
        watch, connectors = _silent_setup(wall_clock)
        connectors["conn0"].force_reconnect.side_effect = RuntimeError("abort failed")

        _check(watch, connectors, _T0 + 60.0)

        ((message, extra),) = errors
        assert message == _CHECK_FAILED
        assert (extra["scope"], extra["kind"], extra["group"]) == (
            "stuck_sockets",
            "check",
            "conn0",
        )
        assert (extra["err_type"], extra["err"]) == ("RuntimeError", "abort failed")
        assert watch.last_forced_at == {"conn0": _T0 + 60.0}  # not retried every pass
        assert watch.group_incidents["conn0"].forced == 0  # a raise is no forced reconnect
        assert _FORCING_SILENT not in [m for m, _extra in logs["warning"]]
        assert _calls(events) == [_SILENT]  # the event went out before the call raised

    def test_the_other_copy_is_forced_on_the_next_pass_and_the_raising_one_is_not_retried(
        self, wall_clock, events, errors, monkeypatch
    ):
        monkeypatch.setattr("sentry_setup.capture_message", MagicMock())
        watch, connectors = _silent_setup(wall_clock)
        connectors["conn0"].force_reconnect.side_effect = RuntimeError("abort failed")
        _check(watch, connectors, _T0 + 60.0)
        # The guard ended the group's pass before the second copy.
        assert connectors["conn6"].force_reconnect.call_count == 0

        _check(watch, connectors, _T0 + 65.0)

        assert connectors["conn0"].force_reconnect.call_count == 1
        connectors["conn6"].force_reconnect.assert_called_once_with(_SILENT_REASON)
        assert watch.group_incidents["conn0"].forced == 1

    def test_the_next_group_is_still_checked_and_forced(self, wall_clock, events, errors):
        watch, connectors = _silent_setup(wall_clock, ("conn0", "conn6"), ("conn1", "conn7"))
        connectors["conn0"].force_reconnect.side_effect = RuntimeError("abort failed")

        _check(watch, connectors, _T0 + 60.0)

        assert [extra["group"] for _message, extra in errors] == ["conn0"]
        assert [c.kwargs["context"]["shards"] for c in events.call_args_list] == [
            ["conn0", "conn6"],
            ["conn1", "conn7"],
        ]
        connectors["conn1"].force_reconnect.assert_called_once_with(_SILENT_REASON)
        connectors["conn7"].force_reconnect.assert_called_once_with(_SILENT_REASON)


class TestAGroupForceThatDidNothing:
    """``force_reconnect`` returns False when the receive loop is not running: no trace."""

    def test_no_line_no_count_and_no_cooldown_for_that_shard(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)
        connectors["conn0"].force_reconnect.return_value = False

        _check(watch, connectors, _T0 + 60.0)

        connectors["conn0"].force_reconnect.assert_called_once_with(_SILENT_REASON)
        assert [line["shard"] for line in _forcing_lines(logs)] == ["conn6"]
        assert watch.last_forced_at == {"conn6": _T0 + 60.0}
        assert watch.group_incidents["conn0"].forced == 1

    def test_the_next_pass_forces_the_shard_once_it_is_receiving(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)
        connectors["conn0"].force_reconnect.return_value = False
        _check(watch, connectors, _T0 + 60.0)
        connectors["conn0"].force_reconnect.return_value = True  # run has reconnected it

        _check(watch, connectors, _T0 + 65.0)

        assert connectors["conn0"].force_reconnect.call_count == 2
        assert watch.last_forced_at["conn0"] == _T0 + 65.0
        assert connectors["conn6"].force_reconnect.call_count == 1  # cooling down
        assert [line["forced_reconnect_number"] for line in _forcing_lines(logs)] == [1, 2]

    def test_no_escalation_follows_a_feed_that_was_never_forced(self, wall_clock, events, logs):
        watch, connectors = _silent_setup(wall_clock)
        for connector in connectors.values():
            connector.force_reconnect.return_value = False
        for offset in (60.0, 125.0, 400.0):  # the floor has lifted by the last one
            _check(watch, connectors, _T0 + offset)

        assert _calls(events) == [_SILENT]
        assert watch.group_incidents["conn0"].forced == 0
        assert _SILENT_HELD not in [m for m, _extra in logs["warning"]]


# --- the loop --------------------------------------------------------------------


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

    monkeypatch.setattr(stuck_sockets.asyncio, "sleep", _sleep)
    return sleeps


def _script_monotonic(monkeypatch, *ticks: float) -> None:
    """Make stuck_sockets read these monotonic values, one per call.

    Replaces only this module's ``time`` name, so asyncio's own clock is untouched.
    """
    values = iter(ticks)
    monkeypatch.setattr(stuck_sockets, "time", SimpleNamespace(monotonic=lambda: next(values)))


@pytest.mark.asyncio
async def test_the_loop_checks_after_each_interval_with_the_clock_it_read_then(monkeypatch):
    sleeps = _script_sleep(monkeypatch, [lambda: None, lambda: None])
    _script_monotonic(monkeypatch, 1000.5, 1005.5, 1005.5, 1010.5, 1010.5)
    with (
        patch.object(socket_stats, "find_stuck", return_value=[]) as find,
        pytest.raises(asyncio.CancelledError),
    ):
        await run_stuck_socket_watchdog(_connectors())

    assert sleeps == [STUCK_CHECK_INTERVAL_S] * 3
    assert [c.args for c in find.call_args_list] == [(1005.5,), (1010.5,)]


@pytest.mark.asyncio
async def test_a_pass_whose_sleep_overran_by_the_loop_lag_threshold_is_skipped(monkeypatch, events):
    assert LOOP_LAG_FLAG_S == 1.0
    _stuck_at_now()
    connectors = _connectors()
    _script_sleep(monkeypatch, [lambda: None, lambda: None])
    # Pass 1 slept 6.0 s for a 5.0 s sleep: 1.0 s of lag, exactly the threshold.
    # Pass 2 slept 5.9375 s: just under it. Both end with the same stuck state.
    _script_monotonic(monkeypatch, 1094.5, 1100.5, 1100.5, 1106.4375, 1106.4375)

    with pytest.raises(asyncio.CancelledError):
        await run_stuck_socket_watchdog(connectors)

    # Only pass 2 looked: one event and one reconnect, at its clock read. Had
    # pass 1 run, it would have sent the event with its 60.0 s gap.
    assert _calls(events) == [_STUCK]
    assert events.call_args.kwargs["context"]["gap_s"] == 65.938  # 65.9375, rounded
    assert connectors["conn0"].force_reconnect.call_count == 1


@pytest.mark.asyncio
async def test_a_failing_pass_is_logged_and_the_next_pass_still_runs(monkeypatch, errors):
    _script_sleep(monkeypatch, [lambda: None, lambda: None])
    _script_monotonic(monkeypatch, 1000.5, 1005.5, 1005.5, 1010.5, 1010.5)
    with (
        patch.object(socket_stats, "find_stuck", side_effect=[RuntimeError("boom"), []]) as find,
        pytest.raises(asyncio.CancelledError),
    ):
        await run_stuck_socket_watchdog(_connectors())

    assert find.call_count == 2
    ((message, extra),) = errors
    assert message == _CHECK_FAILED
    assert (extra["scope"], extra["kind"]) == ("stuck_sockets", "check")
    assert (extra["err_type"], extra["err"]) == ("RuntimeError", "boom")


@pytest.mark.asyncio
async def test_a_failing_pass_sends_one_sentry_event_through_the_rate_limited_error(
    monkeypatch, errors
):
    sent = MagicMock()
    monkeypatch.setattr("sentry_setup.capture_message", sent)
    _script_sleep(monkeypatch, [lambda: None])
    _script_monotonic(monkeypatch, 1000.5, 1005.5, 1005.5)
    with (
        patch.object(socket_stats, "find_stuck", side_effect=RuntimeError("boom")),
        pytest.raises(asyncio.CancelledError),
    ):
        await run_stuck_socket_watchdog(_connectors())

    sent.assert_called_once()
    assert sent.call_args.kwargs["level"] == "error"
    assert sent.call_args.kwargs["tags"] == {"component": "stuck_sockets", "kind": "check"}


@pytest.mark.asyncio
async def test_a_cancel_ends_the_loop_even_from_inside_a_pass(monkeypatch, errors):
    _script_sleep(monkeypatch, [lambda: None])
    _script_monotonic(monkeypatch, 1000.5, 1005.5)
    with (
        patch.object(socket_stats, "find_stuck", side_effect=asyncio.CancelledError()),
        pytest.raises(asyncio.CancelledError),
    ):
        await run_stuck_socket_watchdog(_connectors())

    assert errors == []  # the cancel was not logged as a failed pass


@pytest.mark.asyncio
async def test_cancelling_the_task_ends_it():
    task = asyncio.create_task(run_stuck_socket_watchdog(_connectors()))
    await asyncio.sleep(0)  # into the first sleep

    task.cancel()
    await asyncio.wait({task}, timeout=1.0)

    assert task.cancelled()


def _on_time_passes(count: int) -> list[float]:
    """Monotonic reads for ``count`` passes that each sleep exactly STUCK_CHECK_INTERVAL_S.

    Pass i reads its start at 1000.5 + 5 i and its check time 5 s later, then the
    next iteration reads its start; the last start is read before the sleep that ends the loop.
    """
    ticks: list[float] = []
    for i in range(count + 1):
        start = 1_000.5 + STUCK_CHECK_INTERVAL_S * i
        ticks += [start, start + STUCK_CHECK_INTERVAL_S]
    return ticks[:-1]


@pytest.mark.asyncio
async def test_the_loop_alerts_a_silent_group_on_the_first_pass_that_reaches_the_threshold(
    monkeypatch, wall_clock, events
):
    wall_clock.utc = _IN_WINDOW
    _pair("conn0", "conn6")
    connectors = _connectors("conn0", "conn6")
    _script_sleep(monkeypatch, [lambda: None] * 13)
    _script_monotonic(monkeypatch, *_on_time_passes(13))

    with pytest.raises(asyncio.CancelledError):
        await run_stuck_socket_watchdog(connectors)

    # The first pass checked at 1005.5 and started the group's clock; the 13th, at
    # 1065.5, is the first 60 s on. Nothing was sent or forced by the 12 before it.
    assert _calls(events) == [_SILENT]
    assert events.call_args.kwargs["context"]["since_last_trade_s"] == 60.0
    for connector in connectors.values():
        connector.force_reconnect.assert_called_once_with(_SILENT_REASON)


@pytest.mark.asyncio
async def test_a_pass_whose_sleep_overran_is_skipped_by_the_group_rule_too(
    monkeypatch, wall_clock, events
):
    wall_clock.utc = _IN_WINDOW
    _pair("conn0", "conn6")
    connectors = _connectors("conn0", "conn6")
    _script_sleep(monkeypatch, [lambda: None] * 14)
    # The 13th pass would be the first 60 s on, but it slept 6.0 s for a 5.0 s
    # sleep: exactly LOOP_LAG_FLAG_S, so it is skipped. The 14th pass ran on time.
    _script_monotonic(monkeypatch, *_on_time_passes(12), 1_066.5, 1_066.5, 1_071.5, 1_071.5)

    with pytest.raises(asyncio.CancelledError):
        await run_stuck_socket_watchdog(connectors)

    # The skipped pass would have found the group 61.0 s silent; the next, 66.0 s.
    assert _calls(events) == [_SILENT]
    assert events.call_args.kwargs["context"]["since_last_trade_s"] == 66.0
    for connector in connectors.values():
        connector.force_reconnect.assert_called_once_with(_SILENT_REASON)
