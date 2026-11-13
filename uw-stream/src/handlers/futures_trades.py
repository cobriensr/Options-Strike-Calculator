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

Those 11 keys are the whole websocket frame (frame capture,
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
   can't be deduped; let through, it would inflate the session tally
   and build a one-print bar that DO NOTHING discards. Logged at info as
   ``kind="late_print_dropped"`` with a running count, at most once per
   60s window.
4. **De-duplication on (contract, trade_id).** UW re-delivers every futures
   print 2-11 times. Measured over a 90s live window on 2026-09-08,
   naive summing inflated volume by 1.93x (ZN) to 3.09x (ES); every
   distinct ES trade_id arrived at least twice, so this is the steady
   state, not a reconnect artifact. Duplicates arrive fast (p50 0.1ms,
   max 0.52s observed) and always carry the same ``executed_at``, so
   they always land in the same minute bucket as their original — a
   per-(product, minute) seen-set catches them all and is evicted with
   the bucket. ``trade_id`` was never observed colliding across syms,
   but we key on the pair anyway since it is only documented unique
   within a contract (the canonical name, so a copy under the other year
   spelling is still a copy). The first copy wins, side included.
5. **One contract per root per CME trade date.** ``futures_bars.symbol``
   holds the ROOT (``'ES'``), but the global feed carries every contract
   month. A session runs from 17:00 America/Chicago on the evening before
   its trade date to 17:00 on it (``futures_front_month.trade_date``), and
   each root has ONE contract per session. It is decided once, by
   ``futures_front_month.ensure_front``, from the previous session's
   per-contract volume, and stored in ``futures_front_month`` (plan:
   docs/superpowers/specs/2026-11-06-futures-session-front-month.md). The
   volume is this handler's own tally of deduped outright prints, keyed by
   (product, trade date, canonical contract) and saved to
   ``futures_contract_volume`` (source ``live``). A restart reloads the
   tally and reads the stored decision, so it never changes a decided
   session's contract. A minute's bar comes only from the contract of its
   own trade date, and ``futures_bars.contract`` holds that name in its
   canonical form: root, CME month code and last year digit, so ``ESZ26``
   and ``ESZ6`` are one contract, one tally key and one bar.

   A straggler for the previous session's last minute, still open when the
   new session's first print arrives, keeps that session's contract and
   tally. A decision that can't be had (Neon unreachable at the open) is not
   cached: the minutes of that session become gaps, logged under
   ``kind="front_month_unknown"`` at error level with the cause, and it is
   asked for again after the retry-after (30 s), or after 60 s and then 120 s
   when the lookup keeps timing out. Each front-month database call (a
   decision, a tally load, a tally save) is cut at 8 s. A call that failed is
   not repeated for that root and date for 30 s, and one that TIMED OUT pauses
   every root's front-month calls for the same 30 s, so a hung Neon costs one
   box and not one per call. The call that timed out itself waits 60 s, and
   120 s after each further timeout in a row, so the first call after a pause
   is another root's and a hang confined to a few roots can't hold back the
   rest. Failures that aren't a Neon blip log at error level, per root. A
   print for a trade date more than 3 days old is dropped before any of this
   (``kind="stale_session_dropped"``).

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
- A minute in which the session's contract printed nothing but a back
  month did is emitted as a GAP, logged under ``kind="front_sym_absent"``.
  Substituting the back month's price would inject a carry-basis spike
  into the root series that DO NOTHING could never revise.
- The tally is saved about once a minute (whenever minutes are emitted),
  before a new trade date's decision is asked for (so that decision reads
  the session that just ended) and once on a clean shutdown, so a SIGTERM
  loses none of it and only a crash loses the volume since the last save.
  Only the contracts whose count rose are sent. At most two sessions per
  root are kept in memory.
- ``write_attempted`` (bumped by ``_safe_flush`` with the incoming row
  count) counts per-trade prints while ``write_count`` counts emitted
  bars, so for this channel the two are not comparable and their ratio
  is not a dedup rate.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections import defaultdict
from collections.abc import Awaitable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, NamedTuple

