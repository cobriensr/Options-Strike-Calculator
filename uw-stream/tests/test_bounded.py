"""Tests for run_bounded, the hard-bounded await used on the shutdown path.

``asyncio.wait_for`` cancels the inner awaitable at its deadline and then waits
for it to finish unwinding, so work that will not unwind (a flush parked in a DB
call, a websocket mid close handshake) holds the caller past Railway's SIGKILL
window. ``run_bounded`` returns at the deadline whether or not the work has
unwound. These tests make the work refuse to unwind until the test lets it.
"""

from __future__ import annotations

import asyncio

import pytest

import bounded
from bounded import run_bounded


@pytest.fixture(autouse=True)
async def _every_abandoned_task_finishes():
    yield
    if bounded._unwinding:
        await asyncio.wait(set(bounded._unwinding), timeout=1.0)
    assert not bounded._unwinding, f"test left tasks unwinding: {bounded._unwinding}"


async def _stuck_until(release: asyncio.Event, *, then: BaseException | None = None) -> None:
    """Block forever; once cancelled, keep unwinding until ``release`` is set."""
    try:
        await asyncio.sleep(3600)
    except asyncio.CancelledError:
        await release.wait()
        if then is not None:
            raise then from None
        raise


async def _finish_unwinding(release: asyncio.Event) -> None:
    (task,) = bounded._unwinding
    release.set()
    await asyncio.wait({task}, timeout=2.0)


async def test_returns_the_result_when_the_work_finishes_in_time():
    async def _work() -> str:
        await asyncio.sleep(0)
        return "done"

    assert await run_bounded(_work(), 1.0, name="quick") == "done"
    assert not bounded._unwinding


async def test_propagates_an_exception_from_the_work():
    async def _work() -> None:
        raise RuntimeError("flush blew up")

    with pytest.raises(RuntimeError, match="flush blew up"):
        await run_bounded(_work(), 1.0, name="boom")


async def test_raises_timeout_at_the_deadline_even_if_the_work_will_not_unwind():
    release = asyncio.Event()
    loop = asyncio.get_running_loop()
    started = loop.time()

    with pytest.raises(TimeoutError, match="stuck"):
        await run_bounded(_stuck_until(release), 0.1, name="stuck")

    # wait_for would still be waiting here: the work refuses to unwind.
    assert loop.time() - started < 1.0
    await _finish_unwinding(release)


async def test_cancels_the_work_at_the_deadline():
    cancelled = asyncio.Event()

    async def _work() -> None:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    with pytest.raises(TimeoutError):
        await run_bounded(_work(), 0.05, name="cancelled")

    await asyncio.wait_for(cancelled.wait(), timeout=1.0)


async def test_keeps_a_task_that_is_still_unwinding_until_it_finishes():
    # The loop holds tasks only weakly; run_bounded must hold this one.
    release = asyncio.Event()

    with pytest.raises(TimeoutError):
        await run_bounded(_stuck_until(release), 0.05, name="held")

    assert len(bounded._unwinding) == 1
    await _finish_unwinding(release)
    assert not bounded._unwinding


async def test_logs_a_failure_raised_while_unwinding_instead_of_losing_it(monkeypatch):
    warnings: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        bounded.log, "warning", lambda msg, *a, **kw: warnings.append((msg, kw.get("extra") or {}))
    )
    release = asyncio.Event()

    with pytest.raises(TimeoutError):
        await run_bounded(
            _stuck_until(release, then=RuntimeError("cleanup failed")), 0.05, name="late-fail"
        )
    await _finish_unwinding(release)

    assert len(warnings) == 1
    assert warnings[0][1] == {"task": "late-fail", "err": "cleanup failed"}


async def test_does_not_log_the_cancellation_of_an_abandoned_gather(monkeypatch):
    # A cancelled asyncio.gather future ends with a CancelledError *exception*
    # rather than as cancelled. That is the cancel we asked for, not a failure.
    warnings: list[str] = []
    monkeypatch.setattr(bounded.log, "warning", lambda msg, *a, **kw: warnings.append(msg))
    release = asyncio.Event()
    child = asyncio.create_task(_stuck_until(release))

    with pytest.raises(TimeoutError):
        await run_bounded(asyncio.gather(child, return_exceptions=True), 0.05, name="gathered")
    await _finish_unwinding(release)

    assert warnings == []


async def test_cancelling_the_caller_cancels_the_work():
    cancelled = asyncio.Event()

    async def _work() -> None:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    caller = asyncio.create_task(run_bounded(_work(), 30.0, name="outer"))
    await asyncio.sleep(0.02)
    caller.cancel()

    with pytest.raises(asyncio.CancelledError):
        await caller
    await asyncio.wait_for(cancelled.wait(), timeout=1.0)
