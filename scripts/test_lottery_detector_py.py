"""Parity tests for lottery_detector_py.

Mirrors api/__tests__/lottery-finder.test.ts 1:1 by name and shape so
the Python port cannot drift from the TS source-of-truth without
breaking this suite. Run:

    ml/.venv/bin/pytest scripts/test_lottery_detector_py.py -q
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lottery_detector_py import (  # noqa: E402
    OptionTradeTick,
    EnrichMeta,
    build_flow_quad,
    classify_mode,
    detect_chain_fires,
    enrich_fires,
    get_dominant_side,
    get_time_of_day,
    get_time_of_day_from_ct_hour_min,
    is_cheap_call_pm,
    is_reload,
    ASK_PCT_MIN,
    CNT_WINDOW_MIN,
    VOL_TO_OI_WINDOW_MIN,
    ABS_DELTA_MIN,
)


def isclose(a: float, b: float, tol: float = 1e-6) -> bool:
    return math.isclose(a, b, abs_tol=tol)


# ============================================================
# Helpers — build a fireable tick stream
# ============================================================

BASE = datetime(2026, 5, 1, 13, 30, 0, tzinfo=timezone.utc)  # 08:30 CT


def make_tick(offset_sec: float, **overrides) -> OptionTradeTick:
    defaults = {
        'executed_at': BASE + timedelta(seconds=offset_sec),
        'option_chain': 'SNDK260501C01175000',
        'option_type': 'C',
        'strike': 1175.0,
        'expiry': datetime(2026, 5, 1, 0, 0, 0, tzinfo=timezone.utc),
        'price': 0.5,
        'size': 10,
        'underlying_price': 1170.0,
        'side': 'ask',
        'implied_volatility': 0.5,
        'delta': 0.2,
        'open_interest': 1000,
    }
    defaults.update(overrides)
    return OptionTradeTick(**defaults)


def fireable_stream() -> list[OptionTradeTick]:
    """6 ask-side ticks with cumulative size 150 → vol/OI=0.15 on OI=1000."""
    return [
        make_tick(0, size=50),
        make_tick(30, size=20),
        make_tick(60, size=20),
        make_tick(90, size=20),
        make_tick(120, size=20),
        make_tick(150, size=20),
    ]


# ============================================================
# get_time_of_day
# ============================================================


def test_tod_am_open():
    assert get_time_of_day(datetime(2026, 5, 1, 13, 30, tzinfo=timezone.utc)) == 'AM_open'


def test_tod_mid():
    assert get_time_of_day(datetime(2026, 5, 1, 14, 30, tzinfo=timezone.utc)) == 'MID'


def test_tod_lunch():
    assert get_time_of_day(datetime(2026, 5, 1, 16, 30, tzinfo=timezone.utc)) == 'LUNCH'


def test_tod_pm_after_1230():
    assert get_time_of_day(datetime(2026, 5, 1, 17, 30, tzinfo=timezone.utc)) == 'PM'


def test_tod_pm_at_1459():
    assert get_time_of_day(datetime(2026, 5, 1, 19, 59, tzinfo=timezone.utc)) == 'PM'


def test_tod_from_ct_boundaries():
    assert get_time_of_day_from_ct_hour_min(8, 30) == 'AM_open'
    assert get_time_of_day_from_ct_hour_min(9, 30) == 'MID'
    assert get_time_of_day_from_ct_hour_min(11, 30) == 'LUNCH'
    assert get_time_of_day_from_ct_hour_min(12, 30) == 'PM'


# ============================================================
# get_dominant_side
# ============================================================


def test_dominant_side_ask():
    assert get_dominant_side(0.6) == 'ask'
    assert get_dominant_side(0.95) == 'ask'


def test_dominant_side_bid():
    assert get_dominant_side(0.4) == 'bid'
    assert get_dominant_side(0.05) == 'bid'


def test_dominant_side_mixed():
    assert get_dominant_side(0.5) == 'mixed'
    assert get_dominant_side(0.41) == 'mixed'
    assert get_dominant_side(0.59) == 'mixed'


# ============================================================
# build_flow_quad
# ============================================================


def test_flow_quad_call_ask():
    assert build_flow_quad('C', 0.7) == 'call_ask'


def test_flow_quad_put_bid():
    assert build_flow_quad('P', 0.2) == 'put_bid'


def test_flow_quad_call_mixed():
    assert build_flow_quad('C', 0.5) == 'call_mixed'


# ============================================================
# classify_mode
# ============================================================


def test_classify_sndk_0dte_mode_a():
    assert classify_mode('SNDK', 0, 0.8, 1175, 1170) == 'A_intraday_0DTE'


def test_classify_spy_0dte_mode_a():
    assert classify_mode('SPY', 0, 0.8, 500, 500) == 'A_intraday_0DTE'


def test_classify_meta_2dte_mode_b():
    assert classify_mode('META', 2, 0.8, 510, 500) == 'B_multi_day_DTE1_3'


def test_classify_rejects_far_otm_mode_b():
    assert classify_mode('META', 2, 0.8, 1000, 500) == 'OUT_OF_UNIVERSE'


def test_classify_keeps_just_inside_in_play_gate():
    assert classify_mode('META', 2, 0.8, 549, 500) == 'B_multi_day_DTE1_3'


def test_classify_rejects_spy_dte13_from_mode_b():
    assert classify_mode('SPY', 2, 0.8, 500, 500) == 'OUT_OF_UNIVERSE'


def test_classify_rejects_dte_above_3():
    assert classify_mode('META', 4, 0.8, 500, 500) == 'OUT_OF_UNIVERSE'


def test_classify_rejects_low_ask_pct():
    assert classify_mode('SNDK', 0, 0.5, 1175, 1170) == 'OUT_OF_UNIVERSE'


def test_classify_rejects_unknown_ticker():
    assert classify_mode('FAKE', 0, 0.9, 100, 100) == 'OUT_OF_UNIVERSE'


def test_classify_uppercases_ticker():
    assert classify_mode('sndk', 0, 0.8, 1175, 1170) == 'A_intraday_0DTE'


def test_classify_rejects_zero_spot_mode_b():
    assert classify_mode('META', 2, 0.8, 500, 0) == 'OUT_OF_UNIVERSE'


def test_classify_spxw_0dte_mode_a():
    """SPXW addition (2026-05-07) — must classify as Mode A."""
    assert classify_mode('SPXW', 0, 0.8, 5800, 5800) == 'A_intraday_0DTE'


# ============================================================
# is_reload
# ============================================================


def test_reload_first_fire():
    assert is_reload(None, None) is False


def test_reload_qualifies():
    assert is_reload(2.5, -35) is True


def test_reload_burst_too_low():
    assert is_reload(1.9, -50) is False


def test_reload_drop_too_low():
    assert is_reload(3.0, -25) is False


def test_reload_entry_rose():
    assert is_reload(3.0, 10) is False


# ============================================================
# is_cheap_call_pm
# ============================================================


def test_cheap_call_pm_qualifies():
    assert is_cheap_call_pm('C', 0.5, 'PM') is True


def test_cheap_call_pm_rejects_puts():
    assert is_cheap_call_pm('P', 0.5, 'PM') is False


def test_cheap_call_pm_rejects_dollar_or_more():
    assert is_cheap_call_pm('C', 1.0, 'PM') is False


def test_cheap_call_pm_rejects_non_pm():
    assert is_cheap_call_pm('C', 0.5, 'AM_open') is False
    assert is_cheap_call_pm('C', 0.5, 'MID') is False
    assert is_cheap_call_pm('C', 0.5, 'LUNCH') is False


# ============================================================
# detect_chain_fires
# ============================================================


def test_detector_happy_path():
    fires = detect_chain_fires(fireable_stream(), 1000, 0)
    assert len(fires) == 1
    f = fires[0]
    assert f.alert_seq == 1
    assert f.minutes_since_prev_fire == 0
    assert f.open_interest == 1000
    assert f.spot_at_first == 1170
    assert f.entry_price == 0.5
    assert f.trigger_window_prints >= CNT_WINDOW_MIN
    assert f.trigger_vol_to_oi_window >= VOL_TO_OI_WINDOW_MIN
    assert isclose(f.trigger_iv, 0.5)
    assert abs(f.trigger_delta) >= ABS_DELTA_MIN
    assert f.trigger_ask_pct >= ASK_PCT_MIN


def test_detector_dte_above_max():
    assert detect_chain_fires(fireable_stream(), 1000, 8) == []


def test_detector_zero_oi():
    assert detect_chain_fires(fireable_stream(), 0, 0) == []


def test_detector_below_min_prints():
    assert detect_chain_fires(fireable_stream()[:4], 1000, 0) == []


def test_detector_low_window_vol_to_oi():
    ticks = [make_tick(i * 30, size=1) for i in range(6)]
    assert detect_chain_fires(ticks, 1000, 0) == []


def test_detector_low_ask_pct():
    sides = ['ask', 'ask', 'bid', 'bid', 'bid', 'bid']
    ticks = [
        OptionTradeTick(**{**vars(t), 'side': s})
        for t, s in zip(fireable_stream(), sides)
    ]
    assert detect_chain_fires(ticks, 1000, 0) == []


def test_detector_low_iv():
    ticks = [
        OptionTradeTick(**{**vars(t), 'implied_volatility': 0.2})
        for t in fireable_stream()
    ]
    assert detect_chain_fires(ticks, 1000, 0) == []


def test_detector_low_delta():
    ticks = [
        OptionTradeTick(**{**vars(t), 'delta': 0.05})
        for t in fireable_stream()
    ]
    assert detect_chain_fires(ticks, 1000, 0) == []


def test_detector_first_tick_null_underlying():
    stream = fireable_stream()
    ticks = [
        OptionTradeTick(**{**vars(stream[0]), 'underlying_price': None}),
        *stream[1:],
    ]
    assert detect_chain_fires(ticks, 1000, 0) == []


def test_detector_tolerates_null_iv_in_subset():
    """Mid-window null IV ticks are skipped from the IV mean denominator
    but don't reject the fire (subset average still ≥ ivMin)."""
    stream = fireable_stream()
    ticks = []
    for i, t in enumerate(stream):
        if i % 2 == 1:
            ticks.append(OptionTradeTick(**{**vars(t), 'implied_volatility': None}))
        else:
            ticks.append(t)
    assert len(detect_chain_fires(ticks, 1000, 0)) == 1