import db
import futures_front_month as front_month
from db import is_transient_db_error, single_attempt
from handlers.base import Handler
from logger_setup import MALFORMED_PAYLOAD_LOG_INTERVAL_S, log, rate_limited_log
from sentry_setup import capture_message
from utils import timestamps

_TABLE = "futures_bars"

# Column order MUST match the tuple shape emitted by _collect_completed.
# id (BIGSERIAL) auto-populates; we omit it from the INSERT entirely.
# The four order-flow columns are nullable (api migration, spec Phase 2):
# NULL = unknown, 0 = known to be none. ``contract`` is nullable too (api
# migration #204): the canonical name of the dated outright the bar was built
# from, NULL when the name would fail the column's CHECK.
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
    "contract",
]

# Trade dates of tally and decision kept in memory per root: the current
# session and the one before it, for a straggler. Older ones are evicted at
# the end of each flush.
_SESSIONS_KEPT = 2

# The longest one front-month database call (a decision, a tally load or a
# tally save) may hold the flush. Without it a connection that hangs costs
# asyncpg's whole command_timeout and connect timeout, about 92 s a call, and
# every root's bars wait behind it while the 50,000-slot queue fills.
_LOOKUP_TIMEOUT_S = 8.0

# After a front-month call fails, the same call for the same root (and trade
# date) is not made again for this long; its minutes are gaps meanwhile. A
# call that TIMED OUT waits longer (``_TIMED_OUT_COOLING_S``). Without it a
# Neon outage costs each flush the retry backoff (about 2 s) of every
# undecided root, again and again. Half a minute is about the time a Neon
# restart takes and keeps the gap to a few minutes.
_RETRY_AFTER_S = 30.0

# How long the call that TIMED OUT waits the first time: twice the retry-after,
# while the pause it starts for every other root is one. Were the two equal,
# the timed-out call would be the first call after every pause, and if it
# timed out each time it would re-arm the pause before any other root got a
# turn: one root's hang would black out all six. Doubled, the first call after
# a pause is another root's. Each further timeout of the same call in a row
# doubles it again, up to ``_TIMED_OUT_COOLING_MAX_S``.
_TIMED_OUT_COOLING_S = 2 * _RETRY_AFTER_S

# The cap of that backoff. Every hung call re-arms one 30 s pause each time it
# is tried, so k hung calls that come due one after another keep the pause on
# for ever. Once every hung call's cooling exceeds k x 30 s the pauses have
# free windows, and the healthy roots are served in them. 120 s leaves room
# for up to 3 hung calls and keeps a root's wait after a Neon-wide outage to
# 2 min at most.
_TIMED_OUT_COOLING_MAX_S = 4 * _RETRY_AFTER_S

# A print for a trade date older than the current one by more than this many
# days is dropped before the front-month path. parse_timestamp accepts any
# stamp from 2000 on, and such a print would make ensure_front write a
# permanent decision row for a session that never traded.
_STALE_SESSION_DAYS = 3

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


class _Print(NamedTuple):
    """A normalized single futures print — the unit ``_transform`` emits.

    NOT a database row: this handler aggregates, so the DB row shape is
    produced later by ``_collect_completed``. It is a tuple subclass, so
    it still satisfies the base ``Handler._transform`` contract while
    keeping the field access in ``_flush`` readable.
    """

    product: str
    sym: str
    # The CME trade date of the print's minute, and the contract's canonical
    # name against it (ESZ26 is ESZ6): the keys of the tally, the dedup set and
    # the bar.
    trade_date: date
    contract: str
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


@dataclass
class _Tally:
    """One session's deduped outright volume per canonical contract, for one
    (product, trade date): the input of the next session's decision."""

    counts: dict[str, int] = field(default_factory=dict)
    # The stored tally has been merged into ``counts`` (a restarted process
    # carries on from it). Until it has, the counts are not saved: the table
    # would be overwritten by a lower number, and the stored volume lost.
    loaded: bool = False
    # The count per contract the table is known to hold: what was loaded, or
    # what the last successful save sent. A save sends only the contracts
    # above it, and a failed save leaves it alone so the next one resends.
    saved: dict[str, int] = field(default_factory=dict)

    def unsaved(self) -> dict[str, int]:
        """The counts that are above what the table holds."""
        return {c: v for c, v in self.counts.items() if v > self.saved.get(c, 0)}

    @property
    def dirty(self) -> bool:
        """``counts`` holds volume the table does not."""
        return any(v > self.saved.get(c, 0) for c, v in self.counts.items())


