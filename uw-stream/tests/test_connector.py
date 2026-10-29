"""Unit tests for the WS connector — focused on the join-frame contract
plus the bounded receive-queue handoff to the router (Phase 1, C2)."""

from __future__ import annotations

import asyncio
import errno
import json
import logging
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest
import websockets
from websockets.frames import Close

from connector import Connector
from logger_setup import JsonFormatter
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
        # The real connection's attributes ``_connect_once`` reads for the
        # disconnect diagnostics.
        self.local_address = None
        self.remote_address = None
        self.protocol = SimpleNamespace(close_rcvd=None, close_sent=None)

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


# ──────────────────────────────────────────────────────────────────────────
# AUD-L12a: reconnect backoff jitter — de-syncs lockstep per-shard reconnects.
# ──────────────────────────────────────────────────────────────────────────


def test_jittered_backoff_stays_within_band() -> None:
    """``_jittered_backoff`` must keep the realized sleep within
    ``[base*(1-f), base*(1+f)]`` for every draw, so N sharded connections
    de-sync their reconnects instead of re-handshaking in lockstep.

    Seed-independent by design (production wants independent draws per
    process), so we sample many times and assert the band holds on every
    draw AND that we actually observe spread (not a constant).
    """
    import connector as connector_mod

    f = connector_mod._BACKOFF_JITTER_FRACTION
    assert 0.0 < f < 1.0  # a sane fraction, never zero or full-scale

    for base in (1.0, 2.0, 60.0):
        low = base * (1 - f)
        high = base * (1 + f)
        draws = [connector_mod._jittered_backoff(base) for _ in range(500)]
        for d in draws:
            assert low <= d <= high, (
                f"jittered sleep {d} escaped band [{low}, {high}] for base {base}"
            )
        # The point of jitter is spread — assert the draws are not all equal.
        assert max(draws) > min(draws), (
            "jitter produced a constant — shards would still reconnect in lockstep"
        )


def test_jittered_backoff_zero_is_zero() -> None:
    """A zero base (tests drop _INITIAL_BACKOFF_S to 0.0) jitters to exactly
    0.0 — multiplicative jitter can't manufacture a nonzero wait."""
    import connector as connector_mod

    assert connector_mod._jittered_backoff(0.0) == 0.0


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

    # iter1: not established → sleep(~1.0), then escalate to 2.0
    # iter2: established → reset to 1.0, sleep(~1.0), no escalation
    # iter3: CancelledError before any sleep
    # Sleeps are jittered by ±_BACKOFF_JITTER_FRACTION (de-syncs lockstep
    # per-shard reconnects), so assert each realized sleep is within the band
    # around its un-jittered base rather than an exact value.
    f = connector_mod._BACKOFF_JITTER_FRACTION
    expected_bases = [1.0, 1.0]
    assert len(sleeps) == len(expected_bases), (
        f"expected {len(expected_bases)} sleeps, got {sleeps}"
    )
    for realized, base in zip(sleeps, expected_bases, strict=True):
        assert base * (1 - f) <= realized <= base * (1 + f), (
            f"iter2 should have reset backoff to ~1.0s after the healthy "
            f"session dropped; realized sleep {realized} out of jitter band "
            f"around base {base}. recorded sleeps: {sleeps}"
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
        assert captured == [], "base reconnects across 3 shards must not trip a single-socket storm"

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


# ── self-healing re-subscribe (_reconcile_once / _reconcile_subscriptions) ──


@pytest.mark.asyncio
async def test_reconcile_once_rejoins_only_unacked_channels() -> None:
    """Self-healing core: re-send a join for every channel still
    subscribed=False, and skip the ones the router has already acked.
    """
    ws = FakeWebSocket()
    connector = Connector(channels=["a", "b", "c"], receive_queue=asyncio.Queue(maxsize=1))
    state.channel("a").subscribed = True  # acked → must NOT re-join
    state.channel("b").subscribed = False  # stuck → re-join
    state.channel("c").subscribed = False  # stuck → re-join

    rejoined = await connector._reconcile_once(ws)

    assert rejoined == ["b", "c"]
    sent_channels = [json.loads(f)["channel"] for f in ws.sent]
    assert sent_channels == ["b", "c"]
    # Frames go out as WS TEXT (str), never BINARY (bytes) — UW drops binary.
    assert all(isinstance(f, str) for f in ws.sent)


@pytest.mark.asyncio
async def test_reconcile_once_noop_when_all_acked() -> None:
    """When every channel is acked, reconcile sends nothing."""
    ws = FakeWebSocket()
    connector = Connector(channels=["a", "b"], receive_queue=asyncio.Queue(maxsize=1))
    state.channel("a").subscribed = True
    state.channel("b").subscribed = True

    rejoined = await connector._reconcile_once(ws)

    assert rejoined == []
    assert ws.sent == []


@pytest.mark.asyncio
async def test_reconcile_once_ignores_other_shards_channels() -> None:
    """A shard only re-joins ITS OWN channels — never another shard's stuck
    channel (each shard owns a different socket).
    """
    ws = FakeWebSocket()
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=1))
    state.channel("a").subscribed = True  # this shard, acked
    state.channel("z").subscribed = False  # ANOTHER shard's stuck channel

    rejoined = await connector._reconcile_once(ws)

    assert rejoined == []  # must not touch z
    assert ws.sent == []


