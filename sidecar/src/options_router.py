"""Options-side record routing for the Databento Live pipeline.

Extracted from ``databento_client.py`` (Phase 3b refactor) so the
implicit options-vs-futures fault line in the original god-object
becomes explicit. This module owns:

- the ``_option_definitions`` cache (instrument_id -> strike/type/expiry)
- the ``_options_strikes`` ATM filter window (read by trade dispatch)
- the ``_definition_lag_drops`` counter + 60s summary throttle (SIDE-012)
- the three options handlers: ``handle_definition``, ``handle_trade``,
  ``handle_stat``

What does NOT live here: connection lifecycle, futures bar / TBBO
handling, symbol resolution, ATM-window centering. Those stay on
``DatabentoClient``. ATM recentering writes through to the router's
``_options_strikes`` directly — the router exposes it as a public
attribute so the centering caller can mutate the window without an
extra setter.

Per the Q4 decision: the router takes its dependencies as constructor
args (trade processor + shutdown predicate), no weak refs back to
``DatabentoClient``.
"""

from __future__ import annotations

import threading
import time
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Callable

from logger_setup import log
from session_calendar import cme_session_date
from stat_writer import StatRow, StatWriter
from symbol_manager import OptionsStrikeSet

if TYPE_CHECKING:
    from trade_processor import TradeProcessor


# Stat type constants from the Databento Statistics schema. Re-exported
# here so consumers (incl. tests) have one source of truth — these
# numbers are wire-protocol values, not implementation choices.
STAT_TYPE_OPENING_PRICE = 1
STAT_TYPE_SETTLEMENT = 3
STAT_TYPE_CLEARED_VOLUME = 6
STAT_TYPE_OPEN_INTEREST = 9
STAT_TYPE_IMPLIED_VOL = 14
STAT_TYPE_DELTA = 15

# Map Databento stat_type to (upsert_options_daily kwarg name, value source).
# value_source is "stat_value" (Decimal, scaled by 1e-9) or "stat_quantity"
# (raw int, e.g. open_interest contracts or cleared volume contracts).
#
# Adding a new stat type: add the entry here AND make sure
# upsert_options_daily() accepts the kwarg. The handler dispatches purely
# from this dict; the locked test in test_databento_client.py forces
# new entries to be a deliberate change.
STAT_TYPE_TO_KWARG: dict[int, tuple[str, str]] = {
    STAT_TYPE_OPEN_INTEREST: ("open_interest", "stat_quantity"),
    STAT_TYPE_SETTLEMENT: ("settlement", "stat_value"),
    STAT_TYPE_CLEARED_VOLUME: ("volume", "stat_quantity"),
    STAT_TYPE_IMPLIED_VOL: ("implied_vol", "stat_value"),
    STAT_TYPE_DELTA: ("delta", "stat_value"),
}

# SIDE-012: emit a lag-drop summary at most once per this interval.
DEFINITION_LAG_SUMMARY_INTERVAL_S = 60.0

# FINDING 4: emit a window-filter-drop summary at most once per this interval.
WINDOW_FILTER_SUMMARY_INTERVAL_S = 60.0

# AUD-M26: emit a stat-upsert-failure summary at most once per this interval.
# A persistent failure (numeric overflow, schema drift, the SIDE-016 enum-adapt
# class) would otherwise rot futures_options_daily with zero alerting. Matches
# the SIDE-012 / FINDING 4 throttle cadence so a stuck upsert path is visible in
# Sentry within a minute without per-row spam (stat records on a single iid can
# arrive several times a second).
STAT_UPSERT_FAILURE_SUMMARY_INTERVAL_S = 60.0

# Window-filter drops are EXPECTED during trending sessions: as ES trends,
# the ATM window recenters and previously-subscribed (now off-window) strikes
# keep printing — we deliberately track only ATM +/-10, so filtering those is
# healthy, not data loss. Routine drop counts (tens/min on a trending day) are
# therefore logged locally at INFO and must NOT page. The one genuinely
# actionable failure mode is a STALE/FROZEN window (e.g. ES OHLCV bars stop
# arriving, so recentering halts): then the entire near-ATM tape — hundreds to
# thousands of trades/min — starts failing the filter. Only escalate to a
# Sentry warning once drops in the summary interval cross this threshold, which
# sits well above observed trending-session noise (~40/min on 2026-05-29) yet
# far below a frozen-window tape. Heuristic — tune against future trending days
# if benign sessions start tripping it.
WINDOW_FILTER_STALE_DROP_THRESHOLD = 150

