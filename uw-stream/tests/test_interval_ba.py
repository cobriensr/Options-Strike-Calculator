"""Unit tests for SPXWIntervalBAHandler.

These tests exercise the rolling-bucket state and alert-emission logic
without booting the websocket or asyncpg pool. DB writes are mocked at
the ``db`` module boundary so we only verify the handler's behaviour at
its inputs (raw WS payloads) and outputs (queued alert tuples + flush
side-effects).
"""

from __future__ import annotations

import copy
import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import pytest

from handlers.interval_ba import (
    _ALERT_COLUMNS,
    IntervalBAHandler,
    QQQIntervalBAHandler,
    SPXWIntervalBAHandler,
    SPYIntervalBAHandler,
    _ct_date_from_utc,
    _has_tag,
)

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "interval_ba_sample.json"


# Registry is module-level, so fires from one test leak into the next.
# Reset before every test to keep cross-test confluence detection from
# tagging an alert with a partner that came from an earlier case.
@pytest.fixture(autouse=True)
def _reset_recent_fires():
    from handlers import recent_fires

    recent_fires._reset_for_tests()
    yield
    recent_fires._reset_for_tests()

# Bucket containing 17:06 UTC (2026-05-12 12:05-12:10 CT). All "same
# bucket" timestamps below derive from this anchor so the alignment is
# obvious in failure messages.
_BUCKET_ANCHOR_MS = 1778605500_000  # 2026-05-12T17:05:00Z
_BUCKET_SECONDS = 300

# Index into the alert tuple, mirrors _ALERT_COLUMNS — exposed locally
# so individual asserts read naturally.
_AI: dict[str, int] = {name: i for i, name in enumerate(_ALERT_COLUMNS)}


# ----------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------


@pytest.fixture
def base_payload() -> dict:
    with open(_FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def handler() -> SPXWIntervalBAHandler:
    return SPXWIntervalBAHandler()


def _payload(
    base: dict,
    *,
    chain: str | None = None,
    executed_at_ms: int | None = None,
    price: str | None = None,
    size: int | None = None,
    tags: list[str] | None = None,
    underlying_symbol: str | None = None,
) -> dict:
    """Build a mutated copy of the base SPXW payload.

    Each call gets a fresh UUID so ``ws_trade_id`` uniqueness holds when
    multiple payloads flow through the same handler.
    """
    p = copy.deepcopy(base)
    p["id"] = str(uuid4())
    if chain is not None:
        p["option_chain"] = chain
    if executed_at_ms is not None:
        p["executed_at"] = executed_at_ms
    if price is not None:
        p["price"] = price
    if size is not None:
        p["size"] = size
    if tags is not None:
        p["tags"] = tags
    if underlying_symbol is not None:
        p["underlying_symbol"] = underlying_symbol
    return p


# ----------------------------------------------------------------------
# Threshold / floor logic
# ----------------------------------------------------------------------


class TestAlertEmission:
    def test_alert_fires_immediately_when_first_ask_trade_clears_both_gates(
        self, handler, base_payload,
    ):
        """Today's event: the $408K ASK print on SPXW 7360c fires on its own.

        Single trade is already 100% ask-side and well over $250K, so the
        ratio threshold and premium floor are both satisfied by trade #1.
        Dedupe then blocks the $366K follow-up in the same bucket.
        """
        p1 = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 83_000,  # 12:06:23
            price="4.60",
            size=888,  # → $408,480 premium
        )
        p2 = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 83_000,
            price="4.60",
            size=796,  # → $366,160 premium
        )
        handler._transform(p1)
        assert len(handler._pending_alerts) == 1
        handler._transform(p2)
        # Same bucket → dedupe.
        assert len(handler._pending_alerts) == 1

        alert = handler._pending_alerts[0]
        assert alert[_AI["option_chain"]] == "SPXW260512C07360000"
        assert alert[_AI["ticker"]] == "SPXW"
        assert alert[_AI["option_type"]] == "C"
        assert alert[_AI["ratio_pct"]] == Decimal("100.00")
        # Alert reflects bucket state AT FIRE TIME (only trade 1).
        assert alert[_AI["total_premium"]] == Decimal("408480.00")
        assert alert[_AI["ask_premium"]] == Decimal("408480.00")
        assert alert[_AI["trade_count"]] == 1
        assert alert[_AI["top_trade_premium"]] == Decimal("408480.00")
        assert alert[_AI["top_trade_size"]] == 888
        assert alert[_AI["top_trade_is_sweep"]] is True
        bucket_start = alert[_AI["bucket_start"]]
        assert isinstance(bucket_start, datetime)
        assert int(bucket_start.timestamp()) == _BUCKET_ANCHOR_MS // 1000

    def test_alert_fires_when_accumulated_ask_crosses_floor(
        self, handler, base_payload,
    ):
        """Two sub-floor ASK prints together cross the floor → fires on #2."""
        # $130K alone is below $250K floor → no alert.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="1.30",
                size=1000,  # $130K
            ),
        )
        assert handler._pending_alerts == []

        # +$130K → $260K total ASK, 100% ratio → fires.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
                price="1.30",
                size=1000,
            ),
        )
        assert len(handler._pending_alerts) == 1
        alert = handler._pending_alerts[0]
        assert alert[_AI["total_premium"]] == Decimal("260000.00")
        assert alert[_AI["trade_count"]] == 2

    def test_no_alert_below_premium_floor(self, handler, base_payload):
        """SPXW 7370c $102K ask is below the $250K default floor."""
        p = _payload(
            base_payload,
            chain="SPXW260512C07370000",
            executed_at_ms=_BUCKET_ANCHOR_MS + 78_000,
            price="2.07",
            size=494,  # → ~$102,258 premium
        )
        handler._transform(p)
        assert handler._pending_alerts == []

    def test_no_alert_below_ratio_threshold(self, handler, base_payload):
        """43% ask-side ratio stays under the configured threshold.

        Mid prints land first so the single ASK print never has a
        bucket where it alone satisfies the ratio + floor (which would
        otherwise short-circuit-fire before the dilution arrives).
        """
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 10_000,
                price="2.00",
                size=1000,  # $200K mid
                tags=["mid_side", "neutral"],
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 20_000,
                price="2.00",
                size=1000,  # +$200K mid
                tags=["mid_side", "neutral"],
            ),
        )
        # $300K ASK on top of $400K mid → total $700K, ratio 43% < 75%.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 30_000,
                price="3.00",
                size=1000,
                tags=["ask_side", "bullish"],
            ),
        )
        assert handler._pending_alerts == []

    def test_mid_only_bucket_no_alert(self, handler, base_payload):
        """Pure mid-fill flow — the SPXW baseline — never fires."""
        for offset in (10_000, 20_000, 30_000, 40_000):
            handler._transform(
                _payload(
                    base_payload,
                    executed_at_ms=_BUCKET_ANCHOR_MS + offset,
                    price="3.00",
                    size=1000,  # $300K each → $1.2M mid total
                    tags=["mid_side", "neutral"],
                ),
            )
        assert handler._pending_alerts == []


