"""Tests for sidecar/src/trade_processor.py."""

from __future__ import annotations

import sys
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

# Mock external modules before importing trade_processor.
# The db module requires psycopg2 and a live database connection;
# logger_setup similarly has side effects we want to avoid in tests.
mock_db = MagicMock()
mock_logger = MagicMock()
sys.modules["db"] = mock_db
sys.modules["logger_setup"] = mock_logger

from trade_processor import BATCH_SIZE, StrikeVolume, TradeProcessor  # noqa: E402

import pytest  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def processor() -> TradeProcessor:
    """Return a fresh TradeProcessor with the mock DB reset."""
    mock_db.batch_insert_options_trades.reset_mock()
    return TradeProcessor()


SAMPLE_EXPIRY = date(2026, 4, 6)
SAMPLE_STRIKE = 5300.0
SAMPLE_TS_NS = 1_780_000_000_000_000_000  # arbitrary nanosecond timestamp


def _process_one(
    proc: TradeProcessor,
    *,
    side: str = "B",
    size: int = 1,
    strike: float = SAMPLE_STRIKE,
    option_type: str = "C",
    price_raw: int = 10_000_000_000,
) -> None:
    """Helper to feed a single trade into the processor."""
    proc.process_trade(
        underlying="ES",
        expiry=SAMPLE_EXPIRY,
        strike=strike,
        option_type=option_type,
        ts_ns=SAMPLE_TS_NS,
        price_raw=price_raw,
        size=size,
        side_char=side,
    )


# ---------------------------------------------------------------------------
# StrikeVolume dataclass
# ---------------------------------------------------------------------------


class TestStrikeVolume:
    def test_total_volume_sums_all_three(self) -> None:
        sv = StrikeVolume(buy_volume=10, sell_volume=5, none_volume=3)
        assert sv.total_volume == 18

    def test_total_volume_zero_by_default(self) -> None:
        sv = StrikeVolume()
        assert sv.total_volume == 0

    def test_buy_aggressor_pct_correct_ratio(self) -> None:
        sv = StrikeVolume(buy_volume=3, sell_volume=5, none_volume=2)
        assert sv.buy_aggressor_pct == pytest.approx(0.3)

    def test_buy_aggressor_pct_zero_when_total_zero(self) -> None:
        sv = StrikeVolume()
        assert sv.buy_aggressor_pct == pytest.approx(0.0)

    def test_sell_aggressor_pct_correct_ratio(self) -> None:
        sv = StrikeVolume(buy_volume=3, sell_volume=5, none_volume=2)
        assert sv.sell_aggressor_pct == pytest.approx(0.5)

    def test_sell_aggressor_pct_zero_when_total_zero(self) -> None:
        sv = StrikeVolume()
        assert sv.sell_aggressor_pct == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# TradeProcessor — volume tracking
# ---------------------------------------------------------------------------


class TestProcessTradeVolume:
    def test_buy_side_increments_buy_volume(self, processor: TradeProcessor) -> None:
        _process_one(processor, side="B", size=5)
        vol = processor.get_strike_volume(SAMPLE_STRIKE, "C")
        assert vol.buy_volume == 5
        assert vol.sell_volume == 0
        assert vol.none_volume == 0

    def test_sell_side_increments_sell_volume(self, processor: TradeProcessor) -> None:
        _process_one(processor, side="A", size=3)
        vol = processor.get_strike_volume(SAMPLE_STRIKE, "C")
        assert vol.sell_volume == 3

    def test_none_side_increments_none_volume(self, processor: TradeProcessor) -> None:
        _process_one(processor, side="N", size=7)
        vol = processor.get_strike_volume(SAMPLE_STRIKE, "C")
        assert vol.none_volume == 7

    def test_multiple_sides_accumulate(self, processor: TradeProcessor) -> None:
        _process_one(processor, side="B", size=2)
        _process_one(processor, side="A", size=4)
        _process_one(processor, side="N", size=1)
        vol = processor.get_strike_volume(SAMPLE_STRIKE, "C")
        assert vol.total_volume == 7
        assert vol.buy_volume == 2
        assert vol.sell_volume == 4
        assert vol.none_volume == 1


# ---------------------------------------------------------------------------
# TradeProcessor — price conversion
# ---------------------------------------------------------------------------


class TestProcessTradePriceConversion:
    def test_price_raw_converts_to_decimal(self, processor: TradeProcessor) -> None:
        """price_raw=50_250_000_000 should become Decimal('50.25')."""
        _process_one(processor, price_raw=50_250_000_000)
        # Force flush so we can inspect the DB call args
        processor.flush()
        rows = mock_db.batch_insert_options_trades.call_args[0][0]
        price_in_row = rows[0][5]  # index 5 = price
        assert price_in_row == Decimal("50250000000") / Decimal("1000000000")
        assert price_in_row == Decimal("50.25")


