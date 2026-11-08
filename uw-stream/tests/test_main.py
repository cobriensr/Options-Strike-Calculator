"""Unit tests for main._shutdown — the graceful-shutdown ordering.

The full _run wiring (signals, pool, health server) isn't exercised here;
_shutdown is the part with a correctness-critical invariant: producers
must be cancelled BEFORE the consumer handlers are drained, so the router
can't enqueue a payload into a queue whose drain loop has already emptied
it. Push-notification flushing + session close are also verified.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

import bounded
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
        connectors=[],
        receive_queue=asyncio.Queue(),
        lease_renewal=None,
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
        connectors=[],
        receive_queue=asyncio.Queue(),
        lease_renewal=None,
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

    # AUD-H2: SystemExit bypasses main()'s `except Exception`, so the path must
    # report to Sentry itself.
    messages: list[tuple[str, dict]] = []
    monkeypatch.setattr(main, "capture_message", lambda msg, **kw: messages.append((msg, kw)))

    with pytest.raises(SystemExit) as exc_info:
        await main._run()

    assert exc_info.value.code == 1
    # Pool was opened then closed on the fail path.
    assert pool_calls == ["init", "close"]
    # The lease's session was closed (no leaked connector pool).
    assert fake_session.closed is True
    # CRITICAL: we exited before building ANY connector / opening a socket.
    assert built_connectors == []
    # The acquire-timeout was reported to Sentry at error level (AUD-H2).
    assert len(messages) == 1
    msg, kw = messages[0]
    assert "acquire timed out" in msg
    assert kw.get("level") == "error"
    assert kw.get("tags", {}).get("reason") == "lease_acquire_timeout"


@pytest.mark.asyncio
async def test_run_wires_renewal_task_with_lease_lost_callback(monkeypatch):
    """_run must start the lease renewal task and pass an ``on_lost`` callback
    that sets BOTH the lease_lost flag and the stop Event — so a confirmed
    lease loss routes into the SAME graceful-shutdown path as a SIGTERM AND
    marks the run for a non-zero exit. Also confirms the lease is released on
    shutdown, and that a confirmed loss surfaces as SystemExit(1) so Railway
    restarts the container.
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

        def abort(self) -> None: ...

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

    # A confirmed lease loss (run_renewal fires on_lost) must drain gracefully
    # AND exit non-zero so Railway's ON_FAILURE policy restarts the container.
    with pytest.raises(SystemExit) as exc_info:
        await main._run()
    assert exc_info.value.code == 1

    on_lost = captured.get("on_lost")
    assert on_lost is not None, "renewal task was never started"
    # on_lost must set BOTH the lease_lost flag (drives the non-zero exit) and
    # the stop Event (routes into the same graceful drain as a SIGTERM).
    assert callable(on_lost)
    # And the lease was released during shutdown (graceful drain still ran).
    assert captured["lease"].released is True  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_run_exits_nonzero_and_reports_on_task_crash(_reset_notify_state, monkeypatch):
    """AUD-H1: if a pipeline/background task dies with an unhandled exception,
    _run must capture it to Sentry AND exit non-zero. An exit 0 here would NOT
    trip Railway's ON_FAILURE restart policy, silently stopping ingestion.
    """
    monkeypatch.setattr(main, "init_sentry", lambda: None)

    async def _noop_pool() -> None:
        return None

    monkeypatch.setattr(main, "init_pool", _noop_pool)
    monkeypatch.setattr(main, "close_pool", _noop_pool)

    # Lease disabled so the ONLY thing that wakes _run is the crashing task.
    monkeypatch.setattr(main.settings, "ws_lease_enabled", False, raising=False)
    monkeypatch.setattr(main, "_build_handlers", lambda _ch: {})

    class _ForeverConnector:
        def __init__(self, *_a, **kwargs) -> None:
            self.name = kwargs.get("name", "conn")

        def abort(self) -> None: ...

        async def run(self) -> None:
            await asyncio.sleep(3600)

    class _CrashingRouter:
        def __init__(self, *_a, **_k) -> None: ...

        async def run(self, _q) -> None:
            raise RuntimeError("router boom")

    async def _forever_bg() -> None:
        await asyncio.sleep(3600)

    monkeypatch.setattr(main, "Connector", _ForeverConnector)
    monkeypatch.setattr(main, "Router", _CrashingRouter)
    monkeypatch.setattr(main, "run_server", _forever_bg)
    monkeypatch.setattr(main, "run_subscription_watchdog", _forever_bg)

    captured: list[tuple[BaseException, dict]] = []
    monkeypatch.setattr(main, "capture_exception", lambda exc, **kw: captured.append((exc, kw)))

    with pytest.raises(SystemExit) as exc_info:
        await main._run()

    assert exc_info.value.code == 1
    # The crash was reported to Sentry, tagged with the dead task's name.
    assert len(captured) == 1
    exc, kw = captured[0]
    assert isinstance(exc, RuntimeError)
    assert str(exc) == "router boom"
    assert kw.get("tags", {}).get("task") == "router"


