"""Databento Live client: multi-symbol subscription for futures OHLCV-1m,
ES options Trades, Statistics, and Definition schemas.

Uses the official databento Python SDK with:
- Callback-based record processing
- Automatic reconnection with exponential backoff
- Multiple subscribe() calls for different schema/dataset combos
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import databento as db
from databento import ReconnectPolicy, Side

from config import settings
from logger_setup import log
from symbol_manager import (
    DATASET_CME,
    OptionsStrikeSet,
    compute_atm_strikes,
    get_all_futures_subscriptions,
    get_nearest_es_expiry,
)

if TYPE_CHECKING:
    from quote_processor import QuoteProcessor
    from trade_processor import TradeProcessor


# Stat type constants from Databento Statistics schema
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

# Phase 2a note: we subscribe ONLY to ``tbbo``, never ``mbp-1``. Both
# schemas emit ``MBP1Msg`` and share the same ``rtype``
# (``RType.from_schema(Schema.MBP_1).value == RType.from_schema(Schema.TBBO).value == 1``),
# so they cannot be distinguished at the record level. Subscribing to
# both would also double-deliver every trade — TBBO is the subset of
# MBP-1 events where ``action == 'T'``. TBBO alone gives us quotes at
# trade moments + the trade tick in one stream with no duplication.


class DatabentoClient:
    """Manages the Databento Live connection and data routing."""

    def __init__(
        self,
        trade_processor: TradeProcessor,
        quote_processor: QuoteProcessor | None = None,
    ) -> None:
        self._client: db.Live | None = None
        self._trade_processor = trade_processor
        # Optional to keep older callers (and test fixtures) compatible.
        # In production main.py passes a real QuoteProcessor so TBBO
        # events get persisted; when None, those records are silently
        # ignored by _handle_tbbo and _subscribe_es_l1 is skipped.
        self._quote_processor = quote_processor
        self._connected = False
        self._last_bar_ts = 0.0
        self._options_strikes = OptionsStrikeSet()
        self._lock = threading.Lock()

        # Shutdown barrier: set True at the start of stop() so in-flight
        # Databento callbacks can early-return before initiating a new DB
        # write. Prevents the "callback mid-flight when pool drains" race
        # flagged by the audit under SIDE-006.
        self._shutting_down = False

        # SIDE-012: definition-lag drop tracking. When a trade arrives
        # before its Definition record, _handle_trade silently dropped
        # it. Now we count the drops and emit a periodic summary so
        # operators can see if definition lag is systematic vs transient.
        self._definition_lag_drops = 0
        self._last_lag_summary_ts = 0.0

        # SIDE-011: reconnect gap observability. When the SDK reconnects
        # after a disconnect, we want to know (a) how long the gap was
        # and (b) whether the price jumped discontinuously across it.
        # This maps symbol -> last close seen before the disconnect, so
        # the first bar after reconnect can sanity-check itself against
        # the pre-disconnect level.
        self._last_close_before_disconnect: dict[str, float] = {}
        # Set by _on_reconnect() so the next bar handler for each
        # symbol knows it should run the ATR-style sanity check.
        self._reconnect_sanity_check_pending: set[str] = set()

        # Map raw symbol prefixes to internal names for resolving
        # SDK symbology_map values (e.g., "ESM5" -> "ES")
        self._prefix_to_internal: dict[str, str] = {}

        # Cache: instrument_id -> internal symbol (populated on first resolve)
        self._resolved_cache: dict[int, str | None] = {}

        # Log symbol mapping summary once, not per-contract
        self._mapping_summary_logged = False

        # Store option definitions: instrument_id -> {strike, option_type, expiry}
        self._option_definitions: dict[int, dict] = {}

        # Whether we're waiting for the first ES bar to subscribe to options
        self._options_subscription_pending = False

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def last_bar_ts(self) -> float:
        return self._last_bar_ts

    def start(self) -> None:
        """Initialize the Databento Live client and subscribe to all feeds."""
        log.info("Initializing Databento Live client")

        self._client = db.Live(
            key=settings.databento_api_key,
            ts_out=True,
            heartbeat_interval_s=30,
            reconnect_policy=ReconnectPolicy.RECONNECT,
        )

        # Add reconnect callback
        self._client.add_reconnect_callback(self._on_reconnect)

        # Add record callback for all incoming data
        self._client.add_callback(
            record_callback=self._on_record,
            exception_callback=self._on_error,
        )

        # Subscribe to futures OHLCV-1m (CME Group only — single dataset per session)
        self._subscribe_futures_ohlcv()

        # Subscribe to ES + NQ TBBO for the Phase 5a dual-symbol pipeline.
        # TBBO-only, not MBP-1 + TBBO — see the comment block above the
        # class for why. Phase 4d validated NQ 1h OFI as a Bonferroni-
        # significant predictor of next-day NQ return (ρ=0.313, p<0.001,
        # n=312); ES OFI carries no significant signal but we keep it as
        # qualitative tape flavor alongside NQ.
        if self._quote_processor is not None:
            self._subscribe_l1()

        # Subscribe to the ES.OPT streams (definition/statistics/trades)
        # NOW, before client.start(). Definitions in particular require
        # ``start=0`` to get a snapshot of the session's current
        # instruments, and Databento rejects ``start`` after the session
        # has started. Without the snapshot, the _option_definitions
        # cache never populates and every trade silently hits the
        # definition-lag drop path (SIDE-015). The ATM strike filter
        # that gates writes in _handle_trade/_handle_stat still needs
        # an ES price to set up — that happens on the first ES bar via
        # _update_atm_strikes(), which no longer touches subscribe().
        self._subscribe_es_options_streams()

        # The ATM strike window still needs the first ES bar to center.
        self._options_subscription_pending = True

        # Start streaming (non-blocking with callbacks)
        self._client.start()
        self._connected = True
        log.info("CME Live client started -- streaming")

    def _subscribe_futures_ohlcv(self) -> None:
        """Subscribe to OHLCV-1m for CME/CBOT/NYMEX futures."""
        if not self._client:
            return

        subs = get_all_futures_subscriptions()

        # CME Group products (ES, NQ, ZN, RTY, CL) all on GLBX.MDP3
        cme_symbols = []
        for sym, cfg in subs.items():
            if cfg["dataset"] == DATASET_CME:
                cme_symbols.append(cfg["parent_symbol"])
                # Map prefix for resolving raw symbols from SDK symbology_map
                # e.g., "ES" -> "ES" so "ESM5" matches prefix "ES"
                self._prefix_to_internal[cfg["db_symbol"]] = cfg["db_symbol"]

        if cme_symbols:
            self._client.subscribe(
                dataset=DATASET_CME,
                schema="ohlcv-1m",
                symbols=cme_symbols,
                stype_in="parent",
            )
            log.info(
                "Subscribed to OHLCV-1m on %s: %s",
                DATASET_CME,
                cme_symbols,
                extra={"symbols": cme_symbols},
            )

    def _subscribe_l1(self) -> None:
        """Subscribe to ES + NQ TBBO on GLBX.MDP3 (Phase 5a).

        Only one schema: ``tbbo``. Each record is a trade with the
        pre-trade BBO in ``levels[0]``, so we derive both the quote
        snapshot and the trade tick from a single stream. MBP-1 is
        deliberately not subscribed — see the rationale in the
        module-level comment and in ``quote_processor``. Parent
        symbology (ES.FUT, NQ.FUT) resolves to the active front-month
        contract the same way OHLCV-1m does.

        Phase 5a widens Phase 2a's ES-only subscription to include
        NQ because Phase 4d microstructure EDA found NQ 1h OFI to be
        Bonferroni-significant (ρ=0.313, p_bonf<0.001, n=312) for
        next-day NQ return, while ES carries no significant signal.
        Both symbols flow through the same QuoteProcessor writers —
        ``futures_trade_ticks`` and ``futures_top_of_book`` already
        carry a ``symbol`` column.
        """
        if not self._client:
            return

        self._client.subscribe(
            dataset=DATASET_CME,
            schema="tbbo",
            symbols=["ES.FUT", "NQ.FUT"],
            stype_in="parent",
        )
        log.info("Subscribed to ES + NQ TBBO on %s", DATASET_CME)

    def _handle_ohlcv_from_client(self, record: Any, client: db.Live | None) -> None:
        """Process an OHLCV bar using a specific client's symbology map."""
        if self._shutting_down:
            return
        from db import upsert_futures_bar

        iid = getattr(record, "instrument_id", None)
        if iid is None or client is None:
            return

        raw_symbol = client.symbology_map.get(iid)
        if raw_symbol is None:
            return

        raw_str = str(raw_symbol)

        # Filter out spreads/combos
        if "-" in raw_str or ":" in raw_str or " " in raw_str:
            return

        # Prefix match to internal symbol
        symbol = None
        for prefix in sorted(self._prefix_to_internal, key=len, reverse=True):
            if raw_str.startswith(prefix):
                symbol = self._prefix_to_internal[prefix]
                break
        if symbol is None:
            return

        open_ = Decimal(record.open) / Decimal(1_000_000_000)
        high = Decimal(record.high) / Decimal(1_000_000_000)
        low = Decimal(record.low) / Decimal(1_000_000_000)
        close = Decimal(record.close) / Decimal(1_000_000_000)
        volume = record.volume
        ts_ns = record.ts_event
        ts = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)
        ts = ts.replace(second=0, microsecond=0)

        try:
            upsert_futures_bar(symbol, ts, open_, high, low, close, volume)
            self._last_bar_ts = time.time()
            log.debug("Bar: %s %s C=%.2f", symbol, ts.isoformat(), close)
        except Exception as exc:
            log.error("Failed to upsert bar for %s: %s", symbol, exc)

    def _subscribe_es_options_streams(self) -> None:
        """Subscribe to the ES.OPT definition/statistics/trades streams.

        Must be called BEFORE self._client.start() — the Definition
        subscribe uses ``start=0`` to request the session's current
        snapshot of instruments, and Databento rejects ``start`` if the
        session is already running. Without the snapshot,
        _option_definitions stays empty and every ES option trade
        silently hits the definition-lag drop path (SIDE-015).

        The ATM strike filter in _handle_trade/_handle_stat is
        independent of subscription — it's applied per-record after
        the _option_definitions lookup succeeds. So there's no need to
        know the ES spot price at subscribe time; we subscribe to all
        ES.OPT once here, and _update_atm_strikes later narrows the
        write filter.
        """
        if not self._client:
            return

        # Definition: start=0 requests the full snapshot of currently
        # listed ES option instruments at subscribe time, not just
        # newly-listed ones going forward.
        self._client.subscribe(
            dataset=DATASET_CME,
            schema="definition",
            symbols=["ES.OPT"],
            stype_in="parent",
            start=0,
        )

        # Statistics: live-only. EOD stats (OI, settlement, IV, delta)
        # arrive periodically as the exchange publishes them.
        self._client.subscribe(
            dataset=DATASET_CME,
            schema="statistics",
            symbols=["ES.OPT"],
            stype_in="parent",
        )

        # Trades: live-only. Every ES option trade across every expiry
        # flows through; the ATM strike filter in _handle_trade gates
        # which ones get persisted.
        self._client.subscribe(
            dataset=DATASET_CME,
            schema="trades",
            symbols=["ES.OPT"],
            stype_in="parent",
        )

        log.info(
            "Subscribed to ES.OPT definition (snapshot=start=0), "
            "statistics, trades on %s",
            DATASET_CME,
        )

    def _update_atm_strikes(self, es_price: float) -> None:
        """Recenter the ATM +/-10 strike window on the current ES price.

        Called on the first ES bar (to set the initial window) and on
        any subsequent re-center trigger (±50 pt move from the last
        center). No subscribe() calls — subscriptions are established
        once in _subscribe_es_options_streams() at startup. This method
        only updates the in-memory filter list that
        _handle_trade/_handle_stat consult before persisting a record.
        """
        strikes = compute_atm_strikes(es_price)
        expiry = get_nearest_es_expiry()

        self._options_strikes.center_price = es_price
        self._options_strikes.strikes = strikes
        self._options_strikes.nearest_expiry = expiry

        log.info(
            "ATM strikes recentered: ATM=%.0f, %d strikes, expiry=%s",
            es_price,
            len(strikes),
            expiry,
        )
        self._options_subscription_pending = False

    def _on_record(self, record: Any) -> None:
        """Central callback for all incoming Databento records."""
        try:
            # Route by record type.
            #
            # SIDE-014: several databento-dbn record types ship versioned
            # variants (``InstrumentDefMsg`` + ``InstrumentDefMsgV1`` +
            # ``InstrumentDefMsgV2``, ``StatMsg`` + ``StatMsgV1``, etc.)
            # and the live feed delivers whichever version the session
            # advertises. Previously we matched only the bare name, so
            # Definitions silently routed to the "unknown record" fall-
            # through — which left ``_option_definitions`` empty and
            # made every ES options trade look like a definition-lag
            # drop. Prefix matching with ``startswith`` absorbs V1/V2
            # and any future V3+ without touching this code again.
            record_type = type(record).__name__

            if record_type in ("OHLCVMsg", "OhlcvMsg"):
                self._handle_ohlcv(record)
            elif record_type == "TradeMsg":
                self._handle_trade(record)
            elif record_type.startswith("StatMsg"):
                self._handle_stat(record)
            elif record_type.startswith("InstrumentDefMsg"):
                self._handle_definition(record)
            elif record_type.startswith("SymbolMappingMsg"):
                self._handle_symbol_mapping(record)
            elif record_type == "MBP1Msg":
                # We only subscribe to ``tbbo`` (not ``mbp-1``), so every
                # MBP1Msg we see here is a TBBO record: a trade with the
                # pre-trade BBO carried in levels[0].
                self._handle_tbbo(record)
            elif record_type.startswith("ErrorMsg") or record_type.startswith(
                "SystemMsg"
            ):
                self._handle_system(record)
            # Ignore other record types (heartbeats, etc.)
        except Exception as exc:
            log.error("Error processing record: %s", exc)

    def _on_error(self, exc: Exception) -> None:
        """Handle streaming errors."""
        log.error("Databento stream error: %s", exc)
        self._connected = False

    # Reconnect-gap thresholds (SIDE-011). The audit's original
    # prescription was "fire Sentry breadcrumb, request backfill,
    # validate first-bar price doesn't differ by >1 ATR". We don't
    # have ATR values in the sidecar, so we use a 2% price-move
    # proxy for the first-bar sanity check. Backfill is a future
    # feature — the gap is logged with full structured context so
    # a manual backfill query can be issued if needed.
    RECONNECT_GAP_WARNING_S = 60.0
    RECONNECT_FIRST_BAR_SANITY_PCT = 2.0

    def _on_reconnect(self, last_ts: int, new_start_ts: int) -> None:
        """Called when the client reconnects after a disconnect.

        Computes the gap duration and reports to Sentry via the
        capture_message helper if the gap exceeds
        RECONNECT_GAP_WARNING_S. Also flags every currently-tracked
        symbol for a first-bar price-jump sanity check on the next
        OHLCV record, so discontinuous jumps across the gap get
        logged for manual review. See SIDE-011.
        """
        self._connected = True

        # Databento passes timestamps as nanoseconds since epoch.
        # Convert to seconds for the gap duration calculation.
        try:
            last_s = last_ts / 1e9
            new_s = new_start_ts / 1e9
            gap_s = max(0.0, new_s - last_s)
        except Exception:
            gap_s = 0.0

        context = {
            "last_ts_ns": last_ts,
            "new_start_ts_ns": new_start_ts,
            "gap_s": round(gap_s, 2),
        }

        if gap_s >= self.RECONNECT_GAP_WARNING_S:
            # Significant gap — surface to Sentry as a warning event.
            # The structured context includes the gap duration so the
            # Sentry UI can filter and alert on long gaps.
            from sentry_setup import capture_message

            capture_message(
                f"Databento reconnect gap {gap_s:.1f}s exceeds "
                f"{self.RECONNECT_GAP_WARNING_S:.0f}s threshold",
                level="warning",
                context=context,
            )
        else:
            log.info(
                "Databento reconnected after %.1fs gap",
                gap_s,
                extra={"symbol": None},
            )

        # Arm the first-bar sanity check for every symbol that was
        # being tracked before the disconnect. When the next bar
        # arrives for each symbol, _handle_ohlcv will compare it to
        # _last_close_before_disconnect and warn on discontinuity.
        self._reconnect_sanity_check_pending = set(
            self._last_close_before_disconnect.keys()
        )

    def _resolve_symbol(self, record: Any) -> str | None:
        """Resolve a record's instrument_id to our internal symbol.

        Uses the SDK's symbology_map which maps instrument_id -> raw symbol
        (e.g., 15 -> "ESM5"), then matches the raw symbol prefix to our
        internal name (e.g., "ESM5" starts with "ES" -> "ES").
        """
        iid = getattr(record, "instrument_id", None)
        if iid is None or self._client is None:
            return None

        # Check cache first
        if iid in self._resolved_cache:
            return self._resolved_cache[iid]

        # Look up raw symbol from SDK's auto-populated symbology map
        raw_symbol = self._client.symbology_map.get(iid)
        if raw_symbol is None:
            self._resolved_cache[iid] = None
            return None

        raw_str = str(raw_symbol)

        # Only accept outright contracts (e.g., "ESM6", "CLK26"), not
        # spreads ("CLM6-CLZ6"), butterflies ("CL:BF"), or cracks ("CL:C1").
        # Outrights match: ROOT + month code + year digits
        if "-" in raw_str or ":" in raw_str or " " in raw_str:
            self._resolved_cache[iid] = None
            return None

        # Match against known prefixes (longest match first to avoid
        # "ES" matching "ESM5" when "ESM" might be a different product)
        # Sort by length descending so "RTY" matches before "RT"
        for prefix in sorted(self._prefix_to_internal, key=len, reverse=True):
            if raw_str.startswith(prefix):
                internal = self._prefix_to_internal[prefix]
                self._resolved_cache[iid] = internal
                return internal

        self._resolved_cache[iid] = None
        return None

    def _handle_ohlcv(self, record: Any) -> None:
        """Process an OHLCV-1m bar record."""
        if self._shutting_down:
            return
        from db import upsert_futures_bar

        symbol = self._resolve_symbol(record)
        if symbol is None:
            iid = getattr(record, "instrument_id", 0)
            log.debug("Unknown instrument_id for OHLCV: %d", iid)
            return

        # Convert Databento prices (int64, 1e-9 units) to Decimal
        open_ = Decimal(record.open) / Decimal(1_000_000_000)
        high = Decimal(record.high) / Decimal(1_000_000_000)
        low = Decimal(record.low) / Decimal(1_000_000_000)
        close = Decimal(record.close) / Decimal(1_000_000_000)
        volume = record.volume

        # Convert timestamp (nanoseconds since epoch) to datetime
        ts_ns = record.ts_event
        ts = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)

        # Normalize to minute boundary
        ts = ts.replace(second=0, microsecond=0)

        # SIDE-011: first-bar-after-reconnect sanity check. If this
        # symbol was armed for a sanity check by _on_reconnect, compare
        # the new close to the last close seen before the disconnect
        # and warn on discontinuous jumps that exceed the threshold.
        if symbol in self._reconnect_sanity_check_pending:
            self._reconnect_sanity_check_pending.discard(symbol)
            prev_close = self._last_close_before_disconnect.get(symbol)
            if prev_close is not None and prev_close > 0:
                new_close = float(close)
                pct_move = abs((new_close - prev_close) / prev_close) * 100
                if pct_move >= self.RECONNECT_FIRST_BAR_SANITY_PCT:
                    from sentry_setup import capture_message

                    capture_message(
                        f"{symbol} first-bar-after-reconnect price jump "
                        f"{pct_move:.2f}% exceeds "
                        f"{self.RECONNECT_FIRST_BAR_SANITY_PCT}% threshold",
                        level="warning",
                        context={
                            "symbol": symbol,
                            "prev_close": prev_close,
                            "new_close": new_close,
                            "pct_move": round(pct_move, 2),
                        },
                    )

        # Keep _last_close_before_disconnect current so the sanity check
        # above has fresh data to compare against on the next reconnect.
        # This must run BEFORE the DB upsert (and outside its try block)
        # so a transient DB blip doesn't leave the baseline stale until
        # the next successful upsert. The sanity check above already
        # consulted the prior baseline, so updating it now is safe.
        self._last_close_before_disconnect[symbol] = float(close)

        # Write to DB
        try:
            upsert_futures_bar(symbol, ts, open_, high, low, close, volume)
            self._last_bar_ts = time.time()
            log.debug(
                "Bar: %s %s O=%.2f H=%.2f L=%.2f C=%.2f V=%d",
                symbol,
                ts.isoformat(),
                open_,
                high,
                low,
                close,
                volume,
            )
        except Exception as exc:
            log.error("Failed to upsert bar for %s: %s", symbol, exc)

        # Set the initial ATM window on the first ES bar. Subscriptions
        # for ES.OPT streams were already established at startup; this
        # only updates the strike filter that _handle_trade consults.
        if symbol == "ES" and self._options_subscription_pending:
            self._update_atm_strikes(float(close))

        # Re-center the ATM window when ES moves far enough. Still no
        # subscribe() call — we're already subscribed to every ES.OPT.
        if symbol == "ES" and self._options_strikes.needs_recenter(float(close)):
            log.info(
                "ES moved to %.2f, re-centering options from %.2f",
                float(close),
                self._options_strikes.center_price,
            )
            self._update_atm_strikes(float(close))

    def _handle_tbbo(self, record: Any) -> None:
        """Dispatch a TBBO (``MBP1Msg``) record to the quote processor.

        TBBO delivers one record per trade with the pre-trade BBO in
        ``levels[0]``; ``process_tbbo`` extracts both the quote snapshot
        and the trade tick from that single record. No rtype branching —
        we only subscribe to one schema, so every MBP1Msg reaching this
        handler is already a TBBO event.

        Phase 5a: ES + NQ. Both symbols are subscribed and flow through
        the same writers (``futures_trade_ticks`` + ``futures_top_of_book``
        already carry a ``symbol`` column). Unknown / unresolved
        instrument_ids are dropped defensively.
        """
        if self._shutting_down or self._quote_processor is None:
            return

        symbol = self._resolve_symbol(record)
        if symbol not in ("ES", "NQ"):
            return

        self._quote_processor.process_tbbo(symbol, record)

    # SIDE-012: emit a lag-drop summary at most once per this interval.
    DEFINITION_LAG_SUMMARY_INTERVAL_S = 60.0

    def _maybe_log_definition_lag_summary(self) -> None:
        """Emit a periodic summary of definition-lag drops (SIDE-012).

        Called from _handle_trade. If any trades have been dropped
        since the last summary AND at least
        DEFINITION_LAG_SUMMARY_INTERVAL_S seconds have passed, log a
        structured warning (and forward to Sentry) then reset the
        counter. This converts a previously-silent failure mode into
        a visible one without spamming logs on every drop.
        """
        if self._definition_lag_drops == 0:
            return
        now = time.time()
        if now - self._last_lag_summary_ts < self.DEFINITION_LAG_SUMMARY_INTERVAL_S:
            return
        drops = self._definition_lag_drops
        self._definition_lag_drops = 0
        self._last_lag_summary_ts = now

        from sentry_setup import capture_message

        capture_message(
            f"Dropped {drops} ES option trades with no cached Definition "
            f"(unknown instrument_id — either Definition lag or an "
            f"untracked instrument)",
            level="warning",
            context={
                "drops": drops,
                "interval_s": round(self.DEFINITION_LAG_SUMMARY_INTERVAL_S, 1),
            },
        )

    def _handle_trade(self, record: Any) -> None:
        """Process an ES options trade record."""
        if self._shutting_down:
            return
        # Map Databento Side enum to our char
        side = getattr(record, "side", None)
        if side == Side.ASK:
            side_char = "A"
        elif side == Side.BID:
            side_char = "B"
        else:
            side_char = "N"

        # We need to determine if this is an ES option and extract
        # strike/expiry from the instrument definition
        iid = getattr(record, "instrument_id", 0)
        instrument_info = self._get_option_info(iid)
        if instrument_info is None:
            # SIDE-012: no Definition cached for this instrument_id —
            # either the trade arrived before its Definition (lag) or
            # we never received a Definition for this id at all
            # (untracked instrument). Count it and let the periodic
            # summary surface the total. Previously this was a silent
            # return with no visibility.
            self._definition_lag_drops += 1
            self._maybe_log_definition_lag_summary()
            return

        strike = instrument_info["strike"]
        option_type = instrument_info["option_type"]
        expiry = instrument_info["expiry"]

        # Filter: only process strikes in our ATM window
        if strike not in self._options_strikes.strikes:
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

    def _handle_stat(self, record: Any) -> None:
        """Process a Statistics record (OI, settlement, IV, delta).

        Dispatch is driven by the module-level ``STAT_TYPE_TO_KWARG``
        table — each entry maps a Databento stat_type to the
        ``upsert_options_daily(...)`` kwarg + the source field on the
        record (``stat_value`` is a 1e-9-scaled Decimal price; ``stat_quantity``
        is a raw integer count). Adding a new stat type is a one-line
        dict update; the handler body never needs to grow.
        """
        if self._shutting_down:
            return
        from db import upsert_options_daily

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
        trade_date = date.today()

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

        # Settlement carries an extra is_final flag derived from stat_flags.
        extra_kwargs: dict[str, Any] = {}
        if stat_type == STAT_TYPE_SETTLEMENT:
            extra_kwargs["is_final"] = bool(getattr(record, "stat_flags", 0) & 1)

        try:
            upsert_options_daily(
                "ES",
                trade_date,
                expiry,
                Decimal(str(strike)),
                option_type,
                **{kwarg_name: value},
                **extra_kwargs,
            )
        except Exception as exc:
            log.error("Failed to upsert stat for strike %s: %s", strike, exc)

    def _handle_definition(self, record: Any) -> None:
        """Process an InstrumentDefMsg to discover ES option instruments."""
        # Extract key fields from the definition
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
        # through _handle_trade / _handle_stat into psycopg2, which
        # can't adapt the enum ("can't adapt type 'databento_dbn.
        # InstrumentClass'"). The .value attribute gives the bare 'C'/
        # 'P' string; the str() fallback covers older SDKs where
        # instrument_class is already a bare string.
        option_type_str = getattr(
            instrument_class, "value", str(instrument_class)
        )

        strike_raw = getattr(record, "strike_price", 0)
        strike = float(strike_raw) / 1e9 if strike_raw else 0

        expiry_ns = getattr(record, "expiration", 0)
        if expiry_ns:
            expiry = datetime.fromtimestamp(expiry_ns / 1e9, tz=timezone.utc).date()
        else:
            return

        iid = getattr(record, "instrument_id", 0)

        # Store the option info for this instrument_id
        with self._lock:
            self._option_definitions[iid] = {
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

    def _handle_symbol_mapping(self, record: Any) -> None:
        """Log symbol mappings for debugging.

        The SDK's symbology_map property handles the actual mapping
        automatically — we just log for observability.
        """
        stype_in_symbol = getattr(record, "stype_in_symbol", "")
        stype_out_symbol = getattr(record, "stype_out_symbol", "")
        iid = getattr(record, "instrument_id", 0)
        log.debug(
            "Symbol mapping: %s (%s) -> iid %d",
            stype_in_symbol,
            stype_out_symbol,
            iid,
        )

    def _handle_system(self, record: Any) -> None:
        """Handle system/error messages."""
        msg = getattr(record, "msg", "")
        is_error = (
            getattr(record, "is_error", False) or type(record).__name__ == "ErrorMsg"
        )
        if is_error:
            log.error("Databento system error: %s", msg)
        else:
            log.info("Databento system message: %s", msg)

        # Log mapping summary once after first data interval
        if not self._mapping_summary_logged and "End of interval" in msg:
            self._mapping_summary_logged = True
            if self._client:
                smap = self._client.symbology_map
                log.info(
                    "Symbology map: %d instrument_ids mapped (sample: %s)",
                    len(smap),
                    dict(list(smap.items())[:5]),
                )

        # Options pipeline health snapshot, emitted once per OHLCV-1m
        # interval close (~60s cadence). SIDE-013: if definitions_cached
        # stays at 0 while drops/trades continue flowing, Definition
        # routing or filtering is broken upstream of the trade handler
        # — this log turns that silent failure into a visible one.
        if "End of interval for ohlcv-1m" in msg:
            log.info(
                "Options pipeline: definitions_cached=%d ATM_strikes=%d "
                "center=%.2f",
                len(self._option_definitions),
                len(self._options_strikes.strikes),
                self._options_strikes.center_price,
            )

    def _get_option_info(self, instrument_id: int) -> dict | None:
        """Look up option strike/type/expiry for an instrument_id."""
        return self._option_definitions.get(instrument_id)

    def stop(self) -> None:
        """Gracefully stop all Databento clients.

        Shutdown sequence (SIDE-006):
        1. Set the shutdown barrier flag so in-flight callbacks
           early-return before initiating new DB writes.
        2. Brief pause to let any callbacks currently inside a
           `with get_conn():` block finish their upsert + putconn.
        3. Stop each Databento client (ignoring errors individually).
        4. Flush the TradeProcessor buffer to capture any trades
           that were buffered but not yet batch-inserted.
        """
        self._shutting_down = True
        self._connected = False
        # Give in-flight callbacks up to 200ms to finish their current
        # DB write. Short enough not to stall Railway's SIGTERM grace
        # period (10 seconds by default), long enough to cover typical
        # Neon query latencies on a warm connection (~5-50ms).
        time.sleep(0.2)

        if self._client:
            try:
                self._client.stop()
            except Exception as exc:
                log.error("Error stopping CME client: %s", exc)
        self._client = None
        # stop() both drains the background flush thread (if running)
        # and performs a final flush, replacing the older flush()-only
        # call at this site.
        self._trade_processor.stop()
        if self._quote_processor is not None:
            self._quote_processor.flush()
        log.info("Databento clients stopped")

    def block_for_close(self, timeout: float | None = None) -> None:
        """Block until the client connection closes."""
        if self._client:
            self._client.block_for_close(timeout=timeout)
