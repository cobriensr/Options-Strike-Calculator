"""Unit tests for GexStrikeExpiryHandler._transform.

DB writes are not exercised here — those are covered by an integration
test once the daemon is connected to a real UW Advanced-tier socket.
These tests verify the payload-to-row mapping, type coercion, and
rejection logic at the handler boundary.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from config import settings
from handlers import gex_strike_expiry as gex_mod
from handlers.gex_strike_expiry import (
    _COLUMNS,
    GexStrikeExpiryHandler,
    _ms_epoch_to_minute,
    _to_date,
    _to_decimal,
)
from state import state

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "gex_strike_expiry_sample.json"
# Fixture's expiry is 2026-05-01 — pin "today" to match so the
# 0DTE-only filter introduced by the greek-heatmap retention spec
# (docs/superpowers/specs/greek-heatmap-ws-retention-2026-05-15.md)
# admits the fixture's rows. Each test that exercises a happy path
# must patch `handlers.gex_strike_expiry._today_et` against this date.
_FIXTURE_EXPIRY = date(2026, 5, 1)


@pytest.fixture(autouse=True)
def pin_today_to_fixture(monkeypatch):
    """Pin _today_et to the fixture's expiry by default. Tests that
    explicitly exercise the today-ET filter (TestExpiryNotTodayFilter)
    override this monkeypatch with their own values."""
    monkeypatch.setattr("handlers.gex_strike_expiry._today_et", lambda: _FIXTURE_EXPIRY)


@pytest.fixture
def payload() -> dict:
    with open(_FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def handler() -> GexStrikeExpiryHandler:
    return GexStrikeExpiryHandler()


@pytest.fixture
def col_idx() -> dict[str, int]:
    return {name: i for i, name in enumerate(_COLUMNS)}


class TestTransform:
    def test_returns_tuple_with_correct_arity(self, handler, payload):
        row = handler._transform(payload)
        assert row is not None
        assert len(row) == len(_COLUMNS)

    def test_identity_fields(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["ticker"]] == "SPY"
        assert row[col_idx["expiry"]] == date(2026, 5, 1)
        assert row[col_idx["strike"]] == Decimal("722")

    def test_ts_minute_truncated_to_minute(self, handler, payload, col_idx):
        row = handler._transform(payload)
        ts = row[col_idx["ts_minute"]]
        assert isinstance(ts, datetime)
        assert ts.tzinfo is not None
        # 1777663530000 ms = 2026-05-01T19:25:30 UTC → truncated to 19:25:00
        assert ts == datetime(2026, 5, 1, 19, 25, 0, tzinfo=UTC)
        assert ts.second == 0
        assert ts.microsecond == 0

    def test_string_priced_fields_become_decimal(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["price"]] == Decimal("722.18")
        assert row[col_idx["call_gamma_oi"]] == Decimal("174792.59")
        assert row[col_idx["put_gamma_oi"]] == Decimal("-1172037.66")
        assert row[col_idx["call_charm_oi"]] == Decimal("85658181.72")
        assert row[col_idx["put_vanna_bid_vol"]] == Decimal("-321.27")

    def test_raw_payload_preserved(self, handler, payload, col_idx):
        row = handler._transform(payload)
        # Last column is the JSONB raw_payload — preserved verbatim.
        assert row[col_idx["raw_payload"]] is payload


class TestTransformRejection:
    def test_rejects_missing_ticker(self, handler, payload):
        del payload["ticker"]
        assert handler._transform(payload) is None

    def test_rejects_empty_ticker(self, handler, payload):
        payload["ticker"] = ""
        assert handler._transform(payload) is None

    def test_rejects_missing_expiry(self, handler, payload):
        del payload["expiry"]
        assert handler._transform(payload) is None

    def test_rejects_unparseable_expiry(self, handler, payload):
        payload["expiry"] = "not-a-date"
        assert handler._transform(payload) is None

    def test_rejects_missing_strike(self, handler, payload):
        del payload["strike"]
        assert handler._transform(payload) is None

    def test_rejects_missing_timestamp(self, handler, payload):
        del payload["timestamp"]
        assert handler._transform(payload) is None


class TestEmptyStringNumericQuirk:
    """UW emits ``""`` (empty string) on greek fields that aren't
    computable for the bar — see unusual-whales-websocket skill.

    The handler must coerce these to None (NULL in DB) rather than 0,
    so downstream queries can distinguish "absent" from "zero exposure."
    """

    def test_empty_string_call_gamma_becomes_none(self, handler, payload, col_idx):
        payload["call_gamma_oi"] = ""
        row = handler._transform(payload)
        assert row is not None
        assert row[col_idx["call_gamma_oi"]] is None

    def test_empty_string_charm_becomes_none(self, handler, payload, col_idx):
        payload["put_charm_vol"] = ""
        row = handler._transform(payload)
        assert row is not None
        assert row[col_idx["put_charm_vol"]] is None


class TestHelperFunctions:
    def test_to_decimal_handles_string_number(self):
        assert _to_decimal("722.18") == Decimal("722.18")

    def test_to_decimal_handles_negative(self):
        assert _to_decimal("-1172037.66") == Decimal("-1172037.66")

    def test_to_decimal_handles_empty_string(self):
        assert _to_decimal("") is None

    def test_to_decimal_handles_none(self):
        assert _to_decimal(None) is None

    def test_to_decimal_handles_garbage(self):
        assert _to_decimal("not a number") is None

    def test_to_date_iso_string(self):
        assert _to_date("2026-05-01") == date(2026, 5, 1)

    def test_to_date_invalid(self):
        assert _to_date("garbage") is None
        assert _to_date("") is None
        assert _to_date(None) is None

    def test_ms_epoch_truncates_to_minute(self):
        # 1777663530000 ms = 2026-05-01T19:25:30 UTC
        ts = _ms_epoch_to_minute(1777663530000)
        assert ts == datetime(2026, 5, 1, 19, 25, 0, tzinfo=UTC)

    def test_ms_epoch_handles_string(self):
        ts = _ms_epoch_to_minute("1777663530000")
        assert ts == datetime(2026, 5, 1, 19, 25, 0, tzinfo=UTC)

    def test_ms_epoch_handles_empty(self):
        assert _ms_epoch_to_minute("") is None
        assert _ms_epoch_to_minute(None) is None

    def test_columns_list_matches_table_definition(self):
        # Sanity: the transform's tuple shape must match _COLUMNS length.
        # The actual SQL column list is in api/_lib/db-migrations.ts
        # migration #111 — test_db.test.ts asserts that side.
        assert len(_COLUMNS) == 30
        assert _COLUMNS[0] == "ticker"
        assert _COLUMNS[-1] == "raw_payload"
        # Conflict cols must be a subset of _COLUMNS.
        from handlers.gex_strike_expiry import _CONFLICT_COLS

        for c in _CONFLICT_COLS:
            assert c in _COLUMNS


class TestFlushSortsByConflictKey:
    """The REST cron `/api/cron/fetch-gex-strike-expiry-etfs` writes to
    the same table with rows sorted by strike. Without a matching sort
    here, two concurrent writers acquire row locks in different orders
    and Postgres throws DeadlockDetected (Sentry 4G/4M).

    Verify that `_flush` canonicalizes lock-acquisition order before
    handing the batch to db.bulk_upsert_replace.
    """

    @pytest.mark.asyncio
    async def test_flush_sorts_rows_by_ticker_expiry_strike_ts_minute(self):
        handler = GexStrikeExpiryHandler()
        # Deliberately disordered: same minute, mixed strikes, mixed
        # tickers, mixed expiries. The expected output is lexicographic
        # by (ticker, expiry, strike, ts_minute).
        ts = datetime(2026, 5, 7, 19, 30, 0, tzinfo=UTC)
        # Row tuples here are length-4 stand-ins for the 30-tuple — only
        # the conflict-key positions are inspected by the sort.
        unordered: list[tuple] = [
            ("SPY", date(2026, 5, 8), Decimal("722"), ts),
            ("QQQ", date(2026, 5, 7), Decimal("530"), ts),
            ("SPY", date(2026, 5, 7), Decimal("723"), ts),
            ("SPY", date(2026, 5, 7), Decimal("722"), ts),
            ("QQQ", date(2026, 5, 7), Decimal("525"), ts),
        ]
        captured: list[list[tuple]] = []

        def capture(**kwargs):
            # AsyncMock awaits the result; a sync side_effect returning
            # None makes the awaited mock resolve to None.
            captured.append(list(kwargs["rows"]))

        with patch("handlers.gex_strike_expiry.db") as mock_db:
            mock_db.bulk_upsert_replace = AsyncMock(side_effect=capture)
            await handler._flush(unordered)

        assert len(captured) == 1
        sorted_rows = captured[0]
        # Lexicographic order: QQQ before SPY; within SPY, earlier
        # expiry first; within (SPY, 2026-05-07), strike 722 then 723.
        assert sorted_rows == [
            ("QQQ", date(2026, 5, 7), Decimal("525"), ts),
            ("QQQ", date(2026, 5, 7), Decimal("530"), ts),
            ("SPY", date(2026, 5, 7), Decimal("722"), ts),
            ("SPY", date(2026, 5, 7), Decimal("723"), ts),
            ("SPY", date(2026, 5, 8), Decimal("722"), ts),
        ]

    @pytest.mark.asyncio
    async def test_flush_sorts_rows_for_deterministic_lock_order(self):
        """Phase 2 of uw-stream-hardening replaced asyncpg.executemany
        (N separate prepared-statement runs) with a single multi-row
        INSERT per chunk. Under multi-row INSERT, Postgres acquires
        row locks in tuple-list order *deterministically* — so the
        pre-flush sort here is now load-bearing for deadlock
        prevention against the REST-side cron writer
        (`/api/cron/fetch-gex-strike-expiry-etfs`).

        If this sort is removed or weakened, the AB-BA deadlock that
        Sentry issues 4G / 4M tracked will resurface immediately the
        first time the cron and the WS handler land on overlapping
        minutes. Failing this test is a hard signal that the deadlock
        contract is broken.
        """
        handler = GexStrikeExpiryHandler()
        ts = datetime(2026, 5, 7, 19, 30, 0, tzinfo=UTC)
        # Strikes deliberately out-of-order; expected order is sorted
        # ascending by strike (under the same ticker / expiry / minute).
        unordered: list[tuple] = [
            ("SPY", date(2026, 5, 7), Decimal("1000"), ts),
            ("SPY", date(2026, 5, 7), Decimal("5000"), ts),
            ("SPY", date(2026, 5, 7), Decimal("2000"), ts),
            ("SPY", date(2026, 5, 7), Decimal("4000"), ts),
        ]
        captured: list[list[tuple]] = []

        def capture(**kwargs):
            captured.append(list(kwargs["rows"]))

        with patch("handlers.gex_strike_expiry.db") as mock_db:
            mock_db.bulk_upsert_replace = AsyncMock(side_effect=capture)
            await handler._flush(unordered)

        assert len(captured) == 1
        assert captured[0] == [
            ("SPY", date(2026, 5, 7), Decimal("1000"), ts),
            ("SPY", date(2026, 5, 7), Decimal("2000"), ts),
            ("SPY", date(2026, 5, 7), Decimal("4000"), ts),
            ("SPY", date(2026, 5, 7), Decimal("5000"), ts),
        ]

    @pytest.mark.asyncio
    async def test_flush_passes_through_table_columns_conflict(self):
        # The sort is the only thing this layer adds; everything else
        # must pass through to db.bulk_upsert_replace untouched so the
        # SQL contract stays intact.
        handler = GexStrikeExpiryHandler()
        ts = datetime(2026, 5, 7, 19, 30, 0, tzinfo=UTC)
        rows: list[tuple] = [("SPY", date(2026, 5, 7), Decimal("722"), ts)]
        with patch("handlers.gex_strike_expiry.db") as mock_db:
            mock_db.bulk_upsert_replace = AsyncMock()
            await handler._flush(rows)
            mock_db.bulk_upsert_replace.assert_awaited_once()
            call_kwargs = mock_db.bulk_upsert_replace.await_args.kwargs
            assert call_kwargs["table"] == "ws_gex_strike_expiry"
            assert call_kwargs["columns"] == _COLUMNS
            assert call_kwargs["conflict_cols"] == [
                "ticker",
                "expiry",
                "strike",
                "ts_minute",
            ]


class TestFlushDeduplicatesByConflictKey:
    """UW pushes sub-second updates within the same minute for the same
    (ticker, expiry, strike). After ``_transform`` truncates to
    ``ts_minute`` those updates collapse onto the same conflict key, so
    a single batch can contain duplicates. ``ON CONFLICT DO UPDATE`` then
    fails with "command cannot affect row a second time" (Sentry 2C/4K).

    Verify ``_flush`` deduplicates by the conflict key before handing the
    batch to ``db.bulk_upsert_replace``, keeping the LAST occurrence to
    match the existing "last write wins per minute" semantics.
    """

    @pytest.mark.asyncio
    async def test_flush_keeps_last_write_for_duplicate_conflict_keys(self):
        handler = GexStrikeExpiryHandler()
        ts = datetime(2026, 5, 7, 19, 30, 0, tzinfo=UTC)
        # Three pushes within the same minute for SPY 720 — the third
        # must be the survivor. The price column (index 4) is the
        # differentiator here; the conflict-key 4-tuple is identical
        # across all three rows.
        first = (
            "SPY",
            date(2026, 5, 7),
            Decimal("720"),
            ts,
            Decimal("562.10"),  # price
        )
        second = (
            "SPY",
            date(2026, 5, 7),
            Decimal("720"),
            ts,
            Decimal("562.30"),
        )
        third = (
            "SPY",
            date(2026, 5, 7),
            Decimal("720"),
            ts,
            Decimal("562.55"),
        )
        captured: list[list[tuple]] = []

        def capture(**kwargs):
            captured.append(list(kwargs["rows"]))

        with patch("handlers.gex_strike_expiry.db") as mock_db:
            mock_db.bulk_upsert_replace = AsyncMock(side_effect=capture)
            await handler._flush([first, second, third])

        assert len(captured) == 1
        # One row out, value carries the LAST write's price.
        assert len(captured[0]) == 1
        assert captured[0][0] == third

    @pytest.mark.asyncio
    async def test_flush_preserves_distinct_conflict_keys(self):
        handler = GexStrikeExpiryHandler()
        ts1 = datetime(2026, 5, 7, 19, 30, 0, tzinfo=UTC)
        ts2 = datetime(2026, 5, 7, 19, 31, 0, tzinfo=UTC)
        rows: list[tuple] = [
            ("SPY", date(2026, 5, 7), Decimal("720"), ts1),
            ("SPY", date(2026, 5, 7), Decimal("721"), ts1),  # diff strike
            ("SPY", date(2026, 5, 7), Decimal("720"), ts2),  # diff minute
            ("QQQ", date(2026, 5, 7), Decimal("720"), ts1),  # diff ticker
        ]
        captured: list[list[tuple]] = []

        def capture(**kwargs):
            captured.append(list(kwargs["rows"]))

        with patch("handlers.gex_strike_expiry.db") as mock_db:
            mock_db.bulk_upsert_replace = AsyncMock(side_effect=capture)
            await handler._flush(rows)

        # Distinct conflict keys → no dedupe, 4 rows out.
        assert len(captured) == 1
        assert len(captured[0]) == 4

    @pytest.mark.asyncio
    async def test_flush_dedup_runs_before_sort(self):
        """The deadlock-prevention sort must apply AFTER the dedupe so
        the lock-acquisition order is deterministic on the actually-
        inserted row set, not the pre-dedupe arrival order."""
        handler = GexStrikeExpiryHandler()
        ts = datetime(2026, 5, 7, 19, 30, 0, tzinfo=UTC)
        # Out-of-order strikes with one in-batch duplicate.
        rows: list[tuple] = [
            ("SPY", date(2026, 5, 7), Decimal("722"), ts),
            ("SPY", date(2026, 5, 7), Decimal("720"), ts),
            ("SPY", date(2026, 5, 7), Decimal("722"), ts),  # dup of strike 722
            ("SPY", date(2026, 5, 7), Decimal("721"), ts),
        ]
        captured: list[list[tuple]] = []

        def capture(**kwargs):
            captured.append(list(kwargs["rows"]))

        with patch("handlers.gex_strike_expiry.db") as mock_db:
            mock_db.bulk_upsert_replace = AsyncMock(side_effect=capture)
            await handler._flush(rows)

        # 3 unique strikes, sorted ascending.
        assert captured[0] == [
            ("SPY", date(2026, 5, 7), Decimal("720"), ts),
            ("SPY", date(2026, 5, 7), Decimal("721"), ts),
            ("SPY", date(2026, 5, 7), Decimal("722"), ts),
        ]

    @pytest.mark.asyncio
    async def test_flush_empty_batch_is_no_op(self):
        handler = GexStrikeExpiryHandler()
        with patch("handlers.gex_strike_expiry.db") as mock_db:
            mock_db.bulk_upsert_replace = AsyncMock(return_value=0)
            await handler._flush([])
            # An empty batch should still go through (db layer handles
            # the no-op), so we don't shortcut the call.
            mock_db.bulk_upsert_replace.assert_awaited_once()
            assert mock_db.bulk_upsert_replace.await_args.kwargs["rows"] == []


class TestExpiryNotTodayFilter:
    """0DTE-only ingest filter — see retention spec
    docs/superpowers/specs/greek-heatmap-ws-retention-2026-05-15.md.

    UW pushes every active expiry on `gex_strike_expiry:<TICKER>`; we
    only consume today's 0DTE in production, so the handler drops
    payloads whose expiry doesn't match the current ET trading date.
    Without this filter the table accumulates rows for each future
    expiry every minute it stays on UW's emit list, which (verified
    2026-05-15) inflates the SPY/0DTE slice 8-9x and pushes the
    Greek Heatmap snapshot query to ~18 seconds.
    """

    def test_today_expiry_admitted(self, handler, payload, monkeypatch):
        monkeypatch.setattr("handlers.gex_strike_expiry._today_et", lambda: date(2026, 5, 1))
        # Fixture expiry == 2026-05-01; same as pinned today → admitted.
        row = handler._transform(payload)
        assert row is not None

    def test_future_expiry_rejected(self, handler, payload, monkeypatch):
        monkeypatch.setattr("handlers.gex_strike_expiry._today_et", lambda: date(2026, 4, 28))
        # Today is 2026-04-28; fixture expiry 2026-05-01 is a future
        # expiry that UW is already emitting — must be dropped.
        assert handler._transform(payload) is None

    def test_past_expiry_rejected(self, handler, payload, monkeypatch):
        monkeypatch.setattr("handlers.gex_strike_expiry._today_et", lambda: date(2026, 5, 2))
        # Today is 2026-05-02; fixture expiry 2026-05-01 is in the
        # past. UW shouldn't normally emit these on a per-ticker
        # channel, but a late-arriving payload at the day boundary
        # must still be rejected — never admit non-0DTE rows.
        assert handler._transform(payload) is None

    def test_today_anchored_to_eastern_time_not_utc(self, monkeypatch):
        """At 22:00 ET on May 1 (= 02:00 UTC on May 2), today_et must
        still resolve to May 1. The daemon runs on Railway with a
        UTC clock, so naively calling `datetime.utcnow().date()` would
        incorrectly flip to May 2 between 19:00 and 23:59 ET — opening
        a four-hour window each evening where the next day's 0DTE
        payloads would be admitted while today's would be rejected.
        """
        from datetime import datetime as real_datetime

        from handlers import gex_strike_expiry as mod

        class FakeDatetime(real_datetime):
            @classmethod
            def now(cls, tz=None):
                # 02:00 UTC on May 2 = 22:00 ET on May 1.
                base = real_datetime(2026, 5, 2, 2, 0, 0, tzinfo=UTC)
                return base.astimezone(tz) if tz is not None else base

        monkeypatch.setattr(mod, "datetime", FakeDatetime)
        assert mod._today_et() == date(2026, 5, 1)


@pytest.fixture
def clean_handler_state():
    """Zero every handler's counters so ``filtered`` and ``drop_count`` start at 0."""
    state.handlers.clear()
    yield
    state.handlers.clear()


