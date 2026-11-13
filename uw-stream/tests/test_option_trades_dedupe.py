"""Tests for the redundant-socket dedupe in OptionTradesHandler.enqueue.

With WS_REDUNDANT_OPTION_TRADES on, every option_trades:<TICKER> channel is
joined on two sockets, so each trade reaches the handler twice as an
identical frame. ``enqueue`` drops the second copy by (id, canceled flag)
before it reaches the queue. Spec:
docs/superpowers/specs/uw-stream-redundant-trade-sockets-2026-11-13.md.

The clock is faked at the module boundary (``handlers.option_trades.monotonic``),
not ``time.monotonic``, which asyncio's loop also reads.
"""

from __future__ import annotations

import copy
import json
from collections import deque
from pathlib import Path
from uuid import uuid4

import pytest

from config import settings
from handlers import option_trades as option_trades_mod
from handlers import recent_fires
from handlers.interval_ba import (
    QQQIntervalBAHandler,
    SPXWIntervalBAHandler,
    SPYIntervalBAHandler,
    _aggregate,
)
from handlers.option_trades import OptionTradesHandler
from state import state

_FIXTURES = Path(__file__).parent / "fixtures"

# 12:06:23 CT on 2026-05-12, inside the 17:05:00Z bucket (the 0DTE expiry
# of the SPXW fixture chain).
_BUCKET_START_EPOCH = 1778605500


@pytest.fixture(autouse=True)
def _reset_state():
    state.handlers.clear()
    recent_fires._reset_for_tests()
    yield
    state.handlers.clear()
    recent_fires._reset_for_tests()


class _Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(option_trades_mod, "monotonic", fake)
    return fake


@pytest.fixture
def payload() -> dict:
    with open(_FIXTURES / "option_trades_sample.json") as f:
        return json.load(f)


@pytest.fixture
def handler(clock) -> OptionTradesHandler:
    return OptionTradesHandler()


@pytest.fixture
def info_logs(monkeypatch) -> list[tuple[str, dict]]:
    """Capture ``log.info`` calls made by the handler module.

    The project logger sets ``propagate=False``, so ``caplog`` never sees it
    (same note as tests/test_handlers.py::_record_warnings).
    """
    captured: list[tuple[str, dict]] = []

    def _info(msg, *args, **kwargs):
        captured.append((msg, kwargs.get("extra", {})))

    monkeypatch.setattr(option_trades_mod.log, "info", _info)
    return captured


def _metrics(h: OptionTradesHandler):
    return state.handler(h.name)


def _fresh(p: dict, **changes) -> dict:
    """A copy of ``p`` with a new trade id, plus any field overrides."""
    out = copy.deepcopy(p)
    out["id"] = str(uuid4())
    out.update(changes)
    return out


def _queued(h: OptionTradesHandler) -> list[dict]:
    return list(h.queue._queue)  # type: ignore[attr-defined]


def _process_queue(h: OptionTradesHandler) -> None:
    """What ``Handler.run`` does per queued item: transform it onto the batch."""
    while not h.queue.empty():
        h._add_row(h.queue.get_nowait())
        h.queue.task_done()


