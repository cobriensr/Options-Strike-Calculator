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
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Callable

from logger_setup import log
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

        # Guards concurrent writes to option_definitions from the SDK
        # callback thread vs reads from other handlers.
        self._lock = threading.Lock()

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

        # Filter: only process strikes in our ATM window
        if strike not in self.options_strikes.strikes:
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

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_option_info(self, instrument_id: int) -> dict | None:
        """Look up option strike/type/expiry for an instrument_id."""
        return self.option_definitions.get(instrument_id)

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