# ----------------------------------------------------------------------
# Multi-leg gate
# ----------------------------------------------------------------------


class TestMultiLegGate:
    """Reject buckets dominated by spread-leg routing (trade_code in
    mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct). The 2026-05-13 SPXW 6850
    false fire was a single $1.14M ``mlet`` print → 100% ask, 100%
    multi-leg; the gate at multi_leg_share ≥ 0.5 rejects exactly that.
    """

    def test_no_alert_when_single_multi_leg_print_dominates_bucket(
        self, handler, base_payload,
    ):
        """The 2026-05-13 SPXW 6850 false fire: 1 print, 100% ask, mlet."""
        p = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 38_000,
            price="569.11",
            size=20,  # → $1,138,220 premium (matches prod incident)
        )
        p["trade_code"] = "mlet"
        handler._transform(p)
        assert handler._pending_alerts == []

    @pytest.mark.parametrize(
        "code",
        ["mlat", "mlet", "mlft", "mfto", "masl", "mesl", "mfsl", "mlct"],
    )
    def test_all_opra_multi_leg_codes_are_rejected(
        self, handler, base_payload, code,
    ):
        """All 8 OPRA multi-leg sale conditions gate the alert."""
        p = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 50_000,
            price="4.60",
            size=888,  # $408K — would otherwise fire on the ratio/floor
        )
        p["trade_code"] = code
        handler._transform(p)
        assert handler._pending_alerts == []

    def test_trade_code_match_is_case_insensitive(self, handler, base_payload):
        """UW occasionally upper-cases the trade_code; the gate is robust."""
        p = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
            price="4.60",
            size=888,
        )
        p["trade_code"] = "MLET"
        handler._transform(p)
        assert handler._pending_alerts == []

    def test_alert_fires_when_multi_leg_share_below_threshold(
        self, handler, base_payload,
    ):
        """≥50% single-leg → alert still fires (multi-leg < 50% share)."""
        # Single-leg ask: $408K
        single = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 65_000,
            price="4.60",
            size=888,
        )
        # Multi-leg ask: $138K (24% share of $546K total)
        multi = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 70_000,
            price="4.60",
            size=300,
        )
        multi["trade_code"] = "mlat"
        handler._transform(single)
        # First print already fires on its own (100% ask, $408K > floor) —
        # the multi-leg follow-up just confirms dedupe doesn't reverse it.
        assert len(handler._pending_alerts) == 1
        handler._transform(multi)
        assert len(handler._pending_alerts) == 1

    def test_alert_fires_with_no_trade_code_in_payload(
        self, handler, base_payload,
    ):
        """Payload missing trade_code → tick is treated as single-leg."""
        # Build a payload WITHOUT the field; fixture doesn't include it
        # by default so this is the default case.
        p = _payload(
            base_payload,
            executed_at_ms=_BUCKET_ANCHOR_MS + 75_000,
            price="4.60",
            size=888,
        )
        assert "trade_code" not in p
        handler._transform(p)
        assert len(handler._pending_alerts) == 1


# ----------------------------------------------------------------------
# Dedupe + bucket rollover
# ----------------------------------------------------------------------


class TestDedupe:
    def test_one_alert_per_bucket_for_same_contract(self, handler, base_payload):
        """After firing, additional ASK trades in the same bucket do not re-fire."""
        # First two trades cross the threshold.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
                price="4.60",
                size=888,
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 83_000,
                price="4.60",
                size=796,
            ),
        )
        assert len(handler._pending_alerts) == 1

        # Another ASK trade in the same bucket — must not enqueue a second.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 120_000,
                price="4.60",
                size=500,
            ),
        )
        assert len(handler._pending_alerts) == 1

    def test_new_bucket_resets_state_and_can_fire_again(self, handler, base_payload):
        """Fire bucket A, then 5 minutes later, bucket B can fire independently."""
        # Bucket A: fire.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 90_000,
                price="4.60",
                size=796,
            ),
        )
        assert len(handler._pending_alerts) == 1

        # Bucket B: 5 min + 30s later (next bucket). Two more ASK prints
        # totaling >$250K → second alert.
        bucket_b_anchor = _BUCKET_ANCHOR_MS + (_BUCKET_SECONDS * 1000)
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=bucket_b_anchor + 30_000,
                price="4.00",
                size=600,  # $240K
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=bucket_b_anchor + 40_000,
                price="4.00",
                size=200,  # +$80K → $320K total
            ),
        )
        assert len(handler._pending_alerts) == 2
        # Second alert is in the later bucket.
        first_start = handler._pending_alerts[0][_AI["bucket_start"]]
        second_start = handler._pending_alerts[1][_AI["bucket_start"]]
        assert second_start > first_start
        assert (second_start - first_start).total_seconds() == _BUCKET_SECONDS


