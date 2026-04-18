"""Tests for sidecar/src/quote_processor.py.

Mock strategy mirrors test_trade_processor.py:
- conftest.py provides session-wide mocks for `databento`, `psycopg2`,
  `sentry_sdk` that aren't in the local test venv.
- quote_processor.py is imported normally. Its
  `from db import batch_insert_top_of_book, batch_insert_trade_ticks`
  resolves once at import time; we monkeypatch those already-resolved
  bindings on the `quote_processor` module per-test.
- No module-level sys.modules clobbering.
"""

from __future__ import annotations

import os
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


def _mbp1_record(
    *,
    ts_ns: int = SAMPLE_TS_NS,
    bid_px: int = SAMPLE_BID_RAW,
    ask_px: int = SAMPLE_ASK_RAW,
    bid_sz: int = SAMPLE_BID_SZ,
    ask_sz: int = SAMPLE_ASK_SZ,
) -> SimpleNamespace:
    """Build a fake MBP1Msg-like record. Only the fields quote_processor
    reads need to exist; everything else is absent so getattr returns None
    and we'd exercise the defensive paths."""
    level = SimpleNamespace(
        bid_px=bid_px,
        ask_px=ask_px,
        bid_sz=bid_sz,
        ask_sz=ask_sz,
    )
    return SimpleNamespace(
        ts_event=ts_ns,
        levels=(level,),
    )


def _tbbo_record(
    *,
    trade_price_raw: int,
    size: int = 5,
    ts_ns: int = SAMPLE_TS_NS,
    bid_px: int = SAMPLE_BID_RAW,
    ask_px: int = SAMPLE_ASK_RAW,
) -> SimpleNamespace:
    """Build a fake TBBO record: MBP1Msg with action='T' plus a trade."""
    level = SimpleNamespace(
        bid_px=bid_px,
        ask_px=ask_px,
        bid_sz=SAMPLE_BID_SZ,
        ask_sz=SAMPLE_ASK_SZ,
    )
    return SimpleNamespace(
        ts_event=ts_ns,
        price=trade_price_raw,
        size=size,
        levels=(level,),
    )


# ---------------------------------------------------------------------------
# classify_aggressor — B/S/N edge cases
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
# process_mbp1 — TopOfBookRow extraction
# ---------------------------------------------------------------------------


