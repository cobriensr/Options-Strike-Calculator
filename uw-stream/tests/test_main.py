"""Unit tests for main._shutdown — the graceful-shutdown ordering.

The full _run wiring (signals, pool, health server) isn't exercised here;
_shutdown is the part with a correctness-critical invariant: producers
must be cancelled BEFORE the consumer handlers are drained, so the router
can't enqueue a payload into a queue whose drain loop has already emptied
it. Push-notification flushing + session close are also verified.
"""

from __future__ import annotations

import asyncio

import pytest

import main
import notify


@pytest.fixture(autouse=True)
def _reset_notify_state(monkeypatch):
    """Stub notify's drain/close so _shutdown doesn't touch real HTTP."""
    calls: list[str] = []

    async def _fake_drain_pending(*_a, **_k) -> None:
        calls.append("notify_drain")

    async def _fake_close(*_a, **_k) -> None:
        calls.append("notify_close")

    monkeypatch.setattr(notify, "drain_pending", _fake_drain_pending)
    monkeypatch.setattr(notify, "close_session", _fake_close)
    return calls


class _FakeHandler:
    """Records when its drain runs and asserts producers are already gone."""

    def __init__(self, name: str, events: list[str], producers: list[asyncio.Task]):
        self.name = name
        self._events = events
        self._producers = producers

    async def drain(self) -> int:
        # The whole point of the ordering fix: by the time a handler is
        # drained, every producer must already be finished (cancelled).
        assert all(p.done() for p in self._producers), (
            "producers must be cancelled before handlers are drained"
        )
        self._events.append(f"drain:{self.name}")
        return 0


async def _forever(events: list[str], label: str) -> None:
    try:
        await asyncio.sleep(3600)
    except asyncio.CancelledError:
        events.append(f"cancelled:{label}")
        raise


@pytest.mark.asyncio
async def test_shutdown_cancels_producers_before_draining(_reset_notify_state):
    events: list[str] = []
    calls = _reset_notify_state

    connector = asyncio.create_task(_forever(events, "connector"))
    router = asyncio.create_task(_forever(events, "router"))
    producers = [connector, router]

    health = asyncio.create_task(_forever(events, "health"))
    stop_wait = asyncio.create_task(_forever(events, "stop_wait"))

    handler = _FakeHandler("fake", events, producers)

    # Let every task reach its suspension point so a subsequent cancel
    # is delivered INTO the running coroutine (otherwise a task cancelled
    # before it ever ran never executes its except block).
    await asyncio.sleep(0.02)

    await main._shutdown(
        producer_tasks=producers,
        handlers=[handler],
        other_tasks=[health, stop_wait],
    )

    # Producers cancelled strictly before the handler drain ran.
    assert events.index("cancelled:connector") < events.index("drain:fake")
    assert events.index("cancelled:router") < events.index("drain:fake")
    # Notifications flushed + session closed during shutdown.
    assert calls == ["notify_drain", "notify_close"]
    # Background tasks were cancelled too.
    assert connector.cancelled() and router.cancelled()
    assert health.cancelled() and stop_wait.cancelled()


@pytest.mark.asyncio
async def test_shutdown_logs_but_survives_a_drain_failure(_reset_notify_state):
    """A handler whose drain raises must not abort the shutdown — the
    other handlers, notify flush, and task cancellation still run.
    """
    events: list[str] = []
    calls = _reset_notify_state

    producer = asyncio.create_task(_forever(events, "connector"))

    class _BoomHandler:
        name = "boom"

        async def drain(self) -> int:
            raise RuntimeError("drain blew up")

    good = _FakeHandler("good", events, [producer])

    await asyncio.sleep(0.02)  # let the producer reach its await point

    await main._shutdown(
        producer_tasks=[producer],
        handlers=[_BoomHandler(), good],
        other_tasks=[],
    )

    # The good handler still drained despite the boom handler raising.
    assert "drain:good" in events
    # Notify flush + close still happened.
    assert calls == ["notify_drain", "notify_close"]
    assert producer.cancelled()
