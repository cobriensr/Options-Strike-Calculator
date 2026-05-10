"""off_lit_trades channel handler.

Maps each WS payload onto a row of the ``dark_pool_prints`` table
(migration #116). Filters the global firehose to SPY+QQQ only, drops
extended-hours and contingent-trade prints at the boundary so the table
stays clean for downstream aggregation, and stores every other field UW
emits per the user-decided full-fidelity capture preference.

Reference payload (from UW WS docs):

    {"symbol": "AAPL", "price": "150.25", "type": "off_lit",
     "size": 100, "volume": 1000, "trade_settlement": "regular",
     "trade_code": null, "ext_hour_sold_codes": "extended_hours_trade",
     "sale_cond_codes": null, "executed_at": "2024-09-22T14:30:00Z",
     "nbbo_bid": "150.20", "nbbo_ask": "150.25",
     "nbbo_bid_quantity": 500, "nbbo_ask_quantity": 800,
     "sector": "Technology", "next_earnings_date": "2024-10-25",
     "avg30_volume": "75000000.0", "issue_type": "Common Stock",
     "marketcap": "2400000000000.0"}

Filtering rationale (in handler order):

1. ``symbol ∈ {SPY, QQQ}`` — the off_lit_trades channel is global
   firehose; SPX and NDX are synthesized at read time via candle ratio
   in index_candles_1m, so we only need the two ETFs that map to them.
2. Session hours 08:30-15:00 CT — per memory feedback_extended_hours.md,
   off-session prints distort the volume profile we use for level
   strength. ``executed_at`` arrives as ISO-8601 UTC; we convert to CT
   and check the time-of-day window.
3. ``ext_hour_sold_codes == 'extended_hours_trade'`` — same memory; UW
   sometimes emits ext-hours prints inside the session window with this
   code. Drop unconditionally.
4. ``sale_cond_codes`` containing the contingent-trade marker — per
   memory feedback_contingent_trade_filter.md, contingent prints are
   pre-arranged swap resets that distort volume profile.

Numeric casting follows the project's standard pattern: every WS-string
numeric field gets parsed through Decimal so we never compare or sum
the raw strings UW emits. ``premium`` is computed at ingest as
``price * size`` so the dark pool read query can SUM it directly
without per-row multiplication.

Side-channel work this handler does NOT do:
- SPX/NDX index-level synthesis. That happens at read time in the
  Phase 5 endpoint by joining to index_candles_1m for the
  contemporaneous ETF/index ratio.
- Aggregation to (level, total_premium, trade_count). That's also
  read-time so the mapping methodology can change without backfill.
"""

from __future__ import annotations

from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

import db
from handlers.base import Handler
from logger_setup import rate_limited_log

_TABLE = "dark_pool_prints"

# Per migration #116: UNIQUE (symbol, executed_at, price, size). UW does
# not emit a per-print ID for off_lit_trades (unlike option_trades), so
# this composite is the natural dedup key on daemon reconnect/replay.
# Two distinct prints at the same instant + price + size on the same
# symbol would collide; for SPY/QQQ off-lit volume that's a real but
# accepted risk — Phase 3 verification (capture a real WS sample with
# websocat) may surface a tracking_id field that supersedes this.
_CONFLICT_COLS = ["symbol", "executed_at", "price", "size"]

# Column order MUST match the tuple shape returned by _transform.
# id (BIGSERIAL) and ingested_at (DEFAULT now()) auto-populate; we omit
# them from the INSERT entirely.
_COLUMNS: list[str] = [
    "date",
    "symbol",
    "executed_at",
    "price",
    "size",
    "volume",
    "type",
    "trade_settlement",
    "trade_code",
    "ext_hour_sold_codes",
    "sale_cond_codes",
    "nbbo_bid",
    "nbbo_ask",
    "nbbo_bid_quantity",
    "nbbo_ask_quantity",
    "sector",
    "next_earnings_date",
    "avg30_volume",
    "issue_type",
    "marketcap",
    "premium",
]

# Symbol allowlist — drops every non-SPY/QQQ payload from the firehose
# at the cheapest possible point in the pipeline.
_ALLOWED_SYMBOLS: frozenset[str] = frozenset({"SPY", "QQQ"})

# Session-hours window in America/Chicago. Inclusive 08:30, exclusive
# 15:00 — matches the existing dark-pool cron's filter.
_CT = ZoneInfo("America/Chicago")
_SESSION_START_CT = time(8, 30)
_SESSION_END_CT = time(15, 0)

# Extended-hours and contingent-trade markers per memory feedbacks.
_EXT_HOURS_CODE = "extended_hours_trade"
_CONTINGENT_MARKER = "contingent_trade"


