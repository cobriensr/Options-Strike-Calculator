"""Unit tests for the WS connector — focused on the join-frame contract
plus the bounded receive-queue handoff to the router (Phase 1, C2)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

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
    yield
    state.receive_queue_depth = 0
    state.receive_queue_drops = 0


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
