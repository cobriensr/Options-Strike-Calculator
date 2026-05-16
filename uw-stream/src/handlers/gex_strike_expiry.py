"""gex_strike_expiry:<TICKER> channel handler.

Maps each WS payload onto a row of the ``ws_gex_strike_expiry`` table.
This is the data source for the Strike Battle Map panel — see
docs/superpowers/specs/strike-battle-map-2026-05-03.md.

UW restates aggregated GEX intraday as late prints / cancellations
resolve (same root cause as the vega_flow_etf restatement we hit on
2026-05-01), so this handler UPSERTs on (ticker, expiry, strike,
ts_minute) — last write wins per minute. The natural tick rate of the
underlying channel is sub-second; truncating to minute keeps row volume
bounded while preserving enough resolution for the panel and any
subsequent analysis.

Reference payload (per the unusual-whales-websocket skill):

    {"ticker": "SPY", "expiry": "2025-01-24", "timestamp": 1726670426000,
     "strike": "290", "price": "562.96",
     "call_gamma_oi": "174792.59", "put_gamma_oi": "-1172037.66",
     "call_charm_oi": "85658181.72", "put_charm_oi": "-315259003.37",
     "call_vanna_oi": "-6103.51", "put_vanna_oi": "1337727.64",
     ...vol and ask/bid_vol fields per greek...}

One handler instance is shared across every ``gex_strike_expiry:<TICKER>``
subscription so backpressure and batching apply across the universe
(SPY + QQQ today, room for IWM / XLK / etc later).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

import db
from handlers.base import Handler
from logger_setup import rate_limited_log

_ET = ZoneInfo("America/New_York")


def _today_et() -> date:
    """Current ET trading date. Anchored to America/New_York so the
    daemon's UTC clock doesn't admit "tomorrow's" 0DTE rows between
    19:00 ET (00:00 UTC) and midnight ET.
    """
    return datetime.now(tz=_ET).date()

_TABLE = "ws_gex_strike_expiry"
# Must stay in sync with migration #111 in api/_lib/db-migrations.ts.
_CONFLICT_COLS = ["ticker", "expiry", "strike", "ts_minute"]

# Column order MUST match the tuple shape returned by `_transform`.
# `id` is BIGSERIAL and `received_at` defaults to NOW() in the DB; we
# omit them so they auto-populate.
_COLUMNS: list[str] = [
    "ticker",
    "expiry",
    "strike",
    "ts_minute",
    "price",
    "call_gamma_oi",
    "put_gamma_oi",
    "call_charm_oi",
    "put_charm_oi",
    "call_vanna_oi",
    "put_vanna_oi",
    "call_gamma_vol",
    "put_gamma_vol",
    "call_charm_vol",
    "put_charm_vol",
    "call_vanna_vol",
    "put_vanna_vol",
    "call_gamma_ask_vol",
    "call_gamma_bid_vol",
    "put_gamma_ask_vol",
    "put_gamma_bid_vol",
    "call_charm_ask_vol",
    "call_charm_bid_vol",
    "put_charm_ask_vol",
    "put_charm_bid_vol",
    "call_vanna_ask_vol",
    "call_vanna_bid_vol",
    "put_vanna_ask_vol",
    "put_vanna_bid_vol",
    "raw_payload",
]


class GexStrikeExpiryHandler(Handler):
    """gex_strike_expiry:<TICKER> channels → ws_gex_strike_expiry table.

    A single shared instance handles every per-ticker subscription so
    backpressure and batching span the whole universe rather than
    fragmenting per ticker.
    """

    def __init__(self) -> None:
        super().__init__(name="gex_strike_expiry")

    def _transform(self, payload: dict) -> tuple | None:
        ticker = payload.get("ticker")
        if not isinstance(ticker, str) or not ticker:
            rate_limited_log.warning(
                scope="gex_strike_expiry",
                kind="missing_ticker",
                message="gex_strike_expiry payload missing ticker",
                extra={"sample": str(payload)[:200]},
            )
            return None

        expiry = _to_date(payload.get("expiry"))
        if expiry is None:
            rate_limited_log.warning(
                scope="gex_strike_expiry",
                kind="missing_expiry",
                message="gex_strike_expiry missing or unparseable expiry",
                extra={"ticker": ticker, "raw_expiry": payload.get("expiry")},
            )
            return None

        # 0DTE-only ingest: the two readers of ws_gex_strike_expiry
        # (Greek Heatmap, Strike Battle Map) both consume today's
        # expiry only. UW pushes every active expiry on the
        # `gex_strike_expiry:<TICKER>` channel, so without this filter
        # we accumulate weekly/monthly expiries from days before they
        # become 0DTE — that's the bloat that drove the May 2026
        # retention spec
        # (docs/superpowers/specs/greek-heatmap-ws-retention-2026-05-15.md).
        if expiry != _today_et():
            rate_limited_log.warning(
                scope="gex_strike_expiry",
                kind="expiry_not_today",
                message="gex_strike_expiry rejecting non-0DTE expiry",
                extra={"ticker": ticker, "expiry": expiry.isoformat()},
            )
            return None

        strike = _to_decimal(payload.get("strike"))
        if strike is None:
            rate_limited_log.warning(
                scope="gex_strike_expiry",
                kind="missing_strike",
                message="gex_strike_expiry missing or unparseable strike",
                extra={"ticker": ticker, "raw_strike": payload.get("strike")},
            )
            return None

        ts_minute = _ms_epoch_to_minute(payload.get("timestamp"))
        if ts_minute is None:
            rate_limited_log.warning(
                scope="gex_strike_expiry",
                kind="missing_timestamp",
                message="gex_strike_expiry missing or unparseable timestamp",
                extra={"ticker": ticker, "raw_ts": payload.get("timestamp")},
            )
            return None

        return (
            ticker,
            expiry,
            strike,
            ts_minute,
            _to_decimal(payload.get("price")),
            _to_decimal(payload.get("call_gamma_oi")),
            _to_decimal(payload.get("put_gamma_oi")),
            _to_decimal(payload.get("call_charm_oi")),
            _to_decimal(payload.get("put_charm_oi")),
            _to_decimal(payload.get("call_vanna_oi")),
            _to_decimal(payload.get("put_vanna_oi")),
            _to_decimal(payload.get("call_gamma_vol")),
            _to_decimal(payload.get("put_gamma_vol")),
            _to_decimal(payload.get("call_charm_vol")),
            _to_decimal(payload.get("put_charm_vol")),
            _to_decimal(payload.get("call_vanna_vol")),
            _to_decimal(payload.get("put_vanna_vol")),
            _to_decimal(payload.get("call_gamma_ask_vol")),
            _to_decimal(payload.get("call_gamma_bid_vol")),
            _to_decimal(payload.get("put_gamma_ask_vol")),
            _to_decimal(payload.get("put_gamma_bid_vol")),
            _to_decimal(payload.get("call_charm_ask_vol")),
            _to_decimal(payload.get("call_charm_bid_vol")),
            _to_decimal(payload.get("put_charm_ask_vol")),
            _to_decimal(payload.get("put_charm_bid_vol")),
            _to_decimal(payload.get("call_vanna_ask_vol")),
            _to_decimal(payload.get("call_vanna_bid_vol")),
            _to_decimal(payload.get("put_vanna_ask_vol")),
            _to_decimal(payload.get("put_vanna_bid_vol")),
            payload,  # raw_payload — forward-compat against schema additions
        )

    async def _flush(self, rows: list[tuple]) -> int:
        # Deduplicate by conflict key BEFORE insert. UW pushes sub-second
        # updates within a single minute for the same (ticker, expiry,
        # strike), and the ts_minute truncation in `_transform` collapses
        # them onto the same row. Without this dedupe a batch of 500 can
        # contain multiple rows with the same (ticker, expiry, strike,
        # ts_minute) conflict key, and `ON CONFLICT DO UPDATE` then
        # throws "command cannot affect row a second time" because
        # Postgres refuses to apply the same row's UPDATE twice within a
        # single statement (Sentry issues 2C / 4K, 26+ events since
        # 2026-04-19). The handler's contract is already "last write
        # wins per minute," so keeping the LAST occurrence of each
        # conflict key here matches the existing semantics — we just
        # collapse intra-batch duplicates that the per-statement
        # constraint forbids.
        #
        # `dict[key] = row` overwrites on repeat assignment, so
        # iterating in arrival order naturally keeps the last write.
        dedup: dict[tuple, tuple] = {}
        for row in rows:
            dedup[(row[0], row[1], row[2], row[3])] = row
        deduped = list(dedup.values())

        # UPSERT: UW restates per-minute GEX as the trade tape settles,
        # so existing rows for the same (ticker, expiry, strike, minute)
        # must be overwritten with the latest values, not skipped.
        #
        # Sort rows by the conflict key BEFORE insert. The REST-side cron
        # `/api/cron/fetch-gex-strike-expiry-etfs` (which writes to the
        # same table on overlapping minutes) sorts its rows by strike
        # before insert. Without a matching sort here the two writers
        # acquire row locks in different orders → AB-BA deadlock,
        # surfaced as `NeonDbError: deadlock detected` (Sentry issue 4G)
        # on the cron and `asyncpg.protocol.bind_execute_many`
        # DeadlockDetectedError (issue 4M) on this side. Canonicalizing
        # the order here makes Postgres acquire locks in the same
        # sequence regardless of which writer arrives first.
        #
        # WS arrival order (the original `rows` ordering) carries no
        # data semantics — UPSERT is "last write wins per (ticker,
        # expiry, strike, minute)" — so re-ordering before flush is
        # safe.
        deduped.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
        return await db.bulk_upsert_replace(
            table=_TABLE,
            columns=_COLUMNS,
            rows=deduped,
            conflict_cols=_CONFLICT_COLS,
        )


# ----------------------------------------------------------------------
# Type coercion helpers — duplicated from option_trades.py per that
# handler's stated convention (short, trivial, self-contained).
# ----------------------------------------------------------------------


def _to_decimal(v: Any) -> Decimal | None:
    """Parse a UW JSON-stringy numeric. ``""`` and missing → None.

    UW emits Greek values as strings; the gex channel family also emits
    occasional ``""`` on fields that aren't computable for the bar
    (per the unusual-whales-websocket skill). Treat those as NULL rather
    than 0 so downstream queries can distinguish "absent" from "exactly
    zero exposure."
    """
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def _to_date(v: Any) -> date | None:
    """UW emits ``expiry`` as an ISO date string (YYYY-MM-DD)."""
    if not isinstance(v, str) or not v:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        return None


def _ms_epoch_to_minute(v: Any) -> datetime | None:
    """Convert a millisecond-epoch timestamp to a minute-truncated UTC dt.

    UW's gex_strike_expiry channel pushes sub-second updates; truncating
    to whole minutes is what makes the (ticker, expiry, strike, ts_minute)
    UPSERT key meaningful — every push within the same minute collapses
    onto the same row, so the table stores the *latest* value for each
    minute rather than every micro-update.
    """
    if v is None or v == "":
        return None
    try:
        ms = int(Decimal(str(v)))
    except (InvalidOperation, ValueError):
        return None
    dt = datetime.fromtimestamp(ms / 1000.0, tz=UTC)
    return dt.replace(second=0, microsecond=0)
