"""option_trades:{SPY,SPXW,QQQ} — raw ticks + Interval B/A ask-side alerts.

Subclasses :class:`OptionTradesHandler` so option ticks continue to flow
into ``ws_option_trades`` via the inherited ``_transform`` + ``_flush``.
On top of that, an in-memory per-contract 5-minute bucket tracks the
ask-side premium ratio; when a bucket crosses the configured ratio AND
clears the premium floor, one alert row is queued for ``interval_ba_alerts``.

Architecture: ``IntervalBAHandler`` is the base class, with one thin
per-ticker subclass each (``SPYIntervalBAHandler``, ``SPXWIntervalBAHandler``,
``QQQIntervalBAHandler``) that binds the ticker via class attribute
``_TICKER``. Each subclass gets its own queue + drain task by virtue of
being a distinct class (the ``one-instance-per-class`` invariant in
``main._build_handlers``), so SPY's tick rate can't backpressure SPXW.

Why a dedicated per-ticker handler:

- SPX/SPXW option fills are dominated by mid-side prints because the
  NBBO is wide and most institutional flow is worked between the quote.
  A ≥75% ask-side reading on a 5-min bucket is structurally rare for
  SPX/SPXW (unlike single-name tickers where 50-60% ask is normal) and
  signals real directional conviction. SPY/QQQ behave similarly per the
  2026-05-13 edge-cuts analysis, so the same 75% / $250K calibration
  applies to all three.
- The actionable piece is usually a single dominant sweep that drove
  the ratio. The alert payload surfaces that print (premium, size,
  timestamp, ``is_sweep`` / ``is_floor`` flags) alongside the ratio.
- Cross-symbol confluence (same-direction fires within 90s across two
  or more of the three tickers) lifts SPXW CALL hit-rate from 53% solo
  to 61% — see ``docs/superpowers/specs/interval-ba-confluence-2026-05-13.md``.

See ``docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md`` for
the original SPXW-only design.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import db
from config import settings
from handlers.option_trades import _COLUMNS as _RAW_COLUMNS
from handlers.option_trades import OptionTradesHandler
from logger_setup import log
from handlers.recent_fires import lookup_confluence, record
from notify import build_payload, schedule_notify
from sentry_setup import capture_exception

# Hot-path lookup: column name → tuple index in the raw-tick row built
# by OptionTradesHandler._transform. Evaluated at import so _observe is
# allocation-free per tick.
_C: dict[str, int] = {name: i for i, name in enumerate(_RAW_COLUMNS)}

# 0DTE detection: SPXW expires by CT calendar date. Use ZoneInfo so DST
# transitions are handled correctly (CST = UTC-6, CDT = UTC-5).
_CT = ZoneInfo("America/Chicago")

# Standard equity-option multiplier — SPX/SPXW are 100x.
_MULTIPLIER = Decimal(100)

# Quantize alert numerics to cents to keep the table tidy.
_TWO_PLACES = Decimal("0.01")

# Alert destination table + columns. Order MUST match the tuple shape
# returned by _build_alert_row; column list mirrors the migration
# (Phase 2 of the spec).
_ALERT_TABLE = "interval_ba_alerts"
_ALERT_COLUMNS: list[str] = [
    "option_chain",
    "ticker",
    "option_type",
    "strike",
    "expiry",
    "bucket_start",
    "bucket_end",
    "fired_at",
    "ratio_pct",
    "ask_premium",
    "total_premium",
    "trade_count",
    "top_trade_premium",
    "top_trade_size",
    "top_trade_executed_at",
    "top_trade_is_sweep",
    "top_trade_is_floor",
    "underlying_price",
    # Cross-symbol confluence — OTHER tickers from the SPY/SPXW/QQQ
    # trio that fired same-direction within the configured window.
    # Empty list when this handler fires solo; populated when a partner
    # ETF / index fired same-direction in the recent past. See
    # docs/superpowers/specs/interval-ba-confluence-2026-05-13.md.
    "confluence_tickers",
]
_ALERT_CONFLICT_COLS = ["option_chain", "bucket_start"]

# Symmetric window for cross-symbol confluence detection. A SPY fire
# tagged ``+SPXW`` means SPXW fired same-direction within this many
# seconds — the registry only stores the backward half; the forward
# half is filled in by the later-firing handler's own lookback.
# 90s is calibrated by the 2026-05-12 confluence-vs-solo analysis
# (docs/tmp/interval-ba-confluence-vs-solo-20260512-231709.md).
_CONFLUENCE_WINDOW_SEC = 90


@dataclass(slots=True, frozen=True)
class _Tick:
    """A single options trade reduced to the fields the bucket needs."""

    executed_at: datetime
    premium: Decimal
    size: int
    side: str  # 'ask' | 'bid' | 'mid' | 'no_side'
    is_sweep: bool
    is_floor: bool


class IntervalBAHandler(OptionTradesHandler):
    """Generic Interval B/A handler — one per-ticker subclass per instance.

    Subclasses bind the underlying ticker via class attribute ``_TICKER``
    (e.g. ``"SPY"``, ``"SPXW"``, ``"QQQ"``). Direct instantiation of this
    base class is rejected — use ``SPYIntervalBAHandler`` /
    ``SPXWIntervalBAHandler`` / ``QQQIntervalBAHandler``.

    Each subclass boots as its own handler instance (separate queue,
    separate drain task) by virtue of being a distinct class — see
    ``main._build_handlers`` for the one-instance-per-class invariant.
    A dedicated queue per ticker means SPY's high-volume tick stream
    cannot backpressure SPXW's alert path, and vice versa.
    """

    # Subclasses MUST set this — empty string here forces a clear
    # failure if the base class is instantiated directly.
    _TICKER: str = ""

    # Buckets older than this many windows are pruned per-chain on
    # every observe call. 3 = current + previous + one ahead-of-time
    # slot for clock skew, which is generous given UW's monotonic
    # delivery in steady state. Out-of-order ticks across more than 2
    # windows are extremely rare and would arrive too late to alert.
    _BUCKETS_TO_KEEP = 3

    # Soft cap on the dedupe set. When exceeded, prune entries older
    # than the most recently seen bucket - 24h. The bound is so far
    # above expected (~10K/day) that hitting it is itself a signal
    # something has gone wrong with bucket detection.
    _FIRED_PRUNE_THRESHOLD = 50_000

    def __init__(self) -> None:
        if not self._TICKER:
            raise NotImplementedError(
                f"{type(self).__name__} must set class attribute _TICKER "
                "(use one of SPYIntervalBAHandler / SPXWIntervalBAHandler / "
                "QQQIntervalBAHandler).",
            )
        # Pass the per-ticker channel name through so state.channel and
        # Sentry tags don't carry a stray "option_trades" entry left
        # over from the parent's default.
        super().__init__(name=f"option_trades:{self._TICKER}")

        # Per-contract, per-bucket tick storage. Bucketing by epoch
        # makes out-of-order ticks (UW WS reconnect can deliver up to
        # ~1 window late) idempotent — each tick lands in its correct
        # bucket regardless of arrival order.
        self._ticks: dict[str, dict[int, deque[_Tick]]] = {}

        # Dedupe: (option_chain, bucket_start_epoch_sec). Once we fire
        # for a bucket, suppress further alerts in that bucket even if
        # the ratio climbs further. Pruned on the rare overflow path
        # below — see _prune_fired_if_needed.
        self._fired: set[tuple[str, int]] = set()

        # Alert rows accumulated since the last flush. Drained alongside
        # raw ticks in _flush so they share the existing batch cadence
        # (~2s max latency, far inside the 5-min signal window).
        self._pending_alerts: list[tuple] = []

        # Tuning resolved once at construction. Decimal cast preserves
        # exact comparison against premium sums (which are also Decimal).
        #
        # Two gates: master switch (interval_ba_enabled) AND per-ticker
        # opt-in (this ticker present in interval_ba_tickers). The
        # per-ticker list lets the operator silence one ticker without
        # touching code if its signal degrades — the handler still boots
        # (registered in channel_registry) but writes nothing to the DB.
        master_on = bool(settings.interval_ba_enabled)
        ticker_on = self._TICKER in settings.interval_ba_tickers
        self._enabled = master_on and ticker_on
        self._ratio_threshold = Decimal(
            str(settings.interval_ba_ratio_threshold),
        )
        self._premium_floor = Decimal(settings.interval_ba_premium_floor)
        self._bucket_sec = int(settings.interval_ba_window_sec)

    # ------------------------------------------------------------------
    # Transform — runs the inherited raw-tick build, then side-effects
    # the rolling state and may queue an alert.
    # ------------------------------------------------------------------
    def _transform(self, payload: dict) -> tuple | None:
        row = super()._transform(payload)
        if row is None:
            return row
        # Side-effect bugs MUST NOT poison the raw-tick write path: a
        # raised exception here would bubble up through Handler.run()
        # and increment the channel's drop counter. Capture and swallow
        # — alerts are non-critical, raw ticks are.
        try:
            self._observe(payload, row)
        except Exception as exc:  # pragma: no cover - defensive
            capture_exception(
                exc,
                tags={
                    "component": "handler",
                    "channel": self.name,
                    "stage": "interval_ba_observe",
                },
                context={
                    "option_chain": row[_C["option_chain"]],
                },
            )
        return row

    def _observe(self, payload: dict, row: tuple) -> None:
        """Update rolling state for one tick; queue alert if it fires."""
        ticker = row[_C["ticker"]]
        if ticker != self._TICKER:
            # Defensive — each subclass is only registered for one
            # option_trades:<TICKER> channel, but a future routing change
            # must not silently start computing ratios on the wrong
            # universe (e.g. SPY ticks landing on the SPXW handler).
            return

        executed_at: datetime = row[_C["executed_at"]]
        expiry: date = row[_C["expiry"]]
        if expiry != _ct_date_from_utc(executed_at):
            # 0DTE filter: only fire on contracts expiring today (CT).
            return

        chain: str = row[_C["option_chain"]]
        bucket_start_epoch = self._bucket_epoch(executed_at)
        dedupe_key = (chain, bucket_start_epoch)
        if dedupe_key in self._fired:
            return

        # Bucket the tick by its own bucket epoch, NOT by the contract's
        # "current" bucket. An out-of-order tick from a previous bucket
        # lands in its own bucket without disturbing the active one —
        # the alert evaluation below only looks at THIS tick's bucket
        # so the stale data has no effect on a fresh bucket's ratio.
        chain_buckets = self._ticks.setdefault(chain, {})
        bucket = chain_buckets.setdefault(bucket_start_epoch, deque())

        # Build the tick. SPY/SPXW/QQQ all use the standard 100x options
        # multiplier: premium = price * size * 100. UW also publishes a
        # `premium` field but it's a string and not always present on the
        # WS payload — computing it locally from the typed row keeps us
        # source of truth and avoids string→Decimal parsing twice per tick.
        price: Decimal = row[_C["price"]]
        size: int = row[_C["size"]]
        tags = payload.get("tags") if isinstance(payload, dict) else None
        tick = _Tick(
            executed_at=executed_at,
            premium=price * Decimal(size) * _MULTIPLIER,
            size=size,
            side=row[_C["side"]],
            is_sweep=_has_tag(tags, "sweep"),
            is_floor=_has_tag(tags, "floor"),
        )
        bucket.append(tick)

        # Prune stale buckets for this contract (bounded memory). Done
        # AFTER the append so a late-arriving tick whose bucket survives
        # the cutoff is preserved; ticks older than _BUCKETS_TO_KEEP
        # windows behind the newest seen are dropped. The (N-1) offset
        # keeps exactly _BUCKETS_TO_KEEP buckets: with N=3 we retain
        # newest, newest-w, newest-2w and evict newest-3w and older.
        if len(chain_buckets) > self._BUCKETS_TO_KEEP:
            newest = max(chain_buckets)
            cutoff = newest - (self._BUCKETS_TO_KEEP - 1) * self._bucket_sec
            for stale_epoch in [e for e in chain_buckets if e < cutoff]:
                del chain_buckets[stale_epoch]

        # Re-evaluate aggregates over THIS tick's bucket only.
        ask_premium, total_premium, top_tick = _aggregate(bucket)
        if total_premium <= 0 or total_premium < self._premium_floor:
            return
        ratio = ask_premium / total_premium
        if ratio < self._ratio_threshold:
            return

        # Threshold crossed: queue the alert and dedupe.
        self._fired.add(dedupe_key)
        self._prune_fired_if_needed(bucket_start_epoch)
        bucket_start = datetime.fromtimestamp(bucket_start_epoch, tz=UTC)
        bucket_end = bucket_start + timedelta(seconds=self._bucket_sec)
        option_type = row[_C["option_type"]]
        # Cross-symbol confluence: look back ``_CONFLUENCE_WINDOW_SEC``
        # for same-direction fires on OTHER tickers, then record this
        # fire so the LATER-firing handlers can find us in their
        # lookbacks. Lookup-then-record is the documented order: the
        # current alert never appears in its own confluence list.
        fired_at = datetime.now(tz=UTC)
        confluence = lookup_confluence(
            ticker=ticker,
            option_type=option_type,
            fired_at=fired_at,
            window_sec=_CONFLUENCE_WINDOW_SEC,
        )
        record(ticker=ticker, option_type=option_type, fired_at=fired_at)
        alert_row = _build_alert_row(
            chain=chain,
            ticker=ticker,
            option_type=option_type,
            strike=row[_C["strike"]],
            expiry=expiry,
            bucket_start=bucket_start,
            bucket_end=bucket_end,
            fired_at=fired_at,
            ratio=ratio,
            ask_premium=ask_premium,
            total_premium=total_premium,
            trade_count=len(bucket),
            top_tick=top_tick,
            underlying_price=row[_C["underlying_price"]],
            confluence_tickers=confluence,
        )
        self._pending_alerts.append(alert_row)
        log.info(
            "interval_ba alert queued"
            if self._enabled
            else "interval_ba alert would have fired (disabled)",
            extra={
                "channel": self.name,
                "option_chain": chain,
                "bucket_start": bucket_start.isoformat(),
                "ratio_pct": str(alert_row[_ALERT_COLUMNS.index("ratio_pct")]),
                "total_premium": str(total_premium),
                "trade_count": len(bucket),
                "enabled": self._enabled,
            },
        )

    def _prune_fired_if_needed(self, latest_bucket_epoch: int) -> None:
        """Drop dedupe entries older than ~1 day if the set has grown.

        Pruning is amortised — only runs when the set exceeds the soft
        cap, so the steady-state hot path is a single membership check.
        """
        if len(self._fired) <= self._FIRED_PRUNE_THRESHOLD:
            return
        cutoff = latest_bucket_epoch - 24 * 3600
        self._fired = {(c, b) for (c, b) in self._fired if b >= cutoff}

    # ------------------------------------------------------------------
    # Flush — write raw ticks via super(), then any pending alert rows.
    # ------------------------------------------------------------------
    async def _flush(self, rows: list[tuple]) -> int:
        # Clear pending alerts up front. ``self._fired`` already records
        # which buckets we tried to alert on, so the bucket can't fire
        # again even if these rows never land. Trade-off: on DB failure
        # the alerts in THIS batch are dropped (no retry); the daemon
        # logs them via _observe and Sentry sees the flush failure.
        # Bounded memory is the priority over alert durability during
        # outages — alerts are a few rows/day, ticks are millions.
        pending = self._pending_alerts
        self._pending_alerts = []
        inserted = await super()._flush(rows)
        if pending and self._enabled:
            await db.bulk_insert_ignore_conflict(
                table=_ALERT_TABLE,
                columns=_ALERT_COLUMNS,
                rows=pending,
                conflict_cols=_ALERT_CONFLICT_COLS,
            )
            # Fire-and-forget Web Push notification for each row written.
            # See docs/superpowers/specs/interval-ba-push-v2-2026-05-12.md.
            # schedule_notify no-ops silently when VERCEL_NOTIFY_URL or
            # INTERNAL_NOTIFY_SECRET are unset, so this is safe to call
            # regardless of v2 activation state. It also holds a strong
            # ref to the task so the GC doesn't reap it mid-flight.
            for row in pending:
                payload = build_payload(row, _ALERT_COLUMNS)
                schedule_notify(payload)
        return inserted

    # ------------------------------------------------------------------
    # Internals exposed for tests.
    # ------------------------------------------------------------------
    def _bucket_epoch(self, ts: datetime) -> int:
        """Floor ``ts`` to the bucket boundary (epoch seconds).

        Bucket alignment is wall-clock to UTC seconds; since
        ``_bucket_sec`` divides evenly into the hour (e.g. 300s = 5min,
        600s = 10min) the floor is identical to a CT wall-clock floor
        for the periods we care about. If a future config sets a
        non-aligned window, alerts may straddle UW Periscope's UI
        buckets — that's acceptable for the alert's purpose.
        """
        epoch = int(ts.timestamp())
        return (epoch // self._bucket_sec) * self._bucket_sec


# ----------------------------------------------------------------------
# Pure helpers (no handler state) — kept module-level so tests can call
# them directly without instantiating the handler.
# ----------------------------------------------------------------------


def _aggregate(ticks: Iterable[_Tick]) -> tuple[Decimal, Decimal, _Tick | None]:
    """Sum ask / total premium and find the largest ask-side print.

    Returns ``(ask_premium, total_premium, top_ask_tick_or_None)``.
    Single pass over the iterable so the hot path stays O(n).
    """
    ask_premium = Decimal(0)
    total_premium = Decimal(0)
    top_tick: _Tick | None = None
    top_premium = Decimal(0)
    for t in ticks:
        total_premium += t.premium
        if t.side == "ask":
            ask_premium += t.premium
            if t.premium > top_premium:
                top_premium = t.premium
                top_tick = t
    return ask_premium, total_premium, top_tick


def _build_alert_row(
    *,
    chain: str,
    ticker: str,
    option_type: str,
    strike: Decimal,
    expiry: date,
    bucket_start: datetime,
    bucket_end: datetime,
    fired_at: datetime,
    ratio: Decimal,
    ask_premium: Decimal,
    total_premium: Decimal,
    trade_count: int,
    top_tick: _Tick | None,
    underlying_price: Decimal | None,
    confluence_tickers: list[str],
) -> tuple:
    """Assemble an alert tuple in ``_ALERT_COLUMNS`` order.

    ``fired_at`` is passed in (not computed here) so the caller can use
    the SAME instant for both the alert row and the RecentFires
    registry record — keeps the two views consistent down to the
    microsecond.
    """
    top_premium = (
        top_tick.premium.quantize(_TWO_PLACES) if top_tick is not None else None
    )
    return (
        chain,
        ticker,
        option_type,
        strike,
        expiry,
        bucket_start,
        bucket_end,
        fired_at,
        (ratio * Decimal(100)).quantize(_TWO_PLACES),
        ask_premium.quantize(_TWO_PLACES),
        total_premium.quantize(_TWO_PLACES),
        trade_count,
        top_premium,
        top_tick.size if top_tick is not None else None,
        top_tick.executed_at if top_tick is not None else None,
        top_tick.is_sweep if top_tick is not None else None,
        top_tick.is_floor if top_tick is not None else None,
        underlying_price,
        confluence_tickers,
    )


def _ct_date_from_utc(ts: datetime) -> date:
    """Map a UTC timestamp to the Chicago calendar date.

    SPX/SPXW expire by CT calendar date so 0DTE detection must use the
    Chicago zone, not UTC. ``ZoneInfo`` handles DST transitions.
    """
    return ts.astimezone(_CT).date()


def _has_tag(tags: Any, name: str) -> bool:
    """True iff ``name`` is a string entry in the ``tags`` list."""
    return isinstance(tags, list) and name in tags


# ----------------------------------------------------------------------
# Per-ticker subclasses — one class per option_trades:<TICKER> channel.
# Each binds the ticker via _TICKER. channel_registry maps the channel
# string to the subclass; main._build_handlers' one-instance-per-class
# invariant then gives each ticker its own queue + drain task.
# ----------------------------------------------------------------------


class SPYIntervalBAHandler(IntervalBAHandler):
    """option_trades:SPY → SPY raw ticks + interval B/A alerts."""

    _TICKER = "SPY"


class SPXWIntervalBAHandler(IntervalBAHandler):
    """option_trades:SPXW → SPXW raw ticks + interval B/A alerts.

    The original SPXW-only implementation lives here as a thin subclass
    of :class:`IntervalBAHandler`. All tests / channel_registry imports
    still reference this name unchanged.
    """

    _TICKER = "SPXW"


class QQQIntervalBAHandler(IntervalBAHandler):
    """option_trades:QQQ → QQQ raw ticks + interval B/A alerts."""

    _TICKER = "QQQ"
