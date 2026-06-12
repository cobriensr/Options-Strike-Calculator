"""Unit tests for src/logger_setup.RateLimitedLogger — Phase 3.5 (M3).

A UW wire-format change can flip thousands of payloads per second into
a warning branch. Without per-(scope, kind) throttling, ``log.warning``
alone would saturate the asyncio loop on JSON serialization and stdout
writes, plus burn the Sentry quota on every call.

Tests use a manually-controlled monotonic clock so we don't have to
sleep through real-time intervals.
"""

from __future__ import annotations

import json as _json
import logging as _logging
from unittest.mock import patch

import pytest

from logger_setup import (
    MALFORMED_PAYLOAD_LOG_INTERVAL_S,
    JsonFormatter,
    RateLimitedLogger,
    rate_limited_log,
    scrub_log_tokens,
)


@pytest.fixture(autouse=True)
def _reset_singleton_state():
    """Clear the module-level singleton's bucket dict before AND after
    every test.

    The singleton is process-global, so a test that fires `(scope,
    kind)` X and another test that asserts on first-call behavior for
    the same key would silently couple via the leaked bucket. Clearing
    in both setup and teardown removes any test-order dependency.
    """
    rate_limited_log._state.clear()
    yield
    rate_limited_log._state.clear()


class _FakeClock:
    """Manually-advanceable monotonic clock."""

    def __init__(self, start: float = 1000.0) -> None:
        self._t = start

    def __call__(self) -> float:
        return self._t

    def advance(self, seconds: float) -> None:
        self._t += seconds


def _capture_warnings(monkeypatch) -> list[tuple[tuple, dict]]:
    """Patch the module-level ``log.warning`` and record every call.

    Returns a list of (positional_args, kwargs) per call so tests can
    assert both the formatted message and the structured ``extra``.
    """
    import logger_setup as ls_mod

    captured: list[tuple[tuple, dict]] = []

    def _record(*args, **kwargs):
        captured.append((args, kwargs))

    monkeypatch.setattr(ls_mod.log, "warning", _record)
    return captured


def test_first_call_logs_immediately(monkeypatch):
    captured = _capture_warnings(monkeypatch)
    clock = _FakeClock()
    rl = RateLimitedLogger(interval_s=60.0, clock=clock)

    rl.warning(scope="router", kind="malformed_envelope", message="bad frame")

    assert len(captured) == 1
    args, kwargs = captured[0]
    assert args[0] == "bad frame"
    assert kwargs["extra"]["scope"] == "router"
    assert kwargs["extra"]["kind"] == "malformed_envelope"


def test_first_call_logs_remaining_suppressed(monkeypatch):
    """1000 identical errors in <1s collapse to exactly 1 underlying log
    call. After the window expires, the next call emits a summary AND
    the new event — so 2 total log calls land at that point.
    """
    captured = _capture_warnings(monkeypatch)
    clock = _FakeClock()
    rl = RateLimitedLogger(interval_s=60.0, clock=clock)

    # Fire 1000 identical errors at t=0.
    for _ in range(1000):
        rl.warning(
            scope="router",
            kind="malformed_envelope",
            message="bad frame",
        )

    # Only the first one made it through.
    assert len(captured) == 1

    # Advance past the window and fire one more.
    clock.advance(61.0)
    rl.warning(
        scope="router",
        kind="malformed_envelope",
        message="bad frame",
    )

    # Now 3 underlying calls exist:
    #  1. The original head-of-window warning
    #  2. The summary line for 999 suppressed
    #  3. The new head-of-window warning
    assert len(captured) == 3

    summary_args, summary_kwargs = captured[1]
    # Summary uses the printf-style %d — count is one of the args.
    assert 999 in summary_args
    assert summary_kwargs["extra"]["suppressed_count"] == 999
    assert summary_kwargs["extra"]["scope"] == "router"
    assert summary_kwargs["extra"]["kind"] == "malformed_envelope"

    # The new event is logged in full.
    new_args, _new_kwargs = captured[2]
    assert new_args[0] == "bad frame"


def test_distinct_scope_kind_tuples_have_separate_buckets(monkeypatch):
    """Two different (scope, kind) keys both log their first occurrence
    even when fired back-to-back in the same window.
    """
    captured = _capture_warnings(monkeypatch)
    clock = _FakeClock()
    rl = RateLimitedLogger(interval_s=60.0, clock=clock)

    rl.warning(scope="router", kind="malformed_envelope", message="A")
    rl.warning(scope="router", kind="non_dict_payload", message="B")
    rl.warning(scope="flow_alerts", kind="malformed_envelope", message="C")

    # Three distinct buckets → three head-of-window log calls.
    assert len(captured) == 3
    msgs = [c[0][0] for c in captured]
    assert msgs == ["A", "B", "C"]


