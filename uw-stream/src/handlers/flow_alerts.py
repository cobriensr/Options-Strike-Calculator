"""flow-alerts channel handler.

Maps each WS payload onto a row of the ``ws_flow_alerts`` table. Heavy
fields (raw_payload, JSON arrays) are passed through; OCC symbol parts
are parsed; numeric fields are cast through Decimal so we never compare
or sum the JSON-string forms UW emits for some numbers.

Reference payload (from the unusual-whales-websocket skill):

    {"rule_id": "...", "rule_name": "RepeatedHitsDescendingFill",
     "ticker": "DIA", "option_chain": "DIA241018C00415000",
     "underlying_price": 415.981, ...}

Side-channel work this handler does NOT do (and shouldn't):
- Computing ``dte_at_alert``, ``moneyness``, ``minute_of_day``, etc.
  Those live in the ``ws_flow_alerts_enriched`` view so the math stays
  re-runnable against historic rows.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

import db
from handlers.base import Handler
from logger_setup import log
from utils import occ_parser, ticker_classify

_TABLE = "ws_flow_alerts"
# Must stay in sync with the unique index in
# uw-stream/sql/001_ws_flow_alerts.sql — UW's per-alert `id` UUID.
_CONFLICT_COLS = ["ws_alert_id"]

# Column order MUST match the tuple shape returned by `_transform`.
# `id` is BIGSERIAL and `received_at` defaults to NOW() at the DB; we
# omit them from the INSERT entirely so they auto-populate.
_COLUMNS: list[str] = [
    "ws_alert_id",
    "rule_id",
    "rule_name",
    "ticker",
    "option_chain",
    "issue_type",
    "expiry",
    "strike",
    "option_type",
    "created_at",
    "start_time",
    "end_time",
    "price",
    "underlying_price",
    "bid",
    "ask",
    "volume",
    "total_size",
    "total_premium",
    "total_ask_side_prem",
    "total_bid_side_prem",
    "open_interest",
    "volume_oi_ratio",
    "trade_count",
    "expiry_count",
    "ask_vol",
    "bid_vol",
    "no_side_vol",
    "mid_vol",
    "multi_vol",
    "stock_multi_vol",
    "has_multileg",
    "has_sweep",
    "has_floor",
    "has_singleleg",
    "all_opening_trades",
    "upstream_condition_details",
    "exchanges",
    "trade_ids",
    "url",
    "raw_payload",
]


class FlowAlertsHandler(Handler):
    """flow-alerts channel → ws_flow_alerts table."""

    name = "flow-alerts"

    def __init__(self) -> None:
        super().__init__(name="flow-alerts")

    def _transform(self, payload: dict) -> tuple | None:
        symbol = payload.get("option_chain")
        if not isinstance(symbol, str):
            log.warning("flow-alerts payload missing option_chain", extra={"sample": str(payload)[:200]})
            return None

        # ws_alert_id (UW payload `id`) is the natural dedupe key —
        # NOT NULL UNIQUE in the table. Skip rows missing it.
        ws_alert_id = _to_uuid(payload.get("id"))
        if ws_alert_id is None:
            log.warning(
                "flow-alerts missing or malformed id",
                extra={"symbol": symbol, "raw_id": payload.get("id")},
            )
            return None

        try:
            parsed = occ_parser.parse(symbol)
        except ValueError as exc:
            log.warning(
                "flow-alerts OCC parse failed",
                extra={"symbol": symbol, "err": str(exc)},
            )
            return None

        ticker = payload.get("ticker") or parsed.root
        issue_type = ticker_classify.classify(ticker)

        # Timing — WS gives ms-epoch ints. Default `created_at` to
        # `executed_at`; UW REST historically used a separate `created_at`
        # field but the WS payload only carries `executed_at`. Either way
        # we store one canonical UTC timestamp.
        created_at = _ms_epoch_to_dt(payload.get("executed_at"))
        if created_at is None:
            log.warning("flow-alerts missing executed_at", extra={"symbol": symbol})
            return None

        return (
            ws_alert_id,
            _to_uuid(payload.get("rule_id")),
            payload.get("rule_name"),
            ticker,
            symbol,
            issue_type,
            parsed.expiry,
            parsed.strike,
            parsed.option_type,
            created_at,
            _ms_epoch_to_dt(payload.get("start_time")),
            _ms_epoch_to_dt(payload.get("end_time")),
            _to_decimal(payload.get("price")),
            _to_decimal(payload.get("underlying_price")),
            _to_decimal(payload.get("bid")),
            _to_decimal(payload.get("ask")),
            _to_int(payload.get("volume")),
            _to_int(payload.get("total_size")),
            _to_decimal(payload.get("total_premium")),
            _to_decimal(payload.get("total_ask_side_prem")),
            _to_decimal(payload.get("total_bid_side_prem")),
            _to_int(payload.get("open_interest")),
            _to_decimal(payload.get("volume_oi_ratio")),
            _to_int(payload.get("trade_count")),
            _to_int(payload.get("expiry_count")),
            _to_int(payload.get("ask_vol")),
            _to_int(payload.get("bid_vol")),
            _to_int(payload.get("no_side_vol")),
            _to_int(payload.get("mid_vol")),
            _to_int(payload.get("multi_vol")),
            _to_int(payload.get("stock_multi_vol")),
            _to_bool(payload.get("has_multileg")),
            _to_bool(payload.get("has_sweep")),
            _to_bool(payload.get("has_floor")),
            _to_bool(payload.get("has_singleleg")),
            _to_bool(payload.get("all_opening_trades")),
            payload.get("upstream_condition_details"),
            payload.get("exchanges"),
            payload.get("trade_ids"),
            payload.get("url"),
            payload,  # raw_payload — full original dict
        )

    async def _flush(self, rows: list[tuple]) -> None:
        await db.bulk_insert_ignore_conflict(
            table=_TABLE,
            columns=_COLUMNS,
            rows=rows,
            conflict_cols=_CONFLICT_COLS,
        )


# ----------------------------------------------------------------------
# Type coercion helpers. Everything below is defensive — UW can deliver
# a numeric field as int, float, or string of a number depending on
# which channel and which version of the wire format we're talking to.
# Returning None preserves "no value" semantics in Postgres.
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
        # Round float-y inputs rather than blowing up.
        return int(Decimal(str(v)))
    except (InvalidOperation, ValueError):
        return None


def _to_bool(v: Any) -> bool | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        lo = v.strip().lower()
        if lo in ("true", "t", "1", "yes"):
            return True
        if lo in ("false", "f", "0", "no"):
            return False
    if isinstance(v, (int, float)):
        return bool(v)
    return None


def _ms_epoch_to_dt(v: Any) -> datetime | None:
    if v is None or v == "":
        return None
    try:
        ms = int(Decimal(str(v)))
    except (InvalidOperation, ValueError):
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=UTC)


def _to_uuid(v: Any) -> UUID | None:
    """Parse a UUID, returning None on missing or malformed input.

    UW's WS payload normally emits well-formed UUIDs but a defensive
    parser keeps a single bad alert from poisoning the entire batch
    when asyncpg's ON CONFLICT path runs.
    """
    if v is None or v == "":
        return None
    if isinstance(v, UUID):
        return v
    try:
        return UUID(str(v))
    except (ValueError, AttributeError, TypeError):
        return None
