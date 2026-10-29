"""futures_trades channel handler.

Aggregates the global CME futures trade firehose into 1-minute OHLCV
bars in the ``futures_bars`` table (migration #42). This replaces the
Databento-fed Railway ``sidecar`` as the source of those bars. Each bar
also carries aggressor order flow (spec Phase 2): ``buy_volume``,
``sell_volume``, ``buy_prints`` and ``sell_prints``.

Reference payload (captured live 2026-09-08):

    {"sym": "ESU6", "product": "ES", "exchange": "XCME",
     "executed_at": 1788847011311, "price": "7706.000000000", "size": 3,
     "side": "sell", "nbbo_bid": "7705.750000000",
     "nbbo_ask": "7706.000000000", "trade_id": 2787552,
     "is_block": false}

Those 11 keys are the whole websocket frame (Phase 0b capture,
2026-10-28). There is no ``is_spread`` key and no event fields; those
exist only on REST. Block frames (``"is_block": true``) carry ``qty`` in
place of ``size`` and no ``side``.

Fields used beyond OHLCV:

- ``side`` is the exchange aggressor flag: ``"buy"``, ``"sell"`` or
  ``"none"``, case-sensitive. It agreed with a tick test on 99.1% of
  price-changing ES prints (REST probe, 2026-10-28). Any other value, or
  no key, is unknown.
- ``nbbo_bid``/``nbbo_ask`` are mostly post-trade quotes, so they are
  never used to classify a print.

Order-flow columns follow the NULL vs 0 rule: NULL = unknown, 0 = known
to be none. A bar in which no print carried a known side writes NULL for
all four. Otherwise ``buy``/``sell`` prints add to the matching volume
and print count, and ``none`` or unknown prints count only toward
``volume``, so ``buy_volume + sell_volume <= volume``.

``executed_at`` is **epoch milliseconds (int)**, verified against the
live feed: 1788847011311 decoded to 2026-09-08T05:56:51.311Z against a
wall clock of 05:57:51Z. The epoch-seconds reading (1970-01-21) is
implausible, so the unit is unambiguous. ``timestamps.parse_timestamp`` still
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
2. **Outright contracts only, skipped quietly (no warning).** A print is
   dropped when ``is_block`` is true (Phase 4 stores blocks from the
   ``futures_blocks`` channel), when ``is_spread`` is true (REST-only
   today, kept for a future frame change), or when its ``sym`` is not an
   outright of its product: root + CME month code + one- or two-digit
   year (``ESZ6``, ``ESZ26``; not ``ESZ6-ESH7``, ``ESZ6:ESH7``, ``UD:...``).
   A spread is its own sym, so counted it could win the front-month
   argmax and write a spread price into the root series.
3. **Late prints are dropped**, before the dedup and the tally: any
   print at or before the newest emitted minute, including an interior
   minute that never had a bar (the gap repair refills it). An emitted
   minute's seen-set (4) was evicted with it, so a late re-delivered copy
   can't be deduped; let through, it would inflate the front-month tally
   and build a one-print bar that DO NOTHING discards. Logged at info as
   ``kind="late_print_dropped"`` with a running count, at most once per
   60s window.
4. **De-duplication on (sym, trade_id).** UW re-delivers every futures
   print 2-11 times. Measured over a 90s live window on 2026-09-08,
   naive summing inflated volume by 1.93x (ZN) to 3.09x (ES); every
   distinct ES trade_id arrived at least twice, so this is the steady
   state, not a reconnect artifact. Duplicates arrive fast (p50 0.1ms,
   max 0.52s observed) and always carry the same ``executed_at``, so
   they always land in the same minute bucket as their original — a
   per-(product, minute) seen-set catches them all and is evicted with
   the bucket. ``trade_id`` was never observed colliding across syms,
   but we key on the pair anyway since it is only documented unique
   within a contract. The first copy wins, side included.
5. **Front-month collapse.** ``futures_bars.symbol`` holds the ROOT
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

import math
import re
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, NamedTuple

import db
from handlers.base import Handler
from logger_setup import MALFORMED_PAYLOAD_LOG_INTERVAL_S, log, rate_limited_log
from utils import timestamps

_TABLE = "futures_bars"

# Column order MUST match the tuple shape emitted by _collect_completed.
# id (BIGSERIAL) auto-populates; we omit it from the INSERT entirely.
# The four order-flow columns are nullable (api migration, spec Phase 2):
# NULL = unknown, 0 = known to be none.
_COLUMNS: list[str] = [
    "symbol",
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "buy_volume",
    "sell_volume",
    "buy_prints",
    "sell_prints",
]

# UW's documented ``side`` values, case-sensitive. Anything else (absent,
# null, another spelling) is unknown and never coerced into a side.
_SIDES: frozenset[str] = frozenset({"buy", "sell", "none"})

# Per migration #42: UNIQUE(symbol, ts).
_CONFLICT_COLS: list[str] = ["symbol", "ts"]

# The six roots that previously came from Databento. EQUALITY test only
# — see filtering rationale #1 in the module docstring. DX (ICE-listed)
# and VX (Cboe CFE) are deliberately absent: neither appears on this
# CME feed (verified over a 90s live probe).
_TARGET_PRODUCTS: frozenset[str] = frozenset({"ES", "NQ", "RTY", "CL", "GC", "ZN"})

# An outright contract sym: the product root, one CME month code, and a
# one- or two-digit year (ESZ6, ESZ26). Websocket frames carry no
# ``is_spread`` key (Phase 0b capture, 2026-10-28), so this shape test is
# what keeps spread syms (ESZ6-ESH7, ESZ6:ESH7, UD:...) out of the bars.
# ``fullmatch`` rather than ``^...$``: ``$`` also matches before a trailing
# newline. ``[0-9]`` rather than ``\d``, which matches any Unicode digit.
_OUTRIGHT_SYM: dict[str, re.Pattern[str]] = {
    product: re.compile(rf"{re.escape(product)}[FGHJKMNQUVXZ][0-9]{{1,2}}")
    for product in _TARGET_PRODUCTS
}

# TEMPORARY (spec Phase 0b): remove after one session
# Raw-frame capture for websocket probes P1 (which keys a frame carries)
# and P2 (how re-delivered copies of one print differ). Sampling is on
# trade_id, not on arrival, so every copy of a sampled print is logged.
_CAPTURE_PRODUCTS: frozenset[str] = frozenset({"ES", "NQ"})
_CAPTURE_MODULO: int = 500


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
    # "buy" / "sell" / "none", or None when the frame carried no usable side.
    side: str | None


@dataclass
class _Bar:
    """Mutable OHLCV + aggressor-flow accumulator for one (product, minute, sym)."""

    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    first_at: datetime
    last_at: datetime
    buy_volume: int = 0
    sell_volume: int = 0
    buy_prints: int = 0
    sell_prints: int = 0
    # True once any print in the bar carried a known side ("none"
    # included). False means the flow is unknown, so it is written as
    # NULL rather than as a misleading 0.
    side_seen: bool = False

    def flow(self) -> tuple[int | None, int | None, int | None, int | None]:
        """The four order-flow column values, in ``_COLUMNS`` order."""
        if not self.side_seen:
            return (None, None, None, None)
        return (self.buy_volume, self.sell_volume, self.buy_prints, self.sell_prints)

    def add(self, price: Decimal, size: int, executed_at: datetime, side: str | None) -> None:
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
        # "none" and unknown prints count only toward volume, so
        # buy + sell <= volume and the remainder is unclassified.
        if side is not None:
            self.side_seen = True
        if side == "buy":
            self.buy_volume += size
            self.buy_prints += 1
        elif side == "sell":
            self.sell_volume += size
            self.sell_prints += 1


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
        # product -> newest minute already emitted (written or skipped as a
        # gap). Prints at or before it are dropped in ``_ingest``: that
        # minute's dedup set is gone, so they can't be deduped, and DO
        # NOTHING would discard any bar they built. One entry per product.
        self._emitted_through: dict[str, datetime] = {}
        # Running count of those drops, and the monotonic time of the last
        # info line about them (None until the first drop).
        self._late_dropped: int = 0
        self._late_drop_logged_at: float | None = None

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
        # TEMPORARY (spec Phase 0b): remove after one session
        _maybe_capture(payload, time.time_ns() // 1_000_000)
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

        # 1b. Spread and block prints are skipped quietly, BEFORE the
        # price/size validation. A calendar spread is its own sym, so it
        # would otherwise join the front-month argmax and could write a
        # spread price into the root series. A block frame carries ``qty``
        # and no ``size``/``side``, so it would otherwise log
        # invalid_price_or_size on every block; Phase 4 stores blocks from
        # the futures_blocks channel. Both are expected traffic, not
        # malformed frames, hence no warning. ``is_spread`` is REST-only
        # today; the websocket spread case is caught by the sym shape in 2b.
        if payload.get("is_spread") is True or payload.get("is_block") is True:
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

        # 2b. Outright contracts only: a sym that isn't root + month + year
        # is never a bar. Spread and strategy syms carry a separator
        # (ESZ6-ESH7, ESZ6:ESH7, UD:...) and are skipped quietly like 1b. A
        # separator-free sym that still doesn't match is most likely a
        # feed-wide format change (ESZ2026), which would otherwise black
        # out every bar in silence, so it warns.
        if not _is_outright(product, sym):
            if sym.isalnum():
                rate_limited_log.warning(
                    scope="futures_trades",
                    kind="unrecognized_sym",
                    message="futures_trades sym is not an outright contract of its product",
                    extra={"product": product, "sym": sym},
                )
            return None

        # 3. Timestamp — epoch-ms per the live feed; drives both the
        # minute bucket and open/close ordering.
        executed_at = timestamps.parse_timestamp(payload.get("executed_at"))
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
        if (
            price is None
            or size is None
            or price <= 0
            or size <= 0
            # Summed into BIGINT volume, a huge size overflows the shared INSERT: whole batch lost.
            or size > 2**31 - 1
        ):
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
            # The exchange aggressor flag. nbbo_* is post-trade (REST probe
            # 2026-10-28), so it is never used to classify a print.
            side=_parse_side(payload.get("side")),
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
        """Fold one print into the accumulator (dedup, tally, OHLCV, flow)."""
        # Late print for a minute already emitted: drop it BEFORE the dedup
        # and the tally. Usually a re-delivered copy arriving after its
        # minute's ``_seen`` set was evicted, so dedup can't catch it. Let
        # through, it would inflate the front-month tally, build a
        # one-print bar that DO NOTHING discards (or, for a minute that was
        # a gap, write a permanent partial bar), and could log a false
        # front_sym_absent.
        emitted_through = self._emitted_through.get(print_.product)
        if emitted_through is not None and print_.minute_ts <= emitted_through:
            self._note_late_drop(print_, emitted_through)
            return

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

        # A print from before the current session date (a straggler for a
        # minute held back across midnight UTC) still builds its own bar,
        # but must not touch the new day's tally or its minute's front-month
        # snapshot. In the empty post-roll tally a back-month straggler
        # would otherwise elect itself front for the prior-day minute (a
        # permanent carry-basis spike) and lead the new day too.
        stale = self._session_date is not None and print_.minute_ts.date() < self._session_date
        tally = self._session_volume.setdefault(print_.product, {})
        if not stale:
            tally[print_.sym] = tally.get(print_.sym, 0) + print_.size

        bar_key = (print_.product, print_.minute_ts, print_.sym)
        bar = self._bars.get(bar_key)
        if bar is None:
            # Seeded empty and filled by ``add`` below, so the first print
            # takes the same volume and side path as every later one.
            bar = self._bars[bar_key] = _Bar(
                open=print_.price,
                high=print_.price,
                low=print_.price,
                close=print_.price,
                volume=0,
                first_at=print_.executed_at,
                last_at=print_.executed_at,
            )
        bar.add(print_.price, print_.size, print_.executed_at, print_.side)

        # Snapshot the current session leader for this minute. Recomputed
        # on every print, so the value that survives is the leader as of
        # the minute's last print. A stale print keeps its minute's
        # prior-day snapshot; with none, the minute is the logged
        # front_sym_absent gap.
        if not stale:
            self._front_sym[minute_key] = max(tally.items(), key=lambda kv: (kv[1], kv[0]))[0]

        newest = self._newest_minute.get(print_.product)
        if newest is None or print_.minute_ts > newest:
            self._newest_minute[print_.product] = print_.minute_ts

    def _note_late_drop(self, print_: _Print, emitted_through: datetime) -> None:
        """Count a late-print drop; log it at info, at most once per window.

        Info, not warning: re-delivered copies are the feed's steady state
        (2-11 per print), so a late one is expected traffic, not a fault.
        ``rate_limited_log`` only throttles warnings, so this keeps its own
        window of the same length. The running total lets the gaps between
        lines give the drop rate.
        """
        self._late_dropped += 1
        now = time.monotonic()
        if (
            self._late_drop_logged_at is not None
            and now - self._late_drop_logged_at < MALFORMED_PAYLOAD_LOG_INTERVAL_S
        ):
            return
        self._late_drop_logged_at = now
        log.info(
            "futures_trades print for an already-emitted minute dropped",
            extra={
                "scope": "futures_trades",
                "kind": "late_print_dropped",
                "dropped_total": self._late_dropped,
                "product": print_.product,
                "sym": print_.sym,
                "minute_ts": print_.minute_ts.isoformat(),
                "emitted_through": emitted_through.isoformat(),
            },
        )

    def _roll_session(self, day: date) -> None:
        """Clear the front-month volume tally on a new UTC session day.

        Without this, yesterday's front month keeps its cumulative lead
        into a new session and would stay "front" through the whole roll
        window even after the market has moved on.

        Only a strictly NEWER date rolls the tally, so a late print from
        the previous session can't wipe the current day's tally. A
        straggler whose minute was already emitted never gets here
        (``_ingest`` drops it first). One whose minute is still open (the
        minute held back across midnight) builds its bar but is kept out of
        the new day's tally and its minute's front-month snapshot. Folded
        in, it would land in an EMPTY tally right after the roll, so even a
        few back-month lots would elect that contract front for the
        prior-day minute and write a carry-basis spike into the series.
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
                        *bar.flow(),
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
                        "front-month contract had no prints in a completed minute; bar skipped"
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
            # Written or skipped, this minute is done: later prints for it
            # are dropped in _ingest. Set before the INSERT runs, so a
            # rejected flush also closes the minute (no re-queue; the OHLC
            # gap repair refills it).
            through = self._emitted_through.get(product)
            if through is None or minute_ts > through:
                self._emitted_through[product] = minute_ts

        return out