class FuturesTradesHandler(Handler):
    """futures_trades global firehose → futures_bars 1-minute OHLCV."""

    name = "futures_trades"

    def __init__(self) -> None:
        super().__init__(name="futures_trades")
        # (product, minute_ts, contract) -> accumulating bar. Keyed per
        # canonical contract so emit time can pick the session's contract
        # without having polluted it with other months' prints.
        self._bars: dict[tuple[str, datetime, str], _Bar] = {}
        # product -> newest minute observed. Defines "completed": every
        # minute strictly older than this one is done receiving prints.
        self._newest_minute: dict[str, datetime] = {}
        # (product, trade_date) -> the session's tally. At most
        # ``_SESSIONS_KEPT`` dates per product: older ones are evicted at the
        # end of each flush.
        self._tally: dict[tuple[str, date], _Tally] = {}
        # (product, trade_date) -> the canonical contract the session's bars
        # are built from. Only a lookup that succeeded is here, so a failed
        # one is asked again after the retry-after. Bounded with ``_tally``.
        self._decided: dict[tuple[str, date], str] = {}
        # (product, minute_ts) -> {(contract, trade_id)} already counted.
        self._seen: dict[tuple[str, datetime], set[tuple[str, int]]] = {}
        # product -> newest minute already emitted (written or skipped as a
        # gap). Prints at or before it are dropped in ``_ingest``: that
        # minute's dedup set is gone, so they can't be deduped, and DO
        # NOTHING would discard any bar they built. One entry per product.
        self._emitted_through: dict[str, datetime] = {}
        # Running count of those drops, and the monotonic time of the last
        # info line about them (None until the first drop).
        self._late_dropped: int = 0
        self._late_drop_logged_at: float | None = None
        # Minutes skipped because their session has no decision, in total, and
        # the monotonic time of the last error line per product (one entry per
        # target product at most).
        self._unknown_minutes: int = 0
        self._unknown_logged_at: dict[str, float] = {}
        # (call, product, trade_date) -> monotonic time before which that call
        # is not made again. call is "load" or "decide" with the session's trade
        # date, or "save" with None (one statement per root). Dropped with the
        # session at eviction, so bounded by roots x 2 sessions x 2 calls + roots.
        self._retry_after: dict[tuple[str, str, date | None], float] = {}
        # The same keys -> the cooling that key's last timeout set, for the keys
        # whose last outcome was a timeout (the streak of consecutive timeouts).
        # Every other outcome of a key drops it, and it leaves with the key's
        # ``_retry_after`` entry at eviction, so it is no larger than that dict.
        self._timeout_backoff: dict[tuple[str, str, date | None], float] = {}
        # product -> (kind, exception class) of its last front-month failure, for
        # the front_month_unknown line. Cleared by that root's next decision.
        self._cause: dict[str, tuple[str, str]] = {}
        # After a call TIMES OUT no front-month call is made, for any root, until
        # this monotonic time (None: no pause). One hang is one box, not one per
        # call: six roots would otherwise cost 12 calls x 8 s at the open and again
        # 30 s later. ``_box_cause`` is what a skipped root's gap names.
        self._box_until: float | None = None
        self._box_cause: tuple[str, str] = ("lookup_timeout", "TimeoutError")
        # product -> the last stale trade date logged for it (one line per date).
        self._stale_logged: dict[str, date] = {}

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
        if not front_month.is_outright(product, sym):
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

        # 3b. The print's session and its contract's one name. The session is
        # the CME trade date of the minute (17:00 CT starts the next date), and
        # the name is root + month code + last year digit, so ESZ26 and ESZ6 are
        # one tally key, one dedup key and one bar. A two-digit year outside
        # the window [Y - 1, Y + 8] has no such name: no real contract, dropped
        # with a warning.
        minute_ts = _floor_to_minute(executed_at)
        session = front_month.trade_date(minute_ts)
        contract = front_month.canonical_contract(product, sym, session)
        if contract is None:
            rate_limited_log.warning(
                scope="futures_trades",
                kind="contract_out_of_window",
                message="futures_trades sym has a year outside the contract window; print dropped",
                extra={"product": product, "sym": sym},
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
            trade_date=session,
            contract=contract,
            minute_ts=minute_ts,
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

        Prints for a session older than ``_STALE_SESSION_DAYS`` are dropped
        first. Before the rest is folded, every (product, trade date) in it
        that has no decision yet is asked for (``_prepare``), leaving out the
        prints ``_ingest`` is about to drop as late. When minutes are emitted
        the tally is saved, so about once a minute while the market trades.
        """
        rows = self._drop_stale(rows)
        await self._prepare(
            {(row.product, row.trade_date) for row in rows if not self._is_late(row)}
        )

        for row in rows:
            self._ingest(row)

        completed = self._collect_completed()
        if completed:
            await self._save_tally()
        self._evict_old_sessions()
        if not completed:
            return 0

        return await db.bulk_insert_ignore_conflict(
            table=_TABLE,
            columns=_COLUMNS,
            rows=completed,
            conflict_cols=_CONFLICT_COLS,
        )

    # ------------------------------------------------------------------
    # The session's tally and decision. None of these raises: a Neon outage
    # must cost the minutes of one product at most, never the batch. Each
    # database call is time-boxed (``_LOOKUP_TIMEOUT_S``) and, once it has
    # failed, not made again for ``_RETRY_AFTER_S``.
    # ------------------------------------------------------------------
    def _is_late(self, print_: _Print) -> bool:
        """True for a print at or before its product's newest emitted minute."""
        emitted_through = self._emitted_through.get(print_.product)
        return emitted_through is not None and print_.minute_ts <= emitted_through

    def _drop_stale(self, rows: list[tuple]) -> list[tuple]:
        """The prints whose trade date is within ``_STALE_SESSION_DAYS`` of now.

        An older one can't belong to a session this process has anything to say
        about, and would otherwise be looked up, decided and written as a
        decision row for a date that never traded. Logged once per date.
        """
        floor = front_month.current_trade_date() - timedelta(days=_STALE_SESSION_DAYS)
        fresh = [row for row in rows if row.trade_date >= floor]
        if len(fresh) != len(rows):
            for row in rows:
                if row.trade_date < floor:
                    self._note_stale(row, floor)
        return fresh

    def _note_stale(self, print_: _Print, floor: date) -> None:
        if self._stale_logged.get(print_.product) == print_.trade_date:
            return
        self._stale_logged[print_.product] = print_.trade_date
        rate_limited_log.warning(
            scope="futures_trades",
            kind="stale_session_dropped",
            message="futures_trades print is for a trade date too old to decide; dropped",
            extra={
                "product": print_.product,
                "trade_date": print_.trade_date.isoformat(),
                "floor": floor.isoformat(),
            },
            key=print_.product,
        )

    async def _prepare(self, sessions: set[tuple[str, date]]) -> None:
        """Make sure each session in the batch has a tally and a decision."""
        for key in sessions:
            self._tally.setdefault(key, _Tally())
        await self._load_missing()
        for key in sorted(sessions):
            if key not in self._decided:
                await self._decide(key)

    @staticmethod
    async def _timed[T](call: Awaitable[T]) -> T:
        """Await a front-month database call for at most ``_LOOKUP_TIMEOUT_S``."""
        async with asyncio.timeout(_LOOKUP_TIMEOUT_S):
            return await call

    def _cooling(self, call: str, product: str, day: date | None) -> bool:
        """True while a failed ``call`` for this root and date waits out its retry-after."""
        deadline = self._retry_after.get((call, product, day))
        return deadline is not None and time.monotonic() < deadline

    def _cool(
        self, call: str, product: str, day: date | None, exc: BaseException | None = None
    ) -> float:
        """Hold a failed ``call`` back, and return the seconds it waits.

        The retry-after for a failure and for a ``None`` decision (``exc``
        None); either ends the call's streak of timeouts. A timeout backs off
        per consecutive timeout of the same call: ``_TIMED_OUT_COOLING_S`` the
        first time, doubled each time after, up to
        ``_TIMED_OUT_COOLING_MAX_S``.
        """
        key = (call, product, day)
        if isinstance(exc, TimeoutError):
            last = self._timeout_backoff.get(key)
            cooling = (
                _TIMED_OUT_COOLING_S if last is None else min(2 * last, _TIMED_OUT_COOLING_MAX_S)
            )
            self._timeout_backoff[key] = cooling
        else:
            cooling = _RETRY_AFTER_S
            self._timeout_backoff.pop(key, None)
        self._retry_after[key] = time.monotonic() + cooling
        return cooling

    def _clear_cooling(self, call: str, product: str, day: date | None) -> None:
        """Forget a call's cooling and timeout streak: it worked, or its session is gone."""
        self._retry_after.pop((call, product, day), None)
        self._timeout_backoff.pop((call, product, day), None)

    def _boxed_out(self) -> bool:
        """True while a call that timed out holds every root's front-month calls."""
        return self._box_until is not None and time.monotonic() < self._box_until

    def _note_failure(
        self,
        kind: str,
        message: str,
        product: str,
        day: date | None,
        exc: BaseException,
        wait: float,
    ) -> None:
        """Remember and report a failed front-month call, per root.

        A transient database error (a timeout among them) is a warning, which
        the minutes it costs escalate as ``front_month_unknown``. Anything else
        (a bad row, a rejected statement) is an error, and
        ``RateLimitedLogger.error`` sends its head-of-window line to Sentry as
        an event, before the next open. One window per root and level. ``wait``
        is the seconds ``_cool`` held the call back, which the line says. A
        timeout also pauses every root's front-month calls for the retry-after
        (``_boxed_out``); any other failure cools its own call only.
        """
        err_type = type(exc).__name__
        self._cause[product] = (kind, err_type)
        if isinstance(exc, TimeoutError):
            self._box_until = time.monotonic() + _RETRY_AFTER_S
            self._box_cause = (kind, err_type)
        report = rate_limited_log.warning if is_transient_db_error(exc) else rate_limited_log.error
        report(
            scope="futures_trades",
            kind=kind,
            message=f"futures_trades {message}; asked again after {wait:.0f}s",
            extra={
                "product": product,
                "trade_date": day.isoformat() if day is not None else None,
                "err_type": err_type,
                "err": str(exc),
            },
            key=product,
        )

    async def _load_missing(self) -> None:
        """Merge the stored tally into every session that hasn't had it yet.

        The first sight of a (product, trade date) loads it, so a restart
        carries on counting. A load that failed is retried here once its
        retry-after has run out (60 s, then 120 s, for a load that keeps timing
        out), and the volume counted meanwhile is added to what is stored: the
        table holds only what earlier processes saw, never this one's counts (a
        session isn't saved until it is loaded). Nothing is loaded while a
        timeout holds every root's calls (``_boxed_out``).
        """
        for (product, day), tally in list(self._tally.items()):
            if tally.loaded or self._cooling("load", product, day) or self._boxed_out():
                continue
            try:
                stored = await self._timed(front_month.load_tally(product, day))
            except Exception as exc:
                wait = self._cool("load", product, day, exc)
                self._note_failure(
                    "tally_load_failed", "tally load failed", product, day, exc, wait
                )
                continue
            for contract, volume in stored.items():
                tally.counts[contract] = tally.counts.get(contract, 0) + volume
                tally.saved[contract] = volume
            tally.loaded = True
            self._clear_cooling("load", product, day)

    async def _decide(self, key: tuple[str, date]) -> None:
        """Ask for one session's contract, after saving the tally.

        The decision for a session reads the volume of the one before it, so
        that volume must be in the table first: with the tally unsaved the
        lookup is not made, and the session stays undecided until it can be.
        A lookup that fails, times out or returns None is not cached, and is
        not repeated for 30 s after a failure or a None, or for 60 s and then
        120 s after consecutive timeouts. While a timeout holds every root's
        calls (``_boxed_out``) none is made, and the root's gap names that
        timeout as its cause.
        """
        product, day = key
        if self._cooling("decide", product, day):
            return
        if self._boxed_out():
            self._cause[product] = self._box_cause
            return
        if not await self._save_tally(product):
            self._cause.setdefault(product, ("tally_unsaved", ""))
            return
        try:
            contract = await self._timed(front_month.ensure_front(product, day))
        except Exception as exc:
            # ensure_front swallows its own failures; what reaches here is the
            # time box cancelling it.
            wait = self._cool("decide", product, day, exc)
            self._note_failure(
                "lookup_timeout", "front-month lookup timed out", product, day, exc, wait
            )
            return
        if contract is None:
            self._cool("decide", product, day)
            self._cause[product] = front_month.last_failure(product) or ("ensure_front_failed", "")
            return
        self._decided[key] = contract
        self._clear_cooling("decide", product, day)
        self._cause.pop(product, None)

    async def _save_tally(self, product: str | None = None) -> bool:
        """Save the tallies that changed, one statement, for one product or all.

        Only the contracts above what the table holds are sent. False when a
        save failed or is waiting out its retry-after (or a timeout holds every
        root's calls), or when a tally with unsaved volume has not been loaded
        (it can't be saved yet), so a caller that needs the table current knows
        it isn't. Never raises. For one product the unloaded tallies of other
        roots don't count.
        """
        sessions = [key for key in self._tally if product is None or key[0] == product]
        stuck = any(not self._tally[key].loaded and self._tally[key].dirty for key in sessions)
        dirty = [key for key in sessions if self._tally[key].loaded and self._tally[key].dirty]
        if product is None:
            dirty = [key for key in dirty if not self._cooling("save", key[0], None)]
        elif dirty and self._cooling("save", product, None):
            return False
        if dirty and self._boxed_out():
            return False
        if dirty:
            changed = {key: self._tally[key].unsaved() for key in dirty}
            rows = [
                (p, day, contract, volume)
                for (p, day), counts in changed.items()
                for contract, volume in counts.items()
            ]
            try:
                await self._timed(front_month.save_tally(rows))
            except Exception as exc:
                for p in sorted({p for p, _ in dirty}):
                    wait = self._cool("save", p, None, exc)
                    self._note_failure("tally_save_failed", "tally save failed", p, None, exc, wait)
                return False
            for key, counts in changed.items():
                self._tally[key].saved.update(counts)
            for p in {p for p, _ in dirty}:
                self._clear_cooling("save", p, None)
        return not stuck

    def _evict_old_sessions(self) -> None:
        """Keep each product's ``_SESSIONS_KEPT`` newest trade dates.

        Run at the end of every flush, after the minutes that needed an older
        decision have been emitted, so the maps stay bounded by roots x 2. The
        retry-afters and timeout streaks of an evicted session go with it.
        """
        by_product: dict[str, list[date]] = defaultdict(list)
        for product, day in self._tally:
            by_product[product].append(day)
        for product, days in by_product.items():
            for day in sorted(days)[:-_SESSIONS_KEPT]:
                del self._tally[(product, day)]
                self._decided.pop((product, day), None)
                self._clear_cooling("load", product, day)
                self._clear_cooling("decide", product, day)

    async def _drain_inner(self) -> int:
        """The base drain, then one save of the tally.

        The final flush saves only when a minute completes, so without this a
        clean shutdown loses the volume since the last emitted minute (under a
        minute of it). One attempt, no retry (``single_attempt``): Railway's
        SIGKILL comes at a fixed deadline. A failure is logged, never raised.
        """
        flushed = await super()._drain_inner()
        with single_attempt():
            await self._save_tally()
        return flushed

    def _ingest(self, print_: _Print) -> None:
        """Fold one print into the accumulator (dedup, tally, OHLCV, flow)."""
        # Late print for a minute already emitted: drop it BEFORE the dedup
        # and the tally. Usually a re-delivered copy arriving after its
        # minute's ``_seen`` set was evicted, so dedup can't catch it. Let
        # through, it would inflate the session tally, build a
        # one-print bar that DO NOTHING discards (or, for a minute that was
        # a gap, write a permanent partial bar), and could log a false
        # front_sym_absent.
        if self._is_late(print_):
            self._note_late_drop(print_, self._emitted_through[print_.product])
            return

        minute_key = (print_.product, print_.minute_ts)

        # Dedup FIRST — before the volume tally, so a heavily re-delivered
        # contract can't inflate the volume the next session's decision reads.
        # A print with no trade_id can't be dedup-keyed; count it rather
        # than collapsing every such print into one.
        if print_.trade_id is not None:
            seen = self._seen.setdefault(minute_key, set())
            dedup_key = (print_.contract, print_.trade_id)
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

        # The tally of the print's OWN session. A straggler for the previous
        # session's last minute counts there, not in the new session's tally.
        tally = self._tally[(print_.product, print_.trade_date)]
        tally.counts[print_.contract] = tally.counts.get(print_.contract, 0) + print_.size

        bar_key = (print_.product, print_.minute_ts, print_.contract)
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

    def _note_unknown(self, product: str, day: date, minute_ts: datetime) -> None:
        """Count a minute skipped for want of a decision; log it at error level.

        Error, not warning: a session with no decision loses every minute of
        that root until Neon answers, and an error is what reaches Sentry: the
        line is also an explicit event, because the SDK does not turn an error
        log record into one. One line and event per product per window (this
        keeps its own windows, one entry per product at most), with the running
        total and the cause: the kind and exception class of the root's last
        front-month failure, None when the session simply has not been asked
        for yet.
        """
        self._unknown_minutes += 1
        now = time.monotonic()
        last = self._unknown_logged_at.get(product)
        if last is not None and now - last < MALFORMED_PAYLOAD_LOG_INTERVAL_S:
            return
        self._unknown_logged_at[product] = now
        cause_kind, cause_err_type = self._cause.get(product, (None, None))
        message = "futures_trades front-month contract unknown for a completed minute; bar skipped"
        detail = {
            "scope": "futures_trades",
            "kind": "front_month_unknown",
            "product": product,
            "trade_date": day.isoformat(),
            "minute_ts": minute_ts.isoformat(),
            "unknown_total": self._unknown_minutes,
            "cause_kind": cause_kind,
            "cause_err_type": cause_err_type,
        }
        log.error(message, extra=detail)
        capture_message(
            message,
            level="error",
            tags={"component": "futures_trades", "kind": "front_month_unknown"},
            context=detail,
        )

    @staticmethod
    def _checked_contract(product: str, contract: str) -> str | None:
        """``contract``, or None when futures_bars' CHECK would refuse it.

        The CHECK (migration #204) is the row's own root, one month code and a
        one- or two-digit year, which is ``front_month.is_outright``. One
        refused value fails the whole multi-row INSERT, and every product's
        minutes with it, so a bad name is written as NULL (unknown) with one
        warning instead.
        """
        if front_month.is_outright(product, contract):
            return contract
        rate_limited_log.warning(
            scope="futures_trades",
            kind="invalid_contract",
            message=(
                "futures_trades decided contract fails the futures_bars CHECK; "
                "bar written with NULL contract"
            ),
            extra={"product": product, "contract": contract},
        )
        return None

    def _collect_completed(self) -> list[tuple]:
        """Emit + evict every minute strictly older than its product's newest.

        The newest minute per product is deliberately retained: it is
        still receiving prints, and writing it now would persist a
        partial bar that ``ON CONFLICT DO NOTHING`` could never revise.

        A minute's bar is the one of its own session's contract, whatever the
        newest minute's session is.
        """
        completed: dict[tuple[str, datetime], list[str]] = defaultdict(list)
        for product, minute_ts, contract in self._bars:
            newest = self._newest_minute.get(product)
            if newest is not None and minute_ts < newest:
                completed[(product, minute_ts)].append(contract)

        out: list[tuple] = []
        # Sorted so bars are written in (product, time) order — keeps the
        # multi-row INSERT's lock acquisition deterministic and makes the
        # emitted sequence reproducible for tests and log reading.
        for (product, minute_ts), syms in sorted(completed.items()):
            day = front_month.trade_date(minute_ts)
            front = self._decided.get((product, day))
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
                        self._checked_contract(product, front),
                    )
                )
            elif front is None:
                # No decision for this minute's session (Neon unreachable at
                # the open): nothing says which contract the bar is, so the
                # minute is a gap. Not cached, so it is asked for again after
                # the retry-after.
                self._note_unknown(product, day, minute_ts)
            else:
                # The session's contract printed nothing in this
                # minute while a back month did, so there is no
                # bar to emit and the minute becomes a gap.
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
