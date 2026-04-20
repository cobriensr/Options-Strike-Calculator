"""Minimal tests for sidecar/src/databento_client.py.

Scope per SIDE-010: cover the paths touched by the SIDE-005/006 and
SIDE-011/012 commits. Not a comprehensive test of the Databento
client — that remains open (the file is 800+ lines of multi-threaded
SDK integration that benefits from a real integration harness). What
this file covers:

- Shutdown barrier early-return in all 5 DB-borrowing handlers (SIDE-006)
- Definition-lag drop counter and 60s summary throttle (SIDE-012)
- Reconnect gap duration calculation + Sentry capture at threshold (SIDE-011)
- First-bar-after-reconnect price jump sanity check (SIDE-011)
- _last_close_before_disconnect is updated on each successful bar write

Mock strategy:
- conftest.py provides session-wide mocks for external packages
  (databento, psycopg2, sentry_sdk) that are not in the local venv.
- The real sidecar source modules (db, logger_setup, config,
  sentry_setup, symbol_manager) are imported normally and monkeypatched
  per-test. This keeps test files hermetic — no module-level
  `sys.modules["db"] = MagicMock()` clobbering that would break
  sibling test files.

Environment setup:
- `DATABASE_URL` env var is set here (before importing `db` or
  `config`) so pydantic-settings doesn't raise. The value is a
  throwaway — the real psycopg2 is mocked via conftest so no
  connection is ever attempted.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

# Required env vars for config.py's pydantic-settings validation.
# These must be set BEFORE importing any module that loads config.
# The DATABASE_URL is a throwaway test fixture: psycopg2 is mocked
# via conftest.py so no real connection is ever attempted. The
# embedded password is a test literal, not a real credential.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402

# Import the module and its dependencies as real modules. Any per-test
# patching happens inside the `client` fixture via monkeypatch.
import sentry_setup  # noqa: E402
from databento_client import DatabentoClient  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> DatabentoClient:
    """Return a DatabentoClient with all external deps mocked per-test.

    monkeypatch handles cleanup automatically, so there's no cross-test
    pollution of sentry_setup.capture_message / capture_exception or
    the db module's upsert functions.
    """
    # Patch the sentry_setup module's capture helpers so tests can
    # inspect what databento_client's lazy `from sentry_setup import
    # capture_message` resolves to.
    patched_capture_message = MagicMock()
    patched_capture_exception = MagicMock()
    monkeypatch.setattr(sentry_setup, "capture_message", patched_capture_message)
    monkeypatch.setattr(sentry_setup, "capture_exception", patched_capture_exception)

    # Patch the db module's upsert functions so no real SQL is issued
    # and tests can verify which write paths fired.
    import db

    patched_upsert_futures_bar = MagicMock()
    patched_upsert_options_daily = MagicMock()
    monkeypatch.setattr(db, "upsert_futures_bar", patched_upsert_futures_bar)
    monkeypatch.setattr(db, "upsert_options_daily", patched_upsert_options_daily)

    tp = MagicMock()
    c = DatabentoClient(trade_processor=tp)

    # Pre-populate _prefix_to_internal so _resolve_symbol doesn't
    # short-circuit on an empty mapping in tests that need a symbol.
    c._prefix_to_internal = {"ES": "ES", "NQ": "NQ"}
    # Fake a symbology_map on a fake _client so _resolve_symbol works.
    c._client = MagicMock()
    c._client.symbology_map = {1: "ESM6", 2: "NQM6"}

    # Expose the patched mocks for test inspection via attributes on
    # the client. These aren't "real" fields — they're test-only
    # probes that avoid needing the tests to import the db/sentry
    # modules themselves.
    c._test_capture_message = patched_capture_message  # type: ignore[attr-defined]
    c._test_capture_exception = patched_capture_exception  # type: ignore[attr-defined]
    c._test_upsert_futures_bar = patched_upsert_futures_bar  # type: ignore[attr-defined]
    c._test_upsert_options_daily = patched_upsert_options_daily  # type: ignore[attr-defined]
    return c


def _make_bar_record(iid: int = 1, close_raw: int = 5800_000_000_000) -> MagicMock:
    """Build a fake OHLCVMsg for _handle_ohlcv."""
    rec = MagicMock()
    rec.instrument_id = iid
    rec.open = close_raw
    rec.high = close_raw + 1_000_000_000
    rec.low = close_raw - 1_000_000_000
    rec.close = close_raw
    rec.volume = 100
    rec.ts_event = 1_780_000_000_000_000_000
    return rec


def _make_trade_record(iid: int = 99) -> MagicMock:
    """Build a fake TradeMsg for _handle_trade."""
    import databento

    rec = MagicMock()
    rec.instrument_id = iid
    rec.side = databento.Side.ASK
    rec.ts_event = 1_780_000_000_000_000_000
    rec.price = 50_250_000_000
    rec.size = 1
    return rec


# ---------------------------------------------------------------------------
# SIDE-006 — shutdown barrier early-return
# ---------------------------------------------------------------------------


class TestShutdownBarrier:
    def test_init_has_barrier_false(self, client: DatabentoClient) -> None:
        assert client._shutting_down is False

    def test_handle_ohlcv_early_returns_when_shutting_down(
        self, client: DatabentoClient
    ) -> None:
        client._shutting_down = True
        rec = _make_bar_record()
        # Patch the lazy-imported upsert_futures_bar at the point where
        # _handle_ohlcv will look it up. Using a plain `with patch`
        # because we need to intercept the import INSIDE the method,
        # not at module level.
        with patch("db.upsert_futures_bar") as upsert_mock:
            client._handle_ohlcv(rec)
            upsert_mock.assert_not_called()

    def test_handle_ohlcv_runs_when_not_shutting_down(
        self, client: DatabentoClient
    ) -> None:
        client._shutting_down = False
        rec = _make_bar_record()
        with patch("db.upsert_futures_bar") as upsert_mock:
            client._handle_ohlcv(rec)
            upsert_mock.assert_called_once()

    def test_handle_trade_early_returns_when_shutting_down(
        self, client: DatabentoClient
    ) -> None:
        client._shutting_down = True
        # Preload a definition so we'd normally dispatch to trade_processor
        client._option_definitions[99] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": None,
        }
        client._options_strikes = MagicMock()
        client._options_strikes.strikes = [5800.0]

        rec = _make_trade_record()
        client._handle_trade(rec)
        client._trade_processor.process_trade.assert_not_called()

    def test_handle_ohlcv_from_client_early_returns_when_shutting_down(
        self, client: DatabentoClient
    ) -> None:
        client._shutting_down = True
        fake_client = MagicMock()
        fake_client.symbology_map = {5: "DXH6"}
        rec = _make_bar_record(iid=5)
        with patch("db.upsert_futures_bar") as upsert_mock:
            client._handle_ohlcv_from_client(rec, fake_client)
            upsert_mock.assert_not_called()

    def test_handle_stat_early_returns_when_shutting_down(
        self, client: DatabentoClient
    ) -> None:
        client._shutting_down = True
        rec = MagicMock()
        rec.stat_type = 9  # STAT_TYPE_OPEN_INTEREST
        with patch("db.upsert_options_daily") as upsert_mock:
            client._handle_stat(rec)
            upsert_mock.assert_not_called()


# ---------------------------------------------------------------------------
# SIDE-012 — definition lag drop counter
# ---------------------------------------------------------------------------


class TestDefinitionLagDrops:
    def test_counter_starts_at_zero(self, client: DatabentoClient) -> None:
        assert client._definition_lag_drops == 0
        assert client._last_lag_summary_ts == pytest.approx(0.0)

    def test_trade_without_definition_is_dropped(self, client: DatabentoClient) -> None:
        """A trade with no matching definition must NOT reach the
        trade_processor. On the very first drop, the summary fires
        immediately (because _last_lag_summary_ts starts at 0) and
        resets the counter to 0 in the same call — so we assert on
        the downstream signal (trade not forwarded, Sentry called)
        rather than the transient counter value."""
        client._options_strikes = MagicMock()
        client._options_strikes.strikes = [5800.0]
        rec = _make_trade_record(iid=999)  # no definition for this iid
        client._handle_trade(rec)
        client._trade_processor.process_trade.assert_not_called()
        client._test_capture_message.assert_called_once()

    def test_trade_with_definition_does_not_increment_counter(
        self, client: DatabentoClient
    ) -> None:
        client._option_definitions[99] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": None,
        }
        client._options_strikes = MagicMock()
        client._options_strikes.strikes = [5800.0]
        rec = _make_trade_record()
        client._handle_trade(rec)
        assert client._definition_lag_drops == 0

    def test_rapid_drops_are_throttled(self, client: DatabentoClient) -> None:
        """Multiple drops within the 60s interval fire only one summary."""
        import time as real_time

        client._options_strikes = MagicMock()
        client._options_strikes.strikes = [5800.0]

        # First drop fires a summary
        client._handle_trade(_make_trade_record(iid=998))
        assert client._test_capture_message.call_count == 1
        # _last_lag_summary_ts was updated to "now"
        assert client._last_lag_summary_ts > 0

        # Fix the clock so the throttle stays active for subsequent drops
        client._last_lag_summary_ts = real_time.time()

        # Additional drops should NOT fire another summary
        for _ in range(5):
            client._handle_trade(_make_trade_record(iid=997))

        # Still only the one original summary
        assert client._test_capture_message.call_count == 1
        # Counter has accumulated the additional drops
        assert client._definition_lag_drops == 5


# ---------------------------------------------------------------------------
# SIDE-011 — reconnect gap observability
# ---------------------------------------------------------------------------


class TestReconnectGap:
    def test_small_gap_does_not_fire_sentry(self, client: DatabentoClient) -> None:
        """A gap under RECONNECT_GAP_WARNING_S is logged but not sent
        to Sentry."""
        last_ts = 1_000_000_000_000_000_000  # 1s in ns
        # 10s later (under the 60s threshold)
        new_ts = last_ts + 10 * 1_000_000_000
        client._on_reconnect(last_ts, new_ts)

        client._test_capture_message.assert_not_called()
        assert client._connected is True

    def test_large_gap_fires_sentry_warning(self, client: DatabentoClient) -> None:
        """A gap of 120s (> 60s threshold) fires a structured warning."""
        last_ts = 1_000_000_000_000_000_000
        new_ts = last_ts + 120 * 1_000_000_000
        client._on_reconnect(last_ts, new_ts)

        client._test_capture_message.assert_called_once()
        call = client._test_capture_message.call_args
        assert "120" in str(call.args[0]) or "120.0" in str(call.args[0])
        assert call.kwargs.get("level") == "warning"
        assert "gap_s" in call.kwargs.get("context", {})
        assert call.kwargs["context"]["gap_s"] == pytest.approx(120.0)

    def test_reconnect_arms_sanity_check_for_tracked_symbols(
        self, client: DatabentoClient
    ) -> None:
        """Symbols with a recorded last-close should be armed for the
        next-bar sanity check after reconnect."""
        client._last_close_before_disconnect = {"ES": 5800.0, "NQ": 20000.0}
        client._on_reconnect(0, 0)
        assert client._reconnect_sanity_check_pending == {"ES", "NQ"}

    def test_handle_ohlcv_updates_last_close(self, client: DatabentoClient) -> None:
        """Every successful bar write updates the per-symbol last-close
        so the sanity check always has fresh data."""
        rec = _make_bar_record(iid=1, close_raw=5800_000_000_000)
        client._handle_ohlcv(rec)
        assert "ES" in client._last_close_before_disconnect
        assert client._last_close_before_disconnect["ES"] == pytest.approx(5800.0)

    def test_last_close_updates_even_if_db_upsert_raises(
        self, client: DatabentoClient
    ) -> None:
        """Reviewer follow-up: a transient DB blip must NOT leave the
        baseline stale. The in-memory _last_close_before_disconnect
        invariant ("the most recent close we observed for this symbol")
        is decoupled from DB availability — otherwise a single failed
        upsert would silently degrade the next reconnect's sanity check.
        """
        # Make the lazy-imported upsert_futures_bar raise.
        rec = _make_bar_record(iid=1, close_raw=5825_000_000_000)
        with patch(
            "db.upsert_futures_bar",
            side_effect=RuntimeError("simulated DB blip"),
        ):
            client._handle_ohlcv(rec)

        # Even though the DB write failed, the in-memory baseline must
        # reflect the bar we just received.
        assert "ES" in client._last_close_before_disconnect
        assert client._last_close_before_disconnect["ES"] == pytest.approx(5825.0)


class TestFirstBarAfterReconnectSanity:
    def test_small_price_move_does_not_warn(self, client: DatabentoClient) -> None:
        """A <2% move across the gap passes the sanity check silently."""
        client._last_close_before_disconnect["ES"] = 5800.0
        client._reconnect_sanity_check_pending.add("ES")

        # New bar at 5810 (≈0.17% move)
        rec = _make_bar_record(iid=1, close_raw=5810_000_000_000)
        client._handle_ohlcv(rec)

        assert "ES" not in client._reconnect_sanity_check_pending
        client._test_capture_message.assert_not_called()

    def test_large_price_move_fires_warning(self, client: DatabentoClient) -> None:
        """A >2% move across the gap triggers a Sentry warning."""
        client._last_close_before_disconnect["ES"] = 5800.0
        client._reconnect_sanity_check_pending.add("ES")

        # New bar at 5950 (≈2.59% move — exceeds 2% threshold)
        rec = _make_bar_record(iid=1, close_raw=5950_000_000_000)
        client._handle_ohlcv(rec)

        client._test_capture_message.assert_called_once()
        call = client._test_capture_message.call_args
        assert "ES" in str(call.args[0])
        assert call.kwargs.get("level") == "warning"
        ctx = call.kwargs.get("context", {})
        assert ctx.get("symbol") == "ES"
        assert ctx.get("prev_close") == pytest.approx(5800.0)
        assert ctx.get("new_close") == pytest.approx(5950.0)
        assert ctx.get("pct_move") == pytest.approx(2.59, abs=0.01)

    def test_sanity_check_is_one_shot_per_reconnect(
        self, client: DatabentoClient
    ) -> None:
        """After the first bar post-reconnect, subsequent bars for the
        same symbol do NOT re-trigger the sanity check."""
        client._last_close_before_disconnect["ES"] = 5800.0
        client._reconnect_sanity_check_pending.add("ES")

        # First bar: 5% move, should warn
        rec1 = _make_bar_record(iid=1, close_raw=6090_000_000_000)
        client._handle_ohlcv(rec1)
        assert client._test_capture_message.call_count == 1
        assert "ES" not in client._reconnect_sanity_check_pending

        # Second bar: another 5% move, but the symbol isn't armed
        # anymore so no new warning fires
        rec2 = _make_bar_record(iid=1, close_raw=6390_000_000_000)
        client._handle_ohlcv(rec2)
        assert client._test_capture_message.call_count == 1

    def test_no_sanity_check_without_prev_close(self, client: DatabentoClient) -> None:
        """If the symbol is armed but has no previous close, no warning
        fires and no exception is raised."""
        client._reconnect_sanity_check_pending.add("ES")
        # _last_close_before_disconnect does NOT have "ES"

        rec = _make_bar_record(iid=1, close_raw=5800_000_000_000)
        client._handle_ohlcv(rec)

        assert "ES" not in client._reconnect_sanity_check_pending
        client._test_capture_message.assert_not_called()


# ---------------------------------------------------------------------------
# Phase 2a — TBBO dispatch
# ---------------------------------------------------------------------------
#
# Design note (verified against the installed databento_dbn SDK):
#   RType.from_schema(Schema.MBP_1).value == RType.from_schema(Schema.TBBO).value == 1
# and databento_dbn._lib.pyi aliases ``TBBOMsg = MBP1Msg`` — so rtype
# CANNOT distinguish MBP-1 from TBBO at the record level. The earlier
# implementation tried to branch on rtype 0 vs 1 and would silently drop
# every TBBO record in production. The fix: subscribe only to ``tbbo``,
# dispatch every MBP1Msg to ``process_tbbo`` uniformly.


def _make_tbbo_record(iid: int = 1) -> MagicMock:
    """Build a fake TBBO-shaped MBP1Msg record for _handle_tbbo."""
    rec = MagicMock()
    rec.instrument_id = iid
    rec.ts_event = 1_780_000_000_000_000_000
    # QuoteProcessor reads ``levels[0]`` for the pre-trade BBO and
    # ``price``/``size`` for the trade itself.
    level = MagicMock()
    level.bid_px = 4_999_500_000_000
    level.ask_px = 5_000_500_000_000
    level.bid_sz = 10
    level.ask_sz = 12
    rec.levels = (level,)
    rec.price = 5_000_500_000_000
    rec.size = 1
    type(rec).__name__ = "MBP1Msg"
    return rec


class TestHandleTbboRouting:
    def test_tbbo_record_routes_to_process_tbbo(self, client: DatabentoClient) -> None:
        """Every MBP1Msg reaching _handle_tbbo must dispatch to
        QuoteProcessor.process_tbbo — there is no rtype branching."""
        qp = MagicMock()
        client._quote_processor = qp
        rec = _make_tbbo_record(iid=1)
        client._handle_tbbo(rec)
        qp.process_tbbo.assert_called_once_with("ES", rec)

    def test_no_quote_processor_is_noop(self, client: DatabentoClient) -> None:
        """When quote_processor is None (legacy callers or tests), the
        handler must early-return without touching the record."""
        client._quote_processor = None
        client._handle_tbbo(_make_tbbo_record())  # must not raise

    def test_shutdown_barrier_skips_dispatch(self, client: DatabentoClient) -> None:
        qp = MagicMock()
        client._quote_processor = qp
        client._shutting_down = True
        client._handle_tbbo(_make_tbbo_record())
        qp.process_tbbo.assert_not_called()

    def test_nq_symbol_is_processed(self, client: DatabentoClient) -> None:
        """Phase 5a widens the pipeline: NQ records MUST flow through
        to QuoteProcessor.process_tbbo alongside ES. Flipped from
        Phase 2a's ES-only scope guard — NQ 1h OFI is the validated
        signal (Phase 4d: ρ=0.313, p_bonf<0.001, n=312)."""
        qp = MagicMock()
        client._quote_processor = qp
        rec = _make_tbbo_record(iid=2)  # iid=2 resolves to NQ in fixture
        client._handle_tbbo(rec)
        qp.process_tbbo.assert_called_once_with("NQ", rec)

    def test_unknown_symbol_is_dropped(self, client: DatabentoClient) -> None:
        """An instrument_id that doesn't resolve to ES or NQ is dropped
        defensively — we only process the two subscribed parent symbols."""
        qp = MagicMock()
        client._quote_processor = qp
        # iid=999 has no symbology_map entry → _resolve_symbol returns None.
        rec = _make_tbbo_record(iid=999)
        client._handle_tbbo(rec)
        qp.process_tbbo.assert_not_called()


class TestSubscribeL1:
    def test_issues_single_tbbo_subscription_for_es_and_nq(
        self, client: DatabentoClient
    ) -> None:
        """_subscribe_l1 must issue exactly ONE subscribe call, for
        ``tbbo`` on both ES.FUT and NQ.FUT. Subscribing to both
        ``mbp-1`` and ``tbbo`` would double-deliver every trade (TBBO
        is a subset of MBP-1 events filtered to action == 'T')."""
        client._client = MagicMock()

        client._subscribe_l1()

        assert client._client.subscribe.call_count == 1
        call_kwargs = client._client.subscribe.call_args.kwargs
        assert call_kwargs["schema"] == "tbbo"
        assert set(call_kwargs["symbols"]) == {"ES.FUT", "NQ.FUT"}
        assert call_kwargs["stype_in"] == "parent"

    def test_does_not_subscribe_to_mbp1(self, client: DatabentoClient) -> None:
        """Regression guard: future edits must NOT re-introduce an
        mbp-1 subscription — see the TestHandleTbboRouting design note.
        Phase 5a preserves the Phase 2a anti-regression unchanged."""
        client._client = MagicMock()
        client._subscribe_l1()

        schemas_subscribed = [
            call.kwargs.get("schema")
            for call in client._client.subscribe.call_args_list
        ]
        assert "mbp-1" not in schemas_subscribed

    def test_noop_without_client(self, client: DatabentoClient) -> None:
        """If the Databento Live client hasn't been created yet, the
        method must be a safe no-op rather than raising."""
        client._client = None
        client._subscribe_l1()  # must not raise


# ---------------------------------------------------------------------------
# SIDE-013 — options pipeline diagnostics log
# ---------------------------------------------------------------------------


def _make_system_record(msg: str, is_error: bool = False) -> MagicMock:
    """Build a fake SystemMsg / ErrorMsg for _handle_system."""
    rec = MagicMock()
    rec.msg = msg
    rec.is_error = is_error
    return rec


class TestOptionsPipelineDiagnostics:
    """SIDE-013: periodic health snapshot of the options pipeline.

    When definitions_cached stays at 0 while trades flow, Definition
    routing or the instrument_class filter is broken upstream — this
    log turns that silent failure into a visible one at ~60s cadence.
    """

    def test_diagnostic_log_fires_on_ohlcv_end_of_interval(
        self, client: DatabentoClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """An OHLCV-1m end-of-interval system message must emit the
        diagnostic line with current definitions_cached + ATM_strikes."""
        client._option_definitions[123] = {
            "strike": 5800.0,
            "option_type": "C",
            "expiry": None,
        }
        client._option_definitions[456] = {
            "strike": 5805.0,
            "option_type": "P",
            "expiry": None,
        }
        client._options_strikes = MagicMock()
        client._options_strikes.strikes = [5800.0, 5805.0, 5810.0]
        client._options_strikes.center_price = 5800.0

        with caplog.at_level("INFO"):
            client._handle_system(
                _make_system_record("End of interval for ohlcv-1m")
            )

        diagnostic_lines = [
            r.message for r in caplog.records if "Options pipeline:" in r.message
        ]
        assert len(diagnostic_lines) == 1
        assert "definitions_cached=2" in diagnostic_lines[0]
        assert "ATM_strikes=3" in diagnostic_lines[0]

    def test_diagnostic_does_not_fire_on_other_system_messages(
        self, client: DatabentoClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Only OHLCV-1m end-of-interval triggers the diagnostic — other
        system messages (subscription succeeded, tbbo end-of-interval,
        reconnects) must not emit it, to keep cadence at ~60s."""
        client._options_strikes = MagicMock()
        client._options_strikes.strikes = []
        client._options_strikes.center_price = 0.0

        with caplog.at_level("INFO"):
            client._handle_system(
                _make_system_record("End of interval for tbbo")
            )
            client._handle_system(
                _make_system_record("Subscription request 0 for tbbo succeeded")
            )

        diagnostic_lines = [
            r.message for r in caplog.records if "Options pipeline:" in r.message
        ]
        assert diagnostic_lines == []

    def test_diagnostic_reports_zero_when_cache_empty(
        self, client: DatabentoClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The whole point of this log: surface definitions_cached=0
        so a broken Definition pipeline becomes visible instead of
        silently dropping every trade."""
        client._options_strikes = MagicMock()
        client._options_strikes.strikes = [5800.0]
        client._options_strikes.center_price = 5800.0

        with caplog.at_level("INFO"):
            client._handle_system(
                _make_system_record("End of interval for ohlcv-1m")
            )

        diagnostic_lines = [
            r.message for r in caplog.records if "Options pipeline:" in r.message
        ]
        assert len(diagnostic_lines) == 1
        assert "definitions_cached=0" in diagnostic_lines[0]
