"""Process ES TBBO (trade + pre-trade BBO) records from Databento.

Phase 2a data plumbing for the max-leverage roadmap. We subscribe ONLY
to the ``tbbo`` schema on the ES front-month contract. Each TBBO record
is an ``MBP1Msg`` representing a trade, with the pre-trade top-of-book
carried in ``levels[0]``. From each record we derive two rows:

- A top-of-book snapshot (bid, bid_size, ask, ask_size) → batch-insert
  into ``futures_top_of_book``.
- A trade tick (price, size, classified aggressor side) → batch-insert
  into ``futures_trade_ticks``.

**Why TBBO-only, not MBP-1 + TBBO?** Both the ``mbp-1`` and ``tbbo``
schemas emit ``MBP1Msg`` and share the same ``rtype`` value
(``RType.from_schema(Schema.MBP_1).value == RType.from_schema(Schema.TBBO).value == 1``),
so they are NOT distinguishable at the record level. Subscribing to both
on the same Live client would also double-deliver every trade — TBBO is
the subset of MBP-1 events where ``action == 'T'``. For Phase 2a we only
need quotes at trade moments and trades themselves; subscribing to TBBO
alone gives us both cleanly with no duplication. If Phase 2b later needs
tick-by-tick quote updates between trades, we can add ``mbp-1`` back
with an ``action != 'T'`` filter.

No compute layer lives here — OFI, spread widening, book pressure, and
any derived signals are Phase 2b concerns.

Mirrors the structure of ``trade_processor.py``: in-memory buffers with
batch flush at ``BATCH_SIZE``, explicit ``flush()`` on shutdown. Unlike
the earlier draft, the DB write runs OUTSIDE the critical section — we
swap the buffer under the lock, then release before issuing the network
round trip — so high-volume callbacks don't serialize behind a single
Neon query.
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

# Batch size for DB inserts. Matches the 500-row ``page_size`` used by
# ``batch_insert_options_trades``. TBBO on active ES sessions can emit
# dozens of trades per second; smaller batches would let Neon round-trip
# overhead dominate.
BATCH_SIZE = 500


# Databento encodes prices as int64 with an implicit 1e-9 scale factor.
# Matches the existing convention in trade_processor.py and
# databento_client.py.
_PRICE_SCALE = Decimal(1_000_000_000)


@dataclass
class TopOfBookRow:
    """A single parsed top-of-book quote (pre-trade BBO from a TBBO record)."""

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

    TBBO records carry the pre-trade book level in ``levels[0]``.
    Defensive: edge cases (pre-open with no book, auction) can produce
    records without a populated top level.
    """
    levels = getattr(record, "levels", None)
    if not levels:
        return None
    try:
        return levels[0]
    except (IndexError, TypeError):
        return None


def _parse_top_of_book(symbol: str, record: Any) -> TopOfBookRow | None:
    """Extract the pre-trade BBO snapshot from a TBBO record.

    Returns None on missing / malformed fields so the caller can skip.
    """
    level = _extract_top_level(record)
    if level is None:
        return None

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
            return None

        return TopOfBookRow(
            symbol=symbol,
            ts=_ns_to_datetime(int(ts_ns)),
            bid=Decimal(bid_px) / _PRICE_SCALE,
            bid_size=int(bid_sz),
            ask=Decimal(ask_px) / _PRICE_SCALE,
            ask_size=int(ask_sz),
        )
    except (TypeError, ValueError, ArithmeticError) as exc:
        log.debug("Skipping malformed TBBO top-of-book: %s", exc)
        return None


def _parse_trade_tick(symbol: str, record: Any) -> TradeTickRow | None:
    """Extract the trade event + classified aggressor from a TBBO record.

    Returns None on missing / malformed fields so the caller can skip.
    """
    level = _extract_top_level(record)
    if level is None:
        return None

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
            return None

        price = Decimal(price_raw) / _PRICE_SCALE
        pre_bid = Decimal(bid_px) / _PRICE_SCALE
        pre_ask = Decimal(ask_px) / _PRICE_SCALE

        return TradeTickRow(
            symbol=symbol,
            ts=_ns_to_datetime(int(ts_ns)),
            price=price,
            size=int(size),
            aggressor_side=classify_aggressor(price, pre_bid, pre_ask),
        )
    except (TypeError, ValueError, ArithmeticError) as exc:
        log.debug("Skipping malformed TBBO trade tick: %s", exc)
        return None


