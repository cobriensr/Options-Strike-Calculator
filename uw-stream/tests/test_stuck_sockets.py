"""Tests for stuck_sockets: alert on and reconnect a trade socket that is up but silent (Task 6).

Each option_trades:<TICKER> channel is joined on two sockets, a twin pair. A
socket that stays connected and never receives another trade frame raised
nothing before this task: the twin-silence warning needs a trade frame to end a
gap. ``socket_stats.find_stuck`` is the pure test; these tests cover what
``stuck_sockets`` does with it: one Sentry event per incident, at most one per
shard per cooldown (the alert floor), a forced reconnect bounded by a cooldown,
one escalation, recovery, and a loop that a failing shard, a failing pass or a
loop stall cannot kill.

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
    FORCED_RECONNECT_COOLDOWN_S,
    STUCK_CHECK_INTERVAL_S,
    _check,
    _Watch,
    run_stuck_socket_watchdog,
)

_NOW = 1_100.5

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


def _connectors(*names: str) -> dict[str, MagicMock]:
    return {name: MagicMock(spec=Connector) for name in names or ("conn0", "conn1")}


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
        connectors["conn0"].force_reconnect.side_effect = lambda _r: order.append("force")

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
        self, events, errors
    ):
        _stuck_at_now()
        connectors = _connectors()
        connectors["conn0"].force_reconnect.side_effect = RuntimeError("abort failed")
        watch = _Watch()

        _check(watch, connectors, _NOW)
        # The next pass: the failed call is not retried.
        _check(watch, connectors, _NOW + 5.0)

        assert connectors["conn0"].force_reconnect.call_count == 1
        # The event was sent before the call raised; the escalation is held by the floor.
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