@pytest.mark.asyncio
async def test_reconcile_does_not_reset_subscribed_flag() -> None:
    """Re-joining must NOT clear an acked channel's flag, and must leave a
    stuck channel's flag False (the ack from the re-join flips it True later).
    """
    ws = FakeWebSocket()
    connector = Connector(channels=["a", "b"], receive_queue=asyncio.Queue(maxsize=1))
    state.channel("a").subscribed = True
    state.channel("b").subscribed = False

    await connector._reconcile_once(ws)

    assert state.channel("a").subscribed is True  # untouched
    assert state.channel("b").subscribed is False  # still pending its ack


@pytest.mark.asyncio
async def test_reconcile_subscriptions_returns_on_connection_closed(
    monkeypatch,
) -> None:
    """If the socket drops mid-reconcile, the loop returns cleanly (no raise)
    so the connect loop can reconnect + resubscribe from scratch.
    """
    import connector as connector_mod

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr(connector_mod.asyncio, "sleep", _no_sleep)

    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=1))
    state.channel("a").subscribed = False  # stuck → reconcile will try to send

    class _ClosedWS:
        async def send(self, _frame) -> None:
            raise websockets.ConnectionClosed(None, None)

    # Must complete without raising — the loop catches ConnectionClosed.
    await connector._reconcile_subscriptions(_ClosedWS())


# ──────────────────────────────────────────────────────────────────────────
# AUD-M28: over-cap-shed defense — clean-close storm alerting + a sub-threshold
# session must NOT reset the reconnect backoff.
# ──────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_clean_close_storm_trips_alert(monkeypatch) -> None:
    """Repeated rapid CLEAN closes must trip the storm alert.

    A provider shedding an over-cap connection (the 50-channel-cap incident
    class) accepts the joins and then sends a graceful close — no exception.
    ``_connect_once`` returns cleanly, so before this fix the clean-close
    branch in ``run()`` recorded the reconnect but never storm-checked, and
    the incident stayed silent. This drives that branch ``threshold`` times
    and asserts ``_maybe_alert_storm`` fires.
    """
    import connector as connector_mod

    # Single shard → threshold is the bare base.
    class _FakeSettings:
        channel_shards: ClassVar[list[list[str]]] = [["a"]]
        ws_url = "wss://example/socket"

    monkeypatch.setattr(connector_mod, "settings", _FakeSettings())

    captured: list[str] = []
    monkeypatch.setattr(
        connector_mod,
        "capture_message",
        lambda msg, **_kw: captured.append(msg),
    )

    # No real backoff sleeps.
    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr(connector_mod.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(connector_mod, "_INITIAL_BACKOFF_S", 0.0)

    threshold = connector_mod._RECONNECT_STORM_THRESHOLD
    # _connect_once returns cleanly (no raise) `threshold` times — the
    # over-cap-shed pattern — then cancels to end the run loop.
    calls = 0

    async def _clean_close(self) -> None:
        nonlocal calls
        calls += 1
        if calls > threshold:
            raise asyncio.CancelledError()
        await asyncio.sleep(0)  # clean return → graceful-close branch

    monkeypatch.setattr(Connector, "_connect_once", _clean_close)

    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=1))

    state.reconnect_times.clear()
    try:
        with pytest.raises(asyncio.CancelledError):
            await connector.run()
        # The clean-close branch storm-checked on every iteration and tripped
        # once the count crossed the threshold.
        assert captured == ["uw-stream reconnect storm"], (
            "rapid clean closes must trip the storm alert from the clean-close "
            f"branch, but capture_message was called with: {captured}"
        )
    finally:
        state.reconnect_times.clear()


