"""Tests for alert_engine module."""

from __future__ import annotations

import sys
import time
import types
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Install a mock 'config' module into sys.modules BEFORE alert_engine
# imports it.  The real config.py instantiates Settings() at module level
# which requires env vars we don't have in CI/test.
# ---------------------------------------------------------------------------

_fake_config = types.ModuleType("config")
_fake_settings = MagicMock()
_fake_settings.twilio_configured = False
_fake_settings.alert_config_refresh_s = 999_999
_fake_config.settings = _fake_settings  # type: ignore[attr-defined]
sys.modules.setdefault("config", _fake_config)

# Also mock 'db' so refresh_configs_if_needed doesn't blow up
_fake_db = types.ModuleType("db")
_fake_db.load_alert_config = MagicMock(return_value=None)  # type: ignore[attr-defined]
sys.modules.setdefault("db", _fake_db)

from alert_engine import AlertEngine, AlertState, GLOBAL_HOURLY_CAP  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def state() -> AlertState:
    return AlertState()


@pytest.fixture()
def engine() -> AlertEngine:
    """AlertEngine with config refresh disabled (no DB/env dependency)."""
    eng = AlertEngine(trade_processor=None)
    # Prevent refresh_configs_if_needed from hitting the (mocked) DB
    eng._last_config_refresh = time.time() + 999_999
    return eng


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _feed_bars(
    engine: AlertEngine,
    symbol: str,
    prices: list[float],
    *,
    start_ts: float = 1_000_000.0,
    volume: int = 100,
) -> float:
    """Feed a sequence of 1-minute bars into the engine, return final ts."""
    ts = start_ts
    for price in prices:
        engine.on_bar(symbol, ts, price, volume)
        ts += 60
    return ts - 60  # last bar's timestamp


# ===========================================================================
# 1. AlertState.record_bar
# ===========================================================================


class TestRecordBar:
    def test_stores_bar_and_updates_latest(self, state: AlertState) -> None:
        state.record_bar("ES", 1.0, 5000.0, 100)
        assert state.latest_prices["ES"] == pytest.approx(5000.0)
        assert len(state.price_history["ES"]) == 1

    def test_multiple_bars_accumulate(self, state: AlertState) -> None:
        for i in range(5):
            state.record_bar("ES", float(i), 5000.0 + i, 10)
        assert len(state.price_history["ES"]) == 5
        assert state.latest_prices["ES"] == pytest.approx(5004.0)

    def test_maxlen_120(self, state: AlertState) -> None:
        for i in range(150):
            state.record_bar("ES", float(i), 5000.0, 10)
        assert len(state.price_history["ES"]) == 120

    def test_separate_symbols(self, state: AlertState) -> None:
        state.record_bar("ES", 1.0, 5000.0, 100)
        state.record_bar("NQ", 1.0, 18000.0, 200)
        assert state.latest_prices["ES"] == pytest.approx(5000.0)
        assert state.latest_prices["NQ"] == pytest.approx(18000.0)
        assert len(state.price_history["ES"]) == 1
        assert len(state.price_history["NQ"]) == 1


# ===========================================================================
# 2. AlertState.get_price_change
# ===========================================================================


class TestGetPriceChange:
    def test_empty_history_returns_zero(self, state: AlertState) -> None:
        change, vol = state.get_price_change("ES", 10)
        assert change == pytest.approx(0.0)
        assert vol == 0

    def test_single_bar_returns_zero(self, state: AlertState) -> None:
        state.record_bar("ES", 1.0, 5000.0, 100)
        change, vol = state.get_price_change("ES", 10)
        assert change == pytest.approx(0.0)
        assert vol == 0

    def test_correct_change_within_window(self, state: AlertState) -> None:
        base_ts = 1_000_000.0
        state.record_bar("ES", base_ts, 5000.0, 50)
        state.record_bar("ES", base_ts + 60, 5010.0, 60)
        state.record_bar("ES", base_ts + 120, 5030.0, 70)

        change, vol = state.get_price_change("ES", 10)
        # Window covers all bars; oldest in window is 5000 -> current 5030
        assert change == pytest.approx(30.0)
        assert vol == 50 + 60 + 70

    def test_window_excludes_old_bars(self, state: AlertState) -> None:
        base_ts = 1_000_000.0
        # Bar outside 5-minute window
        state.record_bar("ES", base_ts, 4900.0, 10)
        # Bars inside 5-minute window
        state.record_bar("ES", base_ts + 600, 5000.0, 20)
        state.record_bar("ES", base_ts + 660, 5050.0, 30)

        change, vol = state.get_price_change("ES", 5)
        # Cutoff = 660 - 300 = 360; bar at 600 is >= 360, so oldest=5000
        assert change == pytest.approx(50.0)
        assert vol == 20 + 30


# ===========================================================================
# 3. AlertState.get_pct_change
# ===========================================================================