# ----------------------------------------------------------------------
# TEMPORARY (spec Phase 0b): remove after one session
# ----------------------------------------------------------------------


def _maybe_capture(payload: dict, arrival_ms: int) -> None:
    """TEMPORARY (spec Phase 0b): remove after one session

    Log one ``futures_capture`` info line holding the raw payload and its
    arrival time (epoch ms at enqueue) when the print is ES or NQ and its
    ``trade_id`` is a multiple of ``_CAPTURE_MODULO``. The JSON formatter
    writes ``payload`` as a nested object, so the Railway line parses
    straight back into the frame.
    """
    try:
        if payload.get("product") not in _CAPTURE_PRODUCTS:
            return
        trade_id = _to_int(payload.get("trade_id"))
        if trade_id is None or trade_id % _CAPTURE_MODULO != 0:
            return
        log.info("futures_capture", extra={"arrival_ms": arrival_ms, "payload": payload})
    except Exception:
        # Deliberate swallow: this is a temporary diagnostic on the enqueue
        # hot path, and nothing it does may cost a print or break dispatch.
        # Permanent code would surface the error instead.
        return


# ----------------------------------------------------------------------
# Helpers — defensive coercion. Returning None means "unusable print";
# every caller drops the row rather than substituting a default, so a
# malformed payload can never silently distort a bar.
# ----------------------------------------------------------------------