@pytest.mark.asyncio
async def test_run_exits_zero_on_normal_sigterm(monkeypatch):
    """A normal SIGTERM (deploy supersession) must leave ``lease_lost`` UNSET,
    so _run returns cleanly (exit 0) — NOT SystemExit(1). Otherwise Railway's
    ON_FAILURE policy would restart-loop on every deploy.
    """
    monkeypatch.setattr(main, "init_sentry", lambda: None)

    async def _noop_pool() -> None:
        return None

    monkeypatch.setattr(main, "init_pool", _noop_pool)
    monkeypatch.setattr(main, "close_pool", _noop_pool)

    # Lease disabled (kill switch off) so there's no renewal task — the only
    # way _run wakes is the stop Event we set below (simulating SIGTERM).
    monkeypatch.setattr(main.settings, "ws_lease_enabled", False, raising=False)
    monkeypatch.setattr(main, "_build_handlers", lambda _ch: {})

    class _ForeverConnector:
        def __init__(self, *_a, **kwargs) -> None:
            self.name = kwargs.get("name", "conn")

        def abort(self) -> None: ...

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

    # Capture every asyncio.Event _run constructs so we can fire the ``stop``
    # Event directly (a deterministic SIGTERM stand-in — real signal delivery
    # isn't reliable under pytest). _run builds two Events: lease_lost (first)
    # then stop. With the lease disabled the lease_lost Event stays unset, so a
    # stop-only trigger is exactly the normal-SIGTERM path → exit 0.
    created_events: list[asyncio.Event] = []
    real_event = asyncio.Event

    def _tracking_event() -> asyncio.Event:
        ev = real_event()
        created_events.append(ev)
        return ev

    monkeypatch.setattr(main.asyncio, "Event", _tracking_event)

    real_wait = asyncio.wait

    async def _wait_then_sigterm(tasks, **kwargs):
        # _run has now created lease_lost + stop and is awaiting them. Fire
        # ``stop`` (the LAST event created) to drive a clean graceful shutdown
        # WITHOUT touching lease_lost — the normal SIGTERM path.
        created_events[-1].set()
        return await real_wait(tasks, **kwargs)

    monkeypatch.setattr(main.asyncio, "wait", _wait_then_sigterm)

    # No SystemExit — clean return → exit 0 (lease_lost was never set).
    await main._run()
    # The stop event was the last created; lease_lost (first) stayed unset.
    assert created_events[0].is_set() is False


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
        connectors=[],
        receive_queue=asyncio.Queue(),
        lease_renewal=None,
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
        connectors=[],
        receive_queue=asyncio.Queue(),
        lease_renewal=None,
    )

    assert producer.cancelled()


# --- Per-step bounds ----------------------------------------------------------
#
# Railway SIGKILLs the container ``drainingSeconds`` after SIGTERM. _shutdown's
# steps run one after another, so each gets its own bound; a step that will not
# finish is abandoned (run_bounded) so the steps after it still run.
# test_drain_deadline_fits_railway_draining_seconds sums the bounds.

_BOUNDED_STEPS = ("stop_producers", "release_lease", "flush_notifications", "cancel_background")


async def _unkillable(release: asyncio.Event) -> None:
    """Park, then keep unwinding after a cancel until ``release`` is set."""
    try:
        await asyncio.sleep(3600)
    except asyncio.CancelledError:
        await release.wait()
        raise