class TestEnqueueDedupe:
    async def test_second_copy_is_dropped_before_the_queue(self, handler, payload):
        await handler.enqueue(payload)
        await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 1
        assert _metrics(handler).dupes_dropped == 1

    async def test_first_copy_is_queued_untouched(self, handler, payload):
        await handler.enqueue(payload)

        assert _queued(handler) == [payload]
        assert _queued(handler)[0] is payload

    async def test_dupe_is_not_counted_as_a_backpressure_drop(self, handler, payload):
        # drop_count feeds the drop reporter's Sentry warning; a redundant
        # copy is not lost data and must not trip it.
        await handler.enqueue(payload)
        await handler.enqueue(copy.deepcopy(payload))

        assert _metrics(handler).drop_count == 0
        assert _metrics(handler).queue_depth == 1

    async def test_further_copies_are_dropped_too(self, handler, payload):
        for _ in range(4):
            await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 1
        assert _metrics(handler).dupes_dropped == 3

    async def test_distinct_ids_both_queued(self, handler, payload):
        await handler.enqueue(payload)
        await handler.enqueue(_fresh(payload))

        assert handler.queue.qsize() == 2
        assert _metrics(handler).dupes_dropped == 0

    async def test_same_id_with_a_different_canceled_flag_is_queued(self, handler, payload):
        cancel = copy.deepcopy(payload)
        cancel["canceled"] = True

        await handler.enqueue(payload)
        await handler.enqueue(cancel)

        assert handler.queue.qsize() == 2
        assert _metrics(handler).dupes_dropped == 0

    async def test_the_cancel_flag_is_part_of_the_key_for_both_copies(self, handler, payload):
        cancel = copy.deepcopy(payload)
        cancel["canceled"] = True

        for p in (payload, cancel, copy.deepcopy(payload), copy.deepcopy(cancel)):
            await handler.enqueue(p)

        assert handler.queue.qsize() == 2
        assert _metrics(handler).dupes_dropped == 2

    @pytest.mark.parametrize(
        ("first", "second"),
        [
            ("absent", None),  # key omitted vs JSON null
            (None, False),
            (False, "false"),
            (True, "true"),
            (True, 1),
        ],
    )
    async def test_canceled_spellings_key_the_way_transform_reads_them(
        self, handler, payload, first, second
    ):
        # UW has sent the flag as bool, str and int; _transform reads all of
        # them through _to_bool, so the key must too.
        a = copy.deepcopy(payload)
        b = copy.deepcopy(payload)
        if first == "absent":
            del a["canceled"]
        else:
            a["canceled"] = first
        b["canceled"] = second

        await handler.enqueue(a)
        await handler.enqueue(b)

        assert handler.queue.qsize() == 1

    @pytest.mark.parametrize("bad_id", [None, 12345, ["x"], {"a": 1}, ""])
    async def test_payload_without_a_usable_id_passes_through_unchanged(
        self, handler, payload, bad_id
    ):
        no_id = copy.deepcopy(payload)
        if bad_id is None:
            del no_id["id"]
        else:
            no_id["id"] = bad_id

        await handler.enqueue(no_id)
        await handler.enqueue(copy.deepcopy(no_id))

        assert handler.queue.qsize() == 2
        assert _metrics(handler).dupes_dropped == 0

    async def test_payload_without_id_is_still_rejected_by_transform(self, handler, payload):
        del payload["id"]

        await handler.enqueue(payload)
        _process_queue(handler)

        assert handler._batch == []

    async def test_both_copies_of_a_trade_write_one_row(self, handler, payload):
        await handler.enqueue(payload)
        await handler.enqueue(copy.deepcopy(payload))
        _process_queue(handler)

        assert len(handler._batch) == 1

    async def test_kill_switch_off_passes_every_copy_and_keeps_no_state(
        self, monkeypatch, clock, payload
    ):
        monkeypatch.setattr(settings, "ws_redundant_option_trades", False)
        off = OptionTradesHandler()

        await off.enqueue(payload)
        await off.enqueue(copy.deepcopy(payload))

        assert off.queue.qsize() == 2
        assert _metrics(off).dupes_dropped == 0
        assert off._seen == {}


