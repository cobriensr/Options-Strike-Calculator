"""futures_blocks channel handler.

Stores CME block trades from UW's global ``futures_blocks`` websocket
channel in ``futures_blocks`` (API migration #196), one row per block.

Reference payload (UW channel docs, fetched 2026-10-28):

    {"sym": "ESZ6", "product": "ES", "exchange": "XCME",
     "trade_date": "2026-09-18", "executed_at": 1789741867000,
     "reported_at": 1789741912000, "price": "6612.25", "qty": "250",
     "sec_type": "FUT", "action": "new", "trade_id": 84213907,
     "strategy_link_id": null, "legs": [], "quote_bid": "6612.00",
     "quote_ask": "6612.25", "quote_ts": 1789741866950, "is_block": true}

A multi-leg (``MLEG``) block has ``price: null``, ``product: ""`` and its
legs in ``legs``. The REST ``/futures/flow?blocks_only=true`` probe of
2026-10-28 sent ISO-8601 times and ``product: null`` for the same fields,
so both forms are accepted.

Delivery rules (UW docs) and how this handler follows them:

- **Identity is ``(trade_id, exchange, trade_date)``**, because CME
  reuses a ``trade_id`` in later sessions. It is the table's primary key.
- **The newest message for a block replaces the earlier ones.** CME
  re-reports a block as ``update`` or ``delete``. ``_flush`` upserts
  through ``db.bulk_upsert_if_newer``, which replaces every column only
  when the incoming ``reported_at`` is at least the stored one, so a
  late-arriving older message can't overwrite a newer one.
- **A ``delete`` is a row state.** It replaces the row like any newer
  message, leaving ``action = 'delete'``. Nothing is ever hard-deleted.
- **Joining without access returns ``{"error": ...}``,** and the router
  forwards it here like data (``router.py``). ``_transform`` rejects it,
  logs a rate-limited warning every time, and sends one Sentry event per
  handler instance (one per process), so a lost add-on is loud but
  doesn't page on every frame.
- **Every product is stored** (spec D4 default), not only the six roots
  ``futures_trades`` bars.

Blocks carry ``qty`` and no ``size``/``side``, so they add nothing to the
``futures_bars`` order-flow columns.

Rejection rule: a frame missing an identity field (``trade_id``,
``exchange``, ``trade_date``, ``action``), or with any present field that
doesn't parse, is dropped with a rate-limited warning naming the field.
An optional field that is absent or null is stored as NULL. Numbers
arrive as JSON strings and are parsed to finite ``Decimal`` values,
rounded to 8 places and within their column's range, because one value
past ``NUMERIC(18,8)`` would fail the whole batch's INSERT. The first
rejection of each field per handler instance also goes to Sentry, since
a field that stops parsing usually means UW changed the wire format.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

import db
from handlers.base import Handler
from logger_setup import rate_limited_log
from sentry_setup import capture_message
from utils import timestamps

_TABLE = "futures_blocks"

# ``_to_row`` builds a value for every name here. received_at and
# updated_at are left to their column defaults; the upsert sets
# updated_at = now() on every applied update. raw_payload is the whole
# frame (README convention for per-message tables), replaced with the
# newest frame like every other non-key column.
_COLUMNS: list[str] = [
    "trade_id",
    "exchange",
    "trade_date",
    "sym",
    "product",
    "sec_type",
    "action",
    "price",
    "qty",
    "executed_at",
    "reported_at",
    "strategy_link_id",
    "legs",
    "quote_bid",
    "quote_ask",
    "quote_ts",
    "raw_payload",
]

# Migration #196: PRIMARY KEY (trade_id, exchange, trade_date).
_CONFLICT_COLS: list[str] = ["trade_id", "exchange", "trade_date"]

_ACTIONS: frozenset[str] = frozenset({"new", "update", "delete"})

# Column ranges: price and quote_* are NUMERIC(18,8), which holds
# |x| < 1e10; qty is NUMERIC(24,8), which holds |x| < 1e16. Both have
# scale 8 (UW sends at most 8 decimals). BIGINT tops out at 2**63 - 1.
_PRICE_LIMIT = Decimal("1e10")
_QTY_LIMIT = Decimal("1e16")
_SCALE = Decimal("1e-8")
_BIGINT_MAX = 2**63 - 1

_DIGITS = re.compile(r"[0-9]+")
_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


class _BadFieldError(ValueError):
    """A frame field that is missing or unusable. Carries the field name."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


