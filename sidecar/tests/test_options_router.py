"""Focused tests for ``options_router.OptionsRecordRouter``.

The 874-LOC ``test_databento_client.py`` is the load-bearing signal
that the Phase 3b extraction preserved DatabentoClient's public API
exactly. This file complements it with router-only tests that exercise
the extracted module in isolation — no DatabentoClient needed, just
the router with mocked dependencies.

Mock strategy mirrors test_databento_client.py: the conftest installs
session-wide mocks for databento / psycopg2 / sentry_sdk; this file
patches the source-level ``sentry_setup.capture_message`` and
``db.upsert_options_daily`` per-test.
"""

from __future__ import annotations

import os
from datetime import date
from unittest.mock import MagicMock

# Required env vars for config.py's pydantic-settings validation.
# Same throwaway pattern as test_databento_client.py.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402

import sentry_setup  # noqa: E402
from options_router import (  # noqa: E402
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


@pytest.fixture()
def router_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[OptionsRecordRouter, dict]:
    """Build a router with ``trade_processor`` and ``is_shutting_down``
    mocked, plus capture_message and upsert_options_daily monkeypatched
    for inspection. Returns (router, mocks_dict)."""
    patched_capture_message = MagicMock()
    monkeypatch.setattr(sentry_setup, "capture_message", patched_capture_message)

    import db

    patched_upsert_options_daily = MagicMock()
    monkeypatch.setattr(db, "upsert_options_daily", patched_upsert_options_daily)

    trade_processor = MagicMock()
    shutdown_flag = {"value": False}
    router = OptionsRecordRouter(
        trade_processor=trade_processor,
        is_shutting_down=lambda: shutdown_flag["value"],
    )

    return router, {
        "trade_processor": trade_processor,
        "shutdown_flag": shutdown_flag,
        "capture_message": patched_capture_message,
        "upsert_options_daily": patched_upsert_options_daily,
    }


def _make_trade_record(iid: int = 99) -> MagicMock:
    """TradeMsg-shaped fake record."""
    import databento

    rec = MagicMock()
    rec.instrument_id = iid
    rec.side = databento.Side.ASK
    rec.ts_event = 1_780_000_000_000_000_000
    rec.price = 50_250_000_000
    rec.size = 1
    return rec


def _make_def_record(
    *,
    instrument_class: object,
    iid: int = 1,
    strike_raw: int = 5800_000_000_000,  # 5800.00 in 1e-9
    expiration_ns: int = 1_780_000_000_000_000_000,
) -> MagicMock:
    rec = MagicMock()
    rec.instrument_class = instrument_class
    rec.instrument_id = iid
    rec.strike_price = strike_raw
    rec.expiration = expiration_ns
    return rec


# ---------------------------------------------------------------------------
# Initialization
# ---------------------------------------------------------------------------


class TestInit:
    def test_default_state(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, _ = router_setup
        assert router.option_definitions == {}
        assert router.definition_lag_drops == 0
        assert router.last_lag_summary_ts == pytest.approx(0.0)
        # OptionsStrikeSet has these defaults — guard against accidental
        # rebinding to a different type.
        assert hasattr(router.options_strikes, "strikes")
        assert hasattr(router.options_strikes, "center_price")


# ---------------------------------------------------------------------------
# handle_definition
# ---------------------------------------------------------------------------


class TestHandleDefinition:
    def test_call_definition_caches_option_info(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, _ = router_setup
        rec = _make_def_record(instrument_class="C", iid=42)
        router.handle_definition(rec)
        info = router.option_definitions[42]
        assert info["option_type"] == "C"
        assert info["strike"] == pytest.approx(5800.0)
        assert isinstance(info["expiry"], date)

    def test_put_definition_caches_option_info(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, _ = router_setup
        rec = _make_def_record(instrument_class="P", iid=43)
        router.handle_definition(rec)
        assert router.option_definitions[43]["option_type"] == "P"

    def test_non_option_class_not_cached(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Futures / spreads / cracks must not pollute the option cache."""
        router, _ = router_setup
        for cls in ("F", "S", "X"):
            router.handle_definition(_make_def_record(instrument_class=cls, iid=55))
        assert 55 not in router.option_definitions

    def test_zero_expiration_dropped(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Definitions without an expiration timestamp are unusable for
        downstream pin/expiry routing — must early-return without caching."""
        router, _ = router_setup
        rec = _make_def_record(
            instrument_class="C", iid=77, expiration_ns=0
        )
        router.handle_definition(rec)
        assert 77 not in router.option_definitions

    def test_enum_class_coerced_to_string(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """SIDE-016: psycopg2 can't adapt the InstrumentClass enum, so
        the router must coerce to bare 'C' / 'P' before caching. The
        FakeEnum here mimics the SDK's __eq__-via-value pattern."""
        router, _ = router_setup

        class FakeEnum:
            def __init__(self, value: str) -> None:
                self.value = value

            def __eq__(self, other: object) -> bool:
                return self.value == other

            def __hash__(self) -> int:
                return hash(self.value)

        rec = _make_def_record(instrument_class=FakeEnum("C"), iid=88)
        router.handle_definition(rec)
        stored = router.option_definitions[88]
        assert stored["option_type"] == "C"
        assert isinstance(stored["option_type"], str)


# ---------------------------------------------------------------------------
# handle_trade — happy + drop paths
# ---------------------------------------------------------------------------


class TestHandleTrade:
    def test_known_definition_dispatches_to_processor(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        router.option_definitions[99] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5800.0]

        router.handle_trade(_make_trade_record(iid=99))
        mocks["trade_processor"].process_trade.assert_called_once()

    def test_unknown_definition_increments_drop_counter(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """A trade with no matching definition must NOT reach the
        trade_processor and must surface via the lag-drop summary."""
        router, mocks = router_setup
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5800.0]

        router.handle_trade(_make_trade_record(iid=999))
        mocks["trade_processor"].process_trade.assert_not_called()
        # The first drop fires the summary immediately because
        # last_lag_summary_ts starts at 0.
        mocks["capture_message"].assert_called_once()

    def test_strike_not_in_atm_window_is_dropped(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """ATM filter: a trade for a known strike that's outside the
        current window is dropped without dispatching."""
        router, mocks = router_setup
        router.option_definitions[99] = {
            "strike": 6500.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5800.0]  # 6500 is far outside

        router.handle_trade(_make_trade_record(iid=99))
        mocks["trade_processor"].process_trade.assert_not_called()

    def test_shutdown_barrier_blocks_trade(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        mocks["shutdown_flag"]["value"] = True

        router.option_definitions[99] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5800.0]

        router.handle_trade(_make_trade_record(iid=99))
        mocks["trade_processor"].process_trade.assert_not_called()


# ---------------------------------------------------------------------------
# handle_stat — drives the STAT_TYPE_TO_KWARG dispatch table
# ---------------------------------------------------------------------------


class TestHandleStat:
    def _preload(self, router: OptionsRecordRouter) -> None:
        router.option_definitions[7] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }

    def test_settlement_passes_stat_value_and_is_final(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        self._preload(router)

        rec = MagicMock()
        rec.instrument_id = 7
        rec.stat_type = STAT_TYPE_SETTLEMENT
        rec.stat_value = 1_500_000_000  # 1.5 in 1e-9
        rec.stat_quantity = 0
        rec.stat_flags = 1

        router.handle_stat(rec)
        kwargs = mocks["upsert_options_daily"].call_args.kwargs
        assert "settlement" in kwargs
        assert kwargs["is_final"] is True

    def test_open_interest_uses_stat_quantity(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        self._preload(router)

        rec = MagicMock()
        rec.instrument_id = 7
        rec.stat_type = STAT_TYPE_OPEN_INTEREST
        rec.stat_value = 0
        rec.stat_quantity = 1234

        router.handle_stat(rec)
        kwargs = mocks["upsert_options_daily"].call_args.kwargs
        assert kwargs["open_interest"] == 1234
        assert "is_final" not in kwargs

    def test_unknown_stat_type_dropped(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        self._preload(router)

        rec = MagicMock()
        rec.instrument_id = 7
        rec.stat_type = STAT_TYPE_OPENING_PRICE  # not in the table
        rec.stat_value = 1_000_000_000
        rec.stat_quantity = 0
        router.handle_stat(rec)
        mocks["upsert_options_daily"].assert_not_called()

    def test_missing_definition_dropped(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """An iid not in option_definitions silently drops — same
        semantics as handle_trade but without the lag counter (stats
        come less frequently than trades)."""
        router, mocks = router_setup

        rec = MagicMock()
        rec.instrument_id = 9999
        rec.stat_type = STAT_TYPE_OPEN_INTEREST
        rec.stat_quantity = 100

        router.handle_stat(rec)
        mocks["upsert_options_daily"].assert_not_called()

    def test_shutdown_barrier_blocks_stat(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        mocks["shutdown_flag"]["value"] = True
        self._preload(router)

        rec = MagicMock()
        rec.instrument_id = 7
        rec.stat_type = STAT_TYPE_OPEN_INTEREST
        rec.stat_quantity = 100

        router.handle_stat(rec)
        mocks["upsert_options_daily"].assert_not_called()


# ---------------------------------------------------------------------------
# Definition-lag summary throttling
# ---------------------------------------------------------------------------


class TestLagSummaryThrottle:
    def test_summary_does_not_fire_when_zero_drops(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        router._maybe_log_definition_lag_summary()
        mocks["capture_message"].assert_not_called()

    def test_repeated_drops_throttle_to_one_summary(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Multiple drops within DEFINITION_LAG_SUMMARY_INTERVAL_S
        produce only one summary."""
        router, mocks = router_setup
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5800.0]

        # First drop: fires immediately because last_lag_summary_ts = 0
        router.handle_trade(_make_trade_record(iid=1))
        assert mocks["capture_message"].call_count == 1

        # Pin the throttle clock to "now" so subsequent drops don't fire
        import time as real_time

        router.last_lag_summary_ts = real_time.time()

        for _ in range(5):
            router.handle_trade(_make_trade_record(iid=2))

        assert mocks["capture_message"].call_count == 1
        assert router.definition_lag_drops == 5


# ---------------------------------------------------------------------------
# STAT_TYPE_TO_KWARG dispatch table — locked
# ---------------------------------------------------------------------------


class TestStatTypeToKwargTable:
    """Reuses test_databento_client.py's intent: lock the table so
    adding a new stat type forces a deliberate edit. Duplicated here
    because options_router is the canonical home of the constant."""

    def test_locked(self) -> None:
        assert STAT_TYPE_TO_KWARG == {
            STAT_TYPE_OPEN_INTEREST: ("open_interest", "stat_quantity"),
            STAT_TYPE_SETTLEMENT: ("settlement", "stat_value"),
            STAT_TYPE_CLEARED_VOLUME: ("volume", "stat_quantity"),
            STAT_TYPE_IMPLIED_VOL: ("implied_vol", "stat_value"),
            STAT_TYPE_DELTA: ("delta", "stat_value"),
        }

    def test_summary_interval_is_60s(self) -> None:
        """Sanity guard on the throttle window. If this changes,
        the production-cadence Sentry alert thresholds need re-tuning."""
        assert DEFINITION_LAG_SUMMARY_INTERVAL_S == pytest.approx(60.0)