class TestRotation:
    """Two generations, rotated lazily every 60 s on the monotonic clock."""

    async def test_key_is_remembered_across_one_rotation(self, handler, clock, payload):
        await handler.enqueue(payload)
        clock.now += 61  # one rotation due: the key moves to the older generation
        await handler.enqueue(_fresh(payload))  # triggers the rotation
        await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 2
        assert _metrics(handler).dupes_dropped == 1

    async def test_key_is_forgotten_after_two_rotations(self, handler, clock, payload):
        await handler.enqueue(payload)
        clock.now += 61
        await handler.enqueue(_fresh(payload))  # first rotation
        clock.now += 61
        await handler.enqueue(_fresh(payload))  # second rotation
        await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 4  # the old key was forgotten, so it is queued again
        assert _metrics(handler).dupes_dropped == 0

    async def test_key_is_remembered_for_at_least_sixty_seconds(self, handler, clock, payload):
        await handler.enqueue(payload)
        clock.now += 59.9  # no rotation due yet
        await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 1
        assert _metrics(handler).dupes_dropped == 1

    async def test_idle_gap_forgets_both_generations(self, handler, clock, payload):
        await handler.enqueue(payload)
        clock.now += 61
        await handler.enqueue(_fresh(payload))  # `payload`'s key is now the older generation
        clock.now += 3_600  # an hour of silence (lazy rotation has not run)
        await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 3
        assert _metrics(handler).dupes_dropped == 0

    async def test_idle_gap_forgets_a_key_from_the_current_generation(
        self, handler, clock, payload
    ):
        await handler.enqueue(payload)
        clock.now += 3_600  # the rotation is long overdue when the next frame comes
        await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 2
        assert _metrics(handler).dupes_dropped == 0

    async def test_idle_gap_rotation_empties_the_current_generation_too(
        self, handler, clock, payload
    ):
        await handler.enqueue(payload)
        clock.now += 3_600
        await handler.enqueue(_fresh(payload))  # rotation: nothing old may survive

        assert len(handler._seen) == 1
        assert handler._seen_prev == {}

    async def test_a_dupe_in_the_older_generation_is_dropped(self, handler, clock, payload):
        # The mirror can lag the first copy across a rotation boundary.
        await handler.enqueue(payload)
        clock.now += 61
        await handler.enqueue(_fresh(payload))
        await handler.enqueue(copy.deepcopy(payload))
        await handler.enqueue(copy.deepcopy(payload))

        assert handler.queue.qsize() == 2
        assert _metrics(handler).dupes_dropped == 2

    async def test_memory_is_bounded_by_two_generations(self, handler, clock, payload):
        for _ in range(10):
            for _ in range(50):
                await handler.enqueue(_fresh(payload))
            clock.now += 61

        assert len(handler._seen) + len(handler._seen_prev) <= 100


class TestCounters:
    async def test_single_copy_counts_keys_seen_once_when_their_generation_retires(
        self, handler, clock, payload
    ):
        paired = _fresh(payload)
        lone_a, lone_b = _fresh(payload), _fresh(payload)
        for p in (paired, copy.deepcopy(paired), lone_a, lone_b):
            await handler.enqueue(p)
        assert _metrics(handler).single_copy == 0  # not final until retired

        clock.now += 61
        await handler.enqueue(_fresh(payload))  # generation moves to "older"
        assert _metrics(handler).single_copy == 0
        clock.now += 61
        await handler.enqueue(_fresh(payload))  # and is retired

        assert _metrics(handler).single_copy == 2
        assert _metrics(handler).dupes_dropped == 1

    async def test_a_late_second_copy_in_the_older_generation_is_not_a_single(
        self, handler, clock, payload
    ):
        p = _fresh(payload)
        await handler.enqueue(p)
        clock.now += 61
        await handler.enqueue(_fresh(payload))
        await handler.enqueue(copy.deepcopy(p))  # second copy lands after the rotation
        clock.now += 61
        await handler.enqueue(_fresh(payload))  # `p`'s generation is retired here

        assert _metrics(handler).single_copy == 0
        assert _metrics(handler).dupes_dropped == 1

    async def test_idle_gap_still_counts_the_retired_singles(self, handler, clock, payload):
        await handler.enqueue(payload)
        clock.now += 3_600
        await handler.enqueue(_fresh(payload))

        assert _metrics(handler).single_copy == 1

    async def test_counters_are_logged_every_five_minutes(self, handler, clock, payload, info_logs):
        await handler.enqueue(payload)
        await handler.enqueue(copy.deepcopy(payload))
        await handler.enqueue(_fresh(payload))
        assert info_logs == []

        clock.now += 299
        await handler.enqueue(_fresh(payload))  # a rotation, but the 300 s is not up
        assert info_logs == []

        clock.now += 61  # the next rotation falls after the 300 s mark
        await handler.enqueue(_fresh(payload))

        assert len(info_logs) == 1
        _, extra = info_logs[0]
        assert extra["handler"] == "option_trades"
        assert extra["dupes_dropped"] == 1
        assert extra["dupes_dropped_interval"] == 1
        assert "single_copy" in extra

    async def test_log_reports_the_interval_since_the_previous_log(
        self, handler, clock, payload, info_logs
    ):
        await handler.enqueue(payload)
        await handler.enqueue(copy.deepcopy(payload))
        clock.now += 301
        await handler.enqueue(_fresh(payload))
        await handler.enqueue(_fresh(payload, id="x"))  # not a UUID; still keyed by its string
        await handler.enqueue(_fresh(payload, id="x"))
        clock.now += 301
        await handler.enqueue(_fresh(payload))

        assert [extra["dupes_dropped_interval"] for _, extra in info_logs] == [1, 1]
        assert [extra["dupes_dropped"] for _, extra in info_logs] == [1, 2]

    async def test_no_per_frame_logging(self, handler, clock, payload, info_logs):
        for _ in range(200):
            p = _fresh(payload)
            await handler.enqueue(p)
            await handler.enqueue(copy.deepcopy(p))

        assert info_logs == []

    async def test_kill_switch_off_logs_nothing(self, monkeypatch, clock, payload, info_logs):
        monkeypatch.setattr(settings, "ws_redundant_option_trades", False)
        off = OptionTradesHandler()
        clock.now += 301

        await off.enqueue(payload)

        assert info_logs == []