class OffLitTradesHandler(Handler):
    """off_lit_trades global firehose → dark_pool_prints table (filtered)."""

    name = "off_lit_trades"

    def __init__(self) -> None:
        super().__init__(name="off_lit_trades")

    async def enqueue(self, payload: dict) -> None:
        """Short-circuit non-SPY/QQQ payloads BEFORE the queue.

        The off_lit_trades channel is the global firehose (~6-10M
        records/day across thousands of symbols). SPY+QQQ together are
        <1% of that volume. If we relied on _transform's symbol check
        alone, every non-target payload would still take a queue slot;
        on a drain hiccup the bounded queue would fill with junk and
        drop_oldest would evict legitimate SPY/QQQ payloads waiting
        behind thousands of unrelated tickers.

        Non-target payloads are not "dropped" — they were never
        wanted, so we do NOT increment drop_count for them. The
        _transform symbol check stays as a defensive double-guard
        in case the WS framing ever delivers a payload without
        a symbol field.
        """
        if payload.get("symbol") not in _ALLOWED_SYMBOLS:
            return
        await super().enqueue(payload)

    def _transform(self, payload: dict) -> tuple | None:
        # 1. Symbol filter — defensive double-guard. enqueue() already
        # filtered the firehose so this branch is only reached for
        # SPY/QQQ payloads in steady state.
        symbol = payload.get("symbol")
        if symbol not in _ALLOWED_SYMBOLS:
            return None

        # 2. Parse executed_at; require it for the dedup key
        executed_at = _parse_iso(payload.get("executed_at"))
        if executed_at is None:
            rate_limited_log.warning(
                scope="off_lit_trades",
                kind="missing_executed_at",
                message="off_lit_trades missing or malformed executed_at",
                extra={"symbol": symbol, "raw": payload.get("executed_at")},
            )
            return None

        # 3. Session-hours filter (08:30-15:00 CT inclusive/exclusive)
        if not _in_ct_session(executed_at):
            return None

        # 4. Drop extended-hours-coded rows even when executed_at falls
        # inside the session window (UW occasionally emits late-print
        # corrections with the ext-hours code).
        if payload.get("ext_hour_sold_codes") == _EXT_HOURS_CODE:
            return None

        # 5. Drop contingent-trade rows (pre-arranged swap resets)
        sale_cond = payload.get("sale_cond_codes")
        if isinstance(sale_cond, str) and _CONTINGENT_MARKER in sale_cond:
            return None

        # 6. Cast core numerics; reject if missing or non-positive
        price = _to_decimal(payload.get("price"))
        size = _to_int(payload.get("size"))
        if price is None or size is None or price <= 0 or size <= 0:
            rate_limited_log.warning(
                scope="off_lit_trades",
                kind="invalid_price_or_size",
                message="off_lit_trades missing or invalid price/size",
                extra={"symbol": symbol, "price": payload.get("price"), "size": payload.get("size")},
            )
            return None

        # 7. Compute premium + session date in CT
        premium = price * Decimal(size)
        ct_date = executed_at.astimezone(_CT).date()

        return (
            ct_date,
            symbol,
            executed_at,
            price,
            size,
            _to_int(payload.get("volume")),
            payload.get("type"),
            payload.get("trade_settlement"),
            payload.get("trade_code"),
            payload.get("ext_hour_sold_codes"),
            payload.get("sale_cond_codes"),
            _to_decimal(payload.get("nbbo_bid")),
            _to_decimal(payload.get("nbbo_ask")),
            _to_int(payload.get("nbbo_bid_quantity")),
            _to_int(payload.get("nbbo_ask_quantity")),
            payload.get("sector"),
            _parse_date(payload.get("next_earnings_date")),
            _to_decimal(payload.get("avg30_volume")),
            payload.get("issue_type"),
            _to_decimal(payload.get("marketcap")),
            premium,
        )

    async def _flush(self, rows: list[tuple]) -> int:
        return await db.bulk_insert_ignore_conflict(
            table=_TABLE,
            columns=_COLUMNS,
            rows=rows,
            conflict_cols=_CONFLICT_COLS,
        )


# ----------------------------------------------------------------------
# Helpers — defensive coercion and session-window logic. Returning None
# preserves "no value" semantics in Postgres for nullable columns.
# ----------------------------------------------------------------------


def _to_decimal(v: Any) -> Decimal | None:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def _to_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(Decimal(str(v)))
    except (InvalidOperation, ValueError):
        return None


def _parse_iso(v: Any) -> datetime | None:
    """Parse an ISO-8601 timestamp from UW. Always returns UTC-aware.

    UW emits ``executed_at`` as ``"2024-09-22T14:30:00Z"`` (the trailing
    Z marks UTC). Python's ``fromisoformat`` accepts both ``Z`` and
    ``+00:00`` suffixes since 3.11; the daemon's runtime is >= 3.11
    per pyproject.toml. Defensive parse: anything not ISO-shaped
    returns None and the row is dropped.
    """
    if not isinstance(v, str) or not v:
        return None
    try:
        # Some UW endpoints emit Z; fromisoformat accepts it directly
        # in Python 3.11+, which the daemon requires.
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    # Defensive: if the parsed datetime is naive (no tzinfo), assume UTC
    # since the wire format is always Zulu. A ZeroDivisionError waiting
    # to happen if we ever silently treat a naive ts as local time.
    if dt.tzinfo is None:
        return None
    return dt


def _parse_date(v: Any) -> date | None:
    """Parse a YYYY-MM-DD date string. UW uses this shape for
    ``next_earnings_date``. Returns None on missing or malformed input.
    """
    if not isinstance(v, str) or not v:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        return None


def _in_ct_session(dt: datetime) -> bool:
    """True if dt (UTC-aware) falls within the 08:30-15:00 CT window.

    Half-open interval: includes 08:30:00, excludes 15:00:00. Matches
    the existing dark-pool cron's session-hours filter and the user's
    documented memory rules.
    """
    ct = dt.astimezone(_CT).timetz().replace(tzinfo=None)
    return _SESSION_START_CT <= ct < _SESSION_END_CT
