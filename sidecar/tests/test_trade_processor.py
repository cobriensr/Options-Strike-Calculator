"""Tests for sidecar/src/trade_processor.py.

Mock strategy:
- conftest.py provides session-wide mocks for external packages
  (databento, psycopg2, sentry_sdk) that are not in the local venv.
- trade_processor.py is imported normally. Its module-level
  `from db import batch_insert_options_trades` resolves once at first
  import, and we monkeypatch the resulting binding
  (`trade_processor.batch_insert_options_trades`) per-test via
  monkeypatch.setattr — NOT by clobbering sys.modules, which would
  break sibling test files (test_db.py, test_databento_client.py).
"""

from __future__ import annotations

import os
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

# Required env vars for config.py's pydantic-settings validation.
# The DATABASE_URL is a throwaway test fixture — psycopg2 is mocked
# via conftest.py so no real connection is ever attempted.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402
import trade_processor  # noqa: E402
from trade_processor import BATCH_SIZE, TradeProcessor  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_batch_insert(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Monkeypatch trade_processor.batch_insert_options_trades per-test.

    Returns the mock so tests can assert against it directly. Since
    `trade_processor` did `from db import batch_insert_options_trades`
    at module load, we patch the already-resolved binding on the
    `trade_processor` module object rather than clobbering sys.modules,
    which lets sibling test files mock `db` independently.
    """
    mock = MagicMock()
    monkeypatch.setattr(trade_processor, "batch_insert_options_trades", mock)
    return mock


@pytest.fixture()
def processor() -> TradeProcessor:
    """Return a fresh TradeProcessor."""
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
# TradeProcessor — price conversion
# ---------------------------------------------------------------------------


class TestProcessTradePriceConversion:
    def test_price_raw_converts_to_decimal(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        """price_raw=50_250_000_000 should become Decimal('50.25')."""
        _process_one(processor, price_raw=50_250_000_000)
        # Force flush so we can inspect the DB call args
        processor.flush()
        rows = mock_batch_insert.call_args[0][0]
        price_in_row = rows[0][5]  # index 5 = price
        assert price_in_row == Decimal("50250000000") / Decimal("1000000000")
        assert price_in_row == Decimal("50.25")

    def test_strike_preserves_precision(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        """Strike floats convert to Decimal without floating-point drift."""
        _process_one(processor, strike=5327.5)
        processor.flush()
        rows = mock_batch_insert.call_args[0][0]
        strike_in_row = rows[0][2]  # index 2 = strike
        assert strike_in_row == Decimal("5327.5")

    def test_side_character_preserved(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        """The side char (B/A/N) is passed through unchanged to the DB row."""
        _process_one(processor, side="A")
        processor.flush()
        rows = mock_batch_insert.call_args[0][0]
        assert rows[0][7] == "A"  # index 7 = side


# ---------------------------------------------------------------------------
# TradeProcessor — buffer / flush
# ---------------------------------------------------------------------------


class TestBufferFlush:
    def test_no_flush_before_batch_size(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        for _ in range(BATCH_SIZE - 1):
            _process_one(processor)
        mock_batch_insert.assert_not_called()

    def test_auto_flush_at_batch_size(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        for _ in range(BATCH_SIZE):
            _process_one(processor)
        mock_batch_insert.assert_called_once()
        rows = mock_batch_insert.call_args[0][0]
        assert len(rows) == BATCH_SIZE

    def test_force_flush_sends_remaining(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        count = 10
        for _ in range(count):
            _process_one(processor)
        mock_batch_insert.assert_not_called()

        processor.flush()
        mock_batch_insert.assert_called_once()
        rows = mock_batch_insert.call_args[0][0]
        assert len(rows) == count

    def test_flush_noop_when_buffer_empty(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        processor.flush()
        mock_batch_insert.assert_not_called()

    def test_buffer_clears_after_flush(
        self, processor: TradeProcessor, mock_batch_insert: MagicMock
    ) -> None:
        """A second flush without new trades should not re-insert the same rows."""
        _process_one(processor)
        processor.flush()
        assert mock_batch_insert.call_count == 1
        processor.flush()
        assert mock_batch_insert.call_count == 1