@pytest.mark.parametrize(
    ("min_healthy_s", "expect_established", "label"),
    [
        # Threshold far above any real elapsed time → the (near-instant) session
        # is sub-threshold → a flap → must NOT count as established.
        (1.0e9, False, "flap"),
        # Threshold below any real elapsed time → any session clears it →
        # healthy → must count as established.
        (-1.0, True, "healthy"),
    ],
)
@pytest.mark.asyncio
async def test_connect_once_marks_established_only_after_healthy_duration(
    monkeypatch, min_healthy_s: float, expect_established: bool, label: str
) -> None:
    """``_established`` keys on session DURATION, not subscribe success.

    Drives the REAL ``_connect_once`` (the over-cap-shed pattern: subscribe
    accepts the joins, then the socket closes). The healthy threshold is moved
    relative to the real elapsed time rather than stubbing the monotonic clock
    (asyncio internals also read ``time.monotonic``, so a hard 2-value stub is
    fragile). A sub-threshold session must leave ``_established`` False so
    ``run`` escalates the backoff on a flap; a healthy session must flip it True.
    """
    import connector as connector_mod

    monkeypatch.setattr(connector_mod, "_MIN_HEALTHY_SESSION_S", min_healthy_s)

    class _ConnCtx:
        async def __aenter__(self):
            return _AsyncIterableWS([])  # empty → receive loop exits at once

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def _fake_connect(*_args, **_kwargs):
        return _ConnCtx()

    async def _ok_subscribe(_ws):
        return None  # over-cap-shed accepts the joins...

    monkeypatch.setattr(connector_mod.websockets, "connect", _fake_connect)

    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10))
    monkeypatch.setattr(connector, "_subscribe_all", _ok_subscribe)

    assert connector._established is False
    await connector._connect_once()  # ...then the socket closes

    assert connector._established is expect_established, (
        f"a {label} session should set _established={expect_established} "
        "(subscribe success alone must not count a flap as healthy)"
    )