# ----------------------------------------------------------------------
# Filtering: non-0DTE, non-SPXW, put side
# ----------------------------------------------------------------------


class TestFilters:
    def test_non_zero_dte_filtered_out(self, handler, base_payload):
        """Contract with tomorrow's expiry must not fire even on big ask flow."""
        # Same executed_at, but expiry is one day later.
        p = _payload(
            base_payload,
            chain="SPXW260513C07360000",  # next-day expiry
            executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
            price="5.00",
            size=2000,  # $1M+ premium
        )
        handler._transform(p)
        assert handler._pending_alerts == []

    def test_non_spxw_ticker_filtered_out(self, handler, base_payload):
        """Defensive: an AAPL print routed to this handler must be ignored."""
        p = _payload(
            base_payload,
            underlying_symbol="AAPL",
            chain="AAPL260512C00200000",
            executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
            price="5.00",
            size=2000,
        )
        handler._transform(p)
        assert handler._pending_alerts == []

    def test_put_side_supported(self, handler, base_payload):
        """SPXW put contracts fire the same as calls."""
        # Two big ASK prints on the SPXW 7350 put.
        for size, ms_offset in ((900, 60_000), (700, 90_000)):
            handler._transform(
                _payload(
                    base_payload,
                    chain="SPXW260512P07350000",
                    executed_at_ms=_BUCKET_ANCHOR_MS + ms_offset,
                    price="4.50",
                    size=size,
                ),
            )
        assert len(handler._pending_alerts) == 1
        alert = handler._pending_alerts[0]
        assert alert[_AI["option_type"]] == "P"
        assert alert[_AI["option_chain"]] == "SPXW260512P07350000"


# ----------------------------------------------------------------------
# Alert payload shape — verifies the row matches _ALERT_COLUMNS exactly
# so the Phase 2 migration insert lines up.
# ----------------------------------------------------------------------


class TestAlertRowShape:
    def test_alert_tuple_arity_matches_columns(self, handler, base_payload):
        # Force one alert.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 70_000,
                price="4.60",
                size=796,
            ),
        )
        assert len(handler._pending_alerts) == 1
        assert len(handler._pending_alerts[0]) == len(_ALERT_COLUMNS)

    def test_top_trade_carries_sweep_and_floor_flags(self, handler, base_payload):
        """Floor flag on the largest ASK print must surface in the alert."""
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
                tags=["ask_side", "bullish", "sweep", "floor"],
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 70_000,
                price="4.60",
                size=796,
                tags=["ask_side", "bullish"],
            ),
        )
        assert len(handler._pending_alerts) == 1
        alert = handler._pending_alerts[0]
        assert alert[_AI["top_trade_is_sweep"]] is True
        assert alert[_AI["top_trade_is_floor"]] is True

    def test_underlying_price_carried_from_tick(self, handler, base_payload):
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 70_000,
                price="4.60",
                size=796,
            ),
        )
        assert handler._pending_alerts[0][_AI["underlying_price"]] == Decimal(
            "7355.00",
        )


# ----------------------------------------------------------------------
# Flush — pending alerts drain via db.bulk_insert_ignore_conflict and
# the buffer clears even on success.
# ----------------------------------------------------------------------


class TestFlush:
    @pytest.mark.asyncio
    async def test_flush_writes_alerts_and_clears_buffer(
        self, handler, base_payload, monkeypatch,
    ):
        """_flush must call bulk_insert_ignore_conflict for alerts.

        Sets ``_enabled=True`` to bypass the Phase 1 feature flag — that
        gating is exercised separately by test_feature_flag_disabled.
        """
        handler._enabled = True
        # Stage one alert in the buffer.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 70_000,
                price="4.60",
                size=796,
            ),
        )
        assert len(handler._pending_alerts) == 1

        # Mock both bulk_insert paths — the raw-tick write inherited
        # from OptionTradesHandler AND the alert write the subclass adds.
        calls: list[dict] = []

        async def fake_bulk_insert(*, table, columns, rows, conflict_cols):
            calls.append(
                {
                    "table": table,
                    "columns": columns,
                    "rows": list(rows),
                    "conflict_cols": conflict_cols,
                },
            )
            return len(rows)

        monkeypatch.setattr(
            "handlers.option_trades.db.bulk_insert_ignore_conflict",
            fake_bulk_insert,
        )
        monkeypatch.setattr(
            "handlers.interval_ba.db.bulk_insert_ignore_conflict",
            fake_bulk_insert,
        )

        # Empty raw-tick batch is fine — we only care that the alert
        # write happens unconditionally when there are pending alerts.
        await handler._flush([])

        # Buffer must be cleared post-flush so the next bucket's alerts
        # don't write the previous batch twice.
        assert handler._pending_alerts == []

        # Exactly one call to the alert table — raw ticks were [] so
        # bulk_insert_ignore_conflict returns 0 immediately for that path.
        alert_calls = [c for c in calls if c["table"] == "interval_ba_alerts"]
        assert len(alert_calls) == 1
        assert alert_calls[0]["conflict_cols"] == [
            "option_chain",
            "bucket_start",
        ]
        assert len(alert_calls[0]["rows"]) == 1

    @pytest.mark.asyncio
    async def test_feature_flag_disabled_skips_alert_db_write(
        self, handler, base_payload, monkeypatch,
    ):
        """With _enabled=False (default for Phase 1), no alert DB write."""
        assert handler._enabled is False
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        assert len(handler._pending_alerts) == 1

        alert_calls: list[dict] = []

        async def fake_bulk_insert(*, table, columns, rows, conflict_cols):
            alert_calls.append({"table": table, "rows": list(rows)})
            return len(rows)

        monkeypatch.setattr(
            "handlers.option_trades.db.bulk_insert_ignore_conflict",
            fake_bulk_insert,
        )
        monkeypatch.setattr(
            "handlers.interval_ba.db.bulk_insert_ignore_conflict",
            fake_bulk_insert,
        )

        await handler._flush([])

        # Buffer still cleared.
        assert handler._pending_alerts == []
        # But no call to interval_ba_alerts.
        assert [c for c in alert_calls if c["table"] == "interval_ba_alerts"] == []

    @pytest.mark.asyncio
    async def test_flush_clears_buffer_when_alert_insert_fails(
        self, handler, base_payload, monkeypatch,
    ):
        """Alert-only failure: raw ticks succeed, alert insert raises.

        _pending_alerts must still be cleared (the dedupe set already
        marks the bucket so the alert won't reattempt) and the raise
        must propagate so the base class's _safe_flush captures it.
        """
        handler._enabled = True
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        chain = "SPXW260512C07360000"
        bucket_epoch = _BUCKET_ANCHOR_MS // 1000
        assert (chain, bucket_epoch) in handler._fired

        async def raw_ok(*, table, columns, rows, conflict_cols):
            return len(rows)

        async def alert_boom(*, table, columns, rows, conflict_cols):
            raise RuntimeError("simulated alert insert failure")

        monkeypatch.setattr(
            "handlers.option_trades.db.bulk_insert_ignore_conflict",
            raw_ok,
        )
        monkeypatch.setattr(
            "handlers.interval_ba.db.bulk_insert_ignore_conflict",
            alert_boom,
        )

        with pytest.raises(RuntimeError, match="simulated alert insert"):
            await handler._flush([])

        assert handler._pending_alerts == []
        # _fired retains the bucket so a follow-up tick in the same
        # bucket cannot re-emit the dropped alert.
        assert (chain, bucket_epoch) in handler._fired

    @pytest.mark.asyncio
    async def test_flush_clears_buffer_when_raw_tick_insert_fails(
        self, handler, base_payload, monkeypatch,
    ):
        """Raw-tick failure with alerts pending: alerts cleared anyway.

        Up-front clear guarantees the buffer stays bounded even when
        the inherited raw-tick path raises — the alerts in this batch
        are dropped (logged via _observe; the dedupe set keeps
        retry-fires suppressed).
        """
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        assert len(handler._pending_alerts) == 1

        async def boom(**_kwargs):
            raise RuntimeError("simulated raw-tick failure")

        monkeypatch.setattr(
            "handlers.option_trades.db.bulk_insert_ignore_conflict",
            boom,
        )

        with pytest.raises(RuntimeError, match="simulated raw-tick"):
            await handler._flush([("dummy",)])
        assert handler._pending_alerts == []


