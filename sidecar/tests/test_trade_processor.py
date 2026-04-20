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

import time  # noqa: E402

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


# ---------------------------------------------------------------------------
# TradeProcessor — background flush thread
# ---------------------------------------------------------------------------


def _wait_until(predicate, timeout: float = 2.0, poll: float = 0.01) -> bool:
    """Poll ``predicate`` until it returns truthy or the timeout elapses.

    Returns True if the predicate became truthy, False on timeout. Used
    to keep thread-timing assertions deterministic without hard sleeps.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(poll)
    return False


class TestBackgroundFlush:
    """The background flush thread is the safety net against low-volume
    weekend sessions — without it, a Railway restart before the buffer
    hits BATCH_SIZE loses every buffered trade.
    """

    def test_background_flush_drains_sub_batch_buffer(
        self, mock_batch_insert: MagicMock
    ) -> None:
        """A tick must flush buffered trades even when count < BATCH_SIZE."""
        proc = TradeProcessor(flush_interval_s=0.05)
        proc.start_background_flush()
        try:
            for _ in range(5):
                _process_one(proc)
            assert mock_batch_insert.call_count == 0  # not yet ticked
            assert _wait_until(lambda: mock_batch_insert.call_count >= 1)
            rows = mock_batch_insert.call_args[0][0]
            assert len(rows) == 5
        finally:
            proc.stop()

    def test_background_flush_is_noop_when_buffer_empty(
        self, mock_batch_insert: MagicMock
    ) -> None:
        """A tick with no buffered trades must not call the DB."""
        proc = TradeProcessor(flush_interval_s=0.05)
        proc.start_background_flush()
        try:
            # Let the loop tick several times with nothing buffered
            time.sleep(0.2)
            assert mock_batch_insert.call_count == 0
        finally:
            proc.stop()

    def test_start_background_flush_is_idempotent(
        self, mock_batch_insert: MagicMock
    ) -> None:
        """Double-start must not spawn a second thread or duplicate flushes."""
        proc = TradeProcessor(flush_interval_s=0.05)
        proc.start_background_flush()
        first_thread = proc._flush_thread
        proc.start_background_flush()  # second call — should be no-op
        try:
            assert proc._flush_thread is first_thread
            assert first_thread is not None and first_thread.is_alive()
        finally:
            proc.stop()

    def test_stop_joins_thread_and_performs_final_flush(
        self, mock_batch_insert: MagicMock
    ) -> None:
        """stop() must exit the thread cleanly and commit buffered trades."""
        proc = TradeProcessor(flush_interval_s=10.0)  # long interval — no tick
        proc.start_background_flush()
        _process_one(proc)
        assert mock_batch_insert.call_count == 0  # tick interval too long

        proc.stop()
        # Final flush on stop should have sent the single buffered row.
        assert mock_batch_insert.call_count == 1
        rows = mock_batch_insert.call_args[0][0]
        assert len(rows) == 1
        # And the thread should have exited within the join timeout.
        assert proc._flush_thread is not None
        assert not proc._flush_thread.is_alive()

    def test_stop_without_start_is_safe(self, mock_batch_insert: MagicMock) -> None:
        """stop() before start_background_flush() must still flush buffer."""
        proc = TradeProcessor(flush_interval_s=0.05)
        _process_one(proc)
        proc.stop()
        assert mock_batch_insert.call_count == 1
        assert proc._flush_thread is None