@pytest.mark.asyncio
async def test_sub_threshold_flaps_keep_escalating_backoff(monkeypatch) -> None:
    """Repeated sub-threshold sessions must keep escalating backoff (no reset).

    ``run`` keys the backoff reset on ``_established``. A flap leaves it False,
    so the backoff must keep doubling across consecutive flaps — the defense
    against an over-cap-shed ~1s tight reconnect loop — and reset only when a
    session finally proves healthy.

    Sequence: iter1 flap (escalate 1→2), iter2 flap (escalate 2→4), iter3
    healthy (reset to 1), iter4 cancels. The recorded sleeps pin it.
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
        if calls in (1, 2):
            # Flap: subscribed then dropped before the healthy threshold, so
            # the real _connect_once would leave _established False. Simulate
            # that, then raise ConnectionClosed like a real socket drop.
            self._established = False
            raise websockets.ConnectionClosed(None, None)
        if calls == 3:
            # Healthy session: stayed up past the threshold → _established True.
            self._established = True
            raise websockets.ConnectionClosed(None, None)
        raise asyncio.CancelledError()

    monkeypatch.setattr(Connector, "_connect_once", _conn)

    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10))

    with pytest.raises(asyncio.CancelledError):
        await connector.run()

    # iter1 flap: not established → sleep(~1.0), escalate to 2.0
    # iter2 flap: still not established → sleep(~2.0), escalate to 4.0
    # iter3 healthy: established → reset to 1.0, sleep(~1.0), no escalation
    # iter4: CancelledError before any sleep
    # Sleeps are jittered by ±_BACKOFF_JITTER_FRACTION, so assert each
    # realized sleep falls in the band around its un-jittered base. The
    # escalation schedule itself (1→2→4, reset to 1) is what's under test
    # and is driven by the un-jittered ``backoff``.
    f = connector_mod._BACKOFF_JITTER_FRACTION
    expected_bases = [1.0, 2.0, 1.0]
    assert len(sleeps) == len(expected_bases), (
        f"expected {len(expected_bases)} sleeps, got {sleeps}"
    )
    for realized, base in zip(sleeps, expected_bases, strict=True):
        assert base * (1 - f) <= realized <= base * (1 + f), (
            "sub-threshold flaps must keep escalating backoff (1→2→4); only a "
            f"healthy session resets it to 1.0. realized sleep {realized} out "
            f"of jitter band around base {base}. recorded sleeps: {sleeps}"
        )


# ──────────────────────────────────────────────────────────────────────────
# Disconnect diagnostics. Production drops ~50-260 sockets/day with "no close
# frame received or sent", torn down within ~2 ms of the container. Every
# disconnect log line must carry the shard, both close frames, the transport
# error websockets chains via ``raise ... from``, the session stats, and the
# socket addresses (a drop is matched to Railway network-flow logs by port).
# ──────────────────────────────────────────────────────────────────────────

_LOCAL_ADDR = ("10.250.1.7", 54321)
_REMOTE_ADDR = ("104.18.24.1", 443)
_SECRET = "SUPER_SECRET_UW_TOKEN"
_SECRET_URL = f"wss://api.unusualwhales.com/socket?token={_SECRET}"

# Every disconnect line carries these, None where they don't apply.
_DIAG_FIELDS = frozenset(
    {
        "shard",
        "exc_type",
        "err",
        "close_rcvd",
        "close_sent",
        "cause_type",
        "cause",
        "cause_errno",
        "session_s",
        "frames",
        "since_last_frame_s",
        "local_addr",
        "remote_addr",
        "backoff",
    }
)


class _RecordCollector(logging.Handler):
    """Collects every LogRecord the connector's logger emits.

    The project logger sets ``propagate=False``, so ``caplog`` never sees its
    records. A handler attached to the logger itself does, with each ``extra``
    field as a record attribute.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def connector_records():
    import connector as connector_mod

    collector = _RecordCollector()
    prev_level = connector_mod.log.level
    connector_mod.log.addHandler(collector)
    connector_mod.log.setLevel(logging.DEBUG)
    try:
        yield collector.records
    finally:
        connector_mod.log.removeHandler(collector)
        connector_mod.log.setLevel(prev_level)


def _closed_from(cause: BaseException | None, **kwargs: Any) -> websockets.ConnectionClosedError:
    """A ConnectionClosedError chained the way websockets 17 raises it:
    ``raise self.protocol.close_exc from self.recv_exc`` (cause may be None)."""
    exc = websockets.ConnectionClosedError(kwargs.get("rcvd"), kwargs.get("sent"))
    exc.__cause__ = cause
    exc.__suppress_context__ = True
    return exc