class TestProcessMbp1:
    def test_decodes_bid_ask_prices(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        """Databento int64 1e-9 units become Decimal in-database units."""
        processor.process_mbp1("ES", _mbp1_record())
        processor.flush()

        rows = mock_tob_insert.call_args[0][0]
        assert rows[0][0] == "ES"  # symbol
        assert rows[0][2] == Decimal("4999.5")  # bid
        assert rows[0][4] == Decimal("5000.5")  # ask

    def test_preserves_integer_sizes(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        processor.process_mbp1("ES", _mbp1_record(bid_sz=77, ask_sz=99))
        processor.flush()
        rows = mock_tob_insert.call_args[0][0]
        assert rows[0][3] == 77  # bid_size
        assert rows[0][5] == 99  # ask_size

    def test_converts_ns_timestamp_to_utc(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        processor.process_mbp1("ES", _mbp1_record())
        processor.flush()
        rows = mock_tob_insert.call_args[0][0]
        ts: datetime = rows[0][1]
        assert ts.tzinfo == timezone.utc
        assert ts == datetime.fromtimestamp(SAMPLE_TS_NS / 1e9, tz=timezone.utc)

    def test_missing_levels_is_skipped(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        rec = SimpleNamespace(ts_event=SAMPLE_TS_NS, levels=())
        processor.process_mbp1("ES", rec)
        processor.flush()
        mock_tob_insert.assert_not_called()

    def test_missing_bid_field_is_skipped(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        """None in a required field must skip the row, not crash."""
        rec = _mbp1_record()
        rec.levels[0].bid_px = None  # type: ignore[attr-defined]
        processor.process_mbp1("ES", rec)
        processor.flush()
        mock_tob_insert.assert_not_called()

    def test_malformed_price_is_skipped(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        """Non-numeric ``bid_px`` should log-skip rather than crash."""
        rec = _mbp1_record()
        rec.levels[0].bid_px = "not-a-number"  # type: ignore[attr-defined]
        processor.process_mbp1("ES", rec)
        processor.flush()
        mock_tob_insert.assert_not_called()


# ---------------------------------------------------------------------------
# process_tbbo — TradeTickRow + aggressor derivation
# ---------------------------------------------------------------------------


class TestProcessTbbo:
    def test_buyer_aggressor_at_ask(
        self, processor: QuoteProcessor, mock_trade_insert: MagicMock
    ) -> None:
        # trade at ask (5000.50) with bid 4999.50, ask 5000.50 → 'B'
        processor.process_tbbo("ES", _tbbo_record(trade_price_raw=SAMPLE_ASK_RAW))
        processor.flush()
        rows = mock_trade_insert.call_args[0][0]
        assert rows[0][4] == "B"  # aggressor_side

    def test_seller_aggressor_at_bid(
        self, processor: QuoteProcessor, mock_trade_insert: MagicMock
    ) -> None:
        processor.process_tbbo("ES", _tbbo_record(trade_price_raw=SAMPLE_BID_RAW))
        processor.flush()
        rows = mock_trade_insert.call_args[0][0]
        assert rows[0][4] == "S"

    def test_mid_spread_trade_is_none(
        self, processor: QuoteProcessor, mock_trade_insert: MagicMock
    ) -> None:
        mid_raw = (SAMPLE_BID_RAW + SAMPLE_ASK_RAW) // 2
        processor.process_tbbo("ES", _tbbo_record(trade_price_raw=mid_raw))
        processor.flush()
        rows = mock_trade_insert.call_args[0][0]
        assert rows[0][4] == "N"

    def test_trade_row_shape(
        self, processor: QuoteProcessor, mock_trade_insert: MagicMock
    ) -> None:
        """Row tuple order must match the INSERT column order in db.py."""
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

    def test_missing_levels_is_skipped(
        self, processor: QuoteProcessor, mock_trade_insert: MagicMock
    ) -> None:
        rec = SimpleNamespace(
            ts_event=SAMPLE_TS_NS,
            price=SAMPLE_ASK_RAW,
            size=3,
            levels=(),
        )
        processor.process_tbbo("ES", rec)
        processor.flush()
        mock_trade_insert.assert_not_called()

    def test_missing_trade_price_is_skipped(
        self, processor: QuoteProcessor, mock_trade_insert: MagicMock
    ) -> None:
        rec = _tbbo_record(trade_price_raw=SAMPLE_ASK_RAW)
        rec.price = None  # type: ignore[attr-defined]
        processor.process_tbbo("ES", rec)
        processor.flush()
        mock_trade_insert.assert_not_called()


# ---------------------------------------------------------------------------
# Buffer / flush semantics
# ---------------------------------------------------------------------------


class TestBufferFlush:
    def test_no_tob_flush_before_batch_size(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        for _ in range(BATCH_SIZE - 1):
            processor.process_mbp1("ES", _mbp1_record())
        mock_tob_insert.assert_not_called()

    def test_auto_tob_flush_at_batch_size(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        for _ in range(BATCH_SIZE):
            processor.process_mbp1("ES", _mbp1_record())
        mock_tob_insert.assert_called_once()
        rows = mock_tob_insert.call_args[0][0]
        assert len(rows) == BATCH_SIZE

    def test_auto_trade_flush_at_batch_size(
        self, processor: QuoteProcessor, mock_trade_insert: MagicMock
    ) -> None:
        for _ in range(BATCH_SIZE):
            processor.process_tbbo("ES", _tbbo_record(trade_price_raw=SAMPLE_ASK_RAW))
        mock_trade_insert.assert_called_once()
        rows = mock_trade_insert.call_args[0][0]
        assert len(rows) == BATCH_SIZE

    def test_force_flush_sends_remaining_tob(
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        for _ in range(10):
            processor.process_mbp1("ES", _mbp1_record())
        mock_tob_insert.assert_not_called()
        processor.flush()
        mock_tob_insert.assert_called_once()
        assert len(mock_tob_insert.call_args[0][0]) == 10

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
        self, processor: QuoteProcessor, mock_tob_insert: MagicMock
    ) -> None:
        """A second flush without new events should not re-insert prior rows."""
        processor.process_mbp1("ES", _mbp1_record())
        processor.flush()
        assert mock_tob_insert.call_count == 1
        processor.flush()
        assert mock_tob_insert.call_count == 1

    def test_tob_and_trade_buffers_are_independent(
        self,
        processor: QuoteProcessor,
        mock_tob_insert: MagicMock,
        mock_trade_insert: MagicMock,
    ) -> None:
        """Trade buffer filling must not flush the quote buffer (or vice versa)."""
        for _ in range(10):
            processor.process_mbp1("ES", _mbp1_record())
        for _ in range(BATCH_SIZE):
            processor.process_tbbo("ES", _tbbo_record(trade_price_raw=SAMPLE_ASK_RAW))
        mock_trade_insert.assert_called_once()
        mock_tob_insert.assert_not_called()


# ---------------------------------------------------------------------------
# Row dataclass shape
# ---------------------------------------------------------------------------


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