@pytest.mark.asyncio
@pytest.mark.parametrize("hung_step", [None, *_BOUNDED_STEPS])
async def test_a_hung_shutdown_step_is_abandoned_and_the_later_steps_still_run(
    hung_step, monkeypatch
):
    events: list[str] = []
    release = asyncio.Event()
    messages: list[dict] = []
    monkeypatch.setattr(main, "capture_message", lambda _msg, **kw: messages.append(kw))
    for step in _BOUNDED_STEPS:
        monkeypatch.setitem(main._SHUTDOWN_STEP_TIMEOUTS_S, step, 0.05)

    async def _notify_drain(*_a, **_k) -> None:
        if hung_step == "flush_notifications":
            await asyncio.sleep(3600)
        events.append("notify_drain")

    async def _notify_close(*_a, **_k) -> None:
        events.append("notify_close")

    monkeypatch.setattr(notify, "drain_pending", _notify_drain)
    monkeypatch.setattr(notify, "close_session", _notify_close)

    class _Lease(ws_lease.WsLease):  # type: ignore[misc]
        def __init__(self) -> None:
            pass  # only release() is exercised

        async def release(self) -> bool:
            if hung_step == "release_lease":
                await asyncio.sleep(3600)
            events.append("lease_release")
            return True

    class _Handler:
        name = "good"

        async def drain(self) -> int:
            events.append("drain")
            return 0

    producer = asyncio.create_task(
        _unkillable(release) if hung_step == "stop_producers" else _forever(events, "connector")
    )
    background = asyncio.create_task(
        _unkillable(release) if hung_step == "cancel_background" else _forever(events, "health")
    )
    await asyncio.sleep(0.02)  # let both reach their await point

    shutdown = asyncio.ensure_future(
        main._shutdown(
            producer_tasks=[producer],
            handlers=[_Handler()],
            other_tasks=[background],
            connectors=[],
            receive_queue=asyncio.Queue(),
            lease_renewal=None,
            lease=_Lease(),
            lease_session=_FakeLeaseSession(),
        )
    )
    try:
        done, _ = await asyncio.wait({shutdown}, timeout=2.0)

        assert shutdown in done, f"the hung {hung_step} step held the shutdown"
        shutdown.result()
        expected = ["lease_release", "drain", "notify_drain", "notify_close"]
        if hung_step == "release_lease":
            expected.remove("lease_release")
        if hung_step == "flush_notifications":
            expected.remove("notify_drain")
            expected.remove("notify_close")
        assert [e for e in events if e in expected] == expected
        # Exactly one Sentry warning, naming the step that timed out.
        assert [m["tags"] for m in messages] == (
            [{"component": "main", "step": hung_step}] if hung_step else []
        )
    finally:
        release.set()
        pending = {t for t in (shutdown, producer, background, *bounded._unwinding) if not t.done()}
        if pending:
            await asyncio.wait(pending, timeout=2.0)


def test_shutdown_arguments_whose_omission_brings_a_bug_back_are_required():
    # A caller that forgot connectors= would release the lease with sockets still
    # open; one that forgot lease_renewal= would read its own release as a lost
    # lease. A default would let either compile and run.
    params = inspect.signature(main._shutdown).parameters
    for name in ("connectors", "receive_queue", "lease_renewal"):
        assert params[name].kind is inspect.Parameter.KEYWORD_ONLY
        assert params[name].default is inspect.Parameter.empty, name


@pytest.mark.asyncio
async def test_shutdown_step_timeout_is_reported_with_its_bound(monkeypatch):
    messages: list[tuple[str, dict]] = []
    monkeypatch.setattr(main, "capture_message", lambda msg, **kw: messages.append((msg, kw)))
    monkeypatch.setitem(main._SHUTDOWN_STEP_TIMEOUTS_S, "flush_notifications", 0.05)

    async def _hang(*_a, **_k) -> None:
        await asyncio.sleep(3600)

    monkeypatch.setattr(notify, "drain_pending", _hang)

    # wait_for only guards the test: an unbounded step fails it, not hangs it.
    await asyncio.wait_for(
        main._shutdown(
            producer_tasks=[],
            handlers=[],
            other_tasks=[],
            connectors=[],
            receive_queue=asyncio.Queue(),
            lease_renewal=None,
        ),
        timeout=5.0,
    )

    assert len(messages) == 1
    msg, kw = messages[0]
    assert "flush_notifications" in msg
    assert kw["level"] == "warning"
    assert kw["context"] == {"step": "flush_notifications", "timeout_s": 0.05}