def test_detector_cum_vol_to_oi_gate():
    """OI=10000 with same fireable_stream → cum vol/OI=0.015 (below 0.10)
    AND window vol/OI=0.015 (below 0.05). No fires."""
    assert detect_chain_fires(fireable_stream(), 10000, 0) == []


# ============================================================
# detect_chain_fires — cooldown
# ============================================================


def test_detector_two_fires_after_cooldown():
    # Second burst at t=400 (>5min after t=150 entry) — should fire again.
    ticks = fireable_stream() + [
        make_tick(400, size=50, price=0.3),
        make_tick(420, size=30, price=0.3),
        make_tick(440, size=30, price=0.3),
        make_tick(460, size=30, price=0.3),
        make_tick(480, size=30, price=0.3),
        make_tick(500, size=30, price=0.3),
    ]
    fires = detect_chain_fires(ticks, 1000, 0)
    assert len(fires) >= 2
    assert fires[0].alert_seq == 1
    assert fires[1].alert_seq == 2
    assert fires[1].minutes_since_prev_fire > 5


def test_detector_eviction_at_5min_boundary():
    """Tick at offset=0 must be evicted when cur_ts is exactly 5 min later.
    Sizes deliberately too low to fire — test documents the boundary."""
    ticks = [make_tick(i * 60, size=1000) for i in range(6)]
    fires = detect_chain_fires(ticks, 1_000_000, 0)
    assert fires == []


