"""Unit tests for the WS connector — focused on the join-frame contract
plus the bounded receive-queue handoff to the router (Phase 1, C2)."""

from __future__ import annotations

import asyncio
import json
from typing import Any, ClassVar

import pytest

from connector import Connector
from state import state


class FakeWebSocket:
    """Records every frame sent through send() for later inspection."""

    def __init__(self) -> None:
        self.sent: list[Any] = []

    async def send(self, frame: Any) -> None:
        self.sent.append(frame)


@pytest.fixture(autouse=True)
def _reset_state():
    state.channels.clear()
    state.receive_queue_depth = 0
    state.receive_queue_drops = 0
    state.ws_connected = False
    yield
    state.receive_queue_depth = 0
    state.receive_queue_drops = 0
    state.ws_connected = False


@pytest.mark.asyncio
async def test_subscribe_all_sends_text_frames_not_binary() -> None:
    """Regression: every join frame MUST be a str (WS TEXT opcode 0x1).

    The websockets library sends bytes as a BINARY frame (opcode 0x2),
    which UW's server silently drops without ever processing the join.
    This test fails if anyone reverts the .decode() in _subscribe_all
    or otherwise lets a bytes payload through.
    """
    ws = FakeWebSocket()
    connector = Connector(
        channels=["flow-alerts", "option_trades:SPY"],
        receive_queue=asyncio.Queue(maxsize=10),
    )

    await connector._subscribe_all(ws)

    assert len(ws.sent) == 2
    for frame in ws.sent:
        assert isinstance(frame, str), (
            f"join frame must be str (TEXT), got {type(frame).__name__} "
            "— UW silently drops BINARY-frame joins"
        )

    parsed = [json.loads(f) for f in ws.sent]
    assert parsed[0] == {"channel": "flow-alerts", "msg_type": "join"}
    assert parsed[1] == {"channel": "option_trades:SPY", "msg_type": "join"}


class _AsyncIterableWS:
    """Minimal async-iterable stand-in for a websockets connection.

    Yields the supplied frames in order and then raises StopAsyncIteration,
    which lets ``_connect_once``'s ``async for`` exit cleanly.
    """

    def __init__(self, frames: list[bytes]) -> None:
        self._frames = frames

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for frame in self._frames:
            yield frame


@pytest.mark.asyncio
async def test_receive_queue_drops_oldest_on_overflow(monkeypatch) -> None:
    """Regression for C2: when the receive_queue is full and a new
    frame arrives, the connector must evict the oldest frame, enqueue
    the new one, and tick the receive_queue_drops counter.

    Drives ``_connect_once`` end-to-end (same monkeypatch pattern as
    ``test_connector_pushes_received_frames_into_queue``) so a future
    change that forgets to bump ``state.receive_queue_drops`` from inside
    the connector would fail this test.
    """
    # Pre-fill the queue to maxsize so the FIRST frame the connector
    # tries to enqueue overflows. This forces the eviction branch in
    # ``_connect_once``.
    queue: asyncio.Queue = asyncio.Queue(maxsize=2)
    queue.put_nowait(b"oldest")
    queue.put_nowait(b"middle")
    assert queue.qsize() == 2

    connector = Connector(channels=["flow-alerts"], receive_queue=queue)

    fake_frames = [b"newest"]

    async def _noop_subscribe(_ws):
        pass

    class _ConnCtx:
        async def __aenter__(self):
            return _AsyncIterableWS(fake_frames)

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def _fake_connect(*_args, **_kwargs):
        return _ConnCtx()

    import connector as connector_mod

    monkeypatch.setattr(connector, "_subscribe_all", _noop_subscribe)
    monkeypatch.setattr(connector_mod.websockets, "connect", _fake_connect)

    await connector._connect_once()

    # Connector's own code path bumped the drop counter.
    assert state.receive_queue_drops == 1
    assert queue.qsize() == 2
    # Oldest was evicted; "middle" is now first, "newest" is at the tail.
    first = queue.get_nowait()
    second = queue.get_nowait()
    assert first == b"middle"
    assert second == b"newest"