class FuturesBlocksHandler(Handler):
    """futures_blocks global channel → futures_blocks table (upsert)."""

    name = "futures_blocks"

    def __init__(self) -> None:
        super().__init__(name="futures_blocks")
        self._error_frame_reported = False
        # Fields already reported to Sentry by this instance. Bounded by
        # the frame's field names.
        self._bad_fields_reported: set[str] = set()

    def _transform(self, payload: dict) -> tuple | None:
        if "error" in payload:
            self._reject_error_frame(payload)
            return None
        try:
            return _to_row(payload)
        except _BadFieldError as bad:
            self._reject_bad_field(payload, bad.field)
            return None

    def _reject_bad_field(self, payload: dict, field: str) -> None:
        """Warn on every rejection; send the first per field to Sentry.

        A field that suddenly stops parsing usually means UW changed the
        wire format, which drops every block until fixed. The
        rate-limited warning alone would never page, so the first
        rejection of each field per instance is captured too.
        """
        raw = repr(payload.get(field))[:80]
        rate_limited_log.warning(
            scope="futures_blocks",
            kind=f"bad_{field}",
            message=f"futures_blocks frame has a missing or invalid {field}",
            extra={"trade_id": repr(payload.get("trade_id"))[:40], "raw": raw},
        )
        if field in self._bad_fields_reported:
            return
        self._bad_fields_reported.add(field)
        capture_message(
            f"uw-stream futures_blocks frame rejected: missing or invalid {field}",
            level="warning",
            tags={"component": "handler", "channel": self.name},
            context={"field": field, "raw": raw},
        )

    def _reject_error_frame(self, payload: dict) -> None:
        error = repr(payload.get("error"))[:500]
        rate_limited_log.warning(
            scope="futures_blocks",
            kind="error_frame",
            message="futures_blocks error frame (join refused: no futures access?)",
            extra={"error": error},
        )
        if self._error_frame_reported:
            return
        self._error_frame_reported = True
        capture_message(
            "uw-stream futures_blocks error frame: no block trades will arrive",
            level="error",
            tags={"component": "handler", "channel": self.name},
            context={"error": error},
        )

    async def _flush(self, rows: list[tuple]) -> int:
        """Upsert the batch; returns rows inserted or replaced."""
        return await db.bulk_upsert_if_newer(
            table=_TABLE,
            columns=_COLUMNS,
            rows=rows,
            conflict_cols=_CONFLICT_COLS,
            version_col="reported_at",
            touch_col="updated_at",
        )


# ----------------------------------------------------------------------
# Frame → row. Each parser returns the column value, None for an absent
# optional field, or raises _BadFieldError.
# ----------------------------------------------------------------------


