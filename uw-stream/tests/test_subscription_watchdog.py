"""Tests for the subscription watchdog's pure strike/alert logic.

The watchdog detects SILENT per-channel subscription failures (the 2026-06-02
50-channel-cap outage went unnoticed for ~20h). ``_evaluate`` is the pure core:
it accumulates a consecutive-unsubscribed strike count per channel and reports
channels that NEWLY cross the alert threshold, without re-spamming. These pin
that behavior so a regression can't silently re-open the detection gap.
"""

from __future__ import annotations

from subscription_watchdog import _STRIKES_TO_ALERT, _evaluate


def test_subscribed_channels_never_strike_or_alert():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    newly = _evaluate({"a": True, "b": True}, strikes, alerted)
    assert newly == []
    assert strikes == {"a": 0, "b": 0}
    assert alerted == set()


def test_single_unsubscribed_check_does_not_alert():
    # One missed check tolerates a transient reconnect — must NOT alert yet.
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    newly = _evaluate({"a": False}, strikes, alerted)
    assert newly == []
    assert strikes["a"] == 1
    assert _STRIKES_TO_ALERT >= 2  # guards the "tolerate one reconnect" intent


def test_alerts_after_consecutive_strikes():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    subscribed = {"a": False}
    # Strike up to the threshold; the check that crosses it returns the channel.
    for _ in range(_STRIKES_TO_ALERT - 1):
        assert _evaluate(subscribed, strikes, alerted) == []
    assert _evaluate(subscribed, strikes, alerted) == ["a"]
    assert "a" in alerted


def test_does_not_realert_while_still_stuck():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    subscribed = {"a": False}
    for _ in range(_STRIKES_TO_ALERT):
        _evaluate(subscribed, strikes, alerted)
    assert "a" in alerted
    # Still stuck on later checks — no repeat alert (we don't spam Sentry).
    assert _evaluate(subscribed, strikes, alerted) == []
    assert _evaluate(subscribed, strikes, alerted) == []


def test_resubscribe_resets_and_allows_realert():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    # Get it stuck + alerted.
    for _ in range(_STRIKES_TO_ALERT):
        _evaluate({"a": False}, strikes, alerted)
    assert "a" in alerted
    # It re-subscribes: strikes reset, alerted flag cleared.
    assert _evaluate({"a": True}, strikes, alerted) == []
    assert strikes["a"] == 0
    assert "a" not in alerted
    # A later re-failure must be able to alert again.
    for _ in range(_STRIKES_TO_ALERT - 1):
        assert _evaluate({"a": False}, strikes, alerted) == []
    assert _evaluate({"a": False}, strikes, alerted) == ["a"]


def test_independent_channels_strike_independently():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    # 'a' stuck, 'b' healthy across all checks.
    for _ in range(_STRIKES_TO_ALERT - 1):
        _evaluate({"a": False, "b": True}, strikes, alerted)
    newly = _evaluate({"a": False, "b": True}, strikes, alerted)
    assert newly == ["a"]
    assert strikes["b"] == 0
    assert "b" not in alerted