# ----------------------------------------------------------------------
# Phase 4 push gate — settings.interval_ba_push_confluence_only flips
# whether solo fires reach schedule_notify. DB write is unaffected.
# ----------------------------------------------------------------------


class TestPushConfluenceOnlyGate:
    @pytest.mark.asyncio
    async def test_solo_alert_skips_notify_when_confluence_only_on(
        self, handler, base_payload, monkeypatch,
    ):
        """With confluence_only=True (default), a solo fire writes to
        the DB but doesn't reach schedule_notify."""
        from config import settings

        handler._enabled = True
        monkeypatch.setattr(settings, "interval_ba_push_confluence_only", True)
        # Stage one alert. No partners → confluence_tickers stays [].
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        assert len(handler._pending_alerts) == 1

        # No-op DB write so the flush completes cleanly.
        async def noop_bulk_insert(**_kwargs):
            return 1

        monkeypatch.setattr(
            "handlers.option_trades.db.bulk_insert_ignore_conflict",
            noop_bulk_insert,
        )
        monkeypatch.setattr(
            "handlers.interval_ba.db.bulk_insert_ignore_conflict",
            noop_bulk_insert,
        )

        notify_calls: list[dict] = []
        monkeypatch.setattr(
            "handlers.interval_ba.schedule_notify",
            lambda p: notify_calls.append(p),
        )

        await handler._flush([])
        assert notify_calls == []

    @pytest.mark.asyncio
    async def test_partnered_alert_pushes_when_confluence_only_on(
        self, handler, base_payload, monkeypatch,
    ):
        """A SPXW fire that follows a SPY same-direction fire within
        the confluence window DOES reach schedule_notify."""
        from config import settings

        monkeypatch.setattr(settings, "interval_ba_push_confluence_only", True)

        # Step 1: SPY fires first to seed the recent_fires registry.
        # This goes through the normal _observe but bypasses the SPY
        # handler's own enable gate (we're using the SPXW handler's
        # registry visibility — same module-level state).
        spy_handler = SPYIntervalBAHandler()
        spy_handler._enabled = True
        spy_handler._transform(
            _payload(
                base_payload,
                underlying_symbol="SPY",
                chain="SPY260512C00580000",
                executed_at_ms=_BUCKET_ANCHOR_MS + 50_000,
                price="2.50",
                size=1200,
                tags=["ask_side", "bullish", "sweep"],
            ),
        )
        assert len(spy_handler._pending_alerts) == 1

        # Step 2: SPXW fires (the test's `handler` fixture is SPXW).
        # Should see SPY in its confluence_tickers.
        handler._enabled = True
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        assert len(handler._pending_alerts) == 1
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        assert handler._pending_alerts[0][idx["confluence_tickers"]] == ["SPY"]

        async def noop_bulk_insert(**_kwargs):
            return 1

        monkeypatch.setattr(
            "handlers.option_trades.db.bulk_insert_ignore_conflict",
            noop_bulk_insert,
        )
        monkeypatch.setattr(
            "handlers.interval_ba.db.bulk_insert_ignore_conflict",
            noop_bulk_insert,
        )

        notify_calls: list[dict] = []
        monkeypatch.setattr(
            "handlers.interval_ba.schedule_notify",
            lambda p: notify_calls.append(p),
        )

        await handler._flush([])
        assert len(notify_calls) == 1
        assert "+SPY" in notify_calls[0]["title"]

    @pytest.mark.asyncio
    async def test_solo_alert_pushes_when_confluence_only_off(
        self, handler, base_payload, monkeypatch,
    ):
        """Backward-compat path: confluence_only=False restores
        pre-Phase-4 behavior — every alert fires a push."""
        from config import settings

        handler._enabled = True
        monkeypatch.setattr(
            settings, "interval_ba_push_confluence_only", False,
        )
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        assert len(handler._pending_alerts) == 1

        async def noop_bulk_insert(**_kwargs):
            return 1

        monkeypatch.setattr(
            "handlers.option_trades.db.bulk_insert_ignore_conflict",
            noop_bulk_insert,
        )
        monkeypatch.setattr(
            "handlers.interval_ba.db.bulk_insert_ignore_conflict",
            noop_bulk_insert,
        )

        notify_calls: list[dict] = []
        monkeypatch.setattr(
            "handlers.interval_ba.schedule_notify",
            lambda p: notify_calls.append(p),
        )

        await handler._flush([])
        assert len(notify_calls) == 1
        assert "+" not in notify_calls[0]["title"]