# ---------------------------------------------------------------------------
# TradeProcessor — buffer / flush
# ---------------------------------------------------------------------------


class TestBufferFlush:
    def test_no_flush_before_batch_size(self, processor: TradeProcessor) -> None:
        for _ in range(BATCH_SIZE - 1):
            _process_one(processor)
        mock_db.batch_insert_options_trades.assert_not_called()

    def test_auto_flush_at_batch_size(self, processor: TradeProcessor) -> None:
        for _ in range(BATCH_SIZE):
            _process_one(processor)
        mock_db.batch_insert_options_trades.assert_called_once()
        rows = mock_db.batch_insert_options_trades.call_args[0][0]
        assert len(rows) == BATCH_SIZE

    def test_force_flush_sends_remaining(self, processor: TradeProcessor) -> None:
        count = 10
        for _ in range(count):
            _process_one(processor)
        mock_db.batch_insert_options_trades.assert_not_called()

        processor.flush()
        mock_db.batch_insert_options_trades.assert_called_once()
        rows = mock_db.batch_insert_options_trades.call_args[0][0]
        assert len(rows) == count

    def test_flush_noop_when_buffer_empty(self, processor: TradeProcessor) -> None:
        processor.flush()
        mock_db.batch_insert_options_trades.assert_not_called()


# ---------------------------------------------------------------------------
# TradeProcessor — volume snapshot & strike lookup
# ---------------------------------------------------------------------------


class TestVolumeSnapshot:
    def test_get_volume_snapshot_returns_copy(self, processor: TradeProcessor) -> None:
        _process_one(processor, strike=5300.0, option_type="C")
        snap = processor.get_volume_snapshot()
        assert (5300.0, "C") in snap
        # Mutating the snapshot should not affect processor state
        snap.pop((5300.0, "C"))
        assert processor.get_strike_volume(5300.0, "C").total_volume == 1

    def test_get_strike_volume_returns_default_when_missing(
        self, processor: TradeProcessor
    ) -> None:
        vol = processor.get_strike_volume(9999.0, "P")
        assert vol.total_volume == 0
        assert vol.buy_aggressor_pct == pytest.approx(0.0)

    def test_get_strike_volume_returns_correct_data(
        self, processor: TradeProcessor
    ) -> None:
        _process_one(processor, strike=5300.0, option_type="P", side="A", size=12)
        vol = processor.get_strike_volume(5300.0, "P")
        assert vol.sell_volume == 12
        assert vol.total_volume == 12


# ---------------------------------------------------------------------------
# TradeProcessor — reset
# ---------------------------------------------------------------------------


class TestResetVolumeWindow:
    def test_reset_clears_all_volume_data(self, processor: TradeProcessor) -> None:
        _process_one(processor, strike=5300.0, option_type="C", size=10)
        _process_one(processor, strike=5350.0, option_type="P", size=5)
        assert processor.get_volume_snapshot() != {}

        processor.reset_volume_window()
        assert processor.get_volume_snapshot() == {}
        assert processor.get_strike_volume(5300.0, "C").total_volume == 0


# ---------------------------------------------------------------------------
# TradeProcessor — unusual volume detection
# ---------------------------------------------------------------------------


class TestUnusualVolumeStrikes:
    def test_detects_strikes_exceeding_threshold(
        self, processor: TradeProcessor
    ) -> None:
        # Inject average volume baseline
        processor._avg_volume[(5300.0, "C")] = 10.0

        # Add volume well above 5x the average (60 > 10 * 5)
        _process_one(processor, strike=5300.0, option_type="C", side="B", size=60)

        unusual = processor.get_unusual_volume_strikes(threshold_multiple=5.0)
        assert len(unusual) == 1
        entry = unusual[0]
        assert entry["strike"] == pytest.approx(5300.0)
        assert entry["option_type"] == "C"
        assert entry["volume"] == 60
        assert entry["avg_volume"] == pytest.approx(10.0)
        assert entry["multiple"] == pytest.approx(6.0)
        assert entry["buy_aggressor_pct"] == pytest.approx(1.0)
        assert entry["sell_aggressor_pct"] == pytest.approx(0.0)

    def test_does_not_flag_below_threshold(self, processor: TradeProcessor) -> None:
        processor._avg_volume[(5300.0, "C")] = 100.0
        _process_one(processor, strike=5300.0, option_type="C", side="B", size=10)
        unusual = processor.get_unusual_volume_strikes(threshold_multiple=5.0)
        assert unusual == []

    def test_ignores_strikes_without_avg_volume(
        self, processor: TradeProcessor
    ) -> None:
        # No entry in _avg_volume → avg defaults to 0 → skipped
        _process_one(processor, strike=5300.0, option_type="C", side="B", size=1000)
        unusual = processor.get_unusual_volume_strikes(threshold_multiple=2.0)
        assert unusual == []