@pytest.mark.asyncio
@pytest.mark.parametrize("close_hangs", [False, True])
async def test_shutdown_aborts_connector_sockets_before_the_lease_is_released(
    close_hangs, monkeypatch
):
    """A connector stuck in its closing handshake is cut off when the
    stop_producers step overruns, with its socket still open (see
    Connector.abort). _shutdown aborts every connector's socket after that step,
    whether or not it overran, and before the lease goes: the next deploy
    connects from another host the moment the lease is released.
    """
    events: list[str] = []
    release = asyncio.Event()
    monkeypatch.setattr(main, "capture_message", lambda *_a, **_k: None)
    monkeypatch.setitem(main._SHUTDOWN_STEP_TIMEOUTS_S, "stop_producers", 0.05)

    class _Connector:
        def __init__(self, name: str) -> None:
            self.name = name

        def abort(self) -> None:
            events.append(f"abort:{self.name}")

    class _Lease(ws_lease.WsLease):  # type: ignore[misc]
        def __init__(self) -> None:
            pass  # only release() is exercised

        async def release(self) -> bool:
            events.append("lease_release")
            return True

    producer = asyncio.create_task(
        _unkillable(release) if close_hangs else _forever(events, "connector")
    )
    await asyncio.sleep(0.02)
    try:
        await main._shutdown(
            producer_tasks=[producer],
            connectors=[_Connector("c0"), _Connector("c1")],
            handlers=[],
            other_tasks=[],
            receive_queue=asyncio.Queue(),
            lease_renewal=None,
            lease=_Lease(),
            lease_session=_FakeLeaseSession(),
        )

        assert [e for e in events if e.startswith(("abort", "lease"))] == [
            "abort:c0",
            "abort:c1",
            "lease_release",
        ]
        if not close_hangs:
            assert events.index("cancelled:connector") < events.index("abort:c0")
    finally:
        release.set()
        pending = {t for t in (producer, *bounded._unwinding) if not t.done()}
        if pending:
            await asyncio.wait(pending, timeout=2.0)


@pytest.mark.asyncio
async def test_a_connector_abort_failure_is_reported_and_the_shutdown_goes_on(monkeypatch):
    events: list[str] = []
    captured: list[tuple[BaseException, dict]] = []
    monkeypatch.setattr(main, "capture_exception", lambda exc, **kw: captured.append((exc, kw)))

    class _BrokenConnector:
        name = "c0"

        def abort(self) -> None:
            raise AttributeError("'NoneType' object has no attribute 'abort'")

    class _Connector:
        name = "c1"

        def abort(self) -> None:
            events.append("abort:c1")

    class _Handler:
        name = "good"

        async def drain(self) -> int:
            events.append("drain")
            return 0

    await main._shutdown(
        producer_tasks=[],
        connectors=[_BrokenConnector(), _Connector()],
        handlers=[_Handler()],
        other_tasks=[],
        receive_queue=asyncio.Queue(),
        lease_renewal=None,
    )

    assert events == ["abort:c1", "drain"]
    assert [str(exc) for exc, _ in captured] == ["'NoneType' object has no attribute 'abort'"]
    assert captured[0][1]["tags"] == {"component": "main", "step": "abort_connectors"}
    assert captured[0][1]["context"] == {"connector": "c0"}


@pytest.mark.asyncio
async def test_shutdown_counts_frames_left_in_the_receive_queue_as_dropped(monkeypatch):
    """Frames still in the receive queue once the router is cancelled are never
    routed. They are dropped, so they go in the counter the drop reporter's final
    pass reports. A frame the router took off the queue before dying is not one
    of them.
    """
    monkeypatch.setattr(main.state, "receive_queue_drops", 5)
    queue: asyncio.Queue = asyncio.Queue()
    for frame in (b"a", b"b", b"c"):
        queue.put_nowait(frame)

    async def _router() -> None:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            queue.get_nowait()  # the frame it was routing when it was cancelled
            raise

    router = asyncio.create_task(_router())
    await asyncio.sleep(0.02)

    await main._shutdown(
        producer_tasks=[router],
        handlers=[],
        other_tasks=[],
        connectors=[],
        receive_queue=queue,
        lease_renewal=None,
    )

    assert main.state.receive_queue_drops == 5 + 2