def test_no_summary_when_only_first_call_in_window(monkeypatch):
    """A bucket with no suppressed events should NOT emit a summary
    line on window rollover — only a fresh head-of-window log.
    """
    captured = _capture_warnings(monkeypatch)
    clock = _FakeClock()
    rl = RateLimitedLogger(interval_s=60.0, clock=clock)

    rl.warning(scope="router", kind="malformed_envelope", message="X")
    clock.advance(120.0)
    rl.warning(scope="router", kind="malformed_envelope", message="X")

    # 2 head-of-window logs, NO summary in between.
    assert len(captured) == 2
    # Neither log is a summary (the summary contains "suppressed").
    for args, _kwargs in captured:
        assert "suppressed" not in str(args[0])


def test_extra_payload_only_on_head_of_window(monkeypatch):
    """``extra`` is forwarded only on the head-of-window call. Suppressed
    occurrences never push their ``extra`` through — that's the whole
    point of the throttle (avoid log volume + Sentry quota burn).
    """
    captured = _capture_warnings(monkeypatch)
    clock = _FakeClock()
    rl = RateLimitedLogger(interval_s=60.0, clock=clock)

    rl.warning(
        scope="router",
        kind="malformed_envelope",
        message="bad",
        extra={"sample": "payload-1"},
    )
    rl.warning(
        scope="router",
        kind="malformed_envelope",
        message="bad",
        extra={"sample": "payload-2"},  # suppressed → never logged
    )

    assert len(captured) == 1
    _args, kwargs = captured[0]
    assert kwargs["extra"]["sample"] == "payload-1"


def test_default_interval_matches_constant():
    """The constant is the public knob for the throttle window — make
    sure the default arg in the constructor uses it.
    """
    rl = RateLimitedLogger()
    assert rl._interval_s == MALFORMED_PAYLOAD_LOG_INTERVAL_S


def test_module_singleton_is_shared(monkeypatch):
    """``rate_limited_log`` is the module-level singleton — patching
    its underlying ``log.warning`` should still capture every call from
    every callsite that imports it.
    """
    import logger_setup as ls_mod

    captured: list[tuple[tuple, dict]] = []

    def _record(*args, **kwargs):
        captured.append((args, kwargs))

    monkeypatch.setattr(ls_mod.log, "warning", _record)

    # Reset the singleton's bucket so prior tests don't interfere.
    rate_limited_log._state.clear()

    rate_limited_log.warning(
        scope="singleton-test",
        kind="probe",
        message="hello from singleton",
    )

    assert len(captured) == 1
    assert captured[0][0][0] == "hello from singleton"


@pytest.mark.parametrize("n", [1, 5, 50, 500])
def test_summary_count_equals_n_minus_1_for_n_calls(monkeypatch, n):
    """N identical calls in one window → first logs, then N-1 are
    suppressed. After window rollover, the summary count is exactly N-1.
    """
    captured = _capture_warnings(monkeypatch)
    clock = _FakeClock()
    rl = RateLimitedLogger(interval_s=60.0, clock=clock)

    for _ in range(n):
        rl.warning(scope="s", kind="k", message="m")

    clock.advance(61.0)
    # Trigger window rollover by firing one more call.
    rl.warning(scope="s", kind="k", message="m")

    # Summary expected only when n > 1 (otherwise no suppressions).
    if n == 1:
        # 1 head + 1 new head (no summary in between).
        assert len(captured) == 2
        return

    assert len(captured) == 3  # head + summary + new head
    _summary_args, summary_kwargs = captured[1]
    assert summary_kwargs["extra"]["suppressed_count"] == n - 1


def test_window_uses_monotonic_clock_by_default():
    """Default clock should be ``time.monotonic`` so wall-clock jumps
    (NTP corrections, container migrations) don't reset the throttle.
    """
    import time as time_mod

    rl = RateLimitedLogger()
    assert rl._clock is time_mod.monotonic