def _to_decimal(v: Any) -> Decimal | None:
    """Parse to a finite Decimal, or None when unparseable or non-finite.

    ``Decimal`` happily parses ``"NaN"``, ``"sNaN"`` and ``"Infinity"``,
    and each one breaks a caller: NaN raises InvalidOperation on
    ``price <= 0``, Infinity passes ``price > 0`` into a bar. ``"1e400"``
    is a finite Decimal but past the float range, so no real price or size
    can be that large. ``is_finite`` runs first because ``float`` raises
    on a signaling NaN.
    """
    if v is None or v == "":
        return None
    try:
        d = Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None
    if not d.is_finite() or math.isinf(float(d)):
        return None
    return d


def _to_int(v: Any) -> int | None:
    """Parse to an int (truncating), or None when unusable.

    Built on ``_to_decimal`` so it inherits the finite check:
    ``int(Decimal("Infinity"))`` raises OverflowError, which this used to
    let escape.
    """
    if isinstance(v, bool):
        return None
    d = _to_decimal(v)
    return None if d is None else int(d)


def _is_outright(product: str, sym: str) -> bool:
    """True when ``sym`` is an outright contract of ``product`` (ESZ6, ESZ26)."""
    pattern = _OUTRIGHT_SYM.get(product)
    return pattern is not None and pattern.fullmatch(sym) is not None


def _parse_side(raw: object) -> str | None:
    """Return ``"buy"``, ``"sell"`` or ``"none"`` for those exact strings.

    Anything else, including an absent key, is unknown and returns None.
    UW's values are case-sensitive, so ``"BUY"`` is unknown rather than
    guessed at. The ``isinstance`` check keeps an unhashable value (a list
    or dict on a wire-format change) from raising on the set lookup.
    """
    if isinstance(raw, str) and raw in _SIDES:
        return raw
    return None


def _floor_to_minute(dt: datetime) -> datetime:
    """Truncate a UTC-aware datetime to its minute."""
    return dt.replace(second=0, microsecond=0)
