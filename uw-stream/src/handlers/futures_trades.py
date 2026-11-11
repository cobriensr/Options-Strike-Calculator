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
   ``kind="front_month_unknown"`` at error level, and the next flush asks
   again.

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
- The tally is saved about once a minute (whenever minutes are emitted) and
  before a new trade date's decision is asked for, so that decision reads
  the session that just ended. At most two sessions per root are kept in
  memory.
- ``write_attempted`` (bumped by ``_safe_flush`` with the incoming row
  count) counts per-trade prints while ``write_count`` counts emitted
  bars, so for this channel the two are not comparable and their ratio
  is not a dedup rate.
"""

from __future__ import annotations

import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, NamedTuple

import db
import futures_front_month as front_month
from handlers.base import Handler
from logger_setup import MALFORMED_PAYLOAD_LOG_INTERVAL_S, log, rate_limited_log
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
    # ``counts`` holds volume the table does not.
    dirty: bool = False


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
        # one is asked again at the next flush. Bounded with ``_tally``.
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

        Before the batch is folded, every (product, trade date) in it that has
        no decision yet is asked for (``_prepare``). When minutes are emitted
        the tally is saved, so about once a minute while the market trades.
        """
        await self._prepare({(row.product, row.trade_date) for row in rows})

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
    # The session's tally and decision. Neither lookup raises: a Neon outage
    # must cost the minutes of one product at most, never the batch.
    # ------------------------------------------------------------------
    async def _prepare(self, sessions: set[tuple[str, date]]) -> None:
        """Make sure each session in the batch has a tally and a decision."""
        for key in sessions:
            self._tally.setdefault(key, _Tally())
        await self._load_missing()
        for key in sorted(sessions):
            if key not in self._decided:
                await self._decide(key)

    async def _load_missing(self) -> None:
        """Merge the stored tally into every session that hasn't had it yet.

        The first sight of a (product, trade date) loads it, so a restart
        carries on counting. A load that failed is retried here at the next
        flush, and the volume counted meanwhile is added to what is stored: the
        table holds only what earlier processes saw, never this one's counts
        (a session isn't saved until it is loaded).
        """
        for (product, day), tally in list(self._tally.items()):
            if tally.loaded:
                continue
            try:
                stored = await front_month.load_tally(product, day)
            except Exception as exc:
                self._warn_tally("tally_load_failed", "tally load failed", product, day, exc)
                continue
            for contract, volume in stored.items():
                tally.counts[contract] = tally.counts.get(contract, 0) + volume
            tally.loaded = True

    async def _decide(self, key: tuple[str, date]) -> None:
        """Ask for one session's contract, after saving the tally.

        The decision for a session reads the volume of the one before it, so
        that volume must be in the table first: with the tally unsaved the
        lookup is not made, and the session stays undecided until the next
        flush. A lookup that returns None is not cached either.
        """
        product, day = key
        if not await self._save_tally(product):
            return
        contract = await front_month.ensure_front(product, day)
        if contract is not None:
            self._decided[key] = contract

    async def _save_tally(self, product: str | None = None) -> bool:
        """Save the tallies that changed, one statement, for one product or all.

        False when a save failed, or when a tally with unsaved volume has not
        been loaded (it can't be saved yet), so a caller that needs the table
        current knows it isn't. Never raises.
        """
        sessions = [key for key in self._tally if product is None or key[0] == product]
        stuck = any(not self._tally[key].loaded and self._tally[key].dirty for key in sessions)
        dirty = [key for key in sessions if self._tally[key].loaded and self._tally[key].dirty]
        if dirty:
            rows = [
                (p, day, contract, volume)
                for p, day in dirty
                for contract, volume in self._tally[(p, day)].counts.items()
            ]
            try:
                await front_month.save_tally(rows)
            except Exception as exc:
                self._warn_tally(
                    "tally_save_failed", "tally save failed", dirty[0][0], dirty[0][1], exc
                )
                return False
            for key in dirty:
                self._tally[key].dirty = False
        return not stuck

    @staticmethod
    def _warn_tally(kind: str, message: str, product: str, day: date, exc: Exception) -> None:
        rate_limited_log.warning(
            scope="futures_trades",
            kind=kind,
            message=f"futures_trades {message}; retried at the next flush",
            extra={
                "product": product,
                "trade_date": day.isoformat(),
                "err_type": type(exc).__name__,
                "err": str(exc),
            },
        )

    def _evict_old_sessions(self) -> None:
        """Keep each product's ``_SESSIONS_KEPT`` newest trade dates.

        Run at the end of every flush, after the minutes that needed an older
        decision have been emitted, so the maps stay bounded by roots x 2.
        """
        by_product: dict[str, list[date]] = defaultdict(list)
        for product, day in self._tally:
            by_product[product].append(day)
        for product, days in by_product.items():
            for day in sorted(days)[:-_SESSIONS_KEPT]:
                del self._tally[(product, day)]
                self._decided.pop((product, day), None)

    def _ingest(self, print_: _Print) -> None:
        """Fold one print into the accumulator (dedup, tally, OHLCV, flow)."""
        # Late print for a minute already emitted: drop it BEFORE the dedup
        # and the tally. Usually a re-delivered copy arriving after its
        # minute's ``_seen`` set was evicted, so dedup can't catch it. Let
        # through, it would inflate the session tally, build a
        # one-print bar that DO NOTHING discards (or, for a minute that was
        # a gap, write a permanent partial bar), and could log a false
        # front_sym_absent.
        emitted_through = self._emitted_through.get(print_.product)
        if emitted_through is not None and print_.minute_ts <= emitted_through:
            self._note_late_drop(print_, emitted_through)
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
        tally.dirty = True

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
        that root until Neon answers, and only an error reaches Sentry. One
        line per product per window (``rate_limited_log`` only throttles
        warnings, so this keeps its own windows, one entry per product at most),
        with the running total.
        """
        self._unknown_minutes += 1
        now = time.monotonic()
        last = self._unknown_logged_at.get(product)
        if last is not None and now - last < MALFORMED_PAYLOAD_LOG_INTERVAL_S:
            return
        self._unknown_logged_at[product] = now
        log.error(
            "futures_trades front-month contract unknown for a completed minute; bar skipped",
            extra={
                "scope": "futures_trades",
                "kind": "front_month_unknown",
                "product": product,
                "trade_date": day.isoformat(),
                "minute_ts": minute_ts.isoformat(),
                "unknown_total": self._unknown_minutes,
            },
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
                # minute is a gap. Not cached, so the next flush asks again.
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