def _raised_inside_except(
    outer: BaseException, inner: BaseException, *, from_none: bool = False
) -> BaseException:
    """``outer`` as Python leaves it after being raised inside ``except inner``.

    Without ``from``, Python links ``inner`` as ``__context__``. With
    ``from None`` it still links it, but sets ``__suppress_context__``.
    """
    try:
        try:
            raise inner
        except type(inner):
            if from_none:
                raise outer from None
            raise outer  # noqa: B904 - the implicit chain is what's under test
    except type(outer) as caught:
        return caught
    raise AssertionError("unreachable")


class _SessionWS:
    """Fake connection for one session: yields ``frames``, then ends.

    ``end`` is raised to end the session the way the real ``async for`` ends an
    abnormal close; ``None`` ends the iteration cleanly, as a graceful close
    does. ``protocol`` holds the close frames where websockets' sans-I/O
    protocol object keeps them.
    """

    def __init__(
        self,
        frames: list[bytes],
        end: BaseException | None = None,
        *,
        pre_frame_delay_s: float = 0.0,
        close_rcvd: Close | None = None,
        close_sent: Close | None = None,
    ) -> None:
        self.local_address = _LOCAL_ADDR
        self.remote_address = _REMOTE_ADDR
        self.protocol = SimpleNamespace(close_rcvd=close_rcvd, close_sent=close_sent)
        self._frames = frames
        self._end = end
        self._pre_frame_delay_s = pre_frame_delay_s

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        await asyncio.sleep(self._pre_frame_delay_s)
        for frame in self._frames:
            yield frame
        if self._end is not None:
            raise self._end


class _ConnectCtx:
    """Stand-in for ``websockets.connect(...)``: enters to ``ws`` or raises."""

    def __init__(
        self,
        ws: _SessionWS | None = None,
        enter_exc: BaseException | None = None,
    ) -> None:
        self._ws = ws
        self._enter_exc = enter_exc

    async def __aenter__(self):
        if self._enter_exc is not None:
            raise self._enter_exc
        return self._ws

    async def __aexit__(self, exc_type, exc, tb):
        return False


async def _run_attempts(monkeypatch, connector: Connector, attempts: list[_ConnectCtx]) -> None:
    """Drive the REAL ``run()`` → ``_connect_once`` through ``attempts``.

    Each ``websockets.connect`` call returns the next context; once they run
    out, connect raises CancelledError to end the loop. Backoff is zeroed and
    the storm alert stubbed so only the disconnect log lines vary.
    """
    import connector as connector_mod

    pending = list(attempts)

    def _fake_connect(*_args, **_kwargs):
        if not pending:
            raise asyncio.CancelledError()
        return pending.pop(0)

    async def _noop_subscribe(_ws):
        return None

    monkeypatch.setattr(connector_mod.websockets, "connect", _fake_connect)
    monkeypatch.setattr(connector, "_subscribe_all", _noop_subscribe)
    monkeypatch.setattr(connector_mod, "_INITIAL_BACKOFF_S", 0.0)
    monkeypatch.setattr(connector_mod, "capture_message", lambda *_a, **_k: None)

    with pytest.raises(asyncio.CancelledError):
        await connector.run()


def _only(records: list[logging.LogRecord], msg: str) -> logging.LogRecord:
    matches = [r for r in records if r.getMessage() == msg]
    assert len(matches) == 1, (
        f"expected exactly one {msg!r} record, got {[r.getMessage() for r in records]}"
    )
    return matches[0]