class TestGetPctChange:
    def test_empty_returns_zero(self, state: AlertState) -> None:
        assert state.get_pct_change("CL", 60) == pytest.approx(0.0)

    def test_single_bar_returns_zero(self, state: AlertState) -> None:
        state.record_bar("CL", 1.0, 80.0, 100)
        assert state.get_pct_change("CL", 60) == pytest.approx(0.0)

    def test_correct_percentage(self, state: AlertState) -> None:
        base_ts = 1_000_000.0
        state.record_bar("CL", base_ts, 100.0, 50)
        state.record_bar("CL", base_ts + 60, 102.0, 60)

        pct = state.get_pct_change("CL", 10)
        assert pct == pytest.approx(2.0)

    def test_negative_change(self, state: AlertState) -> None:
        base_ts = 1_000_000.0
        state.record_bar("CL", base_ts, 100.0, 50)
        state.record_bar("CL", base_ts + 60, 97.0, 60)

        pct = state.get_pct_change("CL", 10)
        assert pct == pytest.approx(-3.0)

    def test_zero_base_price_returns_zero(self, state: AlertState) -> None:
        base_ts = 1_000_000.0
        state.record_bar("CL", base_ts, 0.0, 10)
        state.record_bar("CL", base_ts + 60, 5.0, 10)

        assert state.get_pct_change("CL", 10) == pytest.approx(0.0)


# ===========================================================================
# 4. AlertEngine warmup
# ===========================================================================


class TestWarmup:
    def test_no_alerts_before_warmup(self, engine: AlertEngine) -> None:
        """Fewer than MIN_BARS_WARMUP bars should not produce any alerts."""
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP - 1):
            engine.on_bar("ES", base_ts + i * 60, 5000.0 + i * 40, 500)

        assert len(engine._state.last_fired) == 0
        assert len(engine._state.global_fires) == 0

    def test_alert_fires_after_warmup(self, engine: AlertEngine) -> None:
        """After MIN_BARS_WARMUP bars with large enough move, alert fires."""
        base_ts = 1_000_000.0
        prices = [5000.0, 5005.0, 5010.0, 5015.0, 5045.0]
        assert len(prices) == AlertEngine.MIN_BARS_WARMUP

        for i, p in enumerate(prices):
            engine.on_bar("ES", base_ts + i * 60, p, 500)

        # 45-point move with volume should trigger es_momentum
        assert "es_momentum" in engine._state.last_fired


# ===========================================================================
# 5. AlertEngine cooldown
# ===========================================================================


