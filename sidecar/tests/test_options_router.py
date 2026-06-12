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
from datetime import date, datetime, timedelta, timezone
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
    DEFINITION_PRUNE_INTERVAL_S,
    STAT_TYPE_CLEARED_VOLUME,
    STAT_TYPE_DELTA,
    STAT_TYPE_IMPLIED_VOL,
    STAT_TYPE_OPEN_INTEREST,
    STAT_TYPE_OPENING_PRICE,
    STAT_TYPE_SETTLEMENT,
    STAT_TYPE_TO_KWARG,
    WINDOW_FILTER_STALE_DROP_THRESHOLD,
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
        rec = _make_def_record(instrument_class="C", iid=77, expiration_ns=0)
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

    def test_float_noise_strike_within_tolerance_is_processed(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """FINDING 4: a float-noise strike (5849.9999999) within ±0.5 of a
        clean window strike (5850) must be PROCESSED, not dropped by an
        exact-equality membership test."""
        router, mocks = router_setup
        router.option_definitions[99] = {
            "strike": 5849.9999999,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5850]  # clean int, 5-pt grid

        router.handle_trade(_make_trade_record(iid=99))
        mocks["trade_processor"].process_trade.assert_called_once()
        assert router.window_filter_drops == 0

    def test_off_window_strike_drops_and_increments_counter(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """FINDING 4: a genuinely off-window strike (far OTM, not within
        ±0.5 of any window strike) still drops, surfaces via the
        window-filter summary, and does NOT touch the definition-lag
        counter (distinct drop cause)."""
        router, mocks = router_setup
        router.option_definitions[99] = {
            "strike": 6500.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5850]  # 6500 is far outside

        # Pin the throttle clock forward so the drop is counted without the
        # summary firing+resetting it — lets us assert the raw counter.
        import time as real_time

        router.last_window_summary_ts = real_time.time()

        router.handle_trade(_make_trade_record(iid=99))
        mocks["trade_processor"].process_trade.assert_not_called()
        assert router.window_filter_drops == 1
        assert router.definition_lag_drops == 0  # distinct drop cause
        # Throttled: no summary this cycle.
        mocks["capture_message"].assert_not_called()


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
        rec.ts_event = 1_780_000_000_000_000_000

        router.handle_stat(rec)
        # AUD-M27: handle_stat enqueues to the off-thread StatWriter; flush
        # forces the buffered upsert so we can assert on the call.
        router._stat_writer.flush()
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
        rec.ts_event = 1_780_000_000_000_000_000

        router.handle_stat(rec)
        router._stat_writer.flush()  # AUD-M27: drain the off-thread writer
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

    def test_stat_trade_date_uses_cme_session_not_local_clock(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """FINDING 5: handle_stat must derive trade_date from the record's
        ts_event via cme_session_date, not the container local-clock
        date.today(). A stat with a late-evening ts_event (after 17:00 CT)
        keys to the NEXT session date, which differs from date.today()."""
        router, mocks = router_setup
        self._preload(router)

        # 2026-06-15 22:30:00 UTC == 17:30 America/Chicago (after the
        # 17:00 CT roll) -> CME session date 2026-06-16.
        rec = MagicMock()
        rec.instrument_id = 7
        rec.stat_type = STAT_TYPE_OPEN_INTEREST
        rec.stat_value = 0
        rec.stat_quantity = 1234
        rec.ts_event = 1_781_562_600_000_000_000

        router.handle_stat(rec)
        router._stat_writer.flush()  # AUD-M27: drain the off-thread writer
        passed_trade_date = mocks["upsert_options_daily"].call_args.args[1]
        assert passed_trade_date == date(2026, 6, 16)
        assert passed_trade_date != date.today()


# ---------------------------------------------------------------------------
# AUD-M27 — option stats are ENQUEUED to the off-thread StatWriter, not
# upserted synchronously on the SDK callback thread.
# ---------------------------------------------------------------------------


class TestAudM27StatEnqueue:
    def _preload(self, router: OptionsRecordRouter) -> None:
        router.option_definitions[7] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }

    def _make_stat(self) -> MagicMock:
        rec = MagicMock()
        rec.instrument_id = 7
        rec.stat_type = STAT_TYPE_OPEN_INTEREST
        rec.stat_value = 0
        rec.stat_quantity = 4321
        rec.ts_event = 1_780_000_000_000_000_000
        return rec

    def test_stat_is_buffered_not_synchronously_upserted(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """handle_stat must enqueue the stat to the StatWriter buffer and
        NOT call upsert_options_daily on the callback thread."""
        router, mocks = router_setup
        self._preload(router)

        router.handle_stat(self._make_stat())

        mocks["upsert_options_daily"].assert_not_called()
        assert len(router._stat_writer._buffer) == 1
        buffered = router._stat_writer._buffer[0]
        assert buffered.underlying == "ES"
        assert buffered.option_type == "C"
        assert buffered.kwargs == {"open_interest": 4321}

    def test_buffered_stat_drains_on_flush(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Flushing the StatWriter drains the buffered stat through the
        idempotent upsert_options_daily with the original kwargs."""
        router, mocks = router_setup
        self._preload(router)

        router.handle_stat(self._make_stat())
        router._stat_writer.flush()

        mocks["upsert_options_daily"].assert_called_once()
        assert router._stat_writer._buffer == []
        kwargs = mocks["upsert_options_daily"].call_args.kwargs
        assert kwargs["open_interest"] == 4321

    def test_stop_stat_writer_flushes_buffer(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """stop_stat_writer drains any buffered stats so they land in Neon
        before the DB pool is torn down on shutdown."""
        router, mocks = router_setup
        self._preload(router)

        router.handle_stat(self._make_stat())
        assert len(router._stat_writer._buffer) == 1

        router.stop_stat_writer()

        mocks["upsert_options_daily"].assert_called_once()
        assert router._stat_writer._buffer == []


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
# Window-filter (FINDING 4) summary throttling
# ---------------------------------------------------------------------------


class TestWindowFilterSummaryThrottle:
    def test_summary_does_not_fire_when_zero_drops(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        router._maybe_log_window_filter_summary()
        mocks["capture_message"].assert_not_called()

    def test_routine_off_window_drops_do_not_page(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Sub-threshold off-window drops are EXPECTED trending-session
        filtering (we track ATM +/-10 only). They are counted + info-logged
        locally but must NOT page Sentry — this is the DESERT-DG false
        alarm we are silencing."""
        router, mocks = router_setup
        router.option_definitions[99] = {
            "strike": 6500.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5850]

        # One off-window drop: summary runs (last_window_summary_ts = 0) but
        # drops (1) is far below the stale threshold -> info log, no page.
        router.handle_trade(_make_trade_record(iid=99))
        mocks["capture_message"].assert_not_called()

    def test_stale_window_drop_burst_pages_sentry(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """A burst >= WINDOW_FILTER_STALE_DROP_THRESHOLD in one interval
        signals a likely FROZEN ATM window (ES bars stalled) and IS the
        actionable case — it pages with a stale-window message."""
        router, mocks = router_setup
        router.option_definitions[99] = {
            "strike": 6500.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5850]

        # Preload the counter to one below threshold; the next drop crosses
        # it and the summary (last_window_summary_ts = 0) escalates to Sentry.
        router.window_filter_drops = WINDOW_FILTER_STALE_DROP_THRESHOLD - 1
        router.handle_trade(_make_trade_record(iid=99))

        mocks["capture_message"].assert_called_once()
        msg = mocks["capture_message"].call_args.args[0]
        assert "STALE" in msg
        assert mocks["capture_message"].call_args.kwargs["level"] == "warning"

    def test_stale_summary_throttles_to_one_per_interval(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Even above threshold, the summary fires at most once per
        interval — own throttle state, independent of the lag summary."""
        router, mocks = router_setup
        router.option_definitions[99] = {
            "strike": 6500.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }
        router.options_strikes = MagicMock()
        router.options_strikes.strikes = [5850]

        # First burst crosses the threshold and pages.
        router.window_filter_drops = WINDOW_FILTER_STALE_DROP_THRESHOLD - 1
        router.handle_trade(_make_trade_record(iid=99))
        assert mocks["capture_message"].call_count == 1

        import time as real_time

        router.last_window_summary_ts = real_time.time()

        # A second above-threshold burst within the interval is throttled.
        router.window_filter_drops = WINDOW_FILTER_STALE_DROP_THRESHOLD + 10
        router._maybe_log_window_filter_summary()
        assert mocks["capture_message"].call_count == 1
        assert router.window_filter_drops == WINDOW_FILTER_STALE_DROP_THRESHOLD + 10


# ---------------------------------------------------------------------------
# Stat-upsert-failure summary throttling (AUD-M26)
# ---------------------------------------------------------------------------


class TestStatUpsertFailureSummaryThrottle:
    """AUD-M26: a stat upsert failure must page Sentry via the throttled
    summary, not just a log line. Verifies the capture fires on failure and
    that repeated failures within the interval throttle to one capture."""

    def _preload(self, router: OptionsRecordRouter) -> None:
        router.option_definitions[7] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": date(2030, 1, 1),
        }

    def _make_stat_record(self, quantity: int = 1234) -> MagicMock:
        rec = MagicMock()
        rec.instrument_id = 7
        rec.stat_type = STAT_TYPE_OPEN_INTEREST
        rec.stat_value = 0
        rec.stat_quantity = quantity
        rec.ts_event = 1_780_000_000_000_000_000
        return rec

    def test_summary_does_not_fire_when_zero_failures(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, mocks = router_setup
        router._maybe_log_stat_upsert_failure_summary()
        mocks["capture_message"].assert_not_called()

    def test_upsert_failure_pages_sentry_with_error_text(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """A raising upsert is counted AND surfaced via capture_message
        (fires immediately because last_stat_failure_summary_ts = 0). The
        underlying error string is carried into the message + context so the
        root cause (overflow / schema drift / enum-adapt) is visible."""
        router, mocks = router_setup
        self._preload(router)
        mocks["upsert_options_daily"].side_effect = ValueError(
            "numeric field overflow"
        )

        # AUD-M27: handle_stat enqueues; the upsert (and thus the failure)
        # runs when the StatWriter drains. flush() surfaces it through
        # _on_stat_write_failure, preserving the AUD-M26 counter + summary.
        router.handle_stat(self._make_stat_record())
        router._stat_writer.flush()

        mocks["capture_message"].assert_called_once()
        msg = mocks["capture_message"].call_args.args[0]
        assert "futures_options_daily" in msg
        assert "numeric field overflow" in msg
        kwargs = mocks["capture_message"].call_args.kwargs
        assert kwargs["level"] == "warning"
        assert kwargs["context"]["failures"] == 1
        assert "numeric field overflow" in kwargs["context"]["last_error"]
        # Counter reset after the summary fired.
        assert router.stat_upsert_failures == 0

    def test_repeated_failures_throttle_to_one_summary(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Multiple failed flush cycles within
        STAT_UPSERT_FAILURE_SUMMARY_INTERVAL_S produce only one capture —
        own throttle state, no per-batch Sentry spam.

        AUD-M27: the upsert now runs on a StatWriter drain, so each failed
        flush() is one failure increment (the writer re-queues the rows on
        failure, but the AUD-M26 counter is driven once per failed batch via
        _on_stat_write_failure). We avoid re-queue double-counting by giving
        each flush its own fresh writer so the throttle behavior — not the
        re-queue mechanics — is what's under test.
        """
        router, mocks = router_setup
        self._preload(router)
        mocks["upsert_options_daily"].side_effect = ValueError("boom")

        # First failed flush: fires immediately (last_stat_failure_summary_ts
        # = 0) and resets the counter.
        router.handle_stat(self._make_stat_record())
        router._stat_writer.flush()
        assert mocks["capture_message"].call_count == 1

        # Pin the throttle clock to "now" so subsequent failures don't page.
        import time as real_time

        router.last_stat_failure_summary_ts = real_time.time()

        # Drive 5 more failed flush cycles. Use a fresh writer each time so a
        # re-queued row from the prior failure doesn't inflate the count —
        # we're testing the throttle, which must hold the capture at one.
        from stat_writer import StatWriter

        for i in range(5):
            router._stat_writer = StatWriter(
                on_write_failure=router._on_stat_write_failure
            )
            router.handle_stat(self._make_stat_record(quantity=1000 + i))
            router._stat_writer.flush()

        assert mocks["capture_message"].call_count == 1
        assert router.stat_upsert_failures == 5


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


# ---------------------------------------------------------------------------
# M7 — option_definitions past-expiry pruning + throttle
# ---------------------------------------------------------------------------

# UTC "today" anchor used to build deterministic past/future expiries. The
# prune compares against datetime.now(timezone.utc).date(), so deriving the
# fixtures from the same clock keeps the test off real-time flakiness without
# having to patch the prune's internal datetime import.
_TODAY_UTC = datetime.now(timezone.utc).date()
_YESTERDAY = _TODAY_UTC - timedelta(days=1)
_LAST_WEEK = _TODAY_UTC - timedelta(days=7)
_TOMORROW = _TODAY_UTC + timedelta(days=1)


def _def_entry(strike: float, expiry: date, option_type: str = "C") -> dict:
    return {"strike": strike, "option_type": option_type, "expiry": expiry}


class TestPruneExpiredDefinitions:
    def test_removes_past_keeps_future(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Entries whose expiry is strictly before today are removed;
        today's and future entries are retained."""
        router, _ = router_setup
        router.option_definitions = {
            1: _def_entry(5800.0, _LAST_WEEK),
            2: _def_entry(5810.0, _YESTERDAY),
            3: _def_entry(5820.0, _TODAY_UTC),  # today is NOT past — keep
            4: _def_entry(5830.0, _TOMORROW),
        }

        router._prune_expired_definitions()

        assert set(router.option_definitions) == {3, 4}
        assert router.option_definitions[3]["strike"] == pytest.approx(5820.0)
        assert router.option_definitions[4]["strike"] == pytest.approx(5830.0)

    def test_empty_dict_is_noop(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        """Pruning an empty cache must not raise and leaves it empty."""
        router, _ = router_setup
        assert router.option_definitions == {}
        router._prune_expired_definitions()
        assert router.option_definitions == {}

    def test_all_future_kept(
        self, router_setup: tuple[OptionsRecordRouter, dict]
    ) -> None:
        router, _ = router_setup
        router.option_definitions = {
            1: _def_entry(5800.0, _TOMORROW),
            2: _def_entry(5810.0, _TODAY_UTC),
        }
        router._prune_expired_definitions()
        assert set(router.option_definitions) == {1, 2}

    def test_throttle_skips_prune_on_rapid_calls(
        self,
        router_setup: tuple[OptionsRecordRouter, dict],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Two rapid handle_definition calls must NOT both prune: the second
        is inside DEFINITION_PRUNE_INTERVAL_S of the first, so the stale entry
        seeded between them survives until the interval elapses.

        Time is controlled deterministically via a mutable fake clock patched
        onto options_router.time.time — no real wall-clock reads, so no
        flakiness.
        """
        import options_router

        clock = {"now": 1_000_000.0}
        monkeypatch.setattr(options_router.time, "time", lambda: clock["now"])

        # Trigger records carry a FUTURE expiry (30 days out) so the inserted
        # iids are never themselves pruned — keeps the test focused on the
        # seeded stale entry (iid 999) and the throttle gate.
        future_dt = datetime.now(timezone.utc) + timedelta(days=30)
        future_ns = int(future_dt.timestamp() * 1e9)

        def _future_def(iid: int) -> MagicMock:
            return _make_def_record(
                instrument_class="C", iid=iid, expiration_ns=future_ns
            )

        router, _ = router_setup
        # last_prune_ts starts at 0.0, so the FIRST call's throttle gate opens
        # (now - 0 >= interval) and a prune runs (on the empty cache).
        router.handle_definition(_future_def(1))
        assert router.last_prune_ts == pytest.approx(clock["now"])
        assert 1 in router.option_definitions

        # Seed an already-expired entry that a prune WOULD remove.
        router.option_definitions[999] = _def_entry(6000.0, _YESTERDAY)

        # Advance the clock by less than the interval, then fire another
        # definition. The throttle must short-circuit the prune, so the stale
        # entry is still present afterward.
        clock["now"] += DEFINITION_PRUNE_INTERVAL_S / 2.0
        router.handle_definition(_future_def(2))
        assert 999 in router.option_definitions, "throttle should skip prune"

        # Cross the interval boundary; the next definition prunes the stale id.
        clock["now"] += DEFINITION_PRUNE_INTERVAL_S
        router.handle_definition(_future_def(3))
        assert 999 not in router.option_definitions, "prune should run now"

    def test_handle_trade_drives_throttled_prune(
        self,
        router_setup: tuple[OptionsRecordRouter, dict],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """During quiet periods with only Trade traffic (no Definition
        messages), handle_trade must still drive the throttled prune so the
        past-expiry cleanup keeps running. A trade fired after the interval
        elapses prunes an expired entry.

        Time is controlled via a mutable fake clock so the throttle gate is
        deterministic (no real wall-clock reads).
        """
        import options_router

        clock = {"now": 2_000_000.0}
        monkeypatch.setattr(options_router.time, "time", lambda: clock["now"])

        router, _ = router_setup
        # Pin the prune throttle to "now" so the gate is initially closed —
        # isolates the assertion to the post-interval trade firing the prune.
        router.last_prune_ts = clock["now"]

        # Seed a definition for the traded iid (in the ATM window) so the trade
        # itself doesn't short-circuit on a missing definition, plus an
        # already-expired entry that a prune WOULD remove.
        router.option_definitions[99] = _def_entry(5025.0, _TOMORROW)
        router.option_definitions[999] = _def_entry(6000.0, _YESTERDAY)
        router.options_strikes.strikes = {5025.0}

        # A trade inside the throttle interval must NOT prune yet.
        clock["now"] += DEFINITION_PRUNE_INTERVAL_S / 2.0
        router.handle_trade(_make_trade_record(iid=99))
        assert 999 in router.option_definitions, "throttle should skip prune"

        # Cross the interval boundary; the next trade prunes the stale id even
        # though no Definition message arrived.
        clock["now"] += DEFINITION_PRUNE_INTERVAL_S
        router.handle_trade(_make_trade_record(iid=99))
        assert 999 not in router.option_definitions, "trade should drive prune"