# ----------------------------------------------------------------------
# Helpers — _ct_date_from_utc, _has_tag
# ----------------------------------------------------------------------


class TestHelpers:
    def test_ct_date_evening_utc_maps_to_same_ct_date(self):
        # 2026-05-12 22:30 UTC = 17:30 CDT → 2026-05-12
        ts = datetime(2026, 5, 12, 22, 30, tzinfo=UTC)
        assert _ct_date_from_utc(ts) == date(2026, 5, 12)

    def test_ct_date_handles_dst(self):
        # 2026-01-15 06:00 UTC = 00:00 CST → 2026-01-15
        ts = datetime(2026, 1, 15, 6, 0, tzinfo=UTC)
        assert _ct_date_from_utc(ts) == date(2026, 1, 15)

    def test_ct_date_overnight_utc_rolls_back_to_prior_ct_date(self):
        # 2026-05-13 02:00 UTC = 21:00 CDT prev day → 2026-05-12
        ts = datetime(2026, 5, 13, 2, 0, tzinfo=UTC)
        assert _ct_date_from_utc(ts) == date(2026, 5, 12)

    @pytest.mark.parametrize(
        "tags,name,expected",
        [
            (["ask_side", "sweep"], "sweep", True),
            (["ask_side"], "sweep", False),
            ([], "sweep", False),
            (None, "sweep", False),
            ("not_a_list", "sweep", False),
            (["floor", "ask_side"], "floor", True),
        ],
    )
    def test_has_tag(self, tags, name, expected):
        assert _has_tag(tags, name) is expected


# ----------------------------------------------------------------------
# Bucket-floor sanity — make sure the wall-clock alignment matches the
# UW Periscope 5-min UI bucket boundaries (00, 05, 10, 15 past the hour).
# ----------------------------------------------------------------------


class TestBucketFloor:
    @pytest.mark.parametrize(
        "ms,expected_minute",
        [
            (_BUCKET_ANCHOR_MS, 5),            # exactly on boundary
            (_BUCKET_ANCHOR_MS + 1_000, 5),    # +1s
            (_BUCKET_ANCHOR_MS + 299_000, 5),  # bucket end - 1s
            (_BUCKET_ANCHOR_MS + 300_000, 10), # next bucket start
        ],
    )
    def test_bucket_epoch_aligns_to_5min_boundary(
        self, handler, ms, expected_minute,
    ):
        ts = datetime.fromtimestamp(ms / 1000.0, tz=UTC)
        bucket_epoch = handler._bucket_epoch(ts)
        bucket_dt = datetime.fromtimestamp(bucket_epoch, tz=UTC)
        # The boundary minute (in UTC, since 5min divides evenly into
        # the hour) must match — 17:05 → 5, 17:10 → 10, etc.
        assert bucket_dt.minute == expected_minute
        assert bucket_dt.second == 0
        # And the bucket starts at or before the tick.
        assert bucket_epoch * 1000 <= ms

    def test_bucket_size_matches_window_seconds(self, handler):
        anchor = datetime(2026, 5, 12, 17, 5, 0, tzinfo=UTC)
        next_bucket = anchor + timedelta(seconds=_BUCKET_SECONDS)
        assert (
            handler._bucket_epoch(next_bucket)
            - handler._bucket_epoch(anchor)
            == _BUCKET_SECONDS
        )


# ----------------------------------------------------------------------
# Channel routing — make sure option_trades:SPXW resolves to the new
# subclass while every other option_trades:<TICKER> stays on the base.
# ----------------------------------------------------------------------


class TestChannelRouting:
    def test_spy_routes_to_interval_ba_handler(self):
        from channel_registry import handler_class_for_channel
        from handlers.option_trades import OptionTradesHandler

        cls = handler_class_for_channel("option_trades:SPY")
        assert cls is SPYIntervalBAHandler
        assert issubclass(cls, OptionTradesHandler)

    def test_spxw_routes_to_interval_ba_handler(self):
        from channel_registry import handler_class_for_channel
        from handlers.option_trades import OptionTradesHandler

        cls = handler_class_for_channel("option_trades:SPXW")
        assert cls is SPXWIntervalBAHandler
        # Sanity: still a subclass of the base, so the inheritance
        # chain that supplies raw-tick writes is intact.
        assert issubclass(cls, OptionTradesHandler)

    def test_qqq_routes_to_interval_ba_handler(self):
        from channel_registry import handler_class_for_channel
        from handlers.option_trades import OptionTradesHandler

        cls = handler_class_for_channel("option_trades:QQQ")
        assert cls is QQQIntervalBAHandler
        assert issubclass(cls, OptionTradesHandler)

    def test_other_option_trades_tickers_still_use_base(self):
        """Single-name tickers (not the SPY/SPXW/QQQ trio) route to the
        base OptionTradesHandler — raw-tick capture only, no alerting."""
        from channel_registry import handler_class_for_channel
        from handlers.option_trades import OptionTradesHandler

        for ticker in ("TSLA", "AAPL", "NVDA", "IWM"):
            cls = handler_class_for_channel(f"option_trades:{ticker}")
            assert cls is OptionTradesHandler, (
                f"option_trades:{ticker} should map to OptionTradesHandler, "
                f"got {cls.__name__}"
            )

    def test_all_three_interval_ba_channel_tokens_are_known(self):
        """Each of the three is registered exact, so
        Settings._validate_channels_known accepts the bare tokens
        without exercising the prefix path."""
        from channel_registry import is_known_channel_token

        for tok in (
            "option_trades:SPY",
            "option_trades:SPXW",
            "option_trades:QQQ",
        ):
            assert is_known_channel_token(tok), tok