# --- _build_handlers: boot wiring of channel vs handler state (E5) ----------


@pytest.fixture
def _isolated_channel_handler_state():
    """Run against empty channel/handler maps, then restore the originals.

    Uses the real ``state`` singleton (not a swapped copy) so ``main`` and
    ``handlers.base`` write to the same object, exactly as they do at boot.
    """
    from state import state

    saved_channels = dict(state.channels)
    saved_handlers = dict(state.handlers)
    state.channels.clear()
    state.handlers.clear()
    yield state
    state.channels.clear()
    state.channels.update(saved_channels)
    state.handlers.clear()
    state.handlers.update(saved_handlers)


def test_build_handlers_keeps_shared_handler_names_out_of_channel_state(
    _isolated_channel_handler_state,
):
    """Real boot wiring with a mixed channel list: every configured channel is
    pre-registered unsubscribed, nothing else lands in ``state.channels``, and
    every handler (shared family ones included) gets only a ``state.handlers``
    row. Handler construction is pure (settings reads), so no I/O to stub.
    """
    state = _isolated_channel_handler_state
    channels = [
        "flow-alerts",
        "option_trades:SPY",  # dedicated Interval B/A handler, name == channel
        "option_trades:TSLA",
        "option_trades:NVDA",
        "net_flow:TSLA",
        "net_flow:NVDA",
        "gex_strike_expiry:TSLA",
        "gex_strike_expiry:NVDA",
    ]
    shared = {"option_trades", "net_flow", "gex_strike_expiry"}

    handlers = main._build_handlers(channels)

    assert set(handlers) == set(channels)
    assert set(state.channels) == set(channels)
    assert not any(ch.subscribed for ch in state.channels.values())
    assert shared <= set(state.handlers)
    assert shared.isdisjoint(state.channels)
    assert set(state.handlers) == shared | {"flow-alerts", "option_trades:SPY"}
    # One instance per family, shared across that family's tickers.
    assert handlers["net_flow:TSLA"] is handlers["net_flow:NVDA"]
    assert handlers["option_trades:TSLA"] is handlers["option_trades:NVDA"]
    assert handlers["option_trades:SPY"] is not handlers["option_trades:TSLA"]


# --- drop reporter wiring (P2) -----------------------------------------------


def _stub_pipeline(monkeypatch) -> None:
    """Stub Sentry, the pool and the data pipeline so _run reaches its wait.

    The lease is off, so the only things that can wake _run are the stop
    Event and a background task finishing.
    """
    monkeypatch.setattr(main, "init_sentry", lambda: None)

    async def _noop_pool() -> None:
        return None

    monkeypatch.setattr(main, "init_pool", _noop_pool)
    monkeypatch.setattr(main, "close_pool", _noop_pool)
    monkeypatch.setattr(main.settings, "ws_lease_enabled", False, raising=False)
    monkeypatch.setattr(main, "_build_handlers", lambda _ch: {})

    class _ForeverConnector:
        def __init__(self, *_a, **kwargs) -> None:
            self.name = kwargs.get("name", "conn")

        def abort(self) -> None: ...

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


def _sigterm_once_run_is_waiting(monkeypatch) -> None:
    """Fire the stop Event (the last one _run creates) once _run is waiting:
    the normal-SIGTERM path, as in test_run_exits_zero_on_normal_sigterm.
    """
    created_events: list[asyncio.Event] = []
    real_event = asyncio.Event

    def _tracking_event() -> asyncio.Event:
        ev = real_event()
        created_events.append(ev)
        return ev

    monkeypatch.setattr(main.asyncio, "Event", _tracking_event)
    real_wait = asyncio.wait

    async def _wait_then_sigterm(tasks, **kwargs):
        await asyncio.sleep(0)  # let the background tasks reach their first await
        created_events[-1].set()
        return await real_wait(tasks, **kwargs)

    monkeypatch.setattr(main.asyncio, "wait", _wait_then_sigterm)


