"""Tests for the /archive/* concurrency bound (AUD-M25).

`archive_query` runs DuckDB with a per-connection `memory_limit='500MB'`
plus ~2 GB of temp spill, and the routes are unauthenticated on an
unbounded `ThreadingHTTPServer`. Without a cap, N concurrent requests =
N heavy DuckDB connections = a trivial unauthenticated OOM DoS.

These tests pin:
  1. `archive_query_slot()` admits at most `_ARCHIVE_QUERY_CONCURRENCY`
     concurrent holders and raises `ArchiveBusyError` past the cap.
  2. The HTTP handler maps that saturation to a 503 (with Retry-After)
     instead of dispatching another heavy query.

The heavy DuckDB call is stubbed so the suite stays fast and hermetic —
we are testing the bound, not the query.
"""

from __future__ import annotations

import io
import json
import sys
import threading
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import archive_query  # noqa: E402
from health import HealthHandler  # noqa: E402


# ---------------------------------------------------------------------------
# Semaphore-layer tests (archive_query.archive_query_slot)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _fresh_semaphore() -> None:
    """Reset the module-level semaphore to a known cap of 2 per test.

    The bound is process-global; reusing the real one across tests would
    let a leaked slot from one test poison the next. We swap in a fresh
    BoundedSemaphore(2) and restore the original afterward.
    """
    original = archive_query._archive_query_semaphore
    archive_query._archive_query_semaphore = threading.BoundedSemaphore(2)
    try:
        yield
    finally:
        archive_query._archive_query_semaphore = original


def test_slot_admits_up_to_cap() -> None:
    """The first `cap` acquisitions succeed and hold concurrently."""
    cm1 = archive_query.archive_query_slot()
    cm2 = archive_query.archive_query_slot()
    cm1.__enter__()
    cm2.__enter__()
    try:
        # Both slots held — a third must be refused.
        with pytest.raises(archive_query.ArchiveBusyError):
            with archive_query.archive_query_slot():
                pass
    finally:
        cm1.__exit__(None, None, None)
        cm2.__exit__(None, None, None)


def test_slot_releases_on_exit() -> None:
    """A slot freed on context exit is reusable by the next caller."""
    with archive_query.archive_query_slot():
        pass
    # Cap is 2; after the above released, two fresh acquisitions must fit.
    with archive_query.archive_query_slot():
        with archive_query.archive_query_slot():
            with pytest.raises(archive_query.ArchiveBusyError):
                with archive_query.archive_query_slot():
                    pass


def test_slot_releases_even_when_body_raises() -> None:
    """An exception inside the slot still frees it (no leak)."""
    with pytest.raises(RuntimeError):
        with archive_query.archive_query_slot():
            raise RuntimeError("boom")
    # If the slot leaked, only one more acquisition would fit. Two must.
    with archive_query.archive_query_slot():
        with archive_query.archive_query_slot():
            with pytest.raises(archive_query.ArchiveBusyError):
                with archive_query.archive_query_slot():
                    pass


def test_slot_bounds_concurrency_under_threads() -> None:
    """Under real threads, never more than `cap` hold the slot at once."""
    cap = 2
    peak = 0
    current = 0
    lock = threading.Lock()
    release = threading.Event()
    refused = []

    def worker() -> None:
        nonlocal peak, current
        try:
            with archive_query.archive_query_slot():
                with lock:
                    current += 1
                    peak = max(peak, current)
                # Hold the slot until the test signals release so slots
                # genuinely overlap.
                release.wait(timeout=5)
                with lock:
                    current -= 1
        except archive_query.ArchiveBusyError:
            refused.append(True)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    # Give the threads a moment to all attempt acquisition, then release.
    threading.Event().wait(0.2)
    release.set()
    for t in threads:
        t.join(timeout=5)

    assert peak <= cap, f"peak concurrency {peak} exceeded cap {cap}"
    # 6 workers, cap 2 — at least some must have been refused.
    assert refused, "expected some workers to hit the busy cap"


# ---------------------------------------------------------------------------
# HTTP-layer test (handler returns 503 when saturated)
# ---------------------------------------------------------------------------


class _FakeRequest:
    """Minimal request stub BaseHTTPRequestHandler expects."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.raw = f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode()

    def makefile(self, mode: str, *_args: object) -> io.BytesIO:
        if "r" in mode:
            return io.BytesIO(self.raw)
        return io.BytesIO()


def _run_request(path: str) -> tuple[int, dict[str, Any], dict[str, str]]:
    """Drive HealthHandler for one GET; return (status, body, headers)."""
    req = _FakeRequest(path=path)
    output = io.BytesIO()

    class _H(HealthHandler):
        def setup(self_inner) -> None:  # noqa: N805
            self_inner.rfile = req.makefile("rb")
            self_inner.wfile = output

        def finish(self_inner) -> None:  # noqa: N805
            pass

        def log_message(self_inner, *_a: object, **_kw: object) -> None:  # noqa: N805
            pass

    _H(req, ("127.0.0.1", 0), None)  # type: ignore[arg-type]
    raw = output.getvalue().decode()
    status_line, _, rest = raw.partition("\r\n")
    status = int(status_line.split()[1])
    header_text, _, body_text = rest.partition("\r\n\r\n")
    headers = {}
    for line in header_text.split("\r\n"):
        if ":" in line:
            k, _, v = line.partition(":")
            headers[k.strip()] = v.strip()
    body = json.loads(body_text) if body_text else {}
    return status, body, headers


def test_archive_handler_returns_503_when_cap_saturated() -> None:
    """When the slot is fully taken, the route 503s without querying.

    We exhaust the cap by holding both slots in the test thread, then
    fire a request. The handler must shed load (503) and must NOT call
    into the heavy query layer.
    """
    sema = threading.BoundedSemaphore(2)
    with patch.object(archive_query, "_archive_query_semaphore", sema):
        # Saturate the cap from the test thread.
        held1 = archive_query.archive_query_slot()
        held2 = archive_query.archive_query_slot()
        held1.__enter__()
        held2.__enter__()
        try:
            # If saturation works, es_day_summary is never reached.
            with patch(
                "archive_query.es_day_summary",
                side_effect=AssertionError("query must not run when saturated"),
            ):
                status, body, headers = _run_request(
                    path="/archive/es-range?date=2025-01-15"
                )
        finally:
            held1.__exit__(None, None, None)
            held2.__exit__(None, None, None)

    assert status == 503
    assert headers.get("Retry-After") == "1"
    assert "busy" in body["error"]


def test_archive_handler_runs_query_when_slot_available() -> None:
    """With slots free, the route dispatches the query normally (200)."""
    sample = {"date": "2025-01-15", "symbol": "ESH5", "open": 1.0}
    sema = threading.BoundedSemaphore(2)
    with patch.object(archive_query, "_archive_query_semaphore", sema):
        with patch("archive_query.es_day_summary", return_value=sample):
            status, body, _ = _run_request(
                path="/archive/es-range?date=2025-01-15"
            )
    assert status == 200
    assert body == sample
