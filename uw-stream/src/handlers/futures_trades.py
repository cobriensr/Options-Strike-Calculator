"""futures_trades channel handler.

Aggregates the global CME futures trade firehose into 1-minute OHLCV
bars in the ``futures_bars`` table (migration #42). This replaces the
Databento-fed Railway ``sidecar`` as the source of those bars; the
schema is unchanged, so downstream readers need no migration.

Reference payload (captured live 2026-09-08):

    {"sym": "ESU6", "product": "ES", "exchange": "XCME",
     "executed_at": 1788847011311, "price": "7706.000000000", "size": 3,
     "side": "sell", "nbbo_bid": "7705.750000000",
     "nbbo_ask": "7706.000000000", "trade_id": 2787552,
     "is_block": false}

``executed_at`` is **epoch milliseconds (int)**, verified against the
live feed: 1788847011311 decoded to 2026-09-08T05:56:51.311Z against a
wall clock of 05:57:51Z. The epoch-seconds reading (1970-01-21) is
implausible, so the unit is unambiguous. ``_parse_executed_at`` still
accepts an ISO-8601 string as a defensive fallback — UW uses ISO on the
``off_lit_trades`` channel, so a future format flip is plausible and
would otherwise be a silent total blackout.

Why the GLOBAL channel instead of six ``futures:<CONTRACT>`` joins:
one subscription instead of six against UW's 50-channel-per-connection
cap (``PER_CONN_MAX`` in config.py), and contract roll (ESU6 → ESZ6)
needs no expiry calendar.

Filtering rationale (in handler order):

1. ``product`` EQUALITY against the six target roots. This is
   deliberately NOT a prefix match: the micro contracts are separate
   product values (``MES``, ``MNQ``, ``MGC``, ``MYM``, ``M2K``) that a
   ``startswith`` test would fold into their full-size parents and
   corrupt both volume and range. Applied in ``enqueue`` so the ~80% of
   the firehose we don't want never takes a queue slot.
2. **De-duplication on (sym, trade_id).** UW re-delivers every futures
   print 2-11 times. Measured over a 90s live window on 2026-09-08,
   naive summing inflated volume by 1.93x (ZN) to 3.09x (ES); every
   distinct ES trade_id arrived at least twice, so this is the steady
   state, not a reconnect artifact. Duplicates arrive fast (p50 0.1ms,
   max 0.52s observed) and always carry the same ``executed_at``, so
   they always land in the same minute bucket as their original — a
   per-(product, minute) seen-set catches them all and is evicted with
   the bucket. ``trade_id`` was never observed colliding across syms,
   but we key on the pair anyway since it is only documented unique
   within a contract.
3. **Front-month collapse.** ``futures_bars.symbol`` holds the ROOT
   (``'ES'``), but the global feed carries every contract month. Within
   each product we keep only the ``sym`` with the greatest cumulative
   volume so far in the session. Volume-based selection rolls itself at
   the real liquidity crossover and needs no expiry calendar. The
   leader is snapshotted per (product, minute) as prints arrive rather
   than resolved at emit time, so a session rollover between the last
   print of a minute and its flush can't retroactively blank that
   minute's bar.

Bar aggregation is stateful, which does not fit ``_transform``'s 1:1
payload→row contract. So ``_transform`` normalizes a single print and
``_flush`` folds the batch into an in-handler accumulator, emitting
only minutes strictly older than the newest minute seen for that
product. That completed-minutes-only rule is what makes
``ON CONFLICT DO NOTHING`` correct: a partial bar written early would
be locked in permanently, since DO NOTHING never revises it.

Consequences worth knowing:

- The newest minute per product is intentionally never written at
  shutdown. Losing one in-progress minute per deploy is the correct
  trade against permanently persisting a truncated bar.
- A minute in which the front month printed nothing but a back month
  did is emitted as a GAP, logged under ``kind="front_sym_absent"``.
  Substituting the back month's price would inject a carry-basis spike
  into the root series that DO NOTHING could never revise.
- ``write_attempted`` (bumped by ``_safe_flush`` with the incoming row
  count) counts per-trade prints while ``write_count`` counts emitted
  bars, so for this channel the two are not comparable and their ratio
  is not a dedup rate.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, NamedTuple

import db
from handlers.base import Handler
from logger_setup import rate_limited_log

_TABLE = "futures_bars"

# Column order MUST match the tuple shape emitted by _collect_completed.
# id (BIGSERIAL) auto-populates; we omit it from the INSERT entirely.
_COLUMNS: list[str] = ["symbol", "ts", "open", "high", "low", "close", "volume"]

# Per migration #42: UNIQUE(symbol, ts).
_CONFLICT_COLS: list[str] = ["symbol", "ts"]

# The six roots that previously came from Databento. EQUALITY test only
# — see filtering rationale #1 in the module docstring. DX (ICE-listed)
# and VX (Cboe CFE) are deliberately absent: neither appears on this
# CME feed (verified over a 90s live probe).
_TARGET_PRODUCTS: frozenset[str] = frozenset({"ES", "NQ", "RTY", "CL", "GC", "ZN"})

# Floor for epoch-ms timestamps: 2000-01-01. Its real job is catching a
# units flip — epoch SECONDS read as ms lands in 1970 and falls below
# this, so we reject loudly instead of writing bars stamped 1970 that
# would silently poison every reader.
_MIN_PLAUSIBLE_MS = 946_684_800_000

# Ceiling tolerance ABOVE the wall clock. See _parse_executed_at for why
# the upper bound has to track "now" rather than a fixed far-future
# constant. Sized for clock skew between UW's stamp and ours, nothing
# more — a genuine trade is never minutes in the future.
_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

# Bare integer string, for the case where UW ever quotes the epoch the
# way it already quotes price/nbbo. Checked before the ISO parse.
_EPOCH_MS_RE = re.compile(r"[+-]?\d+")


class _Print(NamedTuple):
    """A normalized single futures print — the unit ``_transform`` emits.

    NOT a database row: this handler aggregates, so the DB row shape is
    produced later by ``_collect_completed``. It is a tuple subclass, so
    it still satisfies the base ``Handler._transform`` contract while
    keeping the field access in ``_flush`` readable.
    """

    product: str
    sym: str
    minute_ts: datetime
    price: Decimal
    size: int
    trade_id: int | None
    executed_at: datetime


@dataclass
class _Bar:
    """Mutable OHLCV accumulator for one (product, minute, sym)."""

    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    first_at: datetime
    last_at: datetime

    def add(self, price: Decimal, size: int, executed_at: datetime) -> None:
        # open/close track earliest/latest by executed_at, NOT by arrival
        # order — UW can deliver a print slightly out of sequence and the
        # bar must not care. ``>=`` on the close so that among prints
        # sharing a timestamp the last one folded in wins, matching the
        # "latest print" definition for a same-millisecond cluster.
        if executed_at < self.first_at:
            self.first_at = executed_at
            self.open = price
        if executed_at >= self.last_at:
            self.last_at = executed_at
            self.close = price
        if price > self.high:
            self.high = price
        if price < self.low:
            self.low = price
        self.volume += size


class FuturesTradesHandler(Handler):
    """futures_trades global firehose → futures_bars 1-minute OHLCV."""

    name = "futures_trades"

    def __init__(self) -> None:
        super().__init__(name="futures_trades")
        # (product, minute_ts, sym) -> accumulating bar. Keyed per-sym so
        # front-month selection can pick a contract's bar at emit time
        # without having polluted it with other months' prints.
        self._bars: dict[tuple[str, datetime, str], _Bar] = {}
        # product -> newest minute observed. Defines "completed": every
        # minute strictly older than this one is done receiving prints.
        self._newest_minute: dict[str, datetime] = {}
        # product -> {sym: cumulative deduped session volume}.
        self._session_volume: dict[str, dict[str, int]] = {}
        # (product, minute_ts) -> front-month sym as of that minute's last
        # print. Snapshotted at ingest so a session roll can't retroactively
        # reassign an already-accumulated minute to a different contract.
        self._front_sym: dict[tuple[str, datetime], str] = {}
        # (product, minute_ts) -> {(sym, trade_id)} already counted.
        self._seen: dict[tuple[str, datetime], set[tuple[str, int]]] = {}
        # UTC session date the volume tally belongs to.
        self._session_date: date | None = None

    # ------------------------------------------------------------------
    # Producer side.
    # ------------------------------------------------------------------
    async def enqueue(self, payload: dict) -> None:
        """Short-circuit non-target products BEFORE the queue.

        futures_trades is the global CME firehose (~72-80 frames/s
        overnight, every product and every contract month). Our six
        roots are a minority of that; over a 90s live probe the micros
        alone (MNQ/MGC/MES) outnumbered them. If we relied on
        ``_transform``'s product check alone, every unwanted payload
        would still take a queue slot, and on a drain hiccup the bounded
        queue would fill with ZS/6E/YM prints while drop_oldest evicted
        legitimate ES prints queued behind them.

        Non-target payloads are not "dropped" — they were never wanted,
        so we do NOT increment drop_count for them. The ``_transform``
        check stays as a defensive double-guard.
        """
        if payload.get("product") not in _TARGET_PRODUCTS:
            return
        await super().enqueue(payload)

    # ------------------------------------------------------------------
    # Stateless normalization.
    # ------------------------------------------------------------------
    def _transform(self, payload: dict) -> _Print | None:
        # 1. Product equality filter — defensive double-guard; enqueue()
        # already filtered the firehose. NEVER loosen this to a prefix
        # match: "MES".startswith("ES") is False but "ES" is a prefix of
        # nothing we want either way, and a prefix test in the other
        # direction would swallow the micros.
        product = payload.get("product")
        if product not in _TARGET_PRODUCTS:
            return None

        # 2. Contract symbol — required for front-month selection and as
        # half of the dedup key.
        sym = payload.get("sym")
        if not isinstance(sym, str) or not sym:
            rate_limited_log.warning(
                scope="futures_trades",
                kind="missing_sym",
                message="futures_trades print missing sym",
                extra={"product": product},
            )
            return None

        # 3. Timestamp — epoch-ms per the live feed; drives both the
        # minute bucket and open/close ordering.
        executed_at = _parse_executed_at(payload.get("executed_at"))
        if executed_at is None:
            rate_limited_log.warning(
                scope="futures_trades",
                kind="bad_executed_at",
                message="futures_trades missing or implausible executed_at",
                extra={
                    "product": product,
                    "sym": sym,
                    "raw": repr(payload.get("executed_at"))[:80],
                },
            )
            return None

        # 4. Numerics. price/nbbo_* arrive as JSON STRINGS with 9 decimal
        # places ("7706.000000000"); Decimal keeps high/low comparisons
        # numeric so '999.00' can never sort above '1000.00'.
        price = _to_decimal(payload.get("price"))
        size = _to_int(payload.get("size"))
        if price is None or size is None or price <= 0 or size <= 0:
            rate_limited_log.warning(
                scope="futures_trades",
                kind="invalid_price_or_size",
                message="futures_trades print has invalid price/size",
                extra={
                    "product": product,
                    "sym": sym,
                    "price": payload.get("price"),
                    "size": payload.get("size"),
                },
            )
            return None

        return _Print(
            product=product,
            sym=sym,
            minute_ts=_floor_to_minute(executed_at),
            price=price,
            size=size,
            trade_id=_to_int(payload.get("trade_id")),
            executed_at=executed_at,
        )

    # ------------------------------------------------------------------
    # Stateful aggregation.
    # ------------------------------------------------------------------
    async def _flush(self, rows: list[tuple]) -> int:
        """Fold the batch into the accumulator, write completed minutes.

        Returns the number of BARS the database accepted — not the
        number of prints consumed. A batch that only extends in-progress
        minutes legitimately writes nothing and returns 0.
        """
        for row in rows:
            self._ingest(row)

        completed = self._collect_completed()
        if not completed:
            return 0

        return await db.bulk_insert_ignore_conflict(
            table=_TABLE,
            columns=_COLUMNS,
            rows=completed,
            conflict_cols=_CONFLICT_COLS,
        )

    def _ingest(self, print_: _Print) -> None:
        """Fold one print into the accumulator (dedup, tally, OHLCV)."""
        self._roll_session(print_.minute_ts.date())

        minute_key = (print_.product, print_.minute_ts)

        # Dedup FIRST — before the volume tally, so a heavily re-delivered
        # back month can't win front-month selection on phantom volume.
        # A print with no trade_id can't be dedup-keyed; count it rather
        # than collapsing every such print into one.
        if print_.trade_id is not None:
            seen = self._seen.setdefault(minute_key, set())
            dedup_key = (print_.sym, print_.trade_id)
            if dedup_key in seen:
                return
            seen.add(dedup_key)
        else:
            # An unparseable/absent trade_id can't be dedup-keyed, so this
            # print bypasses suppression entirely. Since UW re-delivers
            # every futures print 2-11x, a feed-wide trade_id format
            # change would silently re-inflate volume by that same factor
            # — the single worst thing that can happen to this handler.
            # Counting the print is still right (collapsing every id-less
            # print into one would be worse), but it must not be quiet.
            rate_limited_log.warning(
                scope="futures_trades",
                kind="missing_trade_id",
                message=(
                    "futures_trades print has no usable trade_id; "
                    "duplicate suppression is inactive for it"
                ),
                extra={"product": print_.product, "sym": print_.sym},
            )

        tally = self._session_volume.setdefault(print_.product, {})
        tally[print_.sym] = tally.get(print_.sym, 0) + print_.size

        bar_key = (print_.product, print_.minute_ts, print_.sym)
        bar = self._bars.get(bar_key)
        if bar is None:
            self._bars[bar_key] = _Bar(
                open=print_.price,
                high=print_.price,
                low=print_.price,
                close=print_.price,
                volume=print_.size,
                first_at=print_.executed_at,
                last_at=print_.executed_at,
            )
        else:
            bar.add(print_.price, print_.size, print_.executed_at)

        # Snapshot the current session leader for this minute. Recomputed
        # on every print, so the value that survives is the leader as of
        # the minute's last print.
        self._front_sym[minute_key] = max(
            tally.items(), key=lambda kv: (kv[1], kv[0])
        )[0]

        newest = self._newest_minute.get(print_.product)
        if newest is None or print_.minute_ts > newest:
            self._newest_minute[print_.product] = print_.minute_ts

    def _roll_session(self, day: date) -> None:
        """Clear the front-month volume tally on a new UTC session day.

        Without this, yesterday's front month keeps its cumulative lead
        into a new session and would stay "front" through the whole roll
        window even after the market has moved on.

        Only a strictly NEWER date rolls the tally, so a late print from
        the previous session can't wipe the current day's tally. Such a
        straggler is folded into the current tally instead; it is a
        handful of lots against a session's worth, and never enough to
        change the argmax.
        """
        if self._session_date is None:
            self._session_date = day
            return
        if day > self._session_date:
            self._session_date = day
            self._session_volume.clear()

    def _collect_completed(self) -> list[tuple]:
        """Emit + evict every minute strictly older than its product's newest.

        The newest minute per product is deliberately retained: it is
        still receiving prints, and writing it now would persist a
        partial bar that ``ON CONFLICT DO NOTHING`` could never revise.
        """
        completed: dict[tuple[str, datetime], list[str]] = defaultdict(list)
        for product, minute_ts, sym in self._bars:
            newest = self._newest_minute.get(product)
            if newest is not None and minute_ts < newest:
                completed[(product, minute_ts)].append(sym)

        out: list[tuple] = []
        # Sorted so bars are written in (product, time) order — keeps the
        # multi-row INSERT's lock acquisition deterministic and makes the
        # emitted sequence reproducible for tests and log reading.
        for (product, minute_ts), syms in sorted(completed.items()):
            front = self._front_sym.get((product, minute_ts))
            bar = self._bars.get((product, minute_ts, front)) if front else None
            if bar is not None:
                out.append(
                    (
                        product,  # symbol column holds the ROOT, not the contract
                        minute_ts,
                        bar.open,
                        bar.high,
                        bar.low,
                        bar.close,
                        bar.volume,
                    )
                )
            else:
                # The session's front month printed nothing in this
                # minute while a back month did, so there is no
                # front-month bar to emit and the minute becomes a gap.
                #
                # We deliberately do NOT fall back to the back month's
                # bar. ``futures_bars.symbol`` is one continuous ROOT
                # series, and back months trade at a carry basis to the
                # front (ES months sit tens of points apart), so writing
                # ESZ6's price into the 'ES' series would inject a fake
                # spike — permanently, since ON CONFLICT DO NOTHING
                # never revises it. A missing minute is strictly safer
                # for range/return features than a wrong one, and
                # readers already tolerate gaps (the overnight tape is
                # sparse). The real defect this guards is the SILENCE:
                # without this log a dropped minute is indistinguishable
                # from a genuinely untraded one.
                rate_limited_log.warning(
                    scope="futures_trades",
                    kind="front_sym_absent",
                    message=(
                        "front-month contract had no prints in a "
                        "completed minute; bar skipped"
                    ),
                    extra={
                        "product": product,
                        "minute_ts": minute_ts.isoformat(),
                        "front_sym": front,
                        "syms_present": sorted(syms),
                    },
                )
            # Evict EVERY contract's state for this minute, not just the
            # front month — the back months are what would otherwise leak.
            for sym in syms:
                del self._bars[(product, minute_ts, sym)]
            self._front_sym.pop((product, minute_ts), None)
            self._seen.pop((product, minute_ts), None)

        return out


# ----------------------------------------------------------------------
# Helpers — defensive coercion. Returning None means "unusable print";
# every caller drops the row rather than substituting a default, so a
# malformed payload can never silently distort a bar.
# ----------------------------------------------------------------------


def _to_decimal(v: Any) -> Decimal | None:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def _to_int(v: Any) -> int | None:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        return int(Decimal(str(v)))
    except (InvalidOperation, ValueError):
        return None


def _parse_executed_at(v: Any) -> datetime | None:
    """Parse ``executed_at`` to a UTC-aware datetime.

    Primary format is epoch MILLISECONDS as a JSON int — verified
    against the live feed on 2026-09-08 (see module docstring). A
    numeric string and an ISO-8601 string are both accepted as
    defensive fallbacks so a UW format change degrades rather than
    blacking the channel out.
    """
    if v is None or isinstance(v, bool):
        return None

    ms: int | None = None
    if isinstance(v, int):
        ms = v
    elif isinstance(v, float):
        ms = int(v)
    elif isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        if _EPOCH_MS_RE.fullmatch(s):
            ms = int(s)
        else:
            try:
                dt = datetime.fromisoformat(s)
            except ValueError:
                return None
            # A naive timestamp has no defensible interpretation here —
            # guessing UTC vs exchange-local would shift bars by hours.
            if dt.tzinfo is None:
                return None
            # Converge on epoch-ms rather than returning early, so the
            # ISO path gets the SAME plausibility bounds as the numeric
            # path. It used to return here after a bare year >= 2000
            # check, which skipped the upper bound entirely.
            ms = int(dt.timestamp() * 1000)
    else:
        return None

    if ms < _MIN_PLAUSIBLE_MS:
        return None
    # The upper bound tracks the WALL CLOCK, not a fixed far-future
    # constant. A single print stamped years ahead but inside a static
    # window would pin ``_newest_minute`` for that product for the
    # lifetime of the process: every subsequent real minute would then
    # read as "completed" and be written as a one-print PARTIAL bar that
    # ON CONFLICT DO NOTHING can never revise. It would also freeze
    # ``_session_date`` in the future, permanently disabling the
    # front-month roll. One bad frame, unbounded corruption — so bound
    # against now, allowing only clock skew.
    if ms > _now_ms() + _MAX_FUTURE_SKEW_MS:
        return None
    return datetime.fromtimestamp(ms / 1000, UTC)


def _now_ms() -> int:
    """Wall clock as epoch ms.

    A named seam so tests can pin "now" — the future-timestamp bound in
    ``_parse_executed_at`` is otherwise untestable without sleeping.
    """
    return int(datetime.now(UTC).timestamp() * 1000)


def _floor_to_minute(dt: datetime) -> datetime:
    """Truncate a UTC-aware datetime to its minute."""
    return dt.replace(second=0, microsecond=0)