@pytest.mark.asyncio
async def test_run_starts_drop_reporter_and_shutdown_cancels_it(_reset_notify_state, monkeypatch):
    _stub_pipeline(monkeypatch)
    events: list[str] = []

    async def _recording_reporter() -> None:
        events.append("started")
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            events.append("cancelled")
            raise

    monkeypatch.setattr(main, "run_drop_reporter", _recording_reporter)
    _sigterm_once_run_is_waiting(monkeypatch)

    await main._run()

    assert events == ["started", "cancelled"]


@pytest.mark.asyncio
async def test_run_does_not_wait_on_a_pool_close_that_never_returns(
    _reset_notify_state, monkeypatch
):
    # asyncpg's pool.close() waits for every acquired connection to be released,
    # and a drain flush abandoned at its deadline may still hold one. The close
    # is the last thing _run does, so it needs its own bound inside the window.
    _stub_pipeline(monkeypatch)
    messages: list[dict] = []
    monkeypatch.setattr(main, "capture_message", lambda _msg, **kw: messages.append(kw))
    monkeypatch.setitem(main._SHUTDOWN_STEP_TIMEOUTS_S, "close_pool", 0.05)

    async def _close_never_returns() -> None:
        await asyncio.sleep(3600)

    monkeypatch.setattr(main, "close_pool", _close_never_returns)
    _sigterm_once_run_is_waiting(monkeypatch)

    # wait_for only guards the test: an unbounded close fails it, not hangs it.
    await asyncio.wait_for(main._run(), timeout=5.0)

    assert [m["tags"] for m in messages] == [{"component": "main", "step": "close_pool"}]


@pytest.mark.asyncio
async def test_run_exits_nonzero_when_drop_reporter_dies(_reset_notify_state, monkeypatch):
    # The reporter sits in the same wait set as the pipeline, so its death gets
    # the AUD-H1 handling: Sentry event tagged with the task name, then exit 1.
    _stub_pipeline(monkeypatch)

    async def _crashing_reporter() -> None:
        raise RuntimeError("reporter boom")

    monkeypatch.setattr(main, "run_drop_reporter", _crashing_reporter)
    captured: list[tuple[BaseException, dict]] = []
    monkeypatch.setattr(main, "capture_exception", lambda exc, **kw: captured.append((exc, kw)))

    with pytest.raises(SystemExit) as exc_info:
        await main._run()

    assert exc_info.value.code == 1
    assert [(str(e), kw["tags"]["task"]) for e, kw in captured] == [
        ("reporter boom", "drop_reporter")
    ]


# --- shutdown order: drop reporter, lease renewal, lease release in _run -----


@pytest.mark.asyncio
async def test_the_drop_reporter_is_cancelled_after_the_handlers_drain(
    _reset_notify_state, monkeypatch
):
    """The reporter's final pass has to see what the drains lose, so shutdown
    cancels it after them. Cancelled first, a failed final flush's lost rows
    would never be reported: the next tick never comes.
    """
    import drop_reporter
    from state import State

    _stub_pipeline(monkeypatch)
    fresh = State()
    reports: list[dict] = []
    monkeypatch.setattr(drop_reporter, "state", fresh)
    monkeypatch.setattr(drop_reporter, "capture_message", lambda _msg, **kw: reports.append(kw))

    class _LossyHandler:
        name = "lossy"

        async def run(self) -> None:
            await asyncio.sleep(3600)

        async def drain(self) -> int:
            fresh.handler("lossy").lost_rows += 7  # the final flush failed
            return 0

    monkeypatch.setattr(main, "_build_handlers", lambda _ch: {"lossy": _LossyHandler()})
    _sigterm_once_run_is_waiting(monkeypatch)

    await main._run()

    assert [(r["tags"]["handler"], r["context"]["lost_rows"]) for r in reports] == [("lossy", 7)]


class _UpstashResponse:
    status = 200

    def __init__(self, command: list) -> None:
        self._command = command

    async def __aenter__(self) -> _UpstashResponse:
        return self

    async def __aexit__(self, *_exc) -> bool:
        return False

    async def json(self) -> dict:
        return {"result": "OK" if self._command[0] == "SET" else 1}