# ----------------------------------------------------------------------
# Interval B/A: the aggregate must not double-count a duplicate frame.
# ----------------------------------------------------------------------


@pytest.fixture
def spxw_payload() -> dict:
    with open(_FIXTURES / "interval_ba_sample.json") as f:
        base = json.load(f)
    # $149,960 of ask-side premium: under the $250K floor on its own, over it
    # (and 100% ask) if the same print were counted twice.
    base.update(price="4.60", size=326, tags=["ask_side"])
    return base


def _bucket(handler: SPXWIntervalBAHandler, payload: dict) -> list:
    return list(handler._ticks[payload["option_chain"]][_BUCKET_START_EPOCH])


class TestIntervalBA:
    async def test_duplicate_frame_leaves_the_aggregate_unchanged(self, spxw_payload):
        single = SPXWIntervalBAHandler()
        await single.enqueue(copy.deepcopy(spxw_payload))
        _process_queue(single)
        expected = _aggregate(deque(_bucket(single, spxw_payload)))

        doubled = SPXWIntervalBAHandler()
        await doubled.enqueue(copy.deepcopy(spxw_payload))
        await doubled.enqueue(copy.deepcopy(spxw_payload))  # the mirror socket's copy
        _process_queue(doubled)

        assert len(_bucket(doubled, spxw_payload)) == 1
        assert _aggregate(deque(_bucket(doubled, spxw_payload))) == expected

    async def test_duplicate_frame_does_not_push_a_bucket_over_the_alert_floor(self, spxw_payload):
        h = SPXWIntervalBAHandler()

        await h.enqueue(copy.deepcopy(spxw_payload))
        await h.enqueue(copy.deepcopy(spxw_payload))
        _process_queue(h)

        assert h._pending_alerts == []

    async def test_without_the_dedupe_the_same_duplicate_would_fire_an_alert(
        self, monkeypatch, spxw_payload
    ):
        # Positive control for the two tests above: with the kill switch off the
        # duplicate is counted twice, which is exactly what the dedupe prevents.
        monkeypatch.setattr(settings, "ws_redundant_option_trades", False)
        h = SPXWIntervalBAHandler()

        await h.enqueue(copy.deepcopy(spxw_payload))
        await h.enqueue(copy.deepcopy(spxw_payload))
        _process_queue(h)

        assert len(_bucket(h, spxw_payload)) == 2
        assert len(h._pending_alerts) == 1

    async def test_distinct_trades_in_one_bucket_still_aggregate(self, spxw_payload):
        h = SPXWIntervalBAHandler()

        await h.enqueue(copy.deepcopy(spxw_payload))
        second = copy.deepcopy(spxw_payload)
        second["id"] = str(uuid4())
        await h.enqueue(second)
        _process_queue(h)

        assert len(_bucket(h, spxw_payload)) == 2
        assert len(h._pending_alerts) == 1

    @pytest.mark.parametrize(
        "cls", [SPYIntervalBAHandler, SPXWIntervalBAHandler, QQQIntervalBAHandler]
    )
    def test_interval_ba_handlers_inherit_enqueue(self, cls):
        # An override would bypass the dedupe and double-count premium.
        assert cls.enqueue is OptionTradesHandler.enqueue

    @pytest.mark.parametrize(
        "cls", [SPYIntervalBAHandler, SPXWIntervalBAHandler, QQQIntervalBAHandler]
    )
    async def test_each_interval_ba_handler_dedupes_on_its_own_row(self, cls, payload):
        h = cls()

        await h.enqueue(payload)
        await h.enqueue(copy.deepcopy(payload))

        assert h.queue.qsize() == 1
        assert state.handler(h.name).dupes_dropped == 1
        assert h.name.startswith("option_trades:")
