"""option_trades:<TICKER> channel handler.

Consumes the per-trade option tick stream from the
``option_trades:<TICKER>`` UW WS channel and writes to ``ws_option_trades``.
Acts as the input feed for the Lottery Finder cron's v4 trigger detector
(see docs/superpowers/specs/lottery-finder-2026-05-02.md, Phase 1.4).

One handler instance is shared across every ``option_trades:<TICKER>``
channel — the daemon registers the same handler in the channel→handler
map for each subscribed ticker so they all flow through one queue and
one batch flush. This keeps DB write contention down and lets the
batch-by-size threshold accumulate cross-ticker flow.

With WS_REDUNDANT_OPTION_TRADES on (the default) each of those channels is
also joined on a second, mirror socket (``Settings.channel_shards``), so every
trade arrives twice. ``enqueue`` drops the second copy by (trade id, canceled
flag) before the queue and counts it; see ``OptionTradesHandler.enqueue`` and
docs/superpowers/specs/uw-stream-redundant-trade-sockets-2026-11-13.md.

Field-name compatibility: UW's option_trades payload is mostly stable
but field naming has shifted historically between ``option_chain``,
``option_chain_id``, and ``option_symbol`` for the OCC string; between
``executed_at`` and ``tape_time`` for the timestamp; and between ``oi``
and ``open_interest`` for OI. We accept whichever spelling we see and
normalise on the way in. The raw payload is preserved verbatim in
``raw_payload`` so a wire-format change can always be re-derived.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from time import monotonic
from typing import Any
from uuid import UUID

import db
from config import settings
from handlers.base import Handler
from logger_setup import log, rate_limited_log
from state import state
from utils import occ_parser

_TABLE = "ws_option_trades"
# Must stay in sync with the ws_option_trades_trade_id_uq unique index in
# migration #109 in api/_lib/db-migrations.ts.
_CONFLICT_COLS = ["ws_trade_id"]

# Column order MUST match the tuple shape returned by `_transform`.
# `id` is BIGSERIAL and `received_at` defaults to NOW() in the DB; we
# omit them so they auto-populate.
_COLUMNS: list[str] = [
    "ws_trade_id",
    "ticker",
    "option_chain",
    "option_type",
    "strike",
    "expiry",
    "executed_at",
    "price",
    "size",
    "underlying_price",
    "side",
    "implied_volatility",
    "delta",
    "open_interest",
    "canceled",
    "raw_payload",
]

# UW does NOT emit a top-level `side` field on the option_trades
# channel — the side classification is one of the entries inside the
# `tags` list (alongside an unrelated bullish/bearish/neutral tag).
# Map the tag → canonical side; anything we can't classify falls back
# to 'no_side' so we still record the print.
_TAG_TO_SIDE: dict[str, str] = {
    "ask_side": "ask",
    "bid_side": "bid",
    "mid_side": "mid",
}

# Redundant-socket dedupe (WS_REDUNDANT_OPTION_TRADES). Every per-ticker
# channel is joined on two sockets, so each trade arrives as two identical
# frames. ``enqueue`` keeps the (trade id, canceled flag) keys it has seen in
# two generations of dicts and rotates them lazily, on the first frame after
# the period is up: no timer task. A key is remembered for at least this many
# seconds and at most about twice that. At the open (~1,300 trades/s) the two
# generations hold ~160k keys.
_DEDUPE_ROTATE_S = 60.0
# How often the counters go to the log (checked at each rotation, so the real
# cadence is 5-6 minutes under traffic and nothing is logged in a quiet market).
_DEDUPE_LOG_INTERVAL_S = 300.0

_TradeKey = tuple[str, bool]


class OptionTradesHandler(Handler):
    """option_trades:<TICKER> channels → ws_option_trades table.

    A single shared instance handles every per-ticker subscription so
    backpressure and batching apply across the universe rather than
    fragmenting into one queue per ticker.

    The Interval B/A subclasses inherit ``enqueue`` and so the dedupe below:
    they aggregate premium in memory, and a duplicate frame that got through
    would be counted twice.
    """

    def __init__(self, name: str = "option_trades") -> None:
        # Channel name is descriptive — the daemon registers this same
        # instance for every option_trades:<TICKER> entry in the handler
        # table, so this name is what shows up in /metrics and Sentry
        # tags rather than any one ticker. Subclasses (e.g. the
        # SPXW-specific Interval B/A handler) override the name so
        # their dedicated queue shows up separately in /metrics.
        super().__init__(name=name)

        # Read once, like the base class's tuning: with the switch off no
        # second copy ever arrives, so nothing is keyed, counted or logged.
        self._dedupe = settings.ws_redundant_option_trades
        # Keys seen in the current / previous generation, each mapped to the
        # number of copies seen so far (1 = one socket delivered it so far).
        self._seen: dict[_TradeKey, int] = {}
        self._seen_prev: dict[_TradeKey, int] = {}
        now = monotonic()
        self._rotate_at = now + _DEDUPE_ROTATE_S
        self._log_at = now + _DEDUPE_LOG_INTERVAL_S
        # What the last log line already reported, for its interval figures.
        self._logged_dupes = 0
        self._logged_singles = 0

    async def enqueue(self, payload: dict) -> None:
        """Queue a payload unless it is the second copy of one already queued.

        The key is (``payload["id"]``, canceled flag), seen within the last
        60-120 s. Two copies of a trade are identical frames; keying on the
        canceled flag keeps a cancel sent under the same id visible, as it is
        without mirror sockets (the DB ignores it on ``ON CONFLICT
        (ws_trade_id)``). A payload without a usable id passes through
        unchanged, so ``_transform`` rejects and logs it as before.

        Known edge, not fixed: when the queue is full and the backpressure
        policy evicts the first copy after its key was recorded, the second
        copy is dropped as a duplicate and the trade is lost. That needs the
        overload the drop counters already report to Sentry.
        """
        if self._dedupe and self._is_duplicate(payload):
            return
        await super().enqueue(payload)

    def _is_duplicate(self, payload: dict) -> bool:
        """Record the payload's key; True if this is the second copy of it."""
        trade_id = payload.get("id")
        if not trade_id or not isinstance(trade_id, str):
            return False
        now = monotonic()
        if now >= self._rotate_at:
            self._rotate(now)
        key = (trade_id, _canceled_flag(payload.get("canceled")))

        copies = self._seen.get(key)
        if copies is not None:
            self._seen[key] = copies + 1
        else:
            copies = self._seen_prev.get(key)
            if copies is None:
                self._seen[key] = 1
                return False
            # The mirror can lag the first copy across a rotation. Count the
            # copy where the key lives so it is not retired as a single.
            self._seen_prev[key] = copies + 1
        state.handler(self.name).dupes_dropped += 1
        return True

    def _rotate(self, now: float) -> None:
        """Retire the older generation; the current one becomes the older one.

        Keys seen once in a retired generation add to ``single_copy``: one
        socket missed that trade. A rotation due for a whole period or more
        (no frames for a while) retires the current generation too, so a key
        older than the guaranteed 60 s is never matched against.
        """
        stale = now - self._rotate_at >= _DEDUPE_ROTATE_S
        singles = _count_singles(self._seen_prev)
        if stale:
            singles += _count_singles(self._seen)
            self._seen_prev = {}
        else:
            self._seen_prev = self._seen
        self._seen = {}
        self._rotate_at = now + _DEDUPE_ROTATE_S
        metrics = state.handler(self.name)
        metrics.single_copy += singles
        if now >= self._log_at:
            log.info(
                "option_trades redundant-socket dedupe",
                extra={
                    "handler": self.name,
                    "dupes_dropped": metrics.dupes_dropped,
                    "dupes_dropped_interval": metrics.dupes_dropped - self._logged_dupes,
                    "single_copy": metrics.single_copy,
                    "single_copy_interval": metrics.single_copy - self._logged_singles,
                },
            )
            self._logged_dupes = metrics.dupes_dropped
            self._logged_singles = metrics.single_copy
            self._log_at = now + _DEDUPE_LOG_INTERVAL_S

    def _transform(self, payload: dict) -> tuple | None:
        symbol = _first(payload, "option_chain", "option_chain_id", "option_symbol")
        if not isinstance(symbol, str):
            rate_limited_log.warning(
                scope="option_trades",
                kind="missing_occ_symbol",
                message="option_trades payload missing OCC symbol",
                extra={"sample": str(payload)[:200]},
            )
            return None

        # ws_trade_id (UW payload `id`) is the natural dedupe key —
        # NOT NULL UNIQUE in the table. Skip rows missing it rather
        # than risk a NULL violation downstream.
        ws_trade_id = _to_uuid(payload.get("id"))
        if ws_trade_id is None:
            rate_limited_log.warning(
                scope="option_trades",
                kind="missing_id",
                message="option_trades missing or malformed id",
                extra={"symbol": symbol, "raw_id": payload.get("id")},
            )
            return None

        try:
            parsed = occ_parser.parse(symbol)
        except ValueError as exc:
            rate_limited_log.warning(
                scope="option_trades",
                kind="occ_parse_failed",
                message="option_trades OCC parse failed",
                extra={"symbol": symbol, "err": str(exc)},
            )
            return None

        ticker = _first(payload, "underlying_symbol", "ticker", "symbol") or parsed.root

        # WS gives ms-epoch ints. Tape-time names vary across UW
        # endpoints — accept the common spellings.
        executed_at = _ms_epoch_to_dt(
            _first(payload, "executed_at", "tape_time", "timestamp"),
        )
        if executed_at is None:
            rate_limited_log.warning(
                scope="option_trades",
                kind="missing_executed_at",
                message="option_trades missing executed_at / tape_time",
                extra={"symbol": symbol},
            )
            return None

        price = _to_decimal(payload.get("price"))
        size = _to_int(payload.get("size"))
        if price is None or price <= 0 or size is None or size <= 0:
            # Non-positive trade fields are unusable — the v4 detector
            # filters them out anyway (`price > 0` upstream), so reject
            # at ingest to keep table noise down.
            rate_limited_log.warning(
                scope="option_trades",
                kind="non_positive_price_or_size",
                message="option_trades non-positive price/size",
                extra={"symbol": symbol, "price": str(price), "size": size},
            )
            return None

        side = _derive_side(payload.get("tags"))

        return (
            ws_trade_id,
            ticker,
            symbol,
            parsed.option_type,
            parsed.strike,
            parsed.expiry,
            executed_at,
            price,
            size,
            _to_decimal(payload.get("underlying_price")),
            side,
            _to_decimal(_first(payload, "implied_volatility", "iv")),
            _to_decimal(payload.get("delta")),
            _to_int(_first(payload, "open_interest", "oi")),
            _to_bool(payload.get("canceled")) or False,
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
# Type coercion helpers — mirrors handlers/flow_alerts.py. Duplicated
# here rather than imported to keep each handler self-contained; the
# helpers are short and trivial enough that the duplication beats a
# shared module that both files would have to import.
# ----------------------------------------------------------------------


def _first(payload: dict, *keys: str) -> Any:
    """Return the first non-None value among the given keys."""
    for k in keys:
        v = payload.get(k)
        if v is not None:
            return v
    return None


def _canceled_flag(raw: Any) -> bool:
    """The ``canceled`` value as ``_transform`` stores it (absent / unreadable → False).

    The usual wire values, absent and JSON false, skip the ``_to_bool`` call:
    this runs on every frame.
    """
    if raw is None or raw is False:
        return False
    return _to_bool(raw) or False


def _count_singles(generation: dict[_TradeKey, int]) -> int:
    """Keys of a retired generation that only one socket delivered."""
    return sum(1 for copies in generation.values() if copies == 1)


def _derive_side(tags: Any) -> str:
    """Pull the canonical side from UW's `tags` list.

    UW encodes side as one of `ask_side` / `bid_side` / `mid_side`
    inside the per-print `tags` array (e.g. `['bid_side', 'bearish']`).
    Returns 'no_side' when no recognised tag is present rather than
    rejecting the row — the CHECK constraint accepts 'no_side', and a
    print missing a side classification is still useful tape data.
    """
    if not isinstance(tags, list):
        return "no_side"
    for tag in tags:
        if isinstance(tag, str) and tag in _TAG_TO_SIDE:
            return _TAG_TO_SIDE[tag]
    return "no_side"


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
    if v is None or v == "":
        return None
    if isinstance(v, UUID):
        return v
    try:
        return UUID(str(v))
    except (ValueError, AttributeError, TypeError):
        return None