@pytest.mark.asyncio
async def test_disconnect_log_reports_transport_cause_and_session(
    monkeypatch, connector_records
) -> None:
    """The production failure: ConnectionClosedError chained from an
    ECONNRESET. The log line must name the shard, the exception class, both
    (absent) close frames, the reset error and its errno, the session's age
    and frame stats, and the socket addresses.
    """
    reset = ConnectionResetError(errno.ECONNRESET, "Connection reset by peer")
    ws = _SessionWS(
        [b"f1", b"f2", b"f3"],
        end=_closed_from(reset),
        pre_frame_delay_s=0.05,
    )
    connector = Connector(
        channels=["flow-alerts"], receive_queue=asyncio.Queue(maxsize=10), name="shard-3"
    )

    await _run_attempts(monkeypatch, connector, [_ConnectCtx(ws)])

    rec = _only(connector_records, "WS connection unavailable")
    assert rec.__dict__.keys() >= _DIAG_FIELDS
    assert rec.shard == "shard-3"
    assert rec.exc_type == "ConnectionClosedError"
    assert rec.err == "no close frame received or sent"
    assert rec.close_rcvd is None
    assert rec.close_sent is None
    assert rec.cause_type == "ConnectionResetError"
    assert rec.cause == repr(reset)
    assert rec.cause_errno == errno.ECONNRESET
    assert rec.frames == 3
    # The frames arrived ~50 ms after connect, then the socket died at once:
    # session age spans the wait, time-since-last-frame does not.
    assert isinstance(rec.session_s, float)
    assert isinstance(rec.since_last_frame_s, float)
    assert 0.0 <= rec.since_last_frame_s < rec.session_s
    assert rec.local_addr == "10.250.1.7:54321"
    assert rec.remote_addr == "104.18.24.1:443"
    assert rec.backoff == 0.0


@pytest.mark.asyncio
async def test_disconnect_log_without_cause_reports_close_frames(
    monkeypatch, connector_records
) -> None:
    """A ConnectionClosedError with no chained cause (websockets raises it
    ``from None`` on a bare TCP EOF) logs None cause fields without crashing,
    and a close frame we sent (our keepalive timeout) shows up as code+reason.
    """
    keepalive = Close(1011, "keepalive ping timeout")
    ws = _SessionWS([], end=_closed_from(None, sent=keepalive))
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10), name="ws")

    await _run_attempts(monkeypatch, connector, [_ConnectCtx(ws)])

    rec = _only(connector_records, "WS connection unavailable")
    assert rec.__dict__.keys() >= _DIAG_FIELDS
    assert rec.exc_type == "ConnectionClosedError"
    assert rec.cause_type is None
    assert rec.cause is None
    assert rec.cause_errno is None
    assert rec.close_rcvd is None
    assert rec.close_sent == {"code": 1011, "reason": "keepalive ping timeout"}
    # Connected but nothing arrived: zero frames, no last-frame age.
    assert rec.frames == 0
    assert rec.since_last_frame_s is None
    assert isinstance(rec.session_s, float)


@pytest.mark.asyncio
async def test_clean_close_log_carries_diag_fields(monkeypatch, connector_records) -> None:
    """A graceful close raises nothing, so the close frames come from the
    socket's protocol state. Same field set as the exception branches."""
    going_away = Close(1001, "going away")
    ws = _SessionWS(
        [b"f1", b"f2"],
        end=None,
        close_rcvd=going_away,
        close_sent=going_away,
    )
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10), name="shard-0")

    await _run_attempts(monkeypatch, connector, [_ConnectCtx(ws)])

    rec = _only(connector_records, "WS closed cleanly, reconnecting after grace")
    assert rec.__dict__.keys() >= _DIAG_FIELDS
    assert rec.shard == "shard-0"
    assert rec.exc_type is None
    assert rec.err is None
    assert rec.cause_type is None
    assert rec.close_rcvd == {"code": 1001, "reason": "going away"}
    assert rec.close_sent == {"code": 1001, "reason": "going away"}
    assert rec.frames == 2
    assert isinstance(rec.session_s, float)
    assert isinstance(rec.since_last_frame_s, float)
    assert rec.local_addr == "10.250.1.7:54321"
    assert rec.remote_addr == "104.18.24.1:443"