def test_detector_cooldown_suppresses_within_5min():
    ticks = fireable_stream() + [
        make_tick(180, size=50, price=0.5),
        make_tick(190, size=50, price=0.5),
        make_tick(200, size=50, price=0.5),
        make_tick(210, size=50, price=0.5),
        make_tick(220, size=50, price=0.5),
    ]
    fires = detect_chain_fires(ticks, 1000, 0)
    assert len(fires) == 1


# ============================================================
# enrich_fires
# ============================================================


def test_enrich_first_fire_nulls():
    fires = detect_chain_fires(fireable_stream(), 1000, 0)
    assert len(fires) == 1
    records = enrich_fires(fires, EnrichMeta(
        date='2026-05-01',
        option_chain_id='SNDK260501C01175000',
        underlying_symbol='SNDK',
        option_type='C',
        strike=1175.0,
        expiry='2026-05-01',
        dte=0,
    ))
    r = records[0]
    assert r.burst_ratio_vs_prev is None
    assert r.entry_drop_pct_vs_prev is None
    assert r.reload_tagged is False
    assert r.tod == 'AM_open'
    assert r.flow_quad == 'call_ask'
    assert r.mode == 'A_intraday_0DTE'
    assert r.cheap_call_pm_tagged is False  # AM_open, not PM


