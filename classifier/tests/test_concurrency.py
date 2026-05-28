"""Tests for the BoundedSemaphore + cold-start observability shipped
in Phase 1.5 Task 4 (Findings 1.6 and 2.3).

These cover four behaviours:

1.  ``_classify_semaphore`` caps simultaneous in-flight matcher
    invocations at ``_CLASSIFY_CONCURRENCY`` (default 8). Excess
    requests queue rather than running.
2.  When the queue wait exceeds ``_QUEUE_WAIT_TIMEOUT_SEC``, the route
    returns 503 with ``retry_after_sec`` in the body. (Server-side
    Retry-After header plumbing lives in test_server.py.)
3.  Queue waits above ``_QUEUE_WAIT_BREADCRUMB_THRESHOLD_SEC`` emit a
    Sentry breadcrumb so the next captured exception carries the
    pressure context.
4.  Cold-start ``import_ms`` is logged exactly once per process; a
    slow import (>5s) additionally captures a Sentry warning message.

The semaphore is module-level in ``multileg_routes``; tests that touch
it explicitly drain + restore it via a fixture so test ordering can't
leave a stuck permit behind.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any
from unittest.mock import patch

import pytest

import multileg_routes

# ── fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
def reset_classify_semaphore():
    """Replace the module semaphore with a fresh one for the test.

    Some tests deliberately exhaust the semaphore to force a 503 path.
    Restoring the original instance afterward keeps cross-test isolation
    even if the test leaks a permit (it shouldn't, but defence in depth).
    """
    original = multileg_routes._classify_semaphore
    cap = multileg_routes._CLASSIFY_CONCURRENCY
    multileg_routes._classify_semaphore = threading.BoundedSemaphore(cap)
    yield
    multileg_routes._classify_semaphore = original


@pytest.fixture
def reset_cold_start_flag():
    """Reset the ``_polars_import_logged`` module flag around the test.

    The cold-start log message must fire exactly once per process; tests
    that exercise it need a guaranteed-False starting point.
    """
    original = multileg_routes._polars_import_logged
    multileg_routes._polars_import_logged = False
    yield
    multileg_routes._polars_import_logged = original


# ── Finding 1.6: BoundedSemaphore caps concurrency ────────────────────────


def test_classify_semaphore_caps_concurrent_matcher_invocations(
    mock_classify_trades,
    reset_classify_semaphore,
    sample_classify_request_body: bytes,
) -> None:
    """Asserts at most _CLASSIFY_CONCURRENCY matcher invocations run at once.

    Spawns ``cap + 4`` worker threads, each calling
    ``handle_classify_payload``. The stub matcher blocks until released
    and records the max concurrent count seen. We assert the observed
    max equals ``_CLASSIFY_CONCURRENCY`` exactly — proving both the cap
    and that overflow requests do get a permit eventually.
    """
    cap = multileg_routes._CLASSIFY_CONCURRENCY
    total_workers = cap + 4

    barrier = threading.Event()
    in_flight = 0
    max_in_flight = 0
    lock = threading.Lock()

    # Replace the conftest fixture's stub with one that blocks on a
    # barrier so we can prove cap+4 workers can't all run together.
    def blocking_classify(_request):
        nonlocal in_flight, max_in_flight
        with lock:
            in_flight += 1
            if in_flight > max_in_flight:
                max_in_flight = in_flight
        barrier.wait(timeout=5.0)
        with lock:
            in_flight -= 1
        return [
            {
                "id": _request.trades[0].id,
                "inferred_structure": "isolated_leg",
                "is_isolated_leg": True,
                "match_confidence": 0.42,
                "pattern_group_id": "test-group",
            }
        ]

    results: list[tuple[int, dict]] = []
    results_lock = threading.Lock()

    def worker() -> None:
        status, body = multileg_routes.handle_classify_payload(
            sample_classify_request_body
        )
        with results_lock:
            results.append((status, body))

    threads = [threading.Thread(target=worker) for _ in range(total_workers)]
    with patch.object(multileg_routes, "_classify_with_polars", blocking_classify):
        for t in threads:
            t.start()

        # Wait for the cap to fill up. If the semaphore didn't cap, we'd
        # see max_in_flight climb to total_workers within a few hundred
        # ms; if it's working, it should plateau at cap.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            with lock:
                if in_flight >= cap:
                    break
            time.sleep(0.01)

        # Give any over-cap threads a chance to (incorrectly) run.
        time.sleep(0.2)

        # Release everyone so the threads can finish.
        barrier.set()
        for t in threads:
            t.join(timeout=5.0)

    # Hard cap: never more than _CLASSIFY_CONCURRENCY concurrent matcher
    # invocations. Equality is the strong assertion — we know at least
    # cap requests should have run in parallel given total_workers > cap.
    assert max_in_flight == cap, (
        f"expected max {cap} concurrent invocations, observed {max_in_flight}"
    )
    # All requests eventually got through (overflow queued, didn't 503).
    assert len(results) == total_workers
    assert all(status == 200 for status, _ in results)


def test_classify_queue_timeout_returns_503_with_retry_after_in_body(
    sample_classify_request_body: bytes,
) -> None:
    """When the semaphore is fully held longer than the queue-wait
    timeout, the request returns 503 with retry_after_sec in the body.
    """
    # Tiny timeout so the test finishes in <1s. We pin a fresh
    # 1-permit semaphore so we only need to hold one permit to block
    # everyone else.
    original_sem = multileg_routes._classify_semaphore
    original_timeout = multileg_routes._QUEUE_WAIT_TIMEOUT_SEC
    multileg_routes._classify_semaphore = threading.BoundedSemaphore(1)
    multileg_routes._QUEUE_WAIT_TIMEOUT_SEC = 0.1

    try:
        # Drain the only permit so the next acquire times out.
        assert multileg_routes._classify_semaphore.acquire(timeout=0)
        try:
            status, body = multileg_routes.handle_classify_payload(
                sample_classify_request_body
            )
        finally:
            multileg_routes._classify_semaphore.release()

        assert status == 503
        assert body["error"] == "classifier queue timeout; retry in a few seconds"
        assert body["retry_after_sec"] == multileg_routes._RETRY_AFTER_SEC
        assert body["concurrency_cap"] == multileg_routes._CLASSIFY_CONCURRENCY
        # queue_wait_sec is the actual measured wait, ≥ the timeout.
        assert body["queue_wait_sec"] >= 0.1
    finally:
        multileg_routes._classify_semaphore = original_sem
        multileg_routes._QUEUE_WAIT_TIMEOUT_SEC = original_timeout


def test_classify_queue_wait_emits_breadcrumb_when_exceeds_threshold(
    mock_classify_trades,
    reset_classify_semaphore,
    sample_classify_request_body: bytes,
) -> None:
    """A queue wait above _QUEUE_WAIT_BREADCRUMB_THRESHOLD_SEC must drop
    a Sentry breadcrumb tagged ``classifier.queue_wait``.

    We don't actually block on a real wait — we patch ``time.monotonic``
    inside ``multileg_routes`` so the route observes a synthetic 6.5s
    wait and crosses the 5.0s threshold.
    """
    breadcrumb_calls: list[dict[str, Any]] = []

    def fake_add_breadcrumb(**kwargs):
        breadcrumb_calls.append(kwargs)

    # Force time.monotonic() to report two values spaced 6.5s apart on
    # the two calls inside handle_classify_payload (start_wait, then the
    # one used to compute queue_wait_sec).
    monotonic_values = iter([1000.0, 1006.5, 1006.5, 1006.5])

    def fake_monotonic() -> float:
        return next(monotonic_values)

    import sentry_setup

    with (
        patch.object(multileg_routes.time, "monotonic", side_effect=fake_monotonic),
        patch.object(sentry_setup, "add_breadcrumb", side_effect=fake_add_breadcrumb),
    ):
        status, _ = multileg_routes.handle_classify_payload(
            sample_classify_request_body
        )

    assert status == 200
    assert len(breadcrumb_calls) == 1
    bc = breadcrumb_calls[0]
    assert bc["category"] == "classifier.queue_wait"
    assert bc["level"] == "warning"
    assert "6.50s" in bc["message"] or "6.5" in bc["message"]
    assert bc["data"]["queue_wait_sec"] == 6.5
    assert bc["data"]["concurrency_cap"] == multileg_routes._CLASSIFY_CONCURRENCY
    assert (
        bc["data"]["threshold_sec"]
        == multileg_routes._QUEUE_WAIT_BREADCRUMB_THRESHOLD_SEC
    )


def test_classify_queue_wait_below_threshold_emits_no_breadcrumb(
    mock_classify_trades,
    reset_classify_semaphore,
    sample_classify_request_body: bytes,
) -> None:
    """Sub-threshold queue waits must NOT emit a breadcrumb (no log
    noise on normal traffic).
    """
    breadcrumb_calls: list[dict[str, Any]] = []

    def fake_add_breadcrumb(**kwargs):
        breadcrumb_calls.append(kwargs)

    import sentry_setup

    with patch.object(
        sentry_setup, "add_breadcrumb", side_effect=fake_add_breadcrumb
    ):
        status, _ = multileg_routes.handle_classify_payload(
            sample_classify_request_body
        )

    assert status == 200
    # Acquired the permit immediately → wait << 5s threshold → no crumb.
    assert breadcrumb_calls == []


def test_classify_breadcrumb_failure_does_not_break_request(
    mock_classify_trades,
    reset_classify_semaphore,
    sample_classify_request_body: bytes,
) -> None:
    """A buggy ``add_breadcrumb`` must NOT prevent the matcher call from
    running. The route's bare-except around the breadcrumb is the
    contract.
    """
    monotonic_values = iter([1000.0, 1010.0, 1010.0, 1010.0])

    def fake_monotonic() -> float:
        return next(monotonic_values)

    import sentry_setup

    with (
        patch.object(multileg_routes.time, "monotonic", side_effect=fake_monotonic),
        patch.object(
            sentry_setup,
            "add_breadcrumb",
            side_effect=RuntimeError("breadcrumb blew up"),
        ),
    ):
        status, body = multileg_routes.handle_classify_payload(
            sample_classify_request_body
        )

    # Still served a successful response.
    assert status == 200
    assert "classifications" in body


def test_classify_semaphore_releases_on_matcher_exception(
    mock_classify_raises,
    reset_classify_semaphore,
    sample_classify_request_body: bytes,
) -> None:
    """The ``finally: _classify_semaphore.release()`` must fire even
    when the matcher raises — otherwise a single 500 would permanently
    consume a permit and the cap would degrade over time.
    """
    cap = multileg_routes._CLASSIFY_CONCURRENCY
    # Trigger a 500.
    status, _ = multileg_routes.handle_classify_payload(
        sample_classify_request_body
    )
    assert status == 500

    # All permits should still be available. acquire+release on every
    # one of them proves nothing leaked.
    acquired: list[bool] = []
    for _ in range(cap):
        acquired.append(
            multileg_routes._classify_semaphore.acquire(timeout=0.1)
        )
    for ok in acquired:
        if ok:
            multileg_routes._classify_semaphore.release()
    assert all(acquired), "matcher 500 leaked a permit; finally clause missing"


# ── Finding 2.3: cold-start import_ms logging ─────────────────────────────


def test_cold_start_logs_import_ms_once_per_process(
    sample_trade: dict[str, Any],
    reset_cold_start_flag,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """First call logs ``classifier: lazy import_ms=<N>``; subsequent
    calls do not.
    """
    request = multileg_routes.MultilegClassifyRequest.model_validate(
        {"trades": [sample_trade]}
    )

    # First call — must emit.
    multileg_routes._classify_with_polars(request)
    first_out = capsys.readouterr().out
    assert "classifier: lazy import_ms=" in first_out
    assert multileg_routes._polars_import_logged is True

    # Second call — must NOT emit a new log line.
    multileg_routes._classify_with_polars(request)
    second_out = capsys.readouterr().out
    assert "classifier: lazy import_ms=" not in second_out


def test_cold_start_captures_sentry_warning_when_import_slow(
    sample_trade: dict[str, Any],
    reset_cold_start_flag,
) -> None:
    """If the measured import duration exceeds the slow-cold-start
    threshold, ``sentry_setup.capture_message`` is invoked at level
    ``warning`` with the timing in ``extra``.
    """
    request = multileg_routes.MultilegClassifyRequest.model_validate(
        {"trades": [sample_trade]}
    )

    capture_calls: list[dict[str, Any]] = []

    def fake_capture_message(message: str, **kwargs):
        capture_calls.append({"message": message, **kwargs})

    # Fake monotonic so import_ms computes to 6000 (> 5000 threshold).
    # The function calls monotonic() once before import and once after;
    # we also need to handle calls polars itself might make during
    # df.with_columns. Easiest path: patch monotonic only on the
    # multileg_routes module reference (it's bound to ``time.monotonic``
    # via ``import time`` + ``time.monotonic`` access).
    monotonic_values = iter([0.0, 6.0])

    def fake_monotonic() -> float:
        try:
            return next(monotonic_values)
        except StopIteration:
            # Anything after the route is done measuring: return the
            # last value so other callers (polars, etc.) don't crash.
            return 6.0

    import sentry_setup

    with (
        patch.object(multileg_routes.time, "monotonic", side_effect=fake_monotonic),
        patch.object(
            sentry_setup, "capture_message", side_effect=fake_capture_message
        ),
    ):
        multileg_routes._classify_with_polars(request)

    assert len(capture_calls) == 1
    call = capture_calls[0]
    assert call["message"] == "classifier slow cold-start import: 6000ms"
    assert call["level"] == "warning"
    assert call["extra"]["import_ms"] == 6000
    assert (
        call["extra"]["threshold_ms"]
        == multileg_routes._COLD_START_SLOW_THRESHOLD_MS
    )


def test_cold_start_no_sentry_capture_when_import_fast(
    sample_trade: dict[str, Any],
    reset_cold_start_flag,
) -> None:
    """A fast cold-start (under the threshold) must NOT trigger Sentry
    capture — only the print() stays.
    """
    request = multileg_routes.MultilegClassifyRequest.model_validate(
        {"trades": [sample_trade]}
    )

    capture_calls: list[Any] = []

    def fake_capture_message(*args, **kwargs):
        capture_calls.append((args, kwargs))

    import sentry_setup

    with patch.object(
        sentry_setup, "capture_message", side_effect=fake_capture_message
    ):
        multileg_routes._classify_with_polars(request)

    assert capture_calls == []


def test_cold_start_sentry_capture_failure_does_not_break_request(
    sample_trade: dict[str, Any],
    reset_cold_start_flag,
) -> None:
    """A buggy ``capture_message`` must not prevent the matcher from
    returning successfully. The bare-except around the Sentry call is
    the contract.
    """
    request = multileg_routes.MultilegClassifyRequest.model_validate(
        {"trades": [sample_trade]}
    )

    monotonic_values = iter([0.0, 6.0])

    def fake_monotonic() -> float:
        try:
            return next(monotonic_values)
        except StopIteration:
            return 6.0

    import sentry_setup

    with (
        patch.object(multileg_routes.time, "monotonic", side_effect=fake_monotonic),
        patch.object(
            sentry_setup,
            "capture_message",
            side_effect=RuntimeError("sentry capture blew up"),
        ),
    ):
        # Must not raise.
        rows = multileg_routes._classify_with_polars(request)

    # Matcher still ran and returned a row.
    assert len(rows) == 1
    assert rows[0]["id"] == sample_trade["id"]
    # Flag still flipped — we don't retry the slow-import log on next call.
    assert multileg_routes._polars_import_logged is True


# ── Server-side Retry-After plumbing for 503 ──────────────────────────────


def test_server_503_response_includes_retry_after_header() -> None:
    """The server lifts ``retry_after_sec`` out of the 503 body and
    sets a ``Retry-After`` HTTP header. Direct exercise of the server
    response helper rather than the full HTTP stack (the running-server
    fixtures live in test_server.py).
    """
    from io import BytesIO
    from unittest.mock import MagicMock

    import server

    # Build a ClassifierHandler instance without going through __init__
    # (BaseHTTPRequestHandler.__init__ takes the request socket etc.).
    handler = server.ClassifierHandler.__new__(server.ClassifierHandler)
    handler.wfile = BytesIO()
    handler.send_response = MagicMock()
    handler.send_header = MagicMock()
    handler.end_headers = MagicMock()

    handler._write_json(
        503,
        {"error": "queue timeout", "retry_after_sec": 5},
        close_connection=True,
        retry_after_sec=5,
    )

    # Headers sent in order: Content-Type, Content-Length, Connection,
    # Retry-After. Assert Retry-After appeared with the right value.
    header_calls = [
        call.args for call in handler.send_header.call_args_list
    ]
    assert ("Retry-After", "5") in header_calls
    assert ("Connection", "close") in header_calls
    handler.send_response.assert_called_once_with(503)

    # Body still includes retry_after_sec so non-RFC-aware callers
    # parse it from JSON.
    body = json.loads(handler.wfile.getvalue())
    assert body["retry_after_sec"] == 5


def test_server_omits_retry_after_when_not_503() -> None:
    """Non-503 responses (200, 400, 500) must NOT carry Retry-After."""
    from io import BytesIO
    from unittest.mock import MagicMock

    import server

    handler = server.ClassifierHandler.__new__(server.ClassifierHandler)
    handler.wfile = BytesIO()
    handler.send_response = MagicMock()
    handler.send_header = MagicMock()
    handler.end_headers = MagicMock()

    handler._write_json(200, {"ok": True})

    header_calls = [
        call.args for call in handler.send_header.call_args_list
    ]
    assert not any(name == "Retry-After" for name, _ in header_calls)