_ABSENT = object()  # a payload with no ``expiry`` key at all


def _metrics():
    return state.handler("gex_strike_expiry")


@pytest.mark.usefixtures("clean_handler_state")
class TestEnqueueFilter:
    """Other-expiry frames are discarded before the queue.

    UW pushes every active expiry on ``gex_strike_expiry:<TICKER>``, about
    85% of them not today's. Rejecting them in ``_transform`` meant they sat
    in the 50,000-slot queue first, and a burst overflowed it. ``enqueue``
    now drops them up front and counts them in ``filtered``, never in
    ``drop_count``: they are not backpressure.
    """

    @pytest.mark.asyncio
    async def test_non_today_expiry_is_not_queued_and_counted(self, handler, payload):
        payload["expiry"] = "2026-05-08"

        await handler.enqueue(payload)

        assert handler.queue.qsize() == 0
        assert _metrics().filtered == 1
        assert _metrics().drop_count == 0
        assert _metrics().queue_depth == 0

    @pytest.mark.asyncio
    async def test_past_expiry_is_filtered_too(self, handler, payload):
        payload["expiry"] = "2026-04-30"

        await handler.enqueue(payload)

        assert handler.queue.qsize() == 0
        assert _metrics().filtered == 1

    @pytest.mark.asyncio
    async def test_today_expiry_is_queued(self, handler, payload):
        assert payload["expiry"] == _FIXTURE_EXPIRY.isoformat()

        await handler.enqueue(payload)

        assert handler.queue.qsize() == 1
        assert handler.queue.get_nowait() is payload
        assert _metrics().filtered == 0

    @pytest.mark.asyncio
    async def test_other_iso_spelling_of_today_is_queued(self, handler, payload):
        payload["expiry"] = "20260501"  # basic ISO 8601 form, parses to today

        await handler.enqueue(payload)

        assert handler.queue.qsize() == 1
        assert _metrics().filtered == 0

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "bad",
        [_ABSENT, "not-a-date", "", None, 20260501, ["2026-05-01"]],
        ids=["missing", "garbage", "empty", "null", "number", "list"],
    )
    async def test_missing_or_garbage_expiry_is_queued_and_transform_logs_it(
        self, handler, payload, bad
    ):
        """An expiry the filter cannot read is not its call: it goes to the
        queue and ``_transform`` rejects it with the same warning as before.
        """
        if bad is _ABSENT:
            del payload["expiry"]
        else:
            payload["expiry"] = bad

        with patch.object(gex_mod, "rate_limited_log", MagicMock()) as log_mock:
            await handler.enqueue(payload)
            assert handler.queue.qsize() == 1
            assert _metrics().filtered == 0
            assert handler._transform(handler.queue.get_nowait()) is None

        log_mock.warning.assert_called_once()
        assert log_mock.warning.call_args.kwargs["kind"] == "missing_expiry"

    @pytest.mark.asyncio
    async def test_frame_queued_before_midnight_is_still_rejected_by_transform(
        self, handler, payload, monkeypatch
    ):
        """The enqueue check is a cache of ``_today_et``, not the last word:
        a frame that was today's when it was queued but is not when it comes
        off the queue (ET midnight in between) is caught by ``_transform``.
        """
        await handler.enqueue(payload)
        assert handler.queue.qsize() == 1

        monkeypatch.setattr(gex_mod, "_today_et", lambda: date(2026, 5, 2))
        with patch.object(gex_mod, "rate_limited_log", MagicMock()) as log_mock:
            assert handler._transform(handler.queue.get_nowait()) is None

        assert log_mock.warning.call_args.kwargs["kind"] == "expiry_not_today"

    @pytest.mark.asyncio
    async def test_burst_of_other_expiry_frames_does_not_overflow_the_queue(
        self, payload, monkeypatch
    ):
        """60,000 non-today frames into a 50,000-slot queue: the old path
        queued 50,000 and evicted 10,000 (``drop_count`` 10,000). Now none is
        queued and none is dropped.
        """
        monkeypatch.setattr(settings, "ws_queue_size", 50_000)
        monkeypatch.setattr(settings, "ws_backpressure_policy", "drop_oldest")
        handler = GexStrikeExpiryHandler()
        assert handler.queue.maxsize == 50_000
        payload["expiry"] = "2026-05-08"

        for _ in range(60_000):
            await handler.enqueue(payload)

        assert handler.queue.qsize() == 0
        assert _metrics().drop_count == 0
        assert _metrics().queue_depth == 0
        assert _metrics().filtered == 60_000