def test_enrich_reload_tag_on_fire_2():
    """SNDK 1175C 5/1 fire #4 archetype: bigger second burst, cheaper entry."""
    fires = [
        # First fire — AM_open, entry $0.50, burst size=100
        type('F', (), dict(
            trigger_time_ct=datetime(2026, 5, 1, 13, 30, tzinfo=timezone.utc),
            entry_time_ct=datetime(2026, 5, 1, 13, 31, tzinfo=timezone.utc),
            entry_price=0.5,
            trigger_vol_to_oi_window=0.06,
            trigger_vol_to_oi_cum=0.12,
            trigger_iv=0.4,
            trigger_delta=0.2,
            trigger_ask_pct=0.7,
            trigger_window_prints=5,
            trigger_window_size=100,
            open_interest=1000,
            spot_at_first=1170,
            alert_seq=1,
            minutes_since_prev_fire=0,
        ))(),
        # Second fire — PM, entry $0.30 (-40%), burst size=250 (2.5×)
        type('F', (), dict(
            trigger_time_ct=datetime(2026, 5, 1, 19, 0, tzinfo=timezone.utc),
            entry_time_ct=datetime(2026, 5, 1, 19, 1, tzinfo=timezone.utc),
            entry_price=0.3,
            trigger_vol_to_oi_window=0.06,
            trigger_vol_to_oi_cum=0.12,
            trigger_iv=0.4,
            trigger_delta=0.2,
            trigger_ask_pct=0.7,
            trigger_window_prints=5,
            trigger_window_size=250,
            open_interest=1000,
            spot_at_first=1170,
            alert_seq=2,
            minutes_since_prev_fire=330,
        ))(),
    ]
    records = enrich_fires(fires, EnrichMeta(
        date='2026-05-01',
        option_chain_id='SNDK260501C01175000',
        underlying_symbol='SNDK',
        option_type='C',
        strike=1175.0,
        expiry='2026-05-01',
        dte=0,
    ))
    assert records[0].reload_tagged is False
    assert records[1].reload_tagged is True
    assert isclose(records[1].burst_ratio_vs_prev, 2.5)
    assert isclose(records[1].entry_drop_pct_vs_prev, -40.0)
    assert records[1].tod == 'PM'
    assert records[1].cheap_call_pm_tagged is True


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-q']))