@pytest.mark.parametrize(
    ("enter_exc", "msg", "exc_type"),
    [
        (websockets.InvalidHandshake(), "WS connection unavailable", "InvalidHandshake"),
        (
            ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused"),
            "WS transport error",
            "ConnectionRefusedError",
        ),
    ],
)
@pytest.mark.asyncio
async def test_pre_connect_failure_logs_no_session(
    monkeypatch, connector_records, enter_exc: BaseException, msg: str, exc_type: str
) -> None:
    """A handshake reject or TCP failure never opened a socket: every session
    field is None, and building the line doesn't crash on the missing socket."""
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10), name="shard-1")

    await _run_attempts(monkeypatch, connector, [_ConnectCtx(enter_exc=enter_exc)])

    rec = _only(connector_records, msg)
    assert rec.__dict__.keys() >= _DIAG_FIELDS
    assert rec.shard == "shard-1"
    assert rec.exc_type == exc_type
    assert rec.session_s is None
    assert rec.frames is None
    assert rec.since_last_frame_s is None
    assert rec.local_addr is None
    assert rec.remote_addr is None
    assert rec.close_rcvd is None
    assert rec.close_sent is None
    assert rec.cause_type is None


@pytest.mark.asyncio
async def test_disconnect_cause_falls_back_to_implicit_context(
    monkeypatch, connector_records
) -> None:
    """An exception raised inside ``except`` WITHOUT ``from`` has no
    ``__cause__``. The transport error it was handling, linked as
    ``__context__``, is reported as the cause."""
    reset = ConnectionResetError(errno.ECONNRESET, "Connection reset by peer")
    closed = _raised_inside_except(websockets.ConnectionClosedError(None, None), reset)
    ws = _SessionWS([b"f1"], end=closed)
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10))

    await _run_attempts(monkeypatch, connector, [_ConnectCtx(ws)])

    rec = _only(connector_records, "WS connection unavailable")
    assert rec.cause_type == "ConnectionResetError"
    assert rec.cause == repr(reset)
    assert rec.cause_errno == errno.ECONNRESET


@pytest.mark.asyncio
async def test_disconnect_cause_honours_from_none(monkeypatch, connector_records) -> None:
    """``raise ... from None`` suppresses the implicit context, so it must not
    be reported as the cause. Mirrors websockets' client handshake check:
    ``raise InvalidHeader("Sec-WebSocket-Accept") from None`` inside
    ``except KeyError``."""
    rejected = _raised_inside_except(
        websockets.InvalidHeader("Sec-WebSocket-Accept"),
        KeyError("Sec-WebSocket-Accept"),
        from_none=True,
    )
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10))

    await _run_attempts(monkeypatch, connector, [_ConnectCtx(enter_exc=rejected)])

    rec = _only(connector_records, "WS connection unavailable")
    assert rec.exc_type == "InvalidHeader"
    assert rec.cause_type is None
    assert rec.cause is None
    assert rec.cause_errno is None


@pytest.mark.asyncio
async def test_session_fields_reset_between_attempts(monkeypatch, connector_records) -> None:
    """A failed connect after a real session must not report the previous
    socket's age, frames or addresses: each attempt starts from nothing."""
    first = _SessionWS([b"f1"], end=_closed_from(ConnectionResetError(errno.ECONNRESET, "reset")))
    refused = ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused")
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10))

    await _run_attempts(
        monkeypatch, connector, [_ConnectCtx(first), _ConnectCtx(enter_exc=refused)]
    )

    dropped = _only(connector_records, "WS connection unavailable")
    assert dropped.frames == 1
    assert dropped.local_addr == "10.250.1.7:54321"

    rec = _only(connector_records, "WS transport error")
    assert rec.session_s is None
    assert rec.frames is None
    assert rec.since_last_frame_s is None
    assert rec.local_addr is None
    assert rec.remote_addr is None