# ----------------------------------------------------------------------
# Out-of-order tick handling — UW WS can replay up to ~1 window of
# late ticks on reconnect. A stale tick must not wipe a fresh bucket.
# ----------------------------------------------------------------------


class TestOutOfOrderTicks:
    def test_late_tick_from_prior_bucket_does_not_wipe_current(
        self, handler, base_payload,
    ):
        # Bucket A: one big ASK that crosses the threshold → fires.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        assert len(handler._pending_alerts) == 1

        # Move into bucket B: $130K ASK (under floor on its own).
        bucket_b = _BUCKET_ANCHOR_MS + (_BUCKET_SECONDS * 1000)
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=bucket_b + 30_000,
                price="1.30",
                size=1000,
            ),
        )
        # Late-arriving tick from bucket A — already-fired buckets are
        # short-circuited via the dedupe set, so the late tick is
        # discarded without touching either bucket's deque. The bug
        # we guard against here is bucket B getting wiped or merged
        # with bucket-A ticks; bucket A's deque is irrelevant once
        # the alert has fired.
        handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 90_000,  # bucket A
                price="4.60",
                size=200,
            ),
        )

        # Bucket B aggregate must still only see the one $130K tick,
        # not be contaminated by the late bucket-A $92K.
        chain = "SPXW260512C07360000"
        bucket_b_epoch = bucket_b // 1000
        bucket_b_deque = handler._ticks[chain][bucket_b_epoch]
        assert len(bucket_b_deque) == 1
        assert bucket_b_deque[0].premium == Decimal("130000")

        # Bucket A's deque is unchanged from when it fired (the late
        # tick was dropped on the dedupe check).
        bucket_a_epoch = _BUCKET_ANCHOR_MS // 1000
        bucket_a_deque = handler._ticks[chain][bucket_a_epoch]
        assert len(bucket_a_deque) == 1
        # _fired still records bucket A as alerted.
        assert (chain, bucket_a_epoch) in handler._fired

    def test_two_contracts_interleaved_stay_independent(
        self, handler, base_payload,
    ):
        """Trades on 7360c and 7370c in the same bucket don't cross-pollute."""
        # $260K ASK on 7360c → fires.
        handler._transform(
            _payload(
                base_payload,
                chain="SPXW260512C07360000",
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="2.60",
                size=1000,
            ),
        )
        # $130K ASK on 7370c → under floor alone.
        handler._transform(
            _payload(
                base_payload,
                chain="SPXW260512C07370000",
                executed_at_ms=_BUCKET_ANCHOR_MS + 65_000,
                price="1.30",
                size=1000,
            ),
        )
        # Another $130K ASK on 7370c → now $260K total on that strike,
        # crosses its own floor.
        handler._transform(
            _payload(
                base_payload,
                chain="SPXW260512C07370000",
                executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
                price="1.30",
                size=1000,
            ),
        )
        # Two distinct alerts, one per contract.
        chains = [a[_AI["option_chain"]] for a in handler._pending_alerts]
        assert chains == [
            "SPXW260512C07360000",
            "SPXW260512C07370000",
        ]

    def test_stale_buckets_pruned_per_contract(self, handler, base_payload):
        """Buckets older than _BUCKETS_TO_KEEP are evicted from memory."""
        # Drop a tick in 4 distinct buckets — only the most recent
        # _BUCKETS_TO_KEEP (=3) should survive.
        for i in range(handler._BUCKETS_TO_KEEP + 1):
            handler._transform(
                _payload(
                    base_payload,
                    executed_at_ms=(
                        _BUCKET_ANCHOR_MS + i * _BUCKET_SECONDS * 1000 + 10_000
                    ),
                    price="0.10",  # tiny; never crosses threshold
                    size=1,
                ),
            )
        chain_buckets = handler._ticks["SPXW260512C07360000"]
        assert len(chain_buckets) == handler._BUCKETS_TO_KEEP


# ----------------------------------------------------------------------
# Defensive: a bug in the rolling-state side-effect must not poison
# the raw-tick write path. _transform must still return the row.
# ----------------------------------------------------------------------


class TestObserveSwallow:
    def test_transform_returns_row_when_observe_raises(
        self, handler, base_payload, monkeypatch,
    ):
        # Force _observe to raise — _transform must still return the
        # row built by the inherited OptionTradesHandler._transform so
        # the raw-tick batch keeps flowing into ws_option_trades.
        def boom(self, payload, row):
            raise RuntimeError("simulated _observe bug")

        monkeypatch.setattr(
            SPXWIntervalBAHandler,
            "_observe",
            boom,
        )
        row = handler._transform(
            _payload(
                base_payload,
                executed_at_ms=_BUCKET_ANCHOR_MS + 60_000,
                price="4.60",
                size=888,
            ),
        )
        assert row is not None
        # Still got a valid raw-tick row — option_chain at known index.
        from handlers.option_trades import _COLUMNS as _RAW_COLS

        raw_idx = {n: i for i, n in enumerate(_RAW_COLS)}
        assert row[raw_idx["option_chain"]] == "SPXW260512C07360000"