@pytest.mark.asyncio
async def test_connector_pushes_received_frames_into_queue(monkeypatch) -> None:
    """End-to-end check: the connector's receive-loop body should land
    every frame from the WS into the receive_queue without parsing.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    connector = Connector(channels=["flow-alerts"], receive_queue=queue)

    # Stub out subscribe_all + websockets.connect so _connect_once just
    # iterates frames and drops them into the queue.
    fake_frames = [b'["flow-alerts",{"x":1}]', b'["flow-alerts",{"x":2}]']

    async def _noop_subscribe(_ws):
        pass

    class _ConnCtx:
        async def __aenter__(self):
            return _AsyncIterableWS(fake_frames)

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def _fake_connect(*_args, **_kwargs):
        return _ConnCtx()

    import connector as connector_mod

    monkeypatch.setattr(connector, "_subscribe_all", _noop_subscribe)
    monkeypatch.setattr(connector_mod.websockets, "connect", _fake_connect)

    await connector._connect_once()

    drained: list[bytes] = []
    while not queue.empty():
        drained.append(queue.get_nowait())
    assert drained == fake_frames


# ----------------------------------------------------------------------
# Phase 3 / M5: defer ws_connected = True until subscribe success
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ws_connected_only_set_after_subscribe_all(monkeypatch) -> None:
    """``state.ws_connected`` must NOT flip to True if ``_subscribe_all``
    raises — otherwise /healthz would lie when a typo'd channel name or
    server-side error frame causes the join to fail. The socket stays
    open with no data flowing and the daemon would report green until
    the next disconnect.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    connector = Connector(channels=["bad-channel"], receive_queue=queue)

    async def _raising_subscribe(_ws):
        raise RuntimeError("simulated subscribe failure")

    class _ConnCtx:
        async def __aenter__(self):
            return _AsyncIterableWS([])

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def _fake_connect(*_args, **_kwargs):
        return _ConnCtx()

    import connector as connector_mod

    monkeypatch.setattr(connector, "_subscribe_all", _raising_subscribe)
    monkeypatch.setattr(connector_mod.websockets, "connect", _fake_connect)

    # Sanity: starts False.
    assert state.ws_connected is False

    with pytest.raises(RuntimeError, match="simulated subscribe failure"):
        await connector._connect_once()

    # Subscribe failed → ws_connected must stay False so the next
    # reconnect retries from scratch.
    assert state.ws_connected is False


@pytest.mark.asyncio
async def test_invalid_handshake_logs_warning_not_capture_exception(monkeypatch) -> None:
    """Regression for the 2026-05-27 UW 503 incident.

    When UW returns HTTP 503 on the WS upgrade, the websockets library
    raises ``InvalidStatus`` (subclass of ``InvalidHandshake``). The
    pre-fix behavior was that this fell through to the catch-all
    ``except Exception`` branch in ``run()``, which called
    ``capture_exception`` every retry — a sustained outage produced one
    Sentry error event per ~60s backoff cycle.

    The fix moves handshake rejections into the typed-warning branch
    alongside ``ConnectionClosed`` so they share the same log.warning +
    storm-alert + backoff treatment, no per-event Sentry capture.
    """
    import websockets

    import connector as connector_mod
    import sentry_setup as sentry_mod

    captured: list[BaseException] = []

    def _spy_capture(exc, **_kwargs):
        captured.append(exc)

    monkeypatch.setattr(sentry_mod, "capture_exception", _spy_capture)
    # The connector module imports capture_exception by name, so patch
    # that binding too — Python doesn't keep the two in sync.
    monkeypatch.setattr(connector_mod, "capture_exception", _spy_capture)

    # Make _connect_once raise once, then signal the run loop to exit
    # via CancelledError so the test doesn't hang.
    call_count = 0

    # Drop initial backoff to zero so the test isn't gated on the real
    # 1s _INITIAL_BACKOFF_S between the two _connect_once iterations.
    monkeypatch.setattr(connector_mod, "_INITIAL_BACKOFF_S", 0.0)

    async def _raise_then_cancel(self):
        # Must be async to substitute for the real _connect_once coroutine;
        # await sleep(0) just yields to the event loop and keeps this a
        # genuine coroutine (avoids "async with no await" lint).
        await asyncio.sleep(0)
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise websockets.InvalidHandshake()
        raise asyncio.CancelledError()

    monkeypatch.setattr(Connector, "_connect_once", _raise_then_cancel)

    connector = Connector(
        channels=["flow-alerts"],
        receive_queue=asyncio.Queue(maxsize=10),
    )

    with pytest.raises(asyncio.CancelledError):
        await connector.run()

    # The InvalidHandshake landed in the typed-warning branch, NOT the
    # catch-all Exception branch. No Sentry capture should have happened.
    assert captured == [], (
        f"InvalidHandshake should be caught by the typed-warning branch "
        f"and NOT trigger capture_exception, but got: {captured}"
    )
    # And the reconnect counter still ticked — the daemon treats it as
    # a retryable transient, same as a clean drop.
    assert state.reconnects_last_hour() >= 1