@pytest.mark.usefixtures("clean_handler_state")
class TestTodayDateCache:
    """``enqueue`` compares against a cached ISO string, refreshed from
    ``_today_et`` at most once per second on the monotonic clock. The clock
    is faked at the module boundary (``handlers.gex_strike_expiry.monotonic``,
    which asyncio's loop does not read).
    """

    @pytest.fixture
    def clock(self, monkeypatch) -> list[float]:
        now = [1000.0]
        monkeypatch.setattr(gex_mod, "monotonic", lambda: now[0])
        return now

    @pytest.fixture
    def today(self, monkeypatch) -> list:
        """Mutable "today" plus a call log, standing in for ``_today_et``."""
        current = [date(2026, 5, 1)]
        calls: list[date] = []

        def fake_today_et() -> date:
            calls.append(current[0])
            return current[0]

        monkeypatch.setattr(gex_mod, "_today_et", fake_today_et)
        return [current, calls]

    @staticmethod
    def _frame(expiry: str) -> dict:
        return {"ticker": "SPY", "expiry": expiry}

    @pytest.mark.asyncio
    async def test_date_is_cached_for_a_second_then_refreshed(self, clock, today):
        current, calls = today
        handler = GexStrikeExpiryHandler()

        await handler.enqueue(self._frame("2026-05-01"))
        assert handler.queue.qsize() == 1
        assert len(calls) == 1

        # ET midnight passes, but inside the one-second window the cache holds.
        current[0] = date(2026, 5, 2)
        clock[0] += 0.9
        await handler.enqueue(self._frame("2026-05-01"))
        await handler.enqueue(self._frame("2026-05-02"))
        assert len(calls) == 1
        assert handler.queue.qsize() == 2  # old date still admitted, new one filtered
        assert _metrics().filtered == 1

        # A full second after the first read, the cache refreshes.
        clock[0] += 0.1
        await handler.enqueue(self._frame("2026-05-01"))
        await handler.enqueue(self._frame("2026-05-02"))
        assert len(calls) == 2
        assert handler.queue.qsize() == 3  # 05-01 now filtered, 05-02 admitted
        assert _metrics().filtered == 2

    @pytest.mark.asyncio
    async def test_hot_path_reads_the_date_once_per_window_not_per_frame(self, clock, today):
        _, calls = today
        handler = GexStrikeExpiryHandler()

        for _ in range(1_000):
            await handler.enqueue(self._frame("2026-05-08"))

        assert len(calls) == 1
        assert _metrics().filtered == 1_000

    @pytest.mark.asyncio
    async def test_first_frame_reads_the_date_before_trusting_the_cache(self, clock, today):
        """A fresh handler must not trust a cache it never filled, whatever the
        monotonic clock reads (it counts from an arbitrary point, often boot).
        """
        _, calls = today
        clock[0] = 0.2
        handler = GexStrikeExpiryHandler()

        await handler.enqueue(self._frame("2026-05-08"))

        assert len(calls) == 1
        assert _metrics().filtered == 1