class TestCooldown:
    def test_alert_blocked_during_cooldown(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        # Feed warmup + trigger bars
        prices = [5000.0, 5005.0, 5010.0, 5015.0, 5045.0]
        for i, p in enumerate(prices):
            engine.on_bar("ES", base_ts + i * 60, p, 500)
        assert "es_momentum" in engine._state.last_fired

        first_fire_time = engine._state.last_fired["es_momentum"]

        # Feed another large move immediately -- should be blocked by cooldown
        engine.on_bar("ES", base_ts + 5 * 60, 5090.0, 500)

        # last_fired timestamp should not have changed
        assert engine._state.last_fired["es_momentum"] == first_fire_time

    def test_alert_fires_after_cooldown_expires(self, engine: AlertEngine) -> None:
        # Use a controllable wall clock so _can_fire / _fire_alert see
        # time advancing past the cooldown window.
        wall_clock = 1_000_000.0

        def fake_time() -> float:
            return wall_clock

        with patch("alert_engine.time.time", side_effect=fake_time):
            base_ts = wall_clock
            prices = [5000.0, 5005.0, 5010.0, 5015.0, 5045.0]
            for i, p in enumerate(prices):
                engine.on_bar("ES", base_ts + i * 60, p, 500)
            assert "es_momentum" in engine._state.last_fired

            first_fire_time = engine._state.last_fired["es_momentum"]

            # Advance wall clock past cooldown (30 min = 1800s)
            cooldown_s = engine._configs["es_momentum"]["cooldown_minutes"] * 60
            wall_clock = base_ts + cooldown_s + 600

            # Build up fresh history past the cooldown boundary
            new_prices = [5100.0, 5105.0, 5110.0, 5115.0, 5155.0]
            for i, p in enumerate(new_prices):
                engine.on_bar("ES", wall_clock + i * 60, p, 500)

            # Should have fired again with a newer timestamp
            assert engine._state.last_fired["es_momentum"] > first_fire_time


# ===========================================================================
# 6. AlertEngine global cap
# ===========================================================================


class TestGlobalCap:
    def test_can_fire_returns_false_after_cap(self, engine: AlertEngine) -> None:
        now = time.time()
        # Simulate GLOBAL_HOURLY_CAP fires in the last hour
        for _ in range(GLOBAL_HOURLY_CAP):
            engine._state.global_fires.append(now)

        assert engine._can_fire("es_momentum") is False

    def test_can_fire_true_when_under_cap(self, engine: AlertEngine) -> None:
        now = time.time()
        for _ in range(GLOBAL_HOURLY_CAP - 1):
            engine._state.global_fires.append(now)

        assert engine._can_fire("es_momentum") is True

    def test_old_fires_dont_count(self, engine: AlertEngine) -> None:
        old = time.time() - 7200  # 2 hours ago
        for _ in range(GLOBAL_HOURLY_CAP):
            engine._state.global_fires.append(old)

        assert engine._can_fire("es_momentum") is True


# ===========================================================================
# 7. ES momentum alert
# ===========================================================================


class TestEsMomentum:
    def test_fires_on_large_move_with_volume(self, engine: AlertEngine) -> None:
        # 35-point move over warmup bars
        prices = [5000.0, 5005.0, 5010.0, 5015.0, 5035.0]
        _feed_bars(engine, "ES", prices, volume=200)
        assert "es_momentum" in engine._state.last_fired

    def test_does_not_fire_on_small_move(self, engine: AlertEngine) -> None:
        # 10-point move -- below 30-pt threshold
        prices = [5000.0, 5002.0, 5004.0, 5006.0, 5010.0]
        _feed_bars(engine, "ES", prices, volume=200)
        assert "es_momentum" not in engine._state.last_fired

    def test_does_not_fire_with_zero_volume(self, engine: AlertEngine) -> None:
        prices = [5000.0, 5005.0, 5010.0, 5015.0, 5035.0]
        _feed_bars(engine, "ES", prices, volume=0)
        assert "es_momentum" not in engine._state.last_fired


# ===========================================================================
# 8. VX backwardation
# ===========================================================================


class TestVxBackwardation:
    def test_fires_when_front_gt_back(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        # Build enough history for both VX symbols
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            engine.on_bar("VX1", ts, 20.0 + i * 0.5, 100)
            engine.on_bar("VX2", ts, 18.0, 100)

        assert "vx_backwardation" in engine._state.last_fired

    def test_does_not_fire_when_front_lt_back(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            engine.on_bar("VX1", ts, 16.0, 100)
            engine.on_bar("VX2", ts, 18.0, 100)

        assert "vx_backwardation" not in engine._state.last_fired

    def test_does_not_fire_when_equal(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            engine.on_bar("VX1", ts, 18.0, 100)
            engine.on_bar("VX2", ts, 18.0, 100)

        assert "vx_backwardation" not in engine._state.last_fired


# ===========================================================================
# 9. ES-NQ divergence
# ===========================================================================


class TestEsNqDivergence:
    def test_fires_on_opposite_direction_moves(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            # ES going up, NQ going down -- divergence > 0.5%
            engine.on_bar("ES", ts, 5000.0 + i * 10, 100)
            engine.on_bar("NQ", ts, 18000.0 - i * 40, 100)

        assert "es_nq_divergence" in engine._state.last_fired

    def test_does_not_fire_when_moving_together(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            # Both moving up together at similar rates
            engine.on_bar("ES", ts, 5000.0 + i * 1, 100)
            engine.on_bar("NQ", ts, 18000.0 + i * 3.6, 100)

        assert "es_nq_divergence" not in engine._state.last_fired


# ===========================================================================
# 10. ZN flight to safety
# ===========================================================================


class TestZnFlightToSafety:
    def test_fires_on_zn_up_es_down(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            # ZN rising >= 0.5 pts, ES falling >= 20 pts
            engine.on_bar("ZN", ts, 110.0 + i * 0.2, 100)
            engine.on_bar("ES", ts, 5000.0 - i * 8, 100)

        assert "zn_flight_safety" in engine._state.last_fired

    def test_does_not_fire_when_both_up(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            engine.on_bar("ZN", ts, 110.0 + i * 0.2, 100)
            engine.on_bar("ES", ts, 5000.0 + i * 5, 100)

        assert "zn_flight_safety" not in engine._state.last_fired

    def test_does_not_fire_when_zn_flat(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        for i in range(AlertEngine.MIN_BARS_WARMUP):
            ts = base_ts + i * 60
            engine.on_bar("ZN", ts, 110.0, 100)
            engine.on_bar("ES", ts, 5000.0 - i * 8, 100)

        assert "zn_flight_safety" not in engine._state.last_fired


# ===========================================================================
# 11. CL spike
# ===========================================================================


class TestClSpike:
    def test_fires_on_large_pct_move(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        # Start at 80, end at 81.8 = +2.25%
        prices = [80.0, 80.2, 80.5, 81.0, 81.8]
        for i, p in enumerate(prices):
            engine.on_bar("CL", base_ts + i * 60, p, 100)

        assert "cl_spike" in engine._state.last_fired

    def test_does_not_fire_on_small_move(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        # Start at 80, end at 80.8 = +1.0% -- below 2% threshold
        prices = [80.0, 80.1, 80.2, 80.4, 80.8]
        for i, p in enumerate(prices):
            engine.on_bar("CL", base_ts + i * 60, p, 100)

        assert "cl_spike" not in engine._state.last_fired

    def test_fires_on_negative_spike(self, engine: AlertEngine) -> None:
        base_ts = 1_000_000.0
        # Start at 80, end at 78.2 = -2.25%
        prices = [80.0, 79.5, 79.0, 78.5, 78.2]
        for i, p in enumerate(prices):
            engine.on_bar("CL", base_ts + i * 60, p, 100)

        assert "cl_spike" in engine._state.last_fired