def test_warning_does_not_raise_on_unhashable_extra(monkeypatch):
    """Defensive: ``extra`` containing nested objects shouldn't crash
    the throttle. (Logger itself stringifies via JsonFormatter at write
    time — we're not asserting JSON shape, just that no exception
    propagates back to the caller's hot path.)
    """
    _capture_warnings(monkeypatch)
    rl = RateLimitedLogger(interval_s=60.0, clock=_FakeClock())

    # Should not raise.
    rl.warning(
        scope="x",
        kind="y",
        message="m",
        extra={"nested": {"deep": [1, 2, 3]}},
    )


def test_module_singleton_state_does_not_leak_across_tests():
    """Sanity: the module-level singleton is a long-lived object. Tests
    that touch it should clean up after themselves. We exercise the
    cleanup pattern documented in the module header here as a smoke
    check so future test additions follow the same convention.
    """
    rate_limited_log._state.clear()
    assert rate_limited_log._state == {}


def test_patched_logger_module_singleton_does_not_blow_up_on_reset():
    """Reset → first call → reset cycle should be safe. Covers the
    'tests may run in any order' case where one test resets the state
    after another seeded it.
    """
    with patch("logger_setup.log.warning"):
        rate_limited_log._state.clear()
        rate_limited_log.warning(scope="a", kind="b", message="c")
        rate_limited_log._state.clear()
        # Re-fire — should treat as fresh head-of-window.
        rate_limited_log.warning(scope="a", kind="b", message="c")


# ──────────────────────────────────────────────────────────────────────────
# AUD-L12b: token scrubbing in the PLAIN-LOG path (JsonFormatter).
#
# Sentry already scrubbed ``?token=<key>`` via sentry_setup._before_send, but
# the JSON formatter wrote messages/extra/exc verbatim — so the WS handshake
# URL (which embeds the UW API key) could land in stdout / the Railway log
# drain in plaintext. These pin the formatter's redaction.
# ──────────────────────────────────────────────────────────────────────────

_WS_URL = "wss://api.unusualwhales.com/socket?token=SUPER_SECRET_KEY"


def _format(record: _logging.LogRecord) -> dict:
    """Run a record through JsonFormatter and parse the emitted JSON line."""
    return _json.loads(JsonFormatter().format(record))


def test_scrub_log_tokens_redacts_and_preserves_shape() -> None:
    out = scrub_log_tokens(f"connecting to {_WS_URL}")
    assert "SUPER_SECRET_KEY" not in out
    assert "token=REDACTED" in out


def test_scrub_log_tokens_noop_without_token() -> None:
    assert scrub_log_tokens("just a plain message") == "just a plain message"


def test_scrub_log_tokens_handles_aliases() -> None:
    assert "X" not in scrub_log_tokens("u?api_key=X")
    assert "Y" not in scrub_log_tokens("u?key=Y")


def test_formatter_scrubs_token_in_message() -> None:
    record = _logging.LogRecord(
        name="uw-stream",
        level=_logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="connecting to %s",
        args=(_WS_URL,),
        exc_info=None,
    )
    entry = _format(record)
    assert "SUPER_SECRET_KEY" not in entry["msg"]
    assert "token=REDACTED" in entry["msg"]


def test_formatter_scrubs_token_in_string_extra() -> None:
    record = _logging.LogRecord(
        name="uw-stream",
        level=_logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="connecting",
        args=(),
        exc_info=None,
    )
    record.ws_url = _WS_URL  # caller-attached extra
    entry = _format(record)
    assert "SUPER_SECRET_KEY" not in _json.dumps(entry)
    assert "token=REDACTED" in entry["ws_url"]


def test_formatter_scrubs_token_in_nested_extra() -> None:
    """A non-string extra (dict) carrying the URL must still be scrubbed by
    the whole-line guard so no path leaks the secret."""
    record = _logging.LogRecord(
        name="uw-stream",
        level=_logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="connecting",
        args=(),
        exc_info=None,
    )
    record.detail = {"url": _WS_URL}
    line = JsonFormatter().format(record)
    assert "SUPER_SECRET_KEY" not in line


def test_formatter_scrubs_token_in_exception_text() -> None:
    try:
        raise RuntimeError(f"handshake failed for {_WS_URL}")
    except RuntimeError:
        import sys

        record = _logging.LogRecord(
            name="uw-stream",
            level=_logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="boom",
            args=(),
            exc_info=sys.exc_info(),
        )
    entry = _format(record)
    assert "SUPER_SECRET_KEY" not in entry["exc"]
    assert "token=REDACTED" in entry["exc"]