# FINDING 4: ATM-window strikes sit on a 5-point grid; a half-point band
# absorbs float-representation noise (e.g. 5849.9999999 vs 5850) without
# false-matching a genuinely off-grid / off-window strike.
STRIKE_MATCH_TOLERANCE = 0.5

# M7: prune past-expiry entries from option_definitions at most once per
# this interval. The Definition subscribe uses start=0 (full snapshot) and
# is re-issued on every reconnect, so iids accumulate across every expiry
# and reconnect for the whole 24/7 process lifetime — unbounded slow memory
# growth without pruning. One hour is far below the daily-expiry cadence that
# makes entries stale, while keeping the prune well off the hot per-message
# path.
DEFINITION_PRUNE_INTERVAL_S = 3600.0


class OptionsRecordRouter:
    """Owns options-side state and dispatches Definition/Trade/Stat records.

    Lifecycle: created once by ``DatabentoClient.__init__``; the client
    holds a reference and delegates to ``handle_definition``,
    ``handle_trade``, and ``handle_stat`` from its central record callback.

    State invariants:

    - ``option_definitions`` is the only place an iid → option-info
      mapping lives; both ``handle_trade`` and ``handle_stat`` consult
      it and silently drop records whose iid hasn't been seen yet.
      Drops on the trade path are counted (``definition_lag_drops``)
      and surfaced via a periodic summary so a lagging Definition
      pipeline becomes visible instead of silently rotting.
    - ``options_strikes`` is the ATM ±10 filter window. The router
      reads ``options_strikes.strikes`` to gate trade writes; the
      centering logic on ``DatabentoClient`` mutates the same object
      through the public attribute (no setter needed because the
      caller mutates fields, not the reference itself in production —
      tests sometimes reassign the attribute, which works fine because
      it's a plain attribute).
    """

    def __init__(
        self,
        trade_processor: TradeProcessor,
        is_shutting_down: Callable[[], bool],
    ) -> None:
        # Per Q4: constructor args, not weak refs back to DatabentoClient.
        self._trade_processor = trade_processor
        self._is_shutting_down = is_shutting_down

        # ATM ±10 strike window. Centered by DatabentoClient on each
        # ES bar; we just read .strikes to gate trade writes.
        self.options_strikes = OptionsStrikeSet()

        # iid -> {"strike": float, "option_type": "C"|"P", "expiry": date}
        self.option_definitions: dict[int, dict] = {}

        # SIDE-012: definition-lag drop tracking.
        self.definition_lag_drops = 0
        self.last_lag_summary_ts = 0.0

        # FINDING 4: ATM-window-filter drop tracking (distinct cause from
        # definition lag — these are known instruments whose strike fell
        # outside the current ATM window). Own throttle state.
        self.window_filter_drops = 0
        self.last_window_summary_ts = 0.0

        # AUD-M26: stat-upsert-failure tracking. A persistent upsert failure
        # (numeric overflow, schema drift, enum-adapt) was previously log-only
        # with zero Sentry alerting. Own throttle state so it doesn't mask /
        # get masked by the other two drop causes; the last raised exception
        # text is carried into the summary so the root cause is visible.
        self.stat_upsert_failures = 0
        self.last_stat_failure_summary_ts = 0.0
        self.last_stat_failure_error = ""

        # M7: throttle state for periodic pruning of past-expiry entries
        # from option_definitions. Matches the time.time() source used by
        # the SIDE-012 / FINDING 4 throttles above.
        self.last_prune_ts = 0.0

        # Guards concurrent writes to option_definitions from the SDK
        # callback thread vs reads from other handlers.
        self._lock = threading.Lock()

        # AUD-M27: route option-stat upserts through a BatchedWriter so
        # the synchronous Neon round trip (a pool borrow + reconnect
        # retry, up to ~10s during a stall) no longer runs on — and
        # head-of-line-blocks — the single SDK callback thread that also
        # drives TBBO + options-trade ingestion. handle_stat now only
        # enqueues; the writer's background thread drains to Neon. The
        # AUD-M26 failure counter is preserved via on_write_failure.
        self._stat_writer = StatWriter(on_write_failure=self._on_stat_write_failure)

    # ------------------------------------------------------------------
    # Definition handler
    # ------------------------------------------------------------------

    def handle_definition(self, record: Any) -> None:
        """Process an InstrumentDefMsg to discover ES option instruments."""
        from datetime import datetime, timezone

        instrument_class = getattr(record, "instrument_class", None)
        if instrument_class not in ("C", "P"):
            # Not a call or put -- could be a future ('F') or other.
            # NOTE: databento_dbn returns an InstrumentClass enum whose
            # __eq__ compares True against its string value, so this
            # ``in`` check works for both enum and bare-string inputs.
            return

        # SIDE-016: coerce InstrumentClass enum → string before storing.
        # databento_dbn.InstrumentClass.CALL compares == 'C' (that's why
        # the filter above works) but the value stored here propagates
        # through handle_trade / handle_stat into psycopg2, which
        # can't adapt the enum ("can't adapt type 'databento_dbn.
        # InstrumentClass'"). The .value attribute gives the bare 'C'/
        # 'P' string; the str() fallback covers older SDKs where
        # instrument_class is already a bare string.
        option_type_str = getattr(instrument_class, "value", str(instrument_class))

        strike_raw = getattr(record, "strike_price", 0)
        strike = float(strike_raw) / 1e9 if strike_raw else 0

        expiry_ns = getattr(record, "expiration", 0)
        if expiry_ns:
            expiry = datetime.fromtimestamp(expiry_ns / 1e9, tz=timezone.utc).date()
        else:
            return

        iid = getattr(record, "instrument_id", 0)

        # M7: periodically drop past-expiry entries so the cache doesn't grow
        # unbounded across expiries/reconnects. Runs BEFORE we take self._lock
        # for the insert below — the prune does its own locking, so the lock is
        # never acquired twice (threading.Lock is non-reentrant). The throttle
        # state (last_prune_ts) is touched only on this single SDK callback
        # thread, matching how the SIDE-012 throttle fields are handled.
        self._maybe_prune_expired_definitions()

        with self._lock:
            self.option_definitions[iid] = {
                "strike": strike,
                "option_type": option_type_str,  # 'C' or 'P'
                "expiry": expiry,
            }

        log.debug(
            "Definition: iid=%d strike=%.2f type=%s expiry=%s",
            iid,
            strike,
            option_type_str,
            expiry,
        )

    # ------------------------------------------------------------------
    # Trade handler
    # ------------------------------------------------------------------

    def handle_trade(self, record: Any) -> None:
        """Process an ES options trade record."""
        if self._is_shutting_down():
            return

        # M7: also drive the throttled past-expiry prune from the trade path.
        # handle_definition is the original caller, but during long stretches
        # with only Trade/Stat traffic (no Definition messages) the 1-hour prune
        # would never fire. Trades arrive continuously, so calling the throttled
        # gate here keeps the prune running regardless of definition traffic. The
        # time.time() compare makes a no-op call ~free. handle_trade holds NO
        # lock at this point — the prune acquires self._lock itself, so there is
        # no double-lock (threading.Lock is non-reentrant).
        self._maybe_prune_expired_definitions()

        # Lazy import: matches the original databento_client behavior
        # — keeps cold-start cost off the import path.
        from databento import Side

        side = getattr(record, "side", None)
        if side == Side.ASK:
            side_char = "A"
        elif side == Side.BID:
            side_char = "B"
        else:
            side_char = "N"

        iid = getattr(record, "instrument_id", 0)
        instrument_info = self._get_option_info(iid)
        if instrument_info is None:
            # SIDE-012: no Definition cached for this instrument_id —
            # either the trade arrived before its Definition (lag) or
            # we never received a Definition for this id at all
            # (untracked instrument). Count it and let the periodic
            # summary surface the total. Previously this was a silent
            # return with no visibility.
            self.definition_lag_drops += 1
            self._maybe_log_definition_lag_summary()
            return

        strike = instrument_info["strike"]
        option_type = instrument_info["option_type"]
        expiry = instrument_info["expiry"]

        # Filter: only process strikes in our ATM window. Match with a
        # ±STRIKE_MATCH_TOLERANCE band rather than exact equality so a
        # float-representation noise strike (5849.9999999) still matches
        # its clean 5-point-grid window entry (5850). FINDING 4: exact
        # equality silently dropped such strikes with no counter/log.
        if not any(
            abs(strike - s) <= STRIKE_MATCH_TOLERANCE
            for s in self.options_strikes.strikes
        ):
            self.window_filter_drops += 1
            self._maybe_log_window_filter_summary()
            return

        self._trade_processor.process_trade(
            underlying="ES",
            expiry=expiry,
            strike=strike,
            option_type=option_type,
            ts_ns=record.ts_event,
            price_raw=record.price,
            size=record.size,
            side_char=side_char,
        )

    # ------------------------------------------------------------------
    # Stat handler
    # ------------------------------------------------------------------

    def handle_stat(self, record: Any) -> None:
        """Process a Statistics record (OI, settlement, IV, delta).

        Dispatch is driven by ``STAT_TYPE_TO_KWARG`` — each entry maps
        a Databento stat_type to the ``upsert_options_daily(...)`` kwarg
        + the source field on the record (``stat_value`` is a 1e-9-scaled
        Decimal price; ``stat_quantity`` is a raw integer count).
        """
        if self._is_shutting_down():
            return

        stat_type = record.stat_type
        mapping = STAT_TYPE_TO_KWARG.get(stat_type)
        if mapping is None:
            return
        kwarg_name, value_source = mapping

        iid = getattr(record, "instrument_id", 0)
        instrument_info = self._get_option_info(iid)
        if instrument_info is None:
            return

        strike = instrument_info["strike"]
        option_type = instrument_info["option_type"]
        expiry = instrument_info["expiry"]

        # FINDING 5: bucket the stat by its CME session date (17:00 CT roll,
        # DST-aware), derived from the record's ts_event — NOT the container
        # local-clock date.today(), which mis-buckets every overnight stat.
        # StatMsg defines ts_event (verified against databento_dbn 0.53.0).
        # If it's missing or non-positive we must NOT silently fall back to
        # a local-clock date (would reintroduce the bug); skip + capture.
        ts_event = getattr(record, "ts_event", None)
        if not isinstance(ts_event, int) or ts_event <= 0:
            from sentry_setup import capture_message

            capture_message(
                "Dropped ES option stat with missing/invalid ts_event — "
                "cannot resolve CME session date",
                level="warning",
                context={"stat_type": stat_type, "strike": strike},
            )
            return
        trade_date = cme_session_date(ts_event)

        # Resolve the value from the configured source field.
        if value_source == "stat_value":
            value: Any = (
                Decimal(record.stat_value) / Decimal(1_000_000_000)
                if hasattr(record, "stat_value")
                else None
            )
        else:  # "stat_quantity"
            stat_quantity = getattr(record, "stat_quantity", None)
            value = int(stat_quantity) if stat_quantity else None

        # Assemble exactly the kwargs the synchronous upsert used to pass:
        # the stat-specific value plus an optional is_final on settlement.
        kwargs: dict[str, Any] = {kwarg_name: value}
        if stat_type == STAT_TYPE_SETTLEMENT:
            kwargs["is_final"] = bool(getattr(record, "stat_flags", 0) & 1)

        # AUD-M27: enqueue to the off-thread StatWriter instead of calling
        # upsert_options_daily synchronously here. The buffered write drains
        # on the StatWriter's background flush; a Neon stall on the stat path
        # no longer head-of-line-blocks TBBO / options-trade ingestion on this
        # SDK callback thread. futures_options_daily is ON CONFLICT DO UPDATE,
        # so the writer's bounded re-queue on failure is safe. The AUD-M26
        # failure counter is preserved via _on_stat_write_failure (wired as
        # the writer's on_write_failure callback).
        self._stat_writer.add(
            StatRow(
                underlying="ES",
                trade_date=trade_date,
                expiry=expiry,
                strike=Decimal(str(strike)),
                option_type=option_type,
                kwargs=kwargs,
            )
        )

    def _on_stat_write_failure(self, exc: BaseException) -> None:
        """AUD-M26 failure tracking, driven from the StatWriter's _write.

        Previously ``handle_stat`` caught the synchronous upsert exception
        inline. Now the upsert runs on the StatWriter's background thread,
        so the writer invokes this callback on a write failure (before it
        re-raises so BatchedWriter re-queues the idempotent rows). Keeps the
        per-failure log line plus the throttled Sentry summary so a
        persistent upsert failure — numeric overflow, schema drift, the
        SIDE-016 enum-adapt class — surfaces instead of silently rotting
        futures_options_daily.

        Called on the StatWriter's flush thread, not the SDK callback
        thread; the counter/summary state it touches is only read+written
        here and in the throttled summary, so no extra lock is needed (the
        single background flush thread serializes these updates).
        """
        log.error("Failed to upsert stat batch: %s", exc)
        self.stat_upsert_failures += 1
        self.last_stat_failure_error = f"{type(exc).__name__}: {exc}"
        self._maybe_log_stat_upsert_failure_summary()

    def start_stat_flush(self) -> None:
        """Start the StatWriter's background flush thread.

        Stats rarely fill a batch on their own, so the time-based flush is
        the primary drain path. Called by ``DatabentoClient.start()``.
        """
        self._stat_writer.start_background_flush()

    def stop_stat_writer(self) -> None:
        """Stop the StatWriter (joins the flush thread + final flush).

        Called by ``DatabentoClient.stop()`` so buffered stats land in Neon
        before the DB pool is drained on shutdown.
        """
        self._stat_writer.stop()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_option_info(self, instrument_id: int) -> dict | None:
        """Look up option strike/type/expiry for an instrument_id."""
        return self.option_definitions.get(instrument_id)

    def _maybe_prune_expired_definitions(self) -> None:
        """Throttle gate for ``_prune_expired_definitions`` (M7).

        Called from ``handle_definition`` on every definition message. Runs
        the prune only when at least ``DEFINITION_PRUNE_INTERVAL_S`` seconds
        have elapsed since the last prune, so the O(n) scan stays off the hot
        per-message path. Uses ``time.time()`` to match the SIDE-012 /
        FINDING 4 throttles. The throttle bookkeeping (``last_prune_ts``) is
        read/written without the lock because definitions are processed on a
        single SDK callback thread — the lock guards only ``option_definitions``
        itself, which the prune mutates under its own ``with self._lock``.
        """
        now = time.time()
        if now - self.last_prune_ts < DEFINITION_PRUNE_INTERVAL_S:
            return
        self.last_prune_ts = now
        self._prune_expired_definitions()

    def _prune_expired_definitions(self) -> None:
        """Remove option_definitions entries whose expiry is in the past (M7).

        The Definition subscribe uses ``start=0`` (full snapshot) and is
        re-issued on every reconnect, so ``option_definitions`` would otherwise
        accumulate every iid ever seen — across every expiry and reconnect —
        for the whole 24/7 process lifetime. This drops entries that can never
        match a live trade again: any cached ``expiry`` strictly before today.

        ``today`` is the current UTC date, matching ``handle_definition``'s
        ``datetime.fromtimestamp(expiry_ns / 1e9, tz=timezone.utc).date()`` so
        the comparison is apples-to-apples. Stale iids are collected first, then
        deleted, to avoid mutating the dict while iterating it. All mutation
        happens under ``self._lock`` (the same guard as the inserts).
        """
        from datetime import datetime, timezone

        today = datetime.now(timezone.utc).date()
        with self._lock:
            stale_iids = [
                iid
                for iid, info in self.option_definitions.items()
                if info["expiry"] < today
            ]
            for iid in stale_iids:
                del self.option_definitions[iid]

        if stale_iids:
            log.info(
                "Pruned %d past-expiry ES option definitions (cache now %d)",
                len(stale_iids),
                len(self.option_definitions),
            )

    def _maybe_log_definition_lag_summary(self) -> None:
        """Emit a periodic summary of definition-lag drops (SIDE-012).

        Called from ``handle_trade``. If any trades have been dropped
        since the last summary AND at least
        ``DEFINITION_LAG_SUMMARY_INTERVAL_S`` seconds have passed, log a
        structured warning (and forward to Sentry) then reset the
        counter. This converts a previously-silent failure mode into
        a visible one without spamming logs on every drop.
        """
        if self.definition_lag_drops == 0:
            return
        now = time.time()
        if now - self.last_lag_summary_ts < DEFINITION_LAG_SUMMARY_INTERVAL_S:
            return
        drops = self.definition_lag_drops
        self.definition_lag_drops = 0
        self.last_lag_summary_ts = now

        from sentry_setup import capture_message

        capture_message(
            f"Dropped {drops} ES option trades with no cached Definition "
            f"(unknown instrument_id — either Definition lag or an "
            f"untracked instrument)",
            level="warning",
            context={
                "drops": drops,
                "interval_s": round(DEFINITION_LAG_SUMMARY_INTERVAL_S, 1),
            },
        )

    def _maybe_log_window_filter_summary(self) -> None:
        """Emit a periodic summary of ATM-window-filter drops (FINDING 4).

        Called from ``handle_trade`` when a known instrument's strike falls
        outside the current ATM window. Mirrors the definition-lag summary
        but uses its own throttle state so the two distinct drop causes don't
        mask each other. Converts the previously-silent window filter into a
        visible one without log-spamming on every drop.
        """
        if self.window_filter_drops == 0:
            return
        now = time.time()
        if now - self.last_window_summary_ts < WINDOW_FILTER_SUMMARY_INTERVAL_S:
            return
        drops = self.window_filter_drops
        self.window_filter_drops = 0
        self.last_window_summary_ts = now

        # Routine trending-session filtering: log locally, do not page.
        if drops < WINDOW_FILTER_STALE_DROP_THRESHOLD:
            log.info(
                "Filtered %d off-ATM-window ES option trades in last %.0fs "
                "(expected as ES trends; tracking ATM +/-10 only)",
                drops,
                WINDOW_FILTER_SUMMARY_INTERVAL_S,
            )
            return

        # Above the stale-window threshold: the ATM window is likely frozen
        # (ES OHLCV bars stalled, so recentering halted) and we are dropping
        # the live near-ATM tape. THIS is the actionable case — page Sentry.
        from sentry_setup import capture_message

        capture_message(
            f"Dropped {drops} ES option trades outside the ATM strike window "
            f"in {WINDOW_FILTER_SUMMARY_INTERVAL_S:.0f}s "
            f"(>= {WINDOW_FILTER_STALE_DROP_THRESHOLD}/interval — ATM window "
            f"may be STALE; check ES OHLCV bar arrival / recentering)",
            level="warning",
            context={
                "drops": drops,
                "interval_s": round(WINDOW_FILTER_SUMMARY_INTERVAL_S, 1),
                "stale_threshold": WINDOW_FILTER_STALE_DROP_THRESHOLD,
            },
        )

    def _maybe_log_stat_upsert_failure_summary(self) -> None:
        """Emit a periodic summary of stat-upsert failures (AUD-M26).

        Called from ``_on_stat_write_failure`` (on the StatWriter flush
        thread) when a buffered stat upsert raises. If any upserts have
        failed since the last summary AND at least
        ``STAT_UPSERT_FAILURE_SUMMARY_INTERVAL_S`` seconds have passed, page
        Sentry with the failure count plus the most recent error string, then
        reset the counter. Mirrors the SIDE-012 / FINDING 4 throttled summaries
        (same ``time.time()`` clock, own throttle state) so a persistent upsert
        failure — numeric overflow, schema drift, the SIDE-016 enum-adapt class
        — becomes visible in Sentry instead of silently rotting
        ``futures_options_daily``, without per-row Sentry spam.
        """
        if self.stat_upsert_failures == 0:
            return
        now = time.time()
        if (
            now - self.last_stat_failure_summary_ts
            < STAT_UPSERT_FAILURE_SUMMARY_INTERVAL_S
        ):
            return
        failures = self.stat_upsert_failures
        last_error = self.last_stat_failure_error
        self.stat_upsert_failures = 0
        self.last_stat_failure_summary_ts = now

        from sentry_setup import capture_message

        capture_message(
            f"Failed to upsert {failures} ES option stat(s) into "
            f"futures_options_daily in "
            f"{STAT_UPSERT_FAILURE_SUMMARY_INTERVAL_S:.0f}s "
            f"(persistent failure rots the table — check for numeric overflow / "
            f"schema drift / enum-adapt). Last error: {last_error}",
            level="warning",
            context={
                "failures": failures,
                "interval_s": round(STAT_UPSERT_FAILURE_SUMMARY_INTERVAL_S, 1),
                "last_error": last_error,
            },
        )