@pytest.mark.asyncio
async def test_backoff_resets_after_established_connection(monkeypatch) -> None:
    """A healthy session that drops must reset the reconnect backoff.

    Regression: backoff used to reset only on a graceful close, never on a
    successful connect. So an initial rough start that escalated the
    backoff (e.g. a UW outage at deploy) would leave the escalated value
    in place; a connection that then streamed for hours and dropped once
    inherited the stale (up to 60s) delay instead of restarting at 1s.

    Sequence: iter1 fails WITHOUT establishing (escalates 1→2), iter2
    establishes a healthy session then drops (must reset to 1), iter3
    cancels to end the loop. The recorded sleeps prove iter2 slept the
    reset 1.0s, not the escalated 2.0s.
    """
    import connector as connector_mod

    sleeps: list[float] = []

    async def _record_sleep(d: float) -> None:
        sleeps.append(d)

    monkeypatch.setattr(connector_mod.asyncio, "sleep", _record_sleep)
    monkeypatch.setattr(connector_mod, "_INITIAL_BACKOFF_S", 1.0)
    monkeypatch.setattr(connector_mod, "_MAX_BACKOFF_S", 60.0)

    calls = 0

    async def _conn(self) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            # Connect failure with no healthy session — escalates backoff.
            raise OSError("connect failed")
        if calls == 2:
            # Healthy session established, then the socket drops. The
            # established flag is what run() keys the reset on.
            self._established = True
            state.ws_connected = True
            raise OSError("drop after healthy session")
        raise asyncio.CancelledError()

    monkeypatch.setattr(Connector, "_connect_once", _conn)

    connector = Connector(
        channels=["flow-alerts"],
        receive_queue=asyncio.Queue(maxsize=10),
    )

    with pytest.raises(asyncio.CancelledError):
        await connector.run()

    # iter1: not established → sleep(1.0), then escalate to 2.0
    # iter2: established → reset to 1.0, sleep(1.0), no escalation
    # iter3: CancelledError before any sleep
    assert sleeps == [1.0, 1.0], (
        "iter2 should have reset backoff to 1.0s after the healthy session "
        f"dropped, but the recorded sleeps were {sleeps}"
    )


@pytest.mark.asyncio
async def test_subscribe_all_paces_joins_between_frames(monkeypatch) -> None:
    """Joins are paced BETWEEN frames (not after the last) so a large
    universe doesn't fire its whole join burst in one tick. A single
    channel adds zero delay; N channels add N-1 pacing sleeps.
    """
    import connector as connector_mod

    sleeps: list[float] = []

    async def _record_sleep(d: float) -> None:
        sleeps.append(d)

    monkeypatch.setattr(connector_mod.asyncio, "sleep", _record_sleep)

    ws = FakeWebSocket()
    connector = Connector(
        channels=["flow-alerts", "option_trades:SPY", "net_flow:QQQ"],
        receive_queue=asyncio.Queue(maxsize=10),
    )

    await connector._subscribe_all(ws)

    assert len(ws.sent) == 3
    # 3 channels → 2 inter-frame pacing sleeps, each _JOIN_PACING_S.
    assert sleeps == [connector_mod._JOIN_PACING_S] * 2


@pytest.mark.asyncio
async def test_storm_threshold_scales_with_shard_count(monkeypatch) -> None:
    """The storm threshold scales by shard count, not the bare base.

    ``reconnects_last_hour()`` is process-global and now aggregates reconnects
    across all N sharded connections. Without scaling, routine independent
    per-shard reconnect churn would trip a storm alert tuned for one socket.
    With 3 shards the threshold is ``_RECONNECT_STORM_THRESHOLD * 3`` — the
    alert must NOT fire at the bare base but MUST fire once the count crosses
    the scaled threshold.
    """
    import connector as connector_mod

    class _FakeSettings:
        channel_shards: ClassVar[list[list[str]]] = [["a"], ["b"], ["c"]]  # 3 shards

    monkeypatch.setattr(connector_mod, "settings", _FakeSettings())

    captured: list[str] = []
    monkeypatch.setattr(
        connector_mod,
        "capture_message",
        lambda msg, **_kw: captured.append(msg),
    )

    base = connector_mod._RECONNECT_STORM_THRESHOLD
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=1))

    state.reconnect_times.clear()
    try:
        for _ in range(base):  # base reconnects, below the scaled 3*base
            state.record_reconnect()
        connector._maybe_alert_storm()
        assert captured == [], (
            "base reconnects across 3 shards must not trip a single-socket storm"
        )

        # Push to the scaled threshold (3 * base) — now it fires once.
        while state.reconnects_last_hour() < base * 3:
            state.record_reconnect()
        connector._maybe_alert_storm()
        assert captured == ["uw-stream reconnect storm"]
    finally:
        state.reconnect_times.clear()


@pytest.mark.asyncio
async def test_ws_connected_set_to_true_when_subscribe_succeeds(monkeypatch) -> None:
    """Mirror of the previous test: when subscribe completes cleanly,
    the flag does flip to True before the receive loop starts.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    connector = Connector(channels=["good-channel"], receive_queue=queue)

    subscribe_called = False

    async def _ok_subscribe(_ws):
        nonlocal subscribe_called
        subscribe_called = True
        # ws_connected MUST still be False at the moment subscribe runs;
        # the connector flips it only after subscribe returns. This is
        # what guarantees /healthz never lies during the join window.
        assert state.ws_connected is False

    class _ConnCtx:
        async def __aenter__(self):
            return _AsyncIterableWS([])

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def _fake_connect(*_args, **_kwargs):
        return _ConnCtx()

    import connector as connector_mod

    monkeypatch.setattr(connector, "_subscribe_all", _ok_subscribe)
    monkeypatch.setattr(connector_mod.websockets, "connect", _fake_connect)

    assert state.ws_connected is False

    await connector._connect_once()

    assert subscribe_called is True
    assert state.ws_connected is True