class QuoteProcessor:
    """Accumulates ES TBBO events and batches DB writes.

    Each TBBO record produces one top-of-book row AND one trade tick row.
    Two separate in-memory buffers are maintained so the independent
    batch-insert round trips to Neon can run on their own page_size-500
    cadences.
    """

    def __init__(self) -> None:
        self._tob_buffer: list[TopOfBookRow] = []
        self._trade_buffer: list[TradeTickRow] = []
        self._lock = threading.Lock()

    def process_tbbo(self, symbol: str, record: Any) -> None:
        """Parse a Databento TBBO record and buffer both the top-of-book
        snapshot and the trade tick.

        Each TBBO record is a trade with the pre-trade book in
        ``levels[0]``, so one record contributes to both buffers. A
        malformed record skips the affected row(s) rather than crashing —
        one bad tick must not kill the stream.
        """
        tob = _parse_top_of_book(symbol, record)
        trade = _parse_trade_tick(symbol, record)

        # Collect any buffers that have crossed BATCH_SIZE under the
        # lock, then release before doing the DB round-trip. Holding the
        # lock across ``execute_values`` would serialize every incoming
        # callback behind one Neon query — untenable at TBBO volumes.
        tob_to_flush: list[TopOfBookRow] = []
        trades_to_flush: list[TradeTickRow] = []
        with self._lock:
            if tob is not None:
                self._tob_buffer.append(tob)
                if len(self._tob_buffer) >= BATCH_SIZE:
                    tob_to_flush = self._tob_buffer
                    self._tob_buffer = []
            if trade is not None:
                self._trade_buffer.append(trade)
                if len(self._trade_buffer) >= BATCH_SIZE:
                    trades_to_flush = self._trade_buffer
                    self._trade_buffer = []

        if tob_to_flush:
            _write_top_of_book(tob_to_flush)
        if trades_to_flush:
            _write_trade_ticks(trades_to_flush)

    def flush(self) -> None:
        """Force flush both buffers. Called on shutdown.

        Swaps each buffer out under the lock, then writes outside it
        (same pattern as ``process_tbbo``).
        """
        with self._lock:
            tob_to_flush = self._tob_buffer
            trades_to_flush = self._trade_buffer
            self._tob_buffer = []
            self._trade_buffer = []

        if tob_to_flush:
            _write_top_of_book(tob_to_flush)
        if trades_to_flush:
            _write_trade_ticks(trades_to_flush)


# ---------------------------------------------------------------------------
# Write helpers — deliberately module-level so ``process_tbbo`` / ``flush``
# can call them OUTSIDE ``self._lock`` without any accidental re-entrancy
# risk. If a future subclass wants to override DB routing it can patch
# ``quote_processor.batch_insert_*`` the same way tests do.
# ---------------------------------------------------------------------------


def _write_top_of_book(rows: list[TopOfBookRow]) -> None:
    """Materialize TopOfBookRow dataclasses into tuples and batch-insert."""
    tuples = [(r.symbol, r.ts, r.bid, r.bid_size, r.ask, r.ask_size) for r in rows]
    try:
        batch_insert_top_of_book(tuples)
    except Exception as exc:
        log.error("Failed to batch insert top-of-book: %s", exc)
        capture_exception(exc, context={"rows": len(tuples)})


def _write_trade_ticks(rows: list[TradeTickRow]) -> None:
    """Materialize TradeTickRow dataclasses into tuples and batch-insert."""
    tuples = [(r.symbol, r.ts, r.price, r.size, r.aggressor_side) for r in rows]
    try:
        batch_insert_trade_ticks(tuples)
    except Exception as exc:
        log.error("Failed to batch insert trade ticks: %s", exc)
        capture_exception(exc, context={"rows": len(tuples)})
