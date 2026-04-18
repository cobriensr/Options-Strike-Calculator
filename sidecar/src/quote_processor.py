"""Process ES L1 Databento streams (MBP-1 + TBBO).

Phase 2a data plumbing for the max-leverage roadmap. Two schemas feed
this module:

- **MBP-1** (`mbp-1`): every book update, including ADDs, MODIFYs,
  CANCELs, and trades. We extract top-of-book (levels[0]) after each
  event and batch-insert into `futures_top_of_book`.
- **TBBO** (`tbbo`): one record per trade carrying the pre-trade BBO
  in levels[0]. We derive the aggressor side by comparing trade price
  to the pre-trade bid/ask (see `classify_aggressor`) and batch-insert
  into `futures_trade_ticks`.

No compute layer lives here — OFI, spread widening, book pressure,
and any derived signals are Phase 2b concerns. This module is purely
a parse-and-batch pass-through so Phase 2b has a DB surface to read
from.

Mirrors the structure of `trade_processor.py`: in-memory buffer per
schema, thread-safe flush at `BATCH_SIZE`, explicit `flush()` called
on shutdown.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from db import batch_insert_top_of_book, batch_insert_trade_ticks
from logger_setup import log
from sentry_setup import capture_exception

# Batch size for DB inserts. Matches the 500-row pattern from
# batch_insert_options_trades / execute_values page_size. MBP-1 on a
# busy ES session can generate hundreds of rows/second, so smaller
# batches would dominate on round-trip cost to Neon.
BATCH_SIZE = 500


# Databento encodes prices as int64 with an implicit 1e-9 scale factor.
# Matches the existing convention in trade_processor.py and
# databento_client.py.
_PRICE_SCALE = Decimal(1_000_000_000)


@dataclass
class TopOfBookRow:
    """A single parsed MBP-1 top-of-book quote."""

    symbol: str
    ts: datetime
    bid: Decimal
    bid_size: int
    ask: Decimal
    ask_size: int


@dataclass
class TradeTickRow:
    """A single parsed TBBO trade with aggressor classification."""

    symbol: str
    ts: datetime
    price: Decimal
    size: int
    aggressor_side: str  # 'B', 'S', or 'N'


def classify_aggressor(
    trade_price: Decimal,
    pre_trade_bid: Decimal,
    pre_trade_ask: Decimal,
) -> str:
    """Derive trade aggressor from trade price vs pre-trade BBO.

    We classify from the pre-trade book rather than relying on Databento's
    ``side`` field directly: Databento's ``Side`` enum docs describe it as
    "the side of the aggressor for trades" but the wording is ambiguous
    across venue conventions, and the existing sidecar code in
    ``trade_processor.py`` already uses a different ('A'/'B'/'N') mapping
    for options trades. Deriving from price vs pre-trade BBO is
    unambiguous and matches the Phase 2a spec.

    Returns:
        'B' if trade price >= pre-trade ask (buyer-initiated)
        'S' if trade price <= pre-trade bid (seller-initiated)
        'N' otherwise (trade printed between the spread — rare but
            possible for auction crosses and some implieds)
    """
    if trade_price >= pre_trade_ask:
        return "B"
    if trade_price <= pre_trade_bid:
        return "S"
    return "N"


def _ns_to_datetime(ts_ns: int) -> datetime:
    """Convert Databento ts_event (nanoseconds since epoch) to aware UTC."""
    return datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)


def _extract_top_level(record: Any) -> Any | None:
    """Return the top-of-book BidAskPair (``levels[0]``) or None.

    MBP-1 / TBBO records carry one book level in the ``levels`` tuple.
    Defensive: occasional edge cases (e.g. pre-open with no book)
    produce records without a populated top level.
    """
    levels = getattr(record, "levels", None)
    if not levels:
        return None
    try:
        return levels[0]
    except (IndexError, TypeError):
        return None


class QuoteProcessor:
    """Accumulates ES MBP-1 + TBBO events and batches DB writes."""

    def __init__(self) -> None:
        self._tob_buffer: list[TopOfBookRow] = []
        self._trade_buffer: list[TradeTickRow] = []
        self._lock = threading.Lock()

    # ---------------------------------------------------------------
    # MBP-1 ingest
    # ---------------------------------------------------------------

    def process_mbp1(self, symbol: str, record: Any) -> None:
        """Parse a Databento MBP-1 (``MBP1Msg``) record and buffer the top-of-book.

        Drops records with missing or malformed fields rather than
        crashing — this keeps one bad tick from killing the stream.
        """
        level = _extract_top_level(record)
        if level is None:
            return

        try:
            bid_px = getattr(level, "bid_px", None)
            ask_px = getattr(level, "ask_px", None)
            bid_sz = getattr(level, "bid_sz", None)
            ask_sz = getattr(level, "ask_sz", None)
            ts_ns = getattr(record, "ts_event", None)
            if (
                bid_px is None
                or ask_px is None
                or bid_sz is None
                or ask_sz is None
                or ts_ns is None
            ):
                return

            row = TopOfBookRow(
                symbol=symbol,
                ts=_ns_to_datetime(int(ts_ns)),
                bid=Decimal(bid_px) / _PRICE_SCALE,
                bid_size=int(bid_sz),
                ask=Decimal(ask_px) / _PRICE_SCALE,
                ask_size=int(ask_sz),
            )
        except (TypeError, ValueError, ArithmeticError) as exc:
            log.debug("Skipping malformed MBP-1 record: %s", exc)
            return

        with self._lock:
            self._tob_buffer.append(row)
            if len(self._tob_buffer) >= BATCH_SIZE:
                self._flush_tob_locked()

    # ---------------------------------------------------------------
    # TBBO ingest
    # ---------------------------------------------------------------

    def process_tbbo(self, symbol: str, record: Any) -> None:
        """Parse a Databento TBBO record and buffer the trade tick.

        TBBO records are ``MBP1Msg`` instances with ``action == 'T'``
        (TRADE). The pre-trade BBO sits in ``levels[0]`` and we use it
        to classify the aggressor side.
        """
        level = _extract_top_level(record)
        if level is None:
            return

        try:
            price_raw = getattr(record, "price", None)
            size = getattr(record, "size", None)
            ts_ns = getattr(record, "ts_event", None)
            bid_px = getattr(level, "bid_px", None)
            ask_px = getattr(level, "ask_px", None)
            if (
                price_raw is None
                or size is None
                or ts_ns is None
                or bid_px is None
                or ask_px is None
            ):
                return

            price = Decimal(price_raw) / _PRICE_SCALE
            pre_bid = Decimal(bid_px) / _PRICE_SCALE
            pre_ask = Decimal(ask_px) / _PRICE_SCALE
            aggressor = classify_aggressor(price, pre_bid, pre_ask)

            row = TradeTickRow(
                symbol=symbol,
                ts=_ns_to_datetime(int(ts_ns)),
                price=price,
                size=int(size),
                aggressor_side=aggressor,
            )
        except (TypeError, ValueError, ArithmeticError) as exc:
            log.debug("Skipping malformed TBBO record: %s", exc)
            return

        with self._lock:
            self._trade_buffer.append(row)
            if len(self._trade_buffer) >= BATCH_SIZE:
                self._flush_trades_locked()

    # ---------------------------------------------------------------
    # Flush helpers — always called under self._lock
    # ---------------------------------------------------------------

    def _flush_tob_locked(self) -> None:
        if not self._tob_buffer:
            return
        rows = [
            (r.symbol, r.ts, r.bid, r.bid_size, r.ask, r.ask_size)
            for r in self._tob_buffer
        ]
        self._tob_buffer.clear()
        try:
            batch_insert_top_of_book(rows)
        except Exception as exc:
            log.error("Failed to batch insert top-of-book: %s", exc)
            capture_exception(exc, context={"rows": len(rows)})

    def _flush_trades_locked(self) -> None:
        if not self._trade_buffer:
            return
        rows = [
            (r.symbol, r.ts, r.price, r.size, r.aggressor_side)
            for r in self._trade_buffer
        ]
        self._trade_buffer.clear()
        try:
            batch_insert_trade_ticks(rows)
        except Exception as exc:
            log.error("Failed to batch insert trade ticks: %s", exc)
            capture_exception(exc, context={"rows": len(rows)})

    def flush(self) -> None:
        """Force flush both buffers. Called on shutdown."""
        with self._lock:
            self._flush_tob_locked()
            self._flush_trades_locked()