def _to_row(p: dict) -> tuple:
    values: dict[str, Any] = {
        "trade_id": _trade_id(p.get("trade_id")),
        "exchange": _exchange(p.get("exchange")),
        "trade_date": _trade_date(p.get("trade_date")),
        "sym": _opt_text(p, "sym"),
        # "" for an MLEG or an unknown root (docs); null on REST. NULL either way.
        "product": _opt_text(p, "product"),
        "sec_type": _opt_text(p, "sec_type"),
        "action": _action(p.get("action")),
        "price": _opt_number(p, "price", _PRICE_LIMIT),
        "qty": _opt_number(p, "qty", _QTY_LIMIT),
        "executed_at": _opt_time(p, "executed_at"),
        "reported_at": _opt_time(p, "reported_at"),
        # Docs: int or null, equal to trade_id when present.
        "strategy_link_id": _opt_bigint_id(p, "strategy_link_id"),
        "legs": _opt_legs(p),
        "quote_bid": _opt_number(p, "quote_bid", _PRICE_LIMIT),
        "quote_ask": _opt_number(p, "quote_ask", _PRICE_LIMIT),
        "quote_ts": _opt_time(p, "quote_ts"),
        # The frame as received; asyncpg's JSONB codec serializes it.
        "raw_payload": p,
    }
    return tuple(values[c] for c in _COLUMNS)


def _trade_id(v: Any) -> int:
    if v is None:
        raise _BadFieldError("trade_id")
    return _bigint_id(v, "trade_id")


def _opt_bigint_id(p: dict, field: str) -> int | None:
    v = p.get(field)
    return None if v is None else _bigint_id(v, field)


def _bigint_id(v: Any, field: str) -> int:
    """A non-negative BIGINT, from an int or a digit string. Never truncated."""
    if isinstance(v, int) and not isinstance(v, bool):
        n = v
    elif isinstance(v, str) and _DIGITS.fullmatch(v):
        n = int(v)
    else:
        raise _BadFieldError(field)
    if not 0 <= n <= _BIGINT_MAX:
        raise _BadFieldError(field)
    return n


def _exchange(v: Any) -> str:
    """Any string, including '' (UW sends '' when it has no MIC)."""
    if not isinstance(v, str):
        raise _BadFieldError("exchange")
    return v


def _trade_date(v: Any) -> date:
    if not isinstance(v, str) or not _ISO_DATE.fullmatch(v):
        raise _BadFieldError("trade_date")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise _BadFieldError("trade_date") from None


def _action(v: Any) -> str:
    # isinstance first: an unhashable value would raise on the set lookup.
    if not isinstance(v, str) or v not in _ACTIONS:
        raise _BadFieldError("action")
    return v


def _opt_text(p: dict, field: str) -> str | None:
    v = p.get(field)
    if v is None or v == "":
        return None
    if not isinstance(v, str):
        raise _BadFieldError(field)
    return v


def _opt_number(p: dict, field: str, limit: Decimal) -> Decimal | None:
    """A finite Decimal rounded to 8 places, with |x| < limit.

    ``Decimal`` parses "NaN", "sNaN" and "Infinity", so the finite check
    is explicit. The limit check also rejects "1e400", which is finite
    as a Decimal but fits no column. Rounding is half away from zero,
    as Postgres rounds NUMERIC input, and the limit is checked again
    afterwards because rounding can carry a value up to it
    (9999999999.999999999 → 1e10).
    """
    v = p.get(field)
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        raise _BadFieldError(field)
    try:
        d = Decimal(str(v))
    except (InvalidOperation, ValueError):
        raise _BadFieldError(field) from None
    if not d.is_finite() or abs(d) >= limit:
        raise _BadFieldError(field)
    d = d.quantize(_SCALE, rounding=ROUND_HALF_UP)
    if abs(d) >= limit:
        raise _BadFieldError(field)
    return d


def _opt_time(p: dict, field: str) -> datetime | None:
    """None when absent, else a UTC time from ``timestamps.parse_timestamp``
    (epoch ms or offset-aware ISO-8601, inside its plausibility window)."""
    v = p.get(field)
    if v is None or v == "":
        return None
    parsed = timestamps.parse_timestamp(v)
    if parsed is None:
        raise _BadFieldError(field)
    return parsed


def _opt_legs(p: dict) -> list | None:
    """The legs array as sent; asyncpg's JSONB codec serializes it."""
    v = p.get("legs")
    if v is None:
        return None
    if not isinstance(v, list):
        raise _BadFieldError("legs")
    return v
