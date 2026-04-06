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
    DATASET_IFUS,
    DATASET_XCBF,
    OptionsStrikeSet,
    compute_atm_strikes,
    get_all_futures_subscriptions,
    get_nearest_es_expiry,
)

if TYPE_CHECKING:
    from alert_engine import AlertEngine
    from trade_processor import TradeProcessor


# Stat type constants from Databento Statistics schema
STAT_TYPE_OPENING_PRICE = 1
STAT_TYPE_SETTLEMENT = 3
STAT_TYPE_CLEARED_VOLUME = 6
STAT_TYPE_OPEN_INTEREST = 9
STAT_TYPE_IMPLIED_VOL = 14
STAT_TYPE_DELTA = 15


class DatabentoClient:
    """Manages the Databento Live connection and data routing."""

    def __init__(
        self,
        alert_engine: AlertEngine,
        trade_processor: TradeProcessor,
    ) -> None:
        self._client: db.Live | None = None
        self._vxm_client: db.Live | None = None
        self._dx_client: db.Live | None = None
        self._alert_engine = alert_engine
        self._trade_processor = trade_processor
        self._connected = False
        self._last_bar_ts = 0.0
        self._options_strikes = OptionsStrikeSet()
        self._lock = threading.Lock()

        # Map raw symbol prefixes to internal names for resolving
        # SDK symbology_map values (e.g., "ESM5" -> "ES")
        self._prefix_to_internal: dict[str, str] = {}

        # Cache: instrument_id -> internal symbol (populated on first resolve)
        self._resolved_cache: dict[int, str | None] = {}

        # VX instrument_id -> internal symbol (VX1 or VX2)
        # Populated when first VX bars arrive, keyed by instrument_id
        self._vxm_resolved: dict[int, str] = {}
        self._vxm_ids_seen: list[int] = []

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

        # Subscribe to ES options after first ES bar arrives (need price for ATM)
        self._options_subscription_pending = True

        # Start streaming (non-blocking with callbacks)
        self._client.start()
        self._connected = True
        log.info("CME Live client started -- streaming")

        # Second client for VX on XCBF.PITCH (separate dataset)
        self._start_vxm_client()

        # Third client for DX on IFUS.IMPACT (ICE Futures US)
        self._start_dx_client()

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

    def _start_vxm_client(self) -> None:
        """Start a second Live client for VXM on XCBF.PITCH.

        Databento only allows one dataset per Live session, so VXM
        (CBOE Futures Exchange) needs its own client separate from
        the CME Group client.
        """
        subs = get_all_futures_subscriptions()
        cfe_symbols = []
        for sym, cfg in subs.items():
            if cfg["dataset"] == DATASET_XCBF:
                cfe_symbols.append(cfg["parent_symbol"])
                self._prefix_to_internal[cfg["db_symbol"]] = cfg["db_symbol"]

        if not cfe_symbols:
            return

        try:
            self._vxm_client = db.Live(
                key=settings.databento_api_key,
                ts_out=True,
                heartbeat_interval_s=30,
                reconnect_policy=ReconnectPolicy.RECONNECT,
            )

            self._vxm_client.add_callback(
                record_callback=self._on_vxm_record,
                exception_callback=self._on_error,
            )

            self._vxm_client.subscribe(
                dataset=DATASET_XCBF,
                schema="ohlcv-1m",
                symbols=cfe_symbols,
                stype_in="parent",
            )

            self._vxm_client.start()
            log.info(
                "VX Live client started on %s: %s",
                DATASET_XCBF,
                cfe_symbols,
            )
        except Exception as exc:
            log.error("Failed to start VX client: %s", exc)
            self._vxm_client = None

    def _start_dx_client(self) -> None:
        """Start a third Live client for DX on IFUS.IMPACT (ICE Futures US)."""
        subs = get_all_futures_subscriptions()
        dx_cfg = subs.get("DX")
        if not dx_cfg or dx_cfg["dataset"] != DATASET_IFUS:
            return

        try:
            self._dx_client = db.Live(
                key=settings.databento_api_key,
                ts_out=True,
                heartbeat_interval_s=30,
                reconnect_policy=ReconnectPolicy.RECONNECT,
            )

            self._dx_client.add_callback(
                record_callback=self._on_dx_record,
                exception_callback=self._on_error,
            )

            self._dx_client.subscribe(
                dataset=DATASET_IFUS,
                schema="ohlcv-1m",
                symbols=[dx_cfg["parent_symbol"]],
                stype_in="parent",
            )

            self._prefix_to_internal["DX"] = "DX"
            self._dx_client.start()
            log.info(
                "DX Live client started on %s: %s",
                DATASET_IFUS,
                dx_cfg["parent_symbol"],
            )
        except Exception as exc:
            log.error("Failed to start DX client: %s", exc)
            self._dx_client = None

    def _on_dx_record(self, record: Any) -> None:
        """Callback for DX client records (IFUS.IMPACT)."""
        try:
            record_type = type(record).__name__
            if record_type not in ("OHLCVMsg", "OhlcvMsg"):
                return
            self._handle_ohlcv_from_client(record, self._dx_client)
        except Exception as exc:
            log.error("Error processing DX record: %s", exc)

    def _handle_ohlcv_from_client(self, record: Any, client: db.Live | None) -> None:
        """Process an OHLCV bar using a specific client's symbology map."""
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

        self._alert_engine.on_bar(symbol, ts.timestamp(), float(close), volume)

    def subscribe_es_options(self, es_price: float) -> None:
        """Subscribe to ES options Trades for ATM +/-10 strikes.

        Called when we have an initial ES price, or when ES moves
        enough to warrant re-centering.
        """
        if not self._client:
            return

        strikes = compute_atm_strikes(es_price)
        expiry = get_nearest_es_expiry()

        self._options_strikes.center_price = es_price
        self._options_strikes.strikes = strikes
        self._options_strikes.nearest_expiry = expiry

        # Build option symbol names for logging
        # For Databento, we subscribe using parent symbology or raw symbols
        # ES options use specific contract symbols on CME
        # Format: e.g. "EW4F5 C5850" for weekly, "ESM5 C5850" for quarterly
        # We'll use glob patterns to capture ATM strikes
        log.info(
            "Subscribing to ES options trades: ATM=%.0f, %d strikes, expiry=%s",
            es_price,
            len(strikes),
            expiry,
        )

        # Subscribe to Definition first to discover exact symbols
        self._client.subscribe(
            dataset=DATASET_CME,
            schema="definition",
            symbols=["ES.OPT"],
            stype_in="parent",
        )

        # Subscribe to Statistics for EOD data
        self._client.subscribe(
            dataset=DATASET_CME,
            schema="statistics",
            symbols=["ES.OPT"],
            stype_in="parent",
        )

        # Subscribe to Trades for ES options
        # Using parent symbology ES.OPT captures all ES options trades
        # We filter by strike in the callback
        self._client.subscribe(
            dataset=DATASET_CME,
            schema="trades",
            symbols=["ES.OPT"],
            stype_in="parent",
        )

        self._options_subscription_pending = False
        log.info("ES options subscriptions active")

    def _on_record(self, record: Any) -> None:
        """Central callback for all incoming Databento records."""
        try:
            # Route by record type
            record_type = type(record).__name__

            if record_type in ("OHLCVMsg", "OhlcvMsg"):
                self._handle_ohlcv(record)
            elif record_type == "TradeMsg":
                self._handle_trade(record)
            elif record_type == "StatMsg":
                self._handle_stat(record)
            elif record_type == "InstrumentDefMsg":
                self._handle_definition(record)
            elif record_type == "SymbolMappingMsg":
                self._handle_symbol_mapping(record)
            elif record_type in ("ErrorMsg", "SystemMsg"):
                self._handle_system(record)
            # Ignore other record types (heartbeats, etc.)
        except Exception as exc:
            log.error("Error processing record: %s", exc)

    def _on_vxm_record(self, record: Any) -> None:
        """Callback for VXM client records (XCBF.PITCH)."""
        try:
            record_type = type(record).__name__
            if record_type not in ("OHLCVMsg", "OhlcvMsg"):
                return  # Only process OHLCV bars from VXM client

            self._handle_vxm_ohlcv(record)
        except Exception as exc:
            log.error("Error processing VXM record: %s", exc)

    def _handle_vxm_ohlcv(self, record: Any) -> None:
        """Process a VX OHLCV-1m bar.

        VX.FUT (front month) and VX.FUT.1 (second month) each get
        a unique instrument_id. We assign VX1 to the first seen and
        VX2 to the second, then route through the normal bar handler.
        """
        from db import upsert_futures_bar

        iid = getattr(record, "instrument_id", None)
        if iid is None or self._vxm_client is None:
            return

        # Resolve instrument_id to VXM1 or VXM2
        if iid not in self._vxm_resolved:
            if len(self._vxm_ids_seen) >= 2:
                return  # Already have both, ignore extra instruments
            self._vxm_ids_seen.append(iid)
            symbol = "VX1" if len(self._vxm_ids_seen) == 1 else "VX2"
            self._vxm_resolved[iid] = symbol
            log.info("VXM mapping: iid %d -> %s", iid, symbol)

        symbol = self._vxm_resolved[iid]

        # Convert prices and timestamp (same as _handle_ohlcv)
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
            log.debug("VXM Bar: %s %s C=%.2f", symbol, ts.isoformat(), close)
        except Exception as exc:
            log.error("Failed to upsert VXM bar for %s: %s", symbol, exc)

        # Feed to alert engine for backwardation checks
        self._alert_engine.on_bar(symbol, ts.timestamp(), float(close), volume)

    def _on_error(self, exc: Exception) -> None:
        """Handle streaming errors."""
        log.error("Databento stream error: %s", exc)
        self._connected = False

    def _on_reconnect(self, last_ts: int, new_start_ts: int) -> None:
        """Called when the client reconnects after a disconnect."""
        log.info(
            "Databento reconnected: gap from %s to %s",
            last_ts,
            new_start_ts,
        )
        self._connected = True

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

        # Feed to alert engine
        self._alert_engine.on_bar(symbol, ts.timestamp(), float(close), volume)

        # Check if we need to subscribe to ES options (first ES bar)
        if symbol == "ES" and self._options_subscription_pending:
            self.subscribe_es_options(float(close))

        # Check if ES options need re-centering
        if symbol == "ES" and self._options_strikes.needs_recenter(float(close)):
            log.info(
                "ES moved to %.2f, re-centering options from %.2f",
                float(close),
                self._options_strikes.center_price,
            )
            self.subscribe_es_options(float(close))

    def _handle_trade(self, record: Any) -> None:
        """Process an ES options trade record."""
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
            return  # Not an option we're tracking

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

        # Check for unusual options volume after each trade
        self._alert_engine.check_es_options_volume()

    def _handle_stat(self, record: Any) -> None:
        """Process a Statistics record (OI, settlement, IV, delta)."""
        from db import upsert_options_daily

        stat_type = record.stat_type
        if stat_type not in (
            STAT_TYPE_SETTLEMENT,
            STAT_TYPE_CLEARED_VOLUME,
            STAT_TYPE_OPEN_INTEREST,
            STAT_TYPE_IMPLIED_VOL,
            STAT_TYPE_DELTA,
        ):
            return

        iid = getattr(record, "instrument_id", 0)
        instrument_info = self._get_option_info(iid)
        if instrument_info is None:
            return

        strike = instrument_info["strike"]
        option_type = instrument_info["option_type"]
        expiry = instrument_info["expiry"]
        trade_date = date.today()

        # Convert stat value from 1e-9 int to Decimal
        stat_value = (
            Decimal(record.stat_value) / Decimal(1_000_000_000)
            if hasattr(record, "stat_value")
            else None
        )
        stat_quantity = getattr(record, "stat_quantity", None)

        # Determine if settlement is final
        is_final = (
            bool(getattr(record, "stat_flags", 0) & 1)
            if stat_type == STAT_TYPE_SETTLEMENT
            else False
        )

        try:
            if stat_type == STAT_TYPE_OPEN_INTEREST:
                upsert_options_daily(
                    "ES",
                    trade_date,
                    expiry,
                    Decimal(str(strike)),
                    option_type,
                    open_interest=int(stat_quantity) if stat_quantity else None,
                )
            elif stat_type == STAT_TYPE_SETTLEMENT:
                upsert_options_daily(
                    "ES",
                    trade_date,
                    expiry,
                    Decimal(str(strike)),
                    option_type,
                    settlement=stat_value,
                    is_final=is_final,
                )
            elif stat_type == STAT_TYPE_CLEARED_VOLUME:
                upsert_options_daily(
                    "ES",
                    trade_date,
                    expiry,
                    Decimal(str(strike)),
                    option_type,
                    volume=int(stat_quantity) if stat_quantity else None,
                )
            elif stat_type == STAT_TYPE_IMPLIED_VOL:
                upsert_options_daily(
                    "ES",
                    trade_date,
                    expiry,
                    Decimal(str(strike)),
                    option_type,
                    implied_vol=stat_value,
                )
            elif stat_type == STAT_TYPE_DELTA:
                upsert_options_daily(
                    "ES",
                    trade_date,
                    expiry,
                    Decimal(str(strike)),
                    option_type,
                    delta=stat_value,
                )
        except Exception as exc:
            log.error("Failed to upsert stat for strike %s: %s", strike, exc)

    def _handle_definition(self, record: Any) -> None:
        """Process an InstrumentDefMsg to discover ES option instruments."""
        # Extract key fields from the definition
        instrument_class = getattr(record, "instrument_class", None)
        if instrument_class not in ("C", "P"):
            # Not a call or put -- could be a future ('F') or other
            return

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
                "option_type": instrument_class,  # 'C' or 'P'
                "expiry": expiry,
            }

        log.debug(
            "Definition: iid=%d strike=%.2f type=%s expiry=%s",
            iid,
            strike,
            instrument_class,
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

    def _get_option_info(self, instrument_id: int) -> dict | None:
        """Look up option strike/type/expiry for an instrument_id."""
        return self._option_definitions.get(instrument_id)

    def stop(self) -> None:
        """Gracefully stop all Databento clients."""
        self._connected = False
        clients = [
            ("CME", self._client),
            ("VX", self._vxm_client),
            ("DX", self._dx_client),
        ]
        for name, client in clients:
            if client:
                try:
                    client.stop()
                except Exception as exc:
                    log.error("Error stopping %s client: %s", name, exc)
        self._client = None
        self._vxm_client = None
        self._dx_client = None
        self._trade_processor.flush()
        log.info("Databento clients stopped")

    def block_for_close(self, timeout: float | None = None) -> None:
        """Block until the client connection closes."""
        if self._client:
            self._client.block_for_close(timeout=timeout)