class _UpstashSession:
    """Answers every lease command as a holder would. Like aiohttp's, a closed
    session raises RuntimeError on post(), which is not a ClientError.
    """

    def __init__(self) -> None:
        self.closed = False

    def post(self, _url, *, json, headers) -> _UpstashResponse:
        if self.closed:
            raise RuntimeError("Session is closed")
        return _UpstashResponse(json)

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_a_drain_longer_than_a_renew_interval_does_not_read_as_a_lost_lease(
    _reset_notify_state, monkeypatch
):
    """The renewal task used to be cancelled last, after the release step had
    closed the lease's session. Its next tick then called post() on a closed
    session, which raises RuntimeError rather than a lease error, and
    run_renewal reads any such error as a lost lease: an error event, on_lost,
    and an exit-1 restart. Any drain longer than the renew interval did that.
    """
    _stub_pipeline(monkeypatch)
    monkeypatch.setattr(main.settings, "ws_lease_enabled", True, raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_url", "https://t.upstash.io", raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_token", "tok", raising=False)
    monkeypatch.setattr(main.settings, "ws_lease_ttl_ms", 600, raising=False)
    monkeypatch.setattr(main.settings, "ws_lease_renew_ms", 20, raising=False)
    session = _UpstashSession()
    monkeypatch.setattr(main.aiohttp, "ClientSession", lambda *_a, **_k: session)
    lease_events: list[str] = []
    monkeypatch.setattr(ws_lease, "capture_message", lambda msg, **_kw: lease_events.append(msg))

    class _SlowDrainHandler:
        name = "slow"

        async def run(self) -> None:
            await asyncio.sleep(3600)

        async def drain(self) -> int:
            await asyncio.sleep(0.2)  # ten renew intervals
            return 0

    monkeypatch.setattr(main, "_build_handlers", lambda _ch: {"slow": _SlowDrainHandler()})
    _sigterm_once_run_is_waiting(monkeypatch)

    await main._run()  # a SystemExit(1) here is the false lease loss

    assert lease_events == []
    assert session.closed is True


@pytest.mark.asyncio
async def test_run_does_not_wait_on_a_lease_release_that_never_returns(monkeypatch):
    """_run's finally releases the lease on every exit that skipped _shutdown
    (here, an acquire timeout). That release gets the same bound as the
    _shutdown step; unbounded, a wedged Upstash request held the exit until
    Railway's SIGKILL.
    """
    monkeypatch.setattr(main, "init_sentry", lambda: None)
    pool_calls: list[str] = []

    async def _fake_init_pool() -> None:
        pool_calls.append("init")

    async def _fake_close_pool() -> None:
        pool_calls.append("close")

    monkeypatch.setattr(main, "init_pool", _fake_init_pool)
    monkeypatch.setattr(main, "close_pool", _fake_close_pool)
    monkeypatch.setattr(main.settings, "ws_lease_enabled", True, raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_url", "https://test.upstash.io", raising=False)
    monkeypatch.setattr(main.settings, "kv_rest_api_token", "tok", raising=False)
    monkeypatch.setattr(main.aiohttp, "ClientSession", lambda *_a, **_k: _FakeLeaseSession())
    monkeypatch.setitem(main._SHUTDOWN_STEP_TIMEOUTS_S, "release_lease", 0.05)

    class _WedgedLease:
        def __init__(self, **_kwargs) -> None:
            pass

        async def acquire(self, _timeout_s: float) -> bool:
            return False  # a wedged prior generation still holds it

        async def release(self) -> bool:
            await asyncio.sleep(3600)
            return True

    monkeypatch.setattr(main, "WsLease", _WedgedLease)
    messages: list[dict] = []
    monkeypatch.setattr(main, "capture_message", lambda _msg, **kw: messages.append(kw))

    # wait_for only guards the test: an unbounded release fails it, not hangs it.
    with pytest.raises(SystemExit) as exc_info:
        await asyncio.wait_for(main._run(), timeout=5.0)

    assert exc_info.value.code == 1
    assert [m["tags"]["step"] for m in messages if "step" in m.get("tags", {})] == ["release_lease"]
    assert pool_calls == ["init", "close"]  # the exit went on to close the pool
