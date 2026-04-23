"""Tests for sidecar/src/quote_processor.py.

Mock strategy mirrors test_trade_processor.py:
- conftest.py provides session-wide mocks for `databento`, `psycopg2`,
  `sentry_sdk` that aren't in the local test venv.
- quote_processor.py is imported normally. Its
  `from db import batch_insert_top_of_book, batch_insert_trade_ticks`
  resolves once at import time; we monkeypatch those already-resolved
  bindings on the `quote_processor` module per-test.
- No module-level sys.modules clobbering.

Scope note: we only subscribe to the ``tbbo`` schema (not ``mbp-1``) —
see the module docstring for the rationale. There is therefore only one
public ingest path, ``process_tbbo``, which extracts BOTH a top-of-book
snapshot AND a trade tick from each record.
"""

from __future__ import annotations

import os
import threading
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

# Required env vars for config.py's pydantic-settings validation.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402

import quote_processor  # noqa: E402
from quote_processor import (  # noqa: E402
    BATCH_SIZE,
    QuoteProcessor,
    TopOfBookRow,
    TradeTickRow,
    classify_aggressor,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_tob_insert(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    mock = MagicMock()
    monkeypatch.setattr(quote_processor, "batch_insert_top_of_book", mock)
    return mock


@pytest.fixture()
def mock_trade_insert(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    mock = MagicMock()
    monkeypatch.setattr(quote_processor, "batch_insert_trade_ticks", mock)
    return mock


@pytest.fixture()
def processor() -> QuoteProcessor:
    return QuoteProcessor()


# Databento encodes price as int64 with 1e-9 scale. ``5_000_000_000_000``
# decodes to $5000.00 — a realistic-looking ES price for the tests.
SAMPLE_TS_NS = 1_780_000_000_000_000_000
SAMPLE_BID_RAW = 4_999_500_000_000  # $4999.50
SAMPLE_ASK_RAW = 5_000_500_000_000  # $5000.50
SAMPLE_BID_SZ = 10
SAMPLE_ASK_SZ = 12


def _tbbo_record(
    *,
    trade_price_raw: int = SAMPLE_ASK_RAW,
    size: int = 5,
    ts_ns: int = SAMPLE_TS_NS,
    bid_px: int = SAMPLE_BID_RAW,
    ask_px: int = SAMPLE_ASK_RAW,
    bid_sz: int = SAMPLE_BID_SZ,
    ask_sz: int = SAMPLE_ASK_SZ,
) -> SimpleNamespace:
    """Build a fake TBBO record (MBP1Msg shape).

    Each TBBO record is a trade — ``price`` / ``size`` / ``ts_event`` on
    the record, pre-trade BBO carried in ``levels[0]``.
    """
    level = SimpleNamespace(
        bid_px=bid_px,
        ask_px=ask_px,
        bid_sz=bid_sz,
        ask_sz=ask_sz,
    )
    return SimpleNamespace(
        ts_event=ts_ns,
        price=trade_price_raw,
        size=size,
        levels=(level,),
    )


# ---------------------------------------------------------------------------
# classify_aggressor — B/S/N edge cases (pure function, independent of
# record shape and subscription topology — still valid post-rework).
# ---------------------------------------------------------------------------


class TestClassifyAggressor:
    def test_trade_at_ask_is_buyer_initiated(self) -> None:
        assert (
            classify_aggressor(
                Decimal("5000.50"), Decimal("5000.00"), Decimal("5000.50")
            )
            == "B"
        )

    def test_trade_above_ask_is_buyer_initiated(self) -> None:
        assert (
            classify_aggressor(
                Decimal("5001.00"), Decimal("5000.00"), Decimal("5000.50")
            )
            == "B"
        )

    def test_trade_at_bid_is_seller_initiated(self) -> None:
        assert (
            classify_aggressor(
                Decimal("5000.00"), Decimal("5000.00"), Decimal("5000.50")
            )
            == "S"
        )

    def test_trade_below_bid_is_seller_initiated(self) -> None:
        assert (
            classify_aggressor(
                Decimal("4999.50"), Decimal("5000.00"), Decimal("5000.50")
            )
            == "S"
        )

    def test_trade_mid_spread_is_unclassifiable(self) -> None:
        assert (
            classify_aggressor(
                Decimal("5000.25"), Decimal("5000.00"), Decimal("5000.50")
            )
            == "N"
        )

    def test_crossed_book_uses_ask_first(self) -> None:
        """When bid > ask (crossed/locked), we still classify by ask first.

        The `>= ask` check wins on trade == bid == ask. Rare edge case —
        pinning this explicitly so a refactor doesn't silently flip it.
        """
        assert (
            classify_aggressor(
                Decimal("5000.00"), Decimal("5000.00"), Decimal("5000.00")
            )
            == "B"
        )


# ---------------------------------------------------------------------------
# process_tbbo — single record produces BOTH a top-of-book row AND a
# trade tick row. No separate mbp-1 path exists.
# ---------------------------------------------------------------------------


class TestProcessTbboDualWrite:
    def test_single_record_buffers_both_rows(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """A single TBBO record must appear in BOTH buffers — this is the
        core invariant of the TBBO-only subscription design (the quote
        snapshot and the trade tick are derived from the same record)."""
        processor.process_tbbo("ES", _tbbo_record())
        processor.flush()
        mock_tob_insert.assert_called_once()
        mock_trade_insert.assert_called_once()

    def test_tob_row_shape(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,  # noqa: ARG002 — fixture suppresses real write
    ) -> None:
        processor.process_tbbo("ES", _tbbo_record())
        processor.flush()
        rows = mock_tob_insert.call_args[0][0]
        symbol, ts, bid, bid_sz, ask, ask_sz = rows[0]
        assert symbol == "ES"
        assert ts.tzinfo == timezone.utc
        assert ts == datetime.fromtimestamp(SAMPLE_TS_NS / 1e9, tz=timezone.utc)
        assert bid == Decimal("4999.5")
        assert bid_sz == SAMPLE_BID_SZ
        assert ask == Decimal("5000.5")
        assert ask_sz == SAMPLE_ASK_SZ

    def test_trade_row_shape_buyer_aggressor(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,  # noqa: ARG002
        mock_trade_insert: MagicMock,
    ) -> None:
        """Trade at ask with bid 4999.50, ask 5000.50 → aggressor 'B'."""
        processor.process_tbbo(
            "ES", _tbbo_record(trade_price_raw=SAMPLE_ASK_RAW, size=42)
        )
        processor.flush()
        rows = mock_trade_insert.call_args[0][0]
        symbol, ts, price, size, agg = rows[0]
        assert symbol == "ES"
        assert ts.tzinfo == timezone.utc
        assert price == Decimal("5000.5")
        assert size == 42
        assert agg == "B"

    def test_seller_aggressor_at_bid(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,  # noqa: ARG002
        mock_trade_insert: MagicMock,
    ) -> None:
        processor.process_tbbo("ES", _tbbo_record(trade_price_raw=SAMPLE_BID_RAW))
        processor.flush()
        rows = mock_trade_insert.call_args[0][0]
        assert rows[0][4] == "S"

    def test_mid_spread_trade_is_none(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,  # noqa: ARG002
        mock_trade_insert: MagicMock,
    ) -> None:
        mid_raw = (SAMPLE_BID_RAW + SAMPLE_ASK_RAW) // 2
        processor.process_tbbo("ES", _tbbo_record(trade_price_raw=mid_raw))
        processor.flush()
        assert mock_trade_insert.call_args[0][0][0][4] == "N"

    def test_missing_levels_skips_both_rows(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """Without a pre-trade book level, both parsers must skip — we
        have no quote to record AND no way to classify the aggressor."""
        rec = SimpleNamespace(
            ts_event=SAMPLE_TS_NS,
            price=SAMPLE_ASK_RAW,
            size=3,
            levels=(),
        )
        processor.process_tbbo("ES", rec)
        processor.flush()
        mock_tob_insert.assert_not_called()
        mock_trade_insert.assert_not_called()

    def test_missing_trade_price_skips_only_trade(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """A record with a valid pre-trade book but missing trade
        ``price`` yields a TOB row but no trade row — the book snapshot
        is still meaningful on its own."""
        rec = _tbbo_record()
        rec.price = None  # type: ignore[attr-defined]
        processor.process_tbbo("ES", rec)
        processor.flush()
        mock_tob_insert.assert_called_once()
        mock_trade_insert.assert_not_called()

    def test_missing_bid_field_skips_both(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """When a BBO field is None, both parsers bail out — we can't
        record the quote and we can't classify the aggressor either."""
        rec = _tbbo_record()
        rec.levels[0].bid_px = None  # type: ignore[attr-defined]
        processor.process_tbbo("ES", rec)
        processor.flush()
        mock_tob_insert.assert_not_called()
        mock_trade_insert.assert_not_called()

    def test_undef_price_sentinel_skips_both(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """Databento sends INT64_MAX (UNDEF_PRICE = 9_223_372_036_854_775_807)
        for missing prices rather than None — our early check has to treat
        that sentinel exactly like None, otherwise the Decimal(sentinel) /
        1e9 = ~9.22e9 overflows NUMERIC(12,4) and Neon raises
        NumericValueOutOfRange. Regression from quote_processor ingest
        on 2026-04-23."""
        from quote_processor import UNDEF_PRICE

        rec = _tbbo_record()
        rec.levels[0].ask_px = UNDEF_PRICE  # type: ignore[attr-defined]
        processor.process_tbbo("ES", rec)
        processor.flush()
        mock_tob_insert.assert_not_called()
        mock_trade_insert.assert_not_called()

    def test_malformed_price_skips_both(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """Non-numeric bid_px logs-skips rather than crashing the stream.

        Both TOB and trade-tick parsing reach the Decimal conversion
        for bid_px, so a malformed price skips both rows.
        """
        rec = _tbbo_record()
        rec.levels[0].bid_px = "not-a-number"  # type: ignore[attr-defined]
        processor.process_tbbo("ES", rec)
        processor.flush()
        mock_tob_insert.assert_not_called()
        mock_trade_insert.assert_not_called()


# ---------------------------------------------------------------------------
# Buffer / flush semantics — asserts each TBBO record contributes one
# row to each buffer, flush cadence matches BATCH_SIZE, and flush runs
# the DB write OUTSIDE the lock.
# ---------------------------------------------------------------------------


class TestBufferFlush:
    def test_no_flush_before_batch_size(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        for _ in range(BATCH_SIZE - 1):
            processor.process_tbbo("ES", _tbbo_record())
        mock_tob_insert.assert_not_called()
        mock_trade_insert.assert_not_called()

    def test_auto_flush_at_batch_size(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """Since each record appends to BOTH buffers, both flush on the
        same call once ``BATCH_SIZE`` records have been processed."""
        for _ in range(BATCH_SIZE):
            processor.process_tbbo("ES", _tbbo_record())
        mock_tob_insert.assert_called_once()
        mock_trade_insert.assert_called_once()
        assert len(mock_tob_insert.call_args[0][0]) == BATCH_SIZE
        assert len(mock_trade_insert.call_args[0][0]) == BATCH_SIZE

    def test_force_flush_sends_remaining(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        for _ in range(10):
            processor.process_tbbo("ES", _tbbo_record())
        mock_tob_insert.assert_not_called()
        mock_trade_insert.assert_not_called()

        processor.flush()
        assert len(mock_tob_insert.call_args[0][0]) == 10
        assert len(mock_trade_insert.call_args[0][0]) == 10

    def test_flush_empty_is_noop(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        processor.flush()
        mock_tob_insert.assert_not_called()
        mock_trade_insert.assert_not_called()

    def test_buffers_clear_after_flush(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """A second flush without new events must not re-insert prior rows."""
        processor.process_tbbo("ES", _tbbo_record())
        processor.flush()
        assert mock_tob_insert.call_count == 1
        assert mock_trade_insert.call_count == 1
        processor.flush()
        assert mock_tob_insert.call_count == 1
        assert mock_trade_insert.call_count == 1


# ---------------------------------------------------------------------------
# Flush happens OUTSIDE the lock — critical for TBBO throughput. At ES
# trading volumes we cannot serialize every callback behind a single
# Neon round trip.
# ---------------------------------------------------------------------------


class TestFlushOutsideLock:
    def test_auto_flush_releases_lock_before_db_write(
        self,
        processor: QuoteProcessor,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When the BATCH_SIZE threshold triggers an auto-flush inside
        process_tbbo, the DB write must run after self._lock has been
        released. We assert this by recording the lock state from inside
        the mocked DB writers."""

        observed_tob_locked: list[bool] = []
        observed_trade_locked: list[bool] = []

        def fake_tob_writer(rows: list[tuple]) -> None:  # noqa: ARG001
            observed_tob_locked.append(processor._lock.locked())

        def fake_trade_writer(rows: list[tuple]) -> None:  # noqa: ARG001
            observed_trade_locked.append(processor._lock.locked())

        monkeypatch.setattr(
            quote_processor, "batch_insert_top_of_book", fake_tob_writer
        )
        monkeypatch.setattr(
            quote_processor, "batch_insert_trade_ticks", fake_trade_writer
        )

        for _ in range(BATCH_SIZE):
            processor.process_tbbo("ES", _tbbo_record())

        assert observed_tob_locked == [False]
        assert observed_trade_locked == [False]

    def test_manual_flush_releases_lock_before_db_write(
        self,
        processor: QuoteProcessor,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        observed_tob_locked: list[bool] = []
        observed_trade_locked: list[bool] = []

        def fake_tob_writer(rows: list[tuple]) -> None:  # noqa: ARG001
            observed_tob_locked.append(processor._lock.locked())

        def fake_trade_writer(rows: list[tuple]) -> None:  # noqa: ARG001
            observed_trade_locked.append(processor._lock.locked())

        monkeypatch.setattr(
            quote_processor, "batch_insert_top_of_book", fake_tob_writer
        )
        monkeypatch.setattr(
            quote_processor, "batch_insert_trade_ticks", fake_trade_writer
        )

        # Half a batch — flush will run through the manual path.
        for _ in range(5):
            processor.process_tbbo("ES", _tbbo_record())
        processor.flush()

        assert observed_tob_locked == [False]
        assert observed_trade_locked == [False]

    def test_concurrent_callbacks_dont_deadlock_during_flush(
        self,
        processor: QuoteProcessor,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A slow DB write during an auto-flush must NOT block concurrent
        callbacks from making progress. Validates that the lock is
        released before the network round-trip rather than held through
        it. Without the fix, the second thread would block on acquiring
        the lock until the 0.2s sleep finishes."""

        import time as real_time

        def slow_tob_writer(rows: list[tuple]) -> None:  # noqa: ARG001
            real_time.sleep(0.2)

        monkeypatch.setattr(
            quote_processor, "batch_insert_top_of_book", slow_tob_writer
        )
        monkeypatch.setattr(quote_processor, "batch_insert_trade_ticks", MagicMock())

        # Fill the buffer to BATCH_SIZE - 1 so the next call triggers
        # auto-flush in the main thread.
        for _ in range(BATCH_SIZE - 1):
            processor.process_tbbo("ES", _tbbo_record())

        flusher_started_at: list[float] = []
        second_returned_at: list[float] = []

        def flusher() -> None:
            flusher_started_at.append(real_time.monotonic())
            # This call crosses BATCH_SIZE → slow DB write happens here.
            processor.process_tbbo("ES", _tbbo_record())

        def second() -> None:
            # Wait until the flusher has entered; then issue another
            # callback and record how long it takes to return.
            while not flusher_started_at:
                real_time.sleep(0.005)
            # Small delay to ensure flusher has reached the DB write.
            real_time.sleep(0.02)
            start = real_time.monotonic()
            processor.process_tbbo("ES", _tbbo_record())
            second_returned_at.append(real_time.monotonic() - start)

        t1 = threading.Thread(target=flusher)
        t2 = threading.Thread(target=second)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # The second callback must return well before 0.2s — the slow
        # DB write in thread 1 is OUTSIDE the lock, so thread 2 only
        # contends briefly for the buffer-swap critical section.
        assert second_returned_at, "second thread never completed"
        assert second_returned_at[0] < 0.15, (
            f"second callback took {second_returned_at[0]:.3f}s — lock "
            f"is probably held through the DB write"
        )


# ---------------------------------------------------------------------------
# Row dataclass shape
# ---------------------------------------------------------------------------


class TestMultiSymbolProcessing:
    """Phase 5a: the QuoteProcessor must treat every subscribed symbol
    identically. ES and NQ records interleaved in the same batch are
    written with their correct ``symbol`` values into the shared
    ``futures_trade_ticks`` + ``futures_top_of_book`` tables. The
    writers were always symbol-agnostic; this test pins that invariant
    down against future refactors that might accidentally hard-code ES.
    """

    def test_nq_record_is_processed(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """A single NQ record flows through the same writers with
        symbol='NQ' attached. Phase 5a widens the pipeline — the
        Phase 2a 'non-ES drop' behavior was an explicit scope guard
        in databento_client._handle_tbbo, not a QuoteProcessor concern."""
        processor.process_tbbo("NQ", _tbbo_record())
        processor.flush()
        mock_tob_insert.assert_called_once()
        mock_trade_insert.assert_called_once()
        tob_rows = mock_tob_insert.call_args[0][0]
        trade_rows = mock_trade_insert.call_args[0][0]
        assert tob_rows[0][0] == "NQ"
        assert trade_rows[0][0] == "NQ"

    def test_mixed_es_and_nq_batch_preserves_symbols(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """Mixed ES + NQ records in a single flush batch must carry
        their symbol through to both writers. Verifies that neither
        buffer conflates the two — Phase 5a's dual-symbol context
        depends on per-symbol row accounting in the underlying tables.
        """
        processor.process_tbbo("ES", _tbbo_record())
        processor.process_tbbo("NQ", _tbbo_record())
        processor.process_tbbo("ES", _tbbo_record())
        processor.flush()

        tob_rows = mock_tob_insert.call_args[0][0]
        trade_rows = mock_trade_insert.call_args[0][0]
        tob_symbols = [r[0] for r in tob_rows]
        trade_symbols = [r[0] for r in trade_rows]
        assert tob_symbols == ["ES", "NQ", "ES"]
        assert trade_symbols == ["ES", "NQ", "ES"]


class TestRowDataclasses:
    def test_top_of_book_row_fields(self) -> None:
        row = TopOfBookRow(
            symbol="ES",
            ts=datetime.now(tz=timezone.utc),
            bid=Decimal("5000"),
            bid_size=1,
            ask=Decimal("5001"),
            ask_size=2,
        )
        assert row.symbol == "ES"

    def test_trade_tick_row_fields(self) -> None:
        row = TradeTickRow(
            symbol="ES",
            ts=datetime.now(tz=timezone.utc),
            price=Decimal("5000"),
            size=1,
            aggressor_side="B",
        )
        assert row.aggressor_side == "B"
