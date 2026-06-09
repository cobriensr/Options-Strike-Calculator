"""Unit tests for the message router."""

from __future__ import annotations

import asyncio
from typing import Any

import orjson
import pytest

from router import Router
from state import state


class FakeHandler:
    """Test double that records enqueue calls."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.received: list[dict] = []

    async def enqueue(self, payload: dict) -> None:
        self.received.append(payload)


@pytest.fixture
def fake() -> FakeHandler:
    return FakeHandler("flow-alerts")


@pytest.fixture
def router(fake: FakeHandler) -> Router:
    return Router({"flow-alerts": fake})


@pytest.fixture(autouse=True)
def _reset_state():
    """Each test gets a clean channel-state map."""
    state.channels.clear()
    yield
    state.channels.clear()


def _wire(channel: str, payload: Any) -> bytes:
    return orjson.dumps([channel, payload])


@pytest.mark.asyncio
async def test_dispatches_payload_to_handler(router: Router, fake: FakeHandler):
    payload = {"ticker": "SPY", "option_chain": "SPY261019P00415000"}
    await router.dispatch(_wire("flow-alerts", payload))
    assert fake.received == [payload]


@pytest.mark.asyncio
async def test_join_ack_marks_subscribed_and_skips_handler(router: Router, fake: FakeHandler):
    await router.dispatch(_wire("flow-alerts", {"response": {}, "status": "ok"}))
    assert fake.received == []
    assert state.channel("flow-alerts").subscribed is True


@pytest.mark.asyncio
async def test_malformed_json_does_not_raise(router: Router, fake: FakeHandler):
    await router.dispatch(b"not-json")
    assert fake.received == []


@pytest.mark.asyncio
async def test_non_array_envelope_is_dropped(router: Router, fake: FakeHandler):
    await router.dispatch(orjson.dumps({"channel": "flow-alerts", "msg": "x"}))
    assert fake.received == []


@pytest.mark.asyncio
async def test_wrong_array_length_is_dropped(router: Router, fake: FakeHandler):
    await router.dispatch(orjson.dumps(["flow-alerts"]))
    assert fake.received == []


@pytest.mark.asyncio
async def test_non_string_channel_is_dropped(router: Router, fake: FakeHandler):
    await router.dispatch(orjson.dumps([123, {"x": 1}]))
    assert fake.received == []


@pytest.mark.asyncio
async def test_unknown_channel_is_logged_not_raised(router: Router, fake: FakeHandler):
    await router.dispatch(_wire("unknown-channel", {"x": 1}))
    assert fake.received == []


@pytest.mark.asyncio
async def test_payload_must_be_dict(router: Router, fake: FakeHandler):
    await router.dispatch(_wire("flow-alerts", "not-a-dict"))
    assert fake.received == []


@pytest.mark.asyncio
async def test_handler_exception_does_not_propagate(monkeypatch):
    """A bad handler must not crash the router."""

    class BadHandler:
        name = "flow-alerts"

        async def enqueue(self, payload: dict) -> None:
            raise RuntimeError("boom")

    r = Router({"flow-alerts": BadHandler()})
    # If this raises, the test fails. We just care that it doesn't.
    await r.dispatch(_wire("flow-alerts", {"x": 1}))


@pytest.mark.asyncio
async def test_dispatch_accepts_str_and_bytes(router: Router, fake: FakeHandler):
    payload = {"a": 1}
    await router.dispatch(_wire("flow-alerts", payload).decode())
    await router.dispatch(_wire("flow-alerts", payload))
    assert len(fake.received) == 2


@pytest.mark.asyncio
async def test_touch_updates_state_on_real_payload(router: Router, fake: FakeHandler):
    await router.dispatch(_wire("flow-alerts", {"x": 1}))
    assert state.channel("flow-alerts").last_message_ts is not None


@pytest.mark.asyncio
async def test_touch_not_called_for_join_ack(router: Router, fake: FakeHandler):
    """ACK frames shouldn't bump last_message_ts; that's reserved for
    real channel data. Otherwise /healthz would never go stale on a
    channel that's only sending acks."""
    await router.dispatch(_wire("flow-alerts", {"response": {}, "status": "ok"}))
    assert state.channel("flow-alerts").last_message_ts is None


@pytest.mark.asyncio
async def test_run_consumes_from_receive_queue(router: Router, fake: FakeHandler):
    """Phase 1 / C2: ``Router.run`` pulls raw frames off the connector
    → router queue and dispatches them. Verifies the new architecture
    (decoupled receive task) wires together end-to-end.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=4)
    queue.put_nowait(_wire("flow-alerts", {"x": 1}))
    queue.put_nowait(_wire("flow-alerts", {"x": 2}))

    # Run two iterations of the consume loop. We can't await
    # ``router.run`` directly — it never returns — so step through it
    # by awaiting the queue.get() + dispatch path manually for each
    # known item, matching what ``run`` does in production.
    state.receive_queue_depth = 0
    for _ in range(2):
        raw = await queue.get()
        try:
            await router.dispatch(raw)
        finally:
            queue.task_done()
            state.receive_queue_depth = queue.qsize()

    assert len(fake.received) == 2
    assert fake.received == [{"x": 1}, {"x": 2}]
    assert state.receive_queue_depth == 0


@pytest.mark.asyncio
async def test_run_iterates_until_cancelled(router: Router, fake: FakeHandler):
    """Belt-and-suspenders: actually start ``router.run`` as a task,
    push items, then cancel it. Confirms the full ``run`` coroutine
    (not just inline reproduction) consumes from the receive queue.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=4)
    task = asyncio.create_task(router.run(queue))
    try:
        await queue.put(_wire("flow-alerts", {"x": 99}))
        await asyncio.wait_for(queue.join(), timeout=1.0)
        assert fake.received == [{"x": 99}]
        assert state.receive_queue_depth == 0
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
