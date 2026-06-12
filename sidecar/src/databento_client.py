"""Databento Live client: multi-symbol subscription for futures OHLCV-1m,
ES options Trades, Statistics, and Definition schemas.

Uses the official databento Python SDK with:
- Callback-based record processing
- Automatic reconnection with exponential backoff
- Multiple subscribe() calls for different schema/dataset combos

Phase 3b refactor: options-side record routing (Definition/Trade/Stat
handlers + the option_definitions cache + the definition-lag drop
counter) lives in ``options_router.OptionsRecordRouter``. This class
retains: connection lifecycle, subscriptions, OHLCV / TBBO / system /
reconnect handlers, ATM-window centering, and prefix→internal symbol
resolution. The options-side handlers on this class are thin delegating
shims so existing call sites and tests remain stable.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any

import databento as db
import pandas as pd
from databento import ReconnectPolicy

from bar_writer import BarRow, BarWriter
from config import settings
from logger_setup import log
from options_router import (
    DEFINITION_LAG_SUMMARY_INTERVAL_S,
    STAT_TYPE_CLEARED_VOLUME,
    STAT_TYPE_DELTA,
    STAT_TYPE_IMPLIED_VOL,
    STAT_TYPE_OPEN_INTEREST,
    STAT_TYPE_OPENING_PRICE,
    STAT_TYPE_SETTLEMENT,
    STAT_TYPE_TO_KWARG,
    OptionsRecordRouter,
)
from symbol_manager import (
    DATASET_CME,
    compute_atm_strikes,
    get_all_futures_subscriptions,
    get_nearest_es_expiry,
)

if TYPE_CHECKING:
    from quote_processor import QuoteProcessor
    from trade_processor import TradeProcessor


# Re-export for backward compatibility with code (and tests) that
# previously imported these from databento_client.
__all__ = [
    "DatabentoClient",
    "STAT_TYPE_OPENING_PRICE",
    "STAT_TYPE_SETTLEMENT",
    "STAT_TYPE_CLEARED_VOLUME",
    "STAT_TYPE_OPEN_INTEREST",
    "STAT_TYPE_IMPLIED_VOL",
    "STAT_TYPE_DELTA",
    "STAT_TYPE_TO_KWARG",
]

# Phase 2a note: we subscribe ONLY to ``tbbo``, never ``mbp-1``. Both
# schemas emit ``MBP1Msg`` and share the same ``rtype``
# (``RType.from_schema(Schema.MBP_1).value == RType.from_schema(Schema.TBBO).value == 1``),
# so they cannot be distinguished at the record level. Subscribing to
# both would also double-deliver every trade — TBBO is the subset of
# MBP-1 events where ``action == 'T'``. TBBO alone gives us quotes at
# trade moments + the trade tick in one stream with no duplication.


class DatabentoClient:
    """Manages the Databento Live connection and data routing.

    Connection lifecycle, futures bar / TBBO / system / reconnect
    handling, ATM-window centering, and prefix→internal symbol
    resolution live here. Options-side record routing
    (Definition/Trade/Stat handlers + ``option_definitions`` cache +
    definition-lag drop accounting) is owned by
    ``options_router.OptionsRecordRouter``; thin delegating shims
    preserve the original public API.
    """

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
        # AUD-M27: OHLCV-1m bars are buffered + drained off the SDK
        # callback thread so a Neon stall on the bar upsert can't
        # head-of-line-block TBBO / options ingestion (same thread). The
        # background flush is started in start() and stopped in stop().
        self._bar_writer = BarWriter()
        self._connected = False
        self._last_bar_ts = 0.0

        # Shutdown barrier: set True at the start of stop() so in-flight
        # Databento callbacks can early-return before initiating a new DB
        # write. Prevents the "callback mid-flight when pool drains" race
        # flagged by the audit under SIDE-006. The router consults this
        # via the predicate handed to it below.
        self._shutting_down = False

        # Options-side state + handlers. The router owns
        # _option_definitions, _options_strikes (the ATM filter window),
        # and the SIDE-012 definition-lag drop counter. Predicate callback
        # lets the router check the shutdown barrier without holding a
        # back-reference to ``self``.
        self._router = OptionsRecordRouter(
            trade_processor=trade_processor,
            is_shutting_down=lambda: self._shutting_down,
        )

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

        # Whether we're waiting for the first ES bar to subscribe to options
        self._options_subscription_pending = False

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def last_bar_ts(self) -> float:
        return self._last_bar_ts

    # ------------------------------------------------------------------
    # Backward-compat property shims that proxy to the OptionsRecordRouter.
    #
    # The original DatabentoClient owned these fields directly; tests
    # and a few internal callers read/write them. Routing them through
    # the router keeps a single source of truth without breaking
    # existing call sites.
    # ------------------------------------------------------------------

    @property
    def _option_definitions(self) -> dict[int, dict]:
        return self._router.option_definitions

    @property
    def _options_strikes(self) -> Any:
        return self._router.options_strikes

    @_options_strikes.setter
    def _options_strikes(self, value: Any) -> None:
        self._router.options_strikes = value

    @property
    def _definition_lag_drops(self) -> int:
        return self._router.definition_lag_drops

    @_definition_lag_drops.setter
    def _definition_lag_drops(self, value: int) -> None:
        self._router.definition_lag_drops = value

    @property
    def _last_lag_summary_ts(self) -> float:
        return self._router.last_lag_summary_ts

    @_last_lag_summary_ts.setter
    def _last_lag_summary_ts(self, value: float) -> None:
        self._router.last_lag_summary_ts = value

    # SIDE-012 throttle window. Aliased here so existing references
    # (and tests touching the constant) keep working after the move.
    DEFINITION_LAG_SUMMARY_INTERVAL_S = DEFINITION_LAG_SUMMARY_INTERVAL_S

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

        # AUD-M27: start the off-thread bar + stat flush threads before the
        # SDK starts delivering records, so the first bar/stat enqueued has
        # a drain thread already running. Idempotent — safe across reconnect
        # restarts (start_background_flush no-ops if a live thread exists).
        self._bar_writer.start_background_flush()
        self._router.start_stat_flush()

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

        # AUD-M27: enqueue off-thread (see _handle_ohlcv for the full
        # rationale). futures_bars is ON CONFLICT DO UPDATE → re-queue safe.
        self._bar_writer.add(
            BarRow(
                symbol=symbol,
                ts=ts,
                open=open_,
                high=high,
                low=low,
                close=close,
                volume=volume,
            )
        )
        self._last_bar_ts = time.time()
        log.debug("Bar: %s %s C=%.2f", symbol, ts.isoformat(), close)

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
        any subsequent re-center trigger (a move of ES_RECENTER_THRESHOLD
        pts from the last center). No subscribe() calls — subscriptions are established
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
            from sentry_setup import capture_exception

            capture_exception(
                exc,
                tags={"component": "databento_client", "stage": "record_dispatch"},
            )
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

    def _on_reconnect(self, gap_start: pd.Timestamp, gap_end: pd.Timestamp) -> None:
        """Called when the client reconnects after a disconnect.

        Computes the gap duration and reports to Sentry via the
        capture_message helper if the gap exceeds
        RECONNECT_GAP_WARNING_S. Also flags every currently-tracked
        symbol for a first-bar price-jump sanity check on the next
        OHLCV record, so discontinuous jumps across the gap get
        logged for manual review. See SIDE-011.
        """
        self._connected = True

        # The SDK's ReconnectCallback signature is
        # ``Callable[[pd.Timestamp, pd.Timestamp], None]`` (databento
        # common/types.py); ``live/session.py`` dispatches
        # ``callback(gap_start, gap_end)`` with both args as
        # ``pd.Timestamp(..., tz="UTC")``. A ``pd.Timestamp`` subtraction
        # yields a ``Timedelta`` whose ``.total_seconds()`` gives the gap.
        #
        # A narrow guard (NOT a bare ``except``) catches only the
        # arithmetic failure modes that a future SDK signature drift
        # would surface (e.g. ints passed instead of Timestamps), and
        # reports them to Sentry so the drift is LOUD rather than
        # silently clamping the gap to 0 and disarming the SIDE-011
        # alarm — which is exactly the bug this fix removes.
        try:
            gap_s = max(0.0, (gap_end - gap_start).total_seconds())
        except (TypeError, AttributeError) as exc:
            from sentry_setup import capture_exception

            capture_exception(
                exc,
                tags={"component": "databento_client", "stage": "reconnect_gap"},
                context={"gap_start": repr(gap_start), "gap_end": repr(gap_end)},
            )
            log.error(
                "Databento reconnect callback received unexpected arg types "
                "(%s, %s); gap duration unavailable",
                type(gap_start).__name__,
                type(gap_end).__name__,
            )
            gap_s = 0.0

        context = {
            "gap_start": str(gap_start),
            "gap_end": str(gap_end),
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

        # SIDE-017: re-seed the ES option definition snapshot.
        #
        # On reconnect the SDK resubscribes every stored subscription
        # with ``start=None`` and ``snapshot=bool(sub.snapshot)``
        # (databento live/session.py:714-722). Our initial definition
        # subscribe uses ``start=0`` (not ``snapshot=True`` — the SDK's
        # ``snapshot`` kwarg is only supported on the ``mbo`` schema and
        # is mutually exclusive with ``start``, per Live.subscribe's
        # docstring/validation in live/client.py), so the SDK's
        # automatic resubscribe replays NO instrument snapshot. Without
        # re-seeding, ``_option_definitions`` is never repopulated and
        # every post-reconnect ES option trade silently hits the
        # definition-lag drop path (options_router.py). We therefore
        # explicitly re-issue the definition subscribe with ``start=0``
        # on the freshly-established connection to pull the current
        # instrument snapshot again.
        self._reseed_option_definitions()

    def _reseed_option_definitions(self) -> None:
        """Re-issue the ES option definition snapshot subscribe.

        Called from ``_on_reconnect`` because the SDK's automatic
        resubscribe drops our ``start=0`` snapshot request (see SIDE-017
        note in ``_on_reconnect``). A new ``subscribe(..., start=0)`` on
        the reconnected session pulls the full current ES option
        instrument set so ``_option_definitions`` repopulates.
        """
        if not self._client:
            return
        self._client.subscribe(
            dataset=DATASET_CME,
            schema="definition",
            symbols=["ES.OPT"],
            stype_in="parent",
            start=0,
        )
        log.info("Re-seeded ES.OPT definition snapshot after reconnect (SIDE-017)")

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

        # AUD-M27: enqueue the bar to the off-thread BarWriter instead of
        # a synchronous upsert on this SDK callback thread. The buffered
        # write drains on the BarWriter's background flush, so a Neon
        # stall on the bar path no longer head-of-line-blocks TBBO /
        # options ingestion (which share this same callback thread).
        # ``futures_bars`` is ON CONFLICT DO UPDATE, so the writer's
        # bounded re-queue on failure is safe (Sentry capture + retry is
        # owned by BatchedWriter — no per-call try/except needed here).
        self._bar_writer.add(
            BarRow(
                symbol=symbol,
                ts=ts,
                open=open_,
                high=high,
                low=low,
                close=close,
                volume=volume,
            )
        )
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

    # ------------------------------------------------------------------
    # Options-side handlers — thin shims that delegate to the router.
    # The original method names are preserved so existing callers
    # (incl. _on_record dispatch and the ~870-LOC test suite) keep
    # working unchanged.
    # ------------------------------------------------------------------

    def _maybe_log_definition_lag_summary(self) -> None:
        """Delegate to the router (SIDE-012 throttle)."""
        self._router._maybe_log_definition_lag_summary()

    def _handle_trade(self, record: Any) -> None:
        """Delegate options-trade handling to the router."""
        self._router.handle_trade(record)

    def _handle_stat(self, record: Any) -> None:
        """Delegate options-stat handling to the router."""
        self._router.handle_stat(record)

    def _handle_definition(self, record: Any) -> None:
        """Delegate Definition handling to the router."""
        self._router.handle_definition(record)

    def _get_option_info(self, instrument_id: int) -> dict | None:
        """Look up option strike/type/expiry for an instrument_id."""
        return self._router._get_option_info(instrument_id)

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
                "Options pipeline: definitions_cached=%d ATM_strikes=%d center=%.2f",
                len(self._option_definitions),
                len(self._options_strikes.strikes),
                self._options_strikes.center_price,
            )

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
                from sentry_setup import capture_exception

                capture_exception(
                    exc,
                    tags={"component": "databento_client", "stage": "client_stop"},
                )
                log.error("Error stopping CME client: %s", exc)
        self._client = None
        # stop() both drains the background flush thread (if running)
        # and performs a final flush, replacing the older flush()-only
        # call at this site.
        self._trade_processor.stop()
        if self._quote_processor is not None:
            self._quote_processor.flush()
        # AUD-M27: drain the off-thread bar + stat buffers before the pool
        # is torn down. stop() joins each flush thread and performs a final
        # flush, so buffered bars/stats land in Neon on shutdown.
        self._bar_writer.stop()
        self._router.stop_stat_writer()
        log.info("Databento clients stopped")

    def block_for_close(self, timeout: float | None = None) -> None:
        """Block until the client connection closes."""
        if self._client:
            self._client.block_for_close(timeout=timeout)
