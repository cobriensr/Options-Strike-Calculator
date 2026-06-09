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
import ws_lease


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


class _FakeLeaseSession:
    """Minimal aiohttp.ClientSession stand-in for lease wiring tests."""

    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_run_exits_nonzero_when_lease_acquire_times_out(monkeypatch):
    """The lease invariant: a booting daemon must NOT open any UW socket
    until it holds the lease. If acquire times out (a wedged prior gen
    still holds it), _run must exit non-zero (SystemExit) BEFORE building
    any Connector — never force-stealing — so Railway restarts + retries.
    """
    # No real Sentry / DB / aiohttp.
    monkeypatch.setattr(main, "init_sentry", lambda: None)

    pool_calls: list[str] = []

    async def _fake_init_pool() -> None:
        pool_calls.append("init")

    async def _fake_close_pool() -> None:
        pool_calls.append("close")

    monkeypatch.setattr(main, "init_pool", _fake_init_pool)
    monkeypatch.setattr(main, "close_pool", _fake_close_pool)

    # Lease enabled with creds present so _run takes the lease branch.
    monkeypatch.setattr(main.settings, "ws_lease_enabled", True, raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_url", "https://test.upstash.io", raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_token", "tok", raising=False)

    fake_session = _FakeLeaseSession()
    monkeypatch.setattr(main.aiohttp, "ClientSession", lambda *a, **k: fake_session)

    built_connectors: list[object] = []
    monkeypatch.setattr(main, "Connector", lambda *a, **k: built_connectors.append(object()))

    class _FakeLease:
        def __init__(self, **_kwargs) -> None:
            self.released = False

        async def acquire(self, _timeout_s: float) -> bool:
            return False  # contended past timeout — wedged prior gen.

        async def release(self) -> bool:
            self.released = True
            return False

    monkeypatch.setattr(main, "WsLease", _FakeLease)

    with pytest.raises(SystemExit) as exc_info:
        await main._run()

    assert exc_info.value.code == 1
    # Pool was opened then closed on the fail path.
    assert pool_calls == ["init", "close"]
    # The lease's session was closed (no leaked connector pool).
    assert fake_session.closed is True
    # CRITICAL: we exited before building ANY connector / opening a socket.
    assert built_connectors == []


@pytest.mark.asyncio
async def test_run_wires_renewal_task_with_stop_as_on_lost(monkeypatch):
    """_run must start the lease renewal task and bind ``on_lost`` to the
    stop Event's ``.set`` — so a confirmed lease loss routes into the SAME
    graceful-shutdown path as a SIGTERM. Also confirms the lease is released
    on shutdown.
    """
    monkeypatch.setattr(main, "init_sentry", lambda: None)

    async def _noop_pool() -> None:
        return None

    monkeypatch.setattr(main, "init_pool", _noop_pool)
    monkeypatch.setattr(main, "close_pool", _noop_pool)

    monkeypatch.setattr(main.settings, "ws_lease_enabled", True, raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_url", "https://t.upstash.io", raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_token", "tok", raising=False)
    monkeypatch.setattr(main.aiohttp, "ClientSession", lambda *a, **k: _FakeLeaseSession())

    # Stub the data pipeline so _run reaches the renewal wiring + asyncio.wait
    # cleanly without real connectors/router/health/watchdog.
    monkeypatch.setattr(main, "_build_handlers", lambda _ch: {})

    class _ForeverConnector:
        def __init__(self, *_a, **kwargs) -> None:
            # main pre-registers each shard via c.name before tasks start.
            self.name = kwargs.get("name", "conn")

        async def run(self) -> None:
            await asyncio.sleep(3600)

    class _ForeverRouter:
        def __init__(self, *_a, **_k) -> None: ...

        async def run(self, _q) -> None:
            await asyncio.sleep(3600)

    async def _forever_bg() -> None:
        await asyncio.sleep(3600)

    monkeypatch.setattr(main, "Connector", _ForeverConnector)
    monkeypatch.setattr(main, "Router", _ForeverRouter)
    monkeypatch.setattr(main, "run_server", _forever_bg)
    monkeypatch.setattr(main, "run_subscription_watchdog", _forever_bg)

    captured: dict[str, object] = {}

    class _FakeLease:
        def __init__(self, **_k) -> None:
            self.released = False

        async def acquire(self, _t: float) -> bool:
            return True

        async def run_renewal(self, on_lost) -> None:
            captured["on_lost"] = on_lost
            captured["lease"] = self
            # Simulate a confirmed loss: fire on_lost (= stop.set) so the
            # main asyncio.wait wakes deterministically → graceful shutdown.
            on_lost()

        async def release(self) -> bool:
            self.released = True
            return True

    monkeypatch.setattr(main, "WsLease", _FakeLease)

    await main._run()

    on_lost = captured.get("on_lost")
    assert on_lost is not None, "renewal task was never started"
    # on_lost must be the stop Event's bound .set — the wiring under test.
    assert getattr(on_lost, "__name__", None) == "set"
    assert isinstance(getattr(on_lost, "__self__", None), asyncio.Event)
    # And the lease was released during shutdown.
    assert captured["lease"].released is True  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_shutdown_releases_lease_after_producers_then_closes_session(
    _reset_notify_state,
):
    """Release ordering: the lease may only be released AFTER our sockets
    are closed (producers cancelled), and the lease's session closes after
    the release. Releasing earlier would let the next gen connect while our
    sockets are still open — the overlap the lease exists to prevent.
    """
    events: list[str] = []

    producer = asyncio.create_task(_forever(events, "connector"))

    class _RecordingLease(ws_lease.WsLease):  # type: ignore[misc]
        def __init__(self, events_list: list[str]) -> None:
            # Skip the real __init__ — we only exercise release().
            self._events = events_list

        async def release(self) -> bool:
            # By the time release runs, the producer must be cancelled
            # (our sockets closed) — that's the invariant under test.
            assert producer.done(), "lease must be released only after producers are cancelled"
            self._events.append("lease_release")
            return True

    lease = _RecordingLease(events)
    session = _FakeLeaseSession()

    await asyncio.sleep(0.02)  # let the producer reach its await point

    await main._shutdown(
        producer_tasks=[producer],
        handlers=[],
        other_tasks=[],
        lease=lease,
        lease_session=session,
    )

    # Producer cancelled, lease released, session closed — in order.
    assert events.index("cancelled:connector") < events.index("lease_release")
    assert session.closed is True


@pytest.mark.asyncio
async def test_shutdown_without_lease_is_unchanged(_reset_notify_state):
    """When no lease is active (kill switch off), _shutdown must behave
    exactly as before — no lease release, no session close, no error.
    """
    events: list[str] = []
    producer = asyncio.create_task(_forever(events, "connector"))

    await asyncio.sleep(0.02)

    # lease/lease_session default to None — must not raise.
    await main._shutdown(
        producer_tasks=[producer],
        handlers=[],
        other_tasks=[],
    )

    assert producer.cancelled()
