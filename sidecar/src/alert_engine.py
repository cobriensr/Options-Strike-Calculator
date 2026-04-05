"""Alert engine: evaluate conditions on each new bar/trade, fire Twilio SMS.

Alert types:
- es_momentum: ES moves +/-30 pts in 10 min at 2x+ volume
- vx_backwardation: VXM front crosses above VXM second
- es_nq_divergence: ES and NQ diverge >=0.5% in 30 min
- zn_flight_safety: ZN +0.5 pts while ES -20 pts in 30 min
- cl_spike: CL moves +/-2% in 60 min
- es_options_volume: ES option strike hits 5x+ avg volume in 15 min

Rate limiting:
- Max 1 alert per type per cooldown period (default 30 min)
- Global cap: max 10 alerts per hour across all types
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from logger_setup import log

if TYPE_CHECKING:
    from trade_processor import TradeProcessor

# Default alert configurations (used if alert_config table is empty)
DEFAULT_CONFIGS: dict[str, dict] = {
    "es_momentum": {
        "enabled": True,
        "params": {"pts_threshold": 30, "window_minutes": 10, "volume_multiple": 2.0},
        "cooldown_minutes": 30,
    },
    "vx_backwardation": {
        "enabled": True,
        "params": {"spread_threshold": 0},
        "cooldown_minutes": 60,
    },
    "es_nq_divergence": {
        "enabled": True,
        "params": {"divergence_pct": 0.5, "window_minutes": 30},
        "cooldown_minutes": 30,
    },
    "zn_flight_safety": {
        "enabled": True,
        "params": {"zn_move_pts": 0.5, "es_move_pts": -20, "window_minutes": 30},
        "cooldown_minutes": 60,
    },
    "cl_spike": {
        "enabled": True,
        "params": {"change_pct": 2.0, "window_minutes": 60},
        "cooldown_minutes": 30,
    },
    "es_options_volume": {
        "enabled": True,
        "params": {"volume_multiple": 5.0, "window_minutes": 15},
        "cooldown_minutes": 30,
    },
}

GLOBAL_HOURLY_CAP = 10


@dataclass
class BarSnapshot:
    """Minimal bar data for alert evaluation."""

    symbol: str
    ts: float  # Unix timestamp
    close: float
    volume: int = 0


@dataclass
class AlertState:
    """Tracks last-fired timestamps and recent price history per symbol."""

    # Last fired time per alert_type (unix timestamp)
    last_fired: dict[str, float] = field(default_factory=dict)

    # Recent bar closes per symbol: deque of (unix_ts, close, volume)
    price_history: dict[str, deque] = field(default_factory=dict)

    # Global fire timestamps for rate limiting
    global_fires: deque = field(default_factory=lambda: deque(maxlen=100))

    # Latest close prices by symbol (for cross-symbol checks)
    latest_prices: dict[str, float] = field(default_factory=dict)

    def record_bar(self, symbol: str, ts: float, close: float, volume: int) -> None:
        """Record a new bar for alert evaluation."""
        if symbol not in self.price_history:
            # Keep 120 minutes of 1-min bars
            self.price_history[symbol] = deque(maxlen=120)
        self.price_history[symbol].append((ts, close, volume))
        self.latest_prices[symbol] = close

    def get_price_change(self, symbol: str, window_minutes: int) -> tuple[float, float]:
        """Get price change and total volume over the last N minutes.

        Returns (price_change_pts, total_volume).
        """
        history = self.price_history.get(symbol)
        if not history or len(history) < 2:
            return 0.0, 0

        now_ts = history[-1][0]
        cutoff = now_ts - window_minutes * 60
        current_close = history[-1][1]

        # Find the bar closest to the cutoff
        oldest_close = current_close
        total_vol = 0
        for ts, close, vol in history:
            if ts >= cutoff:
                if oldest_close == current_close:
                    oldest_close = close
                total_vol += vol

        return current_close - oldest_close, total_vol

    def get_pct_change(self, symbol: str, window_minutes: int) -> float:
        """Get percentage change over the last N minutes."""
        history = self.price_history.get(symbol)
        if not history or len(history) < 2:
            return 0.0

        now_ts = history[-1][0]
        cutoff = now_ts - window_minutes * 60
        current_close = history[-1][1]

        for ts, close, _ in history:
            if ts >= cutoff:
                if close != 0:
                    return ((current_close - close) / close) * 100
                break
        return 0.0


class AlertEngine:
    """Evaluates alert conditions and fires SMS via Twilio."""

    def __init__(self, trade_processor: TradeProcessor | None = None) -> None:
        self._configs = dict(DEFAULT_CONFIGS)
        self._state = AlertState()
        self._trade_processor = trade_processor
        self._twilio_client = None
        self._last_config_refresh = 0.0

    def update_configs(self, configs: dict[str, dict]) -> None:
        """Update alert configurations from the database."""
        if configs:
            self._configs.update(configs)
            log.info("Alert configs updated: %d types", len(configs))

    def refresh_configs_if_needed(self) -> None:
        """Refresh configs from DB every N seconds."""
        from config import settings

        now = time.time()
        if now - self._last_config_refresh < settings.alert_config_refresh_s:
            return

        self._last_config_refresh = now
        try:
            from db import load_alert_config

            configs = load_alert_config()
            if configs:
                self.update_configs(configs)
        except Exception as exc:
            log.error("Failed to refresh alert configs: %s", exc)

    def on_bar(self, symbol: str, ts: float, close: float, volume: int) -> None:
        """Called for each new 1-minute bar. Evaluates all relevant alerts."""
        self._state.record_bar(symbol, ts, close, volume)
        self.refresh_configs_if_needed()
        self._evaluate_all(symbol)

    def _evaluate_all(self, triggering_symbol: str) -> None:
        """Run all alert evaluations relevant to the triggering symbol."""
        if triggering_symbol == "ES":
            self._check_es_momentum()
            self._check_es_nq_divergence()
            self._check_zn_flight_safety()
        elif triggering_symbol == "NQ":
            self._check_es_nq_divergence()
        elif triggering_symbol in ("VXM1", "VXM2"):
            self._check_vx_backwardation()
        elif triggering_symbol == "ZN":
            self._check_zn_flight_safety()
        elif triggering_symbol == "CL":
            self._check_cl_spike()

    def _can_fire(self, alert_type: str) -> bool:
        """Check rate limits for a specific alert type."""
        cfg = self._configs.get(alert_type)
        if not cfg or not cfg.get("enabled", True):
            return False

        now = time.time()

        # Per-type cooldown
        cooldown_s = cfg.get("cooldown_minutes", 30) * 60
        last = self._state.last_fired.get(alert_type, 0)
        if now - last < cooldown_s:
            return False

        # Global hourly cap
        hour_ago = now - 3600
        recent = sum(1 for t in self._state.global_fires if t > hour_ago)
        if recent >= GLOBAL_HOURLY_CAP:
            return False

        return True

    def _fire_alert(self, alert_type: str, message: str) -> None:
        """Send an SMS alert via Twilio."""
        now = time.time()
        self._state.last_fired[alert_type] = now
        self._state.global_fires.append(now)

        log.info("ALERT [%s]: %s", alert_type, message, extra={"alert": alert_type})

        from config import settings

        if not settings.twilio_configured:
            log.warning("Twilio not configured -- alert logged but not sent")
            return

        try:
            if self._twilio_client is None:
                from twilio.rest import Client

                self._twilio_client = Client(
                    settings.twilio_account_sid, settings.twilio_auth_token
                )

            self._twilio_client.messages.create(
                body=message,
                from_=settings.twilio_from_number,
                to=settings.alert_phone_number,
            )
            log.info("SMS sent for alert: %s", alert_type)
        except Exception as exc:
            log.error("Failed to send SMS for %s: %s", alert_type, exc)

    # ------------------------------------------------------------------
    # Individual alert checks
    # ------------------------------------------------------------------

    def _check_es_momentum(self) -> None:
        """ES moves +/-N pts in M minutes at V× volume."""
        alert_type = "es_momentum"
        if not self._can_fire(alert_type):
            return

        params = self._configs[alert_type]["params"]
        pts_threshold = params["pts_threshold"]
        window = params["window_minutes"]
        vol_multiple = params["volume_multiple"]

        change, volume = self._state.get_price_change("ES", window)

        if abs(change) < pts_threshold:
            return

        # Volume check: compare to historical average (simplified --
        # use the window's average bar volume vs trailing average)
        # For now, fire if price threshold is met and volume > 0
        # TODO: implement proper volume comparison when historical data available
        if volume <= 0:
            return

        price = self._state.latest_prices.get("ES", 0)
        direction = "+" if change > 0 else ""
        msg = (
            f"ES ALERT: /ES {direction}{change:.0f} pts in {window} min. "
            f"Price: {price:.2f}. SPX impact imminent."
        )
        self._fire_alert(alert_type, msg)

    def _check_vx_backwardation(self) -> None:
        """VXM front crosses above VXM second (backwardation)."""
        alert_type = "vx_backwardation"
        if not self._can_fire(alert_type):
            return

        front = self._state.latest_prices.get("VXM1")
        back = self._state.latest_prices.get("VXM2")
        if front is None or back is None:
            return

        if front > back:
            msg = (
                f"VIX BACKWARDATION: Front {front:.2f} > Back {back:.2f}. "
                f"Near-term stress priced in."
            )
            self._fire_alert(alert_type, msg)

    def _check_es_nq_divergence(self) -> None:
        """ES and NQ diverge >= N% in M minutes."""
        alert_type = "es_nq_divergence"
        if not self._can_fire(alert_type):
            return

        params = self._configs[alert_type]["params"]
        window = params["window_minutes"]
        threshold = params["divergence_pct"]

        es_pct = self._state.get_pct_change("ES", window)
        nq_pct = self._state.get_pct_change("NQ", window)

        # Divergence = moving in opposite directions or significantly different magnitude
        divergence = abs(es_pct - nq_pct)
        if divergence < threshold:
            return

        # Must be moving in different directions
        if es_pct * nq_pct > 0 and divergence < threshold * 2:
            return

        msg = (
            f"ES-NQ SPLIT: ES {es_pct:+.1f}% but NQ {nq_pct:+.1f}% "
            f"({window} min). Sector rotation active."
        )
        self._fire_alert(alert_type, msg)

    def _check_zn_flight_safety(self) -> None:
        """ZN rallying while ES selling = flight to safety."""
        alert_type = "zn_flight_safety"
        if not self._can_fire(alert_type):
            return

        params = self._configs[alert_type]["params"]
        window = params["window_minutes"]
        zn_threshold = params["zn_move_pts"]
        es_threshold = params["es_move_pts"]

        zn_change, _ = self._state.get_price_change("ZN", window)
        es_change, _ = self._state.get_price_change("ES", window)

        if zn_change < zn_threshold or es_change > es_threshold:
            return

        msg = (
            f"FLIGHT TO SAFETY: ZN +{zn_change:.2f} pts while ES {es_change:.0f} pts "
            f"({window} min). Institutional exit."
        )
        self._fire_alert(alert_type, msg)

    def _check_cl_spike(self) -> None:
        """CL moves +/-N% in M minutes."""
        alert_type = "cl_spike"
        if not self._can_fire(alert_type):
            return

        params = self._configs[alert_type]["params"]
        window = params["window_minutes"]
        threshold = params["change_pct"]

        pct_change = self._state.get_pct_change("CL", window)

        if abs(pct_change) < threshold:
            return

        price = self._state.latest_prices.get("CL", 0)
        msg = (
            f"CRUDE SPIKE: /CL {pct_change:+.1f}% in {window} min. "
            f"Price: {price:.2f}. "
            + (
                "Inflation repricing -- vol expansion likely."
                if pct_change > 0
                else "Deflation signal -- vol compression favorable."
            )
        )
        self._fire_alert(alert_type, msg)

    def check_es_options_volume(self) -> None:
        """ES option strike hits N× avg volume in M minutes.

        Called separately from on_bar since it requires the TradeProcessor.
        """
        alert_type = "es_options_volume"
        if not self._can_fire(alert_type):
            return
        if self._trade_processor is None:
            return

        params = self._configs[alert_type]["params"]
        threshold = params["volume_multiple"]

        unusual = self._trade_processor.get_unusual_volume_strikes(threshold)
        if not unusual:
            return

        # Fire for the most notable strike
        top = max(unusual, key=lambda x: x["multiple"])
        buy_pct = top["buy_aggressor_pct"] * 100

        side_desc = "buy aggressor (lifting asks)" if buy_pct > 60 else (
            "sell aggressor (hitting bids)" if buy_pct < 40 else "mixed"
        )
        opt_label = "call" if top["option_type"] == "C" else "put"

        msg = (
            f"ES OPTIONS: {int(top['strike'])}{top['option_type']} -- "
            f"{top['volume']:,} contracts ({top['multiple']:.1f}x avg). "
            f"{buy_pct:.0f}% {side_desc}. Institutional {opt_label} "
            f"{'buying' if buy_pct > 60 else 'selling' if buy_pct < 40 else 'activity'}."
        )
        self._fire_alert(alert_type, msg)