# ----------------------------------------------------------------------
# Per-ticker subclasses — SPY and QQQ smoke tests. The full alert-logic
# matrix is exercised against SPXW above; these confirm that swapping
# in a different _TICKER subclass:
#   - rejects ticks from the other two tickers (defensive filter)
#   - fires when its own ticker's ticks cross the same gates
#   - includes the right ticker string in the alert row
# ----------------------------------------------------------------------


class TestSubclassFiltering:
    @pytest.mark.parametrize(
        "subclass,foreign_chain",
        [
            (SPYIntervalBAHandler, "SPXW260512C07360000"),
            (QQQIntervalBAHandler, "SPY260512C00580000"),
        ],
    )
    def test_subclass_ignores_other_ticker_ticks(
        self, base_payload, subclass, foreign_chain,
    ):
        """A SPY handler must drop SPXW ticks (and vice versa) silently."""
        h = subclass()
        h._transform(
            _payload(
                base_payload,
                underlying_symbol="SPXW",  # foreign for both SPY + QQQ
                chain=foreign_chain,
                executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
                price="5.00",
                size=2000,
            ),
        )
        assert h._pending_alerts == []

    def test_spy_subclass_fires_on_spy_ticks(self, base_payload):
        """SPY handler fires on SPY 0DTE ask-side flow that clears both gates.

        SPY 0DTE strike layout differs from SPXW (3-digit underlying so
        OCC strikes are 5-digit ×1000), but the handler is ticker-agnostic
        below the filter — same ratio + premium-floor logic applies.
        """
        h = SPYIntervalBAHandler()
        h._transform(
            _payload(
                base_payload,
                underlying_symbol="SPY",
                chain="SPY260512C00580000",  # SPY $580 call, 0DTE
                executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
                price="2.50",
                size=1200,  # → $300,000 premium → above floor
                tags=["ask_side", "bullish", "sweep"],
            ),
        )
        assert len(h._pending_alerts) == 1
        alert = h._pending_alerts[0]
        assert alert[_AI["ticker"]] == "SPY"
        assert alert[_AI["option_chain"]] == "SPY260512C00580000"
        assert alert[_AI["ratio_pct"]] == Decimal("100.00")

    def test_qqq_subclass_fires_on_qqq_ticks(self, base_payload):
        """QQQ handler fires on QQQ 0DTE ask-side flow."""
        h = QQQIntervalBAHandler()
        h._transform(
            _payload(
                base_payload,
                underlying_symbol="QQQ",
                chain="QQQ260512P00510000",
                executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
                price="2.00",
                size=1400,  # → $280,000 premium
                tags=["ask_side", "bearish"],
            ),
        )
        assert len(h._pending_alerts) == 1
        alert = h._pending_alerts[0]
        assert alert[_AI["ticker"]] == "QQQ"
        assert alert[_AI["option_type"]] == "P"


class TestBaseClassGuard:
    def test_base_class_cannot_be_instantiated(self):
        """Bare IntervalBAHandler() must fail loudly — _TICKER is unset."""
        with pytest.raises(NotImplementedError, match="_TICKER"):
            IntervalBAHandler()


# ----------------------------------------------------------------------
# Cross-symbol confluence — end-to-end through the handler. The
# RecentFires registry's own unit tests are in test_recent_fires.py;
# this class verifies the handler integrates with the registry the way
# the spec describes (asymmetric tagging on write, OTHER-ticker-only,
# direction-matched).
# ----------------------------------------------------------------------


def _fire_one_alert(handler, base_payload, *, chain, underlying_symbol):
    """Push a single ask-side print through the handler that clears
    both gates. Returns the appended alert tuple."""
    handler._transform(
        _payload(
            base_payload,
            underlying_symbol=underlying_symbol,
            chain=chain,
            executed_at_ms=_BUCKET_ANCHOR_MS + 80_000,
            price="2.50",
            size=1200,  # → $300K premium, above the $250K floor
            tags=["ask_side", "bullish", "sweep"],
        ),
    )
    assert len(handler._pending_alerts) == 1
    return handler._pending_alerts[-1]