@pytest.mark.asyncio
async def test_disconnect_logs_never_contain_ws_token(monkeypatch, connector_records) -> None:
    """The WS URL carries the UW key as ``?token=``. Even when the exception
    text and its chained cause both embed that URL, no emitted record, raw
    or JSON-formatted, may contain the key."""
    import connector as connector_mod

    monkeypatch.setattr(
        connector_mod,
        "settings",
        SimpleNamespace(ws_url=_SECRET_URL, channel_shards=[["a"]]),
    )

    pre_connect = OSError(f"cannot connect to {_SECRET_URL}")
    pre_connect.__cause__ = RuntimeError(f"resolver failed for {_SECRET_URL}")
    mid_session = _SessionWS([b"f1"], end=_closed_from(OSError(f"read failed on {_SECRET_URL}")))
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10))

    await _run_attempts(
        monkeypatch,
        connector,
        [_ConnectCtx(enter_exc=pre_connect), _ConnectCtx(mid_session)],
    )

    # Both disconnect lines were emitted (so the check below isn't vacuous).
    assert _only(connector_records, "WS transport error").cause_type == "RuntimeError"
    assert _only(connector_records, "WS connection unavailable").cause_type == "OSError"

    formatter = JsonFormatter()
    for record in connector_records:
        line = formatter.format(record)
        assert _SECRET not in line, f"token leaked into formatted record: {line}"
        raw_values = " ".join(repr(v) for v in record.__dict__.values())
        assert _SECRET not in raw_values, (
            f"token leaked into raw record {record.getMessage()!r}: {raw_values}"
        )


@pytest.mark.asyncio
async def test_unexpected_disconnect_sends_diag_to_sentry(monkeypatch, connector_records) -> None:
    """The catch-all branch logs nothing of its own; it reports to Sentry. The
    capture must carry the same disconnect diagnostics as context, with the
    existing tag, and the token scrubbed out of the exception text and cause."""
    import connector as connector_mod

    monkeypatch.setattr(
        connector_mod,
        "settings",
        SimpleNamespace(ws_url=_SECRET_URL, channel_shards=[["a"]]),
    )
    captured: list[tuple[BaseException, dict[str, Any]]] = []
    monkeypatch.setattr(
        connector_mod,
        "capture_exception",
        lambda exc, **kwargs: captured.append((exc, kwargs)),
    )

    boom = RuntimeError(f"unexpected failure on {_SECRET_URL}")
    boom.__cause__ = ValueError(f"bad state for {_SECRET_URL}")
    ws = _SessionWS([b"f1", b"f2"], end=boom)
    connector = Connector(channels=["a"], receive_queue=asyncio.Queue(maxsize=10), name="shard-2")

    await _run_attempts(monkeypatch, connector, [_ConnectCtx(ws)])

    assert len(captured) == 1, f"expected one Sentry capture, got {captured}"
    exc, kwargs = captured[0]
    assert exc is boom
    assert kwargs["tags"] == {"component": "connector"}
    ctx = kwargs["context"]["disconnect"]
    assert ctx["shard"] == "shard-2"
    assert ctx["exc_type"] == "RuntimeError"
    assert ctx["cause_type"] == "ValueError"
    assert ctx["frames"] == 2
    assert isinstance(ctx["session_s"], float)
    assert isinstance(ctx["since_last_frame_s"], float)
    assert ctx["local_addr"] == "10.250.1.7:54321"
    assert ctx["remote_addr"] == "104.18.24.1:443"
    assert _SECRET not in json.dumps(kwargs["context"], default=str)
    # No disconnect log line of its own: the catch-all reports via Sentry only.
    assert not [r for r in connector_records if r.levelno >= logging.WARNING]


@pytest.mark.parametrize(
    ("addr", "expected"),
    [
        (("10.0.0.5", 443), "10.0.0.5:443"),
        # IPv6 sockname is a 4-tuple; the host gets brackets.
        (("2606:4700::6812:1801", 443, 0, 0), "[2606:4700::6812:1801]:443"),
        (None, None),
        # AF_UNIX gives a path string, not a host/port tuple.
        ("/tmp/sock", None),
        ((), None),
    ],
)
def test_format_addr(addr: object, expected: str | None) -> None:
    import connector as connector_mod

    assert connector_mod._format_addr(addr) == expected
