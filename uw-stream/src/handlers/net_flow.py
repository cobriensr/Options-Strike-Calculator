"""net_flow:<TICKER> channel handler.

Consumes per-tick net call/put premium + volume aggregates from the
``net_flow:<TICKER>`` UW WS channel and writes to
``ws_net_flow_per_ticker``. Input feed for the Lottery Net Flow
per-fire panel — see docs/superpowers/specs/lottery-net-flow-2026-05-03.md.

A single shared handler instance services every per-ticker
subscription so backpressure + batching apply across the universe
rather than fragmenting into one queue per ticker. Mirrors the
OptionTradesHandler shape exactly — see option_trades.py for
rationale.

Important semantic note (confirmed via UW's reference notebook
net_prem_ticks_dashboard_v2.ipynb): each emitted value is a per-tick
DELTA, NOT a running total. Storing raw deltas keeps the truth
single-sourced; cumulative chart values are computed at read time
via SUM(...) OVER (PARTITION BY ticker, date ORDER BY ts).

Reference WS payload (from UW docs):

    {"ticker": "SPY",
     "net_call_prem": "1716.00",
     "net_call_vol": 6,
     "net_put_prem": "1990.00",
     "net_put_vol": 17,
     "time": 1777300076003}
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import db
from handlers.base import Handler
from logger_setup import rate_limited_log

_TABLE = "ws_net_flow_per_ticker"
# Natural dedupe key — UW emits at most one tick per (ticker, ms).
_CONFLICT_COLS = ["ticker", "ts"]

# Column order MUST match the tuple shape returned by `_transform`.
# `id` is BIGSERIAL and `received_at` defaults to NOW() in the DB.
_COLUMNS: list[str] = [
    "ticker",
    "ts",
    "net_call_prem",
    "net_call_vol",
    "net_put_prem",
    "net_put_vol",
    "raw_payload",
]


class NetFlowHandler(Handler):
    """net_flow:<TICKER> channels → ws_net_flow_per_ticker table.

    Single shared instance across all per-ticker subscriptions.
    """

    def __init__(self) -> None:
        # Channel name is descriptive — the daemon registers this same
        # instance for every net_flow:<TICKER> entry in the channel→
        # handler map, so /metrics and Sentry tags use the family
        # name, not any individual ticker.
        super().__init__(name="net_flow")

    def _transform(self, payload: dict) -> tuple | None:
        ticker = payload.get("ticker")
        if not isinstance(ticker, str) or not ticker:
            rate_limited_log.warning(
                scope="net_flow",
                kind="missing_ticker",
                message="net_flow payload missing ticker",
                extra={"sample": str(payload)[:200]},
            )
            return None

        # WS gives ms-epoch int. UW's docs use `time`; defensive aliases
        # in case the key drifts.
        ts = _ms_epoch_to_dt(_first(payload, "time", "tape_time", "timestamp"))
        if ts is None:
            rate_limited_log.warning(
                scope="net_flow",
                kind="missing_time",
                message="net_flow missing time / tape_time",
                extra={"ticker": ticker, "sample": str(payload)[:200]},
            )
            return None

        net_call_prem = _to_decimal(payload.get("net_call_prem"))
        net_put_prem = _to_decimal(payload.get("net_put_prem"))
        net_call_vol = _to_int(payload.get("net_call_vol"))
        net_put_vol = _to_int(payload.get("net_put_vol"))
        if (
            net_call_prem is None
            or net_put_prem is None
            or net_call_vol is None
            or net_put_vol is None
        ):
            # All four are required by the schema (NOT NULL). Reject the
            # whole row rather than silently writing partial data.
            rate_limited_log.warning(
                scope="net_flow",
                kind="missing_numeric_field",
                message="net_flow missing required numeric field",
                extra={
                    "ticker": ticker,
                    "ncp": str(net_call_prem),
                    "ncv": net_call_vol,
                    "npp": str(net_put_prem),
                    "npv": net_put_vol,
                },
            )
            return None

        return (
            ticker,
            ts,
            net_call_prem,
            net_call_vol,
            net_put_prem,
            net_put_vol,
            payload,  # raw_payload — full original dict
        )

    async def _flush(self, rows: list[tuple]) -> int:
        return await db.bulk_insert_ignore_conflict(
            table=_TABLE,
            columns=_COLUMNS,
            rows=rows,
            conflict_cols=_CONFLICT_COLS,
        )


# ----------------------------------------------------------------------
# Type coercion helpers — mirrors handlers/option_trades.py. Duplicated
# rather than imported to keep handlers self-contained; the helpers are
# trivial enough that the duplication beats a shared module both files
# would have to import.
# ----------------------------------------------------------------------


def _first(payload: dict, *keys: str) -> Any:
    """Return the first non-None value among the given keys."""
    for k in keys:
        v = payload.get(k)
        if v is not None:
            return v
    return None


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


def _ms_epoch_to_dt(v: Any) -> datetime | None:
    if v is None or v == "":
        return None
    try:
        ms = int(Decimal(str(v)))
    except (InvalidOperation, ValueError):
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=UTC)