class TestConfluenceTagging:
    def test_first_fire_alone_is_solo(self, base_payload):
        """SPXW fires by itself → confluence_tickers is []."""
        h = SPXWIntervalBAHandler()
        alert = _fire_one_alert(
            h,
            base_payload,
            chain="SPXW260512C07360000",
            underlying_symbol="SPXW",
        )
        assert alert[_AI["confluence_tickers"]] == []

    def test_second_fire_picks_up_first_as_partner(self, base_payload):
        """SPY fires; then SPXW fires same-direction within 90s.

        Asymmetric tagging: the SPY row stays empty (it fired first
        before SPXW existed in the registry); the SPXW row enumerates
        ['SPY'] because the registry now has the SPY fire.
        """
        spy = SPYIntervalBAHandler()
        spxw = SPXWIntervalBAHandler()

        spy_alert = _fire_one_alert(
            spy,
            base_payload,
            chain="SPY260512C00580000",
            underlying_symbol="SPY",
        )
        spxw_alert = _fire_one_alert(
            spxw,
            base_payload,
            chain="SPXW260512C07360000",
            underlying_symbol="SPXW",
        )
        # SPY row written FIRST → no partners yet.
        assert spy_alert[_AI["confluence_tickers"]] == []
        # SPXW row written SECOND → sees SPY in the registry.
        assert spxw_alert[_AI["confluence_tickers"]] == ["SPY"]

    def test_three_way_confluence(self, base_payload):
        """SPY then QQQ then SPXW all CALL within 90s → SPXW row
        enumerates ['QQQ','SPY'] sorted."""
        spy = SPYIntervalBAHandler()
        qqq = QQQIntervalBAHandler()
        spxw = SPXWIntervalBAHandler()

        _fire_one_alert(
            spy, base_payload,
            chain="SPY260512C00580000", underlying_symbol="SPY",
        )
        qqq_alert = _fire_one_alert(
            qqq, base_payload,
            chain="QQQ260512C00510000", underlying_symbol="QQQ",
        )
        spxw_alert = _fire_one_alert(
            spxw, base_payload,
            chain="SPXW260512C07360000", underlying_symbol="SPXW",
        )
        # QQQ saw only SPY before it.
        assert qqq_alert[_AI["confluence_tickers"]] == ["SPY"]
        # SPXW saw both. Sorted for determinism (Q sorts after S — so
        # the order is alphabetical: QQQ, SPY).
        assert spxw_alert[_AI["confluence_tickers"]] == ["QQQ", "SPY"]

    def test_opposite_direction_does_not_count_as_confluence(
        self, base_payload,
    ):
        """SPY CALL fires; SPXW PUT fires same-time → NOT confluence.

        Confluence requires same option_type (both CALL or both PUT).
        Cross-direction simultaneous fires are unrelated signals.
        """
        spy = SPYIntervalBAHandler()
        spxw = SPXWIntervalBAHandler()

        _fire_one_alert(
            spy, base_payload,
            chain="SPY260512C00580000", underlying_symbol="SPY",
        )
        # SPXW PUT — different direction.
        spxw._transform(
            _payload(
                base_payload,
                underlying_symbol="SPXW",
                chain="SPXW260512P07350000",
                executed_at_ms=_BUCKET_ANCHOR_MS + 85_000,
                price="2.50",
                size=1200,
                tags=["ask_side", "bearish"],
            ),
        )
        assert len(spxw._pending_alerts) == 1
        spxw_alert = spxw._pending_alerts[0]
        assert spxw_alert[_AI["option_type"]] == "P"
        assert spxw_alert[_AI["confluence_tickers"]] == []

    def test_self_ticker_never_appears_in_own_confluence(self, base_payload):
        """Two consecutive SPXW CALLs (different contracts) — the
        second's confluence_tickers must NOT include 'SPXW' itself."""
        h = SPXWIntervalBAHandler()
        # First fire on 7360c.
        _fire_one_alert(
            h, base_payload,
            chain="SPXW260512C07360000", underlying_symbol="SPXW",
        )
        # Second fire on 7370c — same direction, different contract.
        # No deduping at the registry layer; the second alert just
        # checks for OTHER tickers' partners.
        h._transform(
            _payload(
                base_payload,
                underlying_symbol="SPXW",
                chain="SPXW260512C07370000",
                executed_at_ms=_BUCKET_ANCHOR_MS + 100_000,
                price="2.50",
                size=1200,
                tags=["ask_side", "bullish"],
            ),
        )
        assert len(h._pending_alerts) == 2
        second = h._pending_alerts[1]
        assert "SPXW" not in second[_AI["confluence_tickers"]]
        assert second[_AI["confluence_tickers"]] == []


# ----------------------------------------------------------------------
# Per-ticker enable gate — handler._enabled flips based on both the
# master interval_ba_enabled flag AND the per-ticker opt-in list. This
# is the new load-bearing config knob added in Phase 2; without test
# coverage a regression here would silently re-enable a ticker the
# operator tried to disable (or vice versa).
# ----------------------------------------------------------------------


class TestTickerGate:
    def test_property_uppercases_and_trims_and_drops_empties(self, monkeypatch):
        """``spy, spxw ,,`` normalizes to {"SPY","SPXW"}."""
        from config import settings

        monkeypatch.setattr(settings, "interval_ba_tickers_csv", "spy, spxw ,,")
        assert settings.interval_ba_tickers == frozenset({"SPY", "SPXW"})

    def test_property_empty_string_returns_empty_set(self, monkeypatch):
        from config import settings

        monkeypatch.setattr(settings, "interval_ba_tickers_csv", "")
        assert settings.interval_ba_tickers == frozenset()

    def test_master_off_disables_every_subclass(self, monkeypatch):
        """Master switch wins even when ticker is in the opt-in list."""
        from config import settings

        monkeypatch.setattr(settings, "interval_ba_enabled", False)
        monkeypatch.setattr(
            settings, "interval_ba_tickers_csv", "SPY,SPXW,QQQ",
        )
        for subclass in (
            SPYIntervalBAHandler,
            SPXWIntervalBAHandler,
            QQQIntervalBAHandler,
        ):
            assert subclass()._enabled is False, subclass.__name__

    def test_ticker_opt_in_filters_subclasses(self, monkeypatch):
        """Only SPXW is in the list → only SPXW handler is enabled."""
        from config import settings

        monkeypatch.setattr(settings, "interval_ba_enabled", True)
        monkeypatch.setattr(settings, "interval_ba_tickers_csv", "SPXW")
        assert SPYIntervalBAHandler()._enabled is False
        assert SPXWIntervalBAHandler()._enabled is True
        assert QQQIntervalBAHandler()._enabled is False

    def test_lowercase_env_value_still_matches_uppercase_ticker(
        self, monkeypatch,
    ):
        """Operator typing ``spy,spxw`` (lowercase) still enables them."""
        from config import settings

        monkeypatch.setattr(settings, "interval_ba_enabled", True)
        monkeypatch.setattr(settings, "interval_ba_tickers_csv", "spy,spxw")
        assert SPYIntervalBAHandler()._enabled is True
        assert SPXWIntervalBAHandler()._enabled is True
        assert QQQIntervalBAHandler()._enabled is False

    def test_empty_ticker_list_disables_all_even_with_master_on(
        self, monkeypatch,
    ):
        """Master on but ticker list empty → all three disabled."""
        from config import settings

        monkeypatch.setattr(settings, "interval_ba_enabled", True)
        monkeypatch.setattr(settings, "interval_ba_tickers_csv", "")
        for subclass in (
            SPYIntervalBAHandler,
            SPXWIntervalBAHandler,
            QQQIntervalBAHandler,
        ):
            assert subclass()._enabled is False, subclass.__name__
