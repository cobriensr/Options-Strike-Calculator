"""Phase 1 leakage-check tests for the take-it training-set builder.

Spec: docs/superpowers/specs/alert-takeit-score-2026-05-16.md
"""

from __future__ import annotations

from datetime import date as date_type

import pandas as pd
import pytest

from takeit.build_training_set import (
    SESSION_PHASES,
    _is_quarter_end_last_hour_ct,
    _session_phase_cat_from_minute_ct,
    add_burst_storm,
    add_cofire_diff_chain_flag,
    add_cofire_flag,
    add_label,
    add_sequential_features,
    build_lottery_from_raw,
    build_silentboom_from_raw,
    derive_common_features,
)
from takeit.config import (
    AGGRESSIVE_ASK_PCT_THRESHOLD,
    BURST_STORM_MIN_COFIRES,
    COFIRE_WINDOW_MIN,
    WIN_LABEL_THRESHOLD_PCT,
)

# ── Fixtures ─────────────────────────────────────────────────────────────────


def _lot_row(
    *,
    id_: int,
    fire_time: str,
    chain: str,
    underlying: str,
    option_type: str,
    strike: float,
    spot: float,
    ask_pct: float = 0.50,
    peak_ceiling_pct: float = 25.0,
    dte: int = 0,
    date_: date_type | None = None,
) -> dict:
    if date_ is None:
        date_ = pd.to_datetime(fire_time, utc=True).date()
    return {
        "id": id_,
        "date": date_,
        "fire_time": fire_time,
        "option_chain_id": chain,
        "underlying_symbol": underlying,
        "option_type": option_type,
        "strike": strike,
        "expiry": date_,
        "dte": dte,
        "trigger_vol_to_oi_window": 1.0,
        "trigger_vol_to_oi_cum": 1.0,
        "trigger_iv": 0.30,
        "trigger_delta": 0.20,
        "trigger_ask_pct": ask_pct,
        "trigger_window_size": 7,
        "trigger_window_prints": 4,
        "entry_price": 1.0,
        "open_interest": 100,
        "spot_at_first": spot,
        "alert_seq": 1,
        "minutes_since_prev_fire": 60.0,
        "flow_quad": "Q1",
        "tod": "AM_open",
        "mode": "A_intraday_0DTE",
        "reload_tagged": False,
        "cheap_call_pm_tagged": False,
        "burst_ratio_vs_prev": 1.5,
        "entry_drop_pct_vs_prev": 0.0,
        "mkt_tide_ncp": 1.0,
        "mkt_tide_npp": -1.0,
        "mkt_tide_diff": 2.0,
        "mkt_tide_otm_diff": 1.5,
        "spx_flow_diff": 0.0,
        "spy_etf_diff": 0.0,
        "qqq_etf_diff": 0.0,
        "zero_dte_diff": 0.0,
        "spx_spot_gamma_oi": 1.0,
        "spx_spot_gamma_vol": 1.0,
        "spx_spot_charm_oi": 1.0,
        "spx_spot_vanna_oi": 1.0,
        "gex_strike_call_minus_put": 0.0,
        "gex_strike_call_ask_minus_bid": 0.0,
        "gex_strike_put_ask_minus_bid": 0.0,
        "gex_strike_actual_strike": strike,
        "score": 12,
        "direction_gated": False,
        "peak_ceiling_pct": peak_ceiling_pct,
        "alert_type": "lottery",
    }


def _sb_row(
    *,
    id_: int,
    fire_time: str,
    chain: str,
    underlying: str,
    option_type: str,
    strike: float,
    spot: float,
    ask_pct: float = 0.50,
    peak_ceiling_pct: float = 25.0,
) -> dict:
    return {
        "id": id_,
        "date": pd.to_datetime(fire_time, utc=True).date(),
        "fire_time": fire_time,
        "option_chain_id": chain,
        "underlying_symbol": underlying,
        "option_type": option_type,
        "strike": strike,
        "expiry": pd.to_datetime(fire_time, utc=True).date(),
        "dte": 0,
        "spike_volume": 1000,
        "baseline_volume": 100.0,
        "spike_ratio": 10.0,
        "ask_pct": ask_pct,
        "vol_oi": 1.0,
        "entry_price": 1.0,
        "open_interest": 100,
        "mkt_tide_diff": 1.0,
        "mkt_tide_otm_diff": 1.0,
        "zero_dte_diff": 0.0,
        "spx_spot_gamma_oi": 1.0,
        "multi_leg_share": 0.10,
        "underlying_price_at_spike": spot,
        "score": 6,
        "score_tier": "tier1",
        "direction_gated": False,
        "peak_ceiling_pct": peak_ceiling_pct,
        "alert_type": "silentboom",
    }


# ── derive_common_features ───────────────────────────────────────────────────


def test_derive_common_features_session_phase_buckets() -> None:
    rows = [
        _lot_row(id_=i, fire_time=t, chain="X", underlying="SPY", option_type="C",
                 strike=500, spot=500)
        for i, t in enumerate(
            [
                "2026-04-01 13:35:00+00:00",  # 8:35 CT -> phase 1
                "2026-04-01 14:30:00+00:00",  # 9:30 CT -> phase 2
                "2026-04-01 16:00:00+00:00",  # 11:00 CT -> phase 3
                "2026-04-01 18:00:00+00:00",  # 13:00 CT -> phase 4
                "2026-04-01 19:30:00+00:00",  # 14:30 CT -> phase 5
            ]
        )
    ]
    df = pd.DataFrame(rows)
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    assert list(out["session_phase"]) == [1, 2, 3, 4, 5]


def test_derive_common_features_itm_and_otm_signs() -> None:
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=510),  # ITM call
        _lot_row(id_=2, fire_time="2026-04-01 14:30:00+00:00", chain="B",
                 underlying="SPY", option_type="C", strike=510, spot=500),  # OTM call
        _lot_row(id_=3, fire_time="2026-04-01 14:30:00+00:00", chain="C",
                 underlying="SPY", option_type="P", strike=500, spot=510),  # OTM put
        _lot_row(id_=4, fire_time="2026-04-01 14:30:00+00:00", chain="D",
                 underlying="SPY", option_type="P", strike=510, spot=500),  # ITM put
    ]
    df = pd.DataFrame(rows)
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    assert list(out["is_itm_at_fire"]) == [1, 0, 0, 1]
    # OTM call: (510 - 500) / 500 = 0.02
    # OTM put: (510 - 500) / 510 = 0.0196 -> stored as (spot - strike)/spot when put
    #   wait: spot=510, strike=500 puts -> (spot - strike)/spot = 10/510 ~ 0.0196
    assert out.iloc[1]["otm_distance_pct"] == pytest.approx(0.02, abs=1e-4)
    assert out.iloc[2]["otm_distance_pct"] == pytest.approx(10 / 510, abs=1e-4)


def test_derive_common_features_nan_spot_yields_na_itm() -> None:
    """When spot is NaN, is_itm_at_fire must be <NA>, not silently 0/1."""
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ]
    df = pd.DataFrame(rows)
    df.loc[0, "spot_at_first"] = pd.NA  # simulate the silentboom pre-backfill case
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    assert pd.isna(out.loc[0, "is_itm_at_fire"])
    assert pd.isna(out.loc[0, "otm_distance_pct"])


def test_dealer_gamma_sign_signs_correctly() -> None:
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500),
        _lot_row(id_=2, fire_time="2026-04-01 14:30:00+00:00", chain="B",
                 underlying="SPY", option_type="C", strike=500, spot=500),
        _lot_row(id_=3, fire_time="2026-04-01 14:30:00+00:00", chain="C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ]
    df = pd.DataFrame(rows)
    df["spx_spot_gamma_oi"] = [5.0, -3.0, 0.0]
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    assert out.loc[0, "dealer_gamma_sign"] == 1
    assert out.loc[1, "dealer_gamma_sign"] == -1
    assert pd.isna(out.loc[2, "dealer_gamma_sign"])  # zero -> NA (neutral)


def test_aggressive_premium_threshold_inclusive() -> None:
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 ask_pct=AGGRESSIVE_ASK_PCT_THRESHOLD - 0.01),
        _lot_row(id_=2, fire_time="2026-04-01 14:30:00+00:00", chain="B",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 ask_pct=AGGRESSIVE_ASK_PCT_THRESHOLD),
    ]
    df = pd.DataFrame(rows)
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    assert list(out["aggressive_premium_flag"]) == [0, 1]


# ── add_burst_storm ──────────────────────────────────────────────────────────


def test_burst_storm_requires_min_distinct_underlyings() -> None:
    # 4 distinct underlyings in 30 min -> badge=0 for the 4th. 5th distinct -> badge=1.
    base = "2026-04-01 14:00:00+00:00"
    tickers = ["A", "B", "C", "D", "E"]
    rows = []
    for i, tk in enumerate(tickers):
        t = pd.to_datetime(base, utc=True) + pd.Timedelta(minutes=i)
        rows.append(_lot_row(
            id_=i, fire_time=t.isoformat(), chain=f"{tk}_X",
            underlying=tk, option_type="C", strike=100, spot=100,
        ))
    df = pd.DataFrame(rows)
    df = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    out = add_burst_storm(df)
    # Counts of strictly-prior distinct underlyings: 0, 1, 2, 3, 4
    assert list(out["burst_storm_distinct_count"]) == [0, 1, 2, 3, 4]
    # Badge fires when count >= BURST_STORM_MIN_COFIRES (5 by default); none here.
    assert all(out["burst_storm_badge"] == 0)


def test_burst_storm_fires_when_threshold_met() -> None:
    # 6 distinct underlyings in <30 min -> 6th row sees 5 prior distinct -> badge=1
    base = "2026-04-01 14:00:00+00:00"
    tickers = list("ABCDEF")
    rows = []
    for i, tk in enumerate(tickers):
        t = pd.to_datetime(base, utc=True) + pd.Timedelta(minutes=i)
        rows.append(_lot_row(
            id_=i, fire_time=t.isoformat(), chain=f"{tk}_X",
            underlying=tk, option_type="C", strike=100, spot=100,
        ))
    df = pd.DataFrame(rows)
    df = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    out = add_burst_storm(df)
    # The 6th row (index 5) should see 5 distinct prior underlyings -> badge=1
    assert out.iloc[5]["burst_storm_distinct_count"] == BURST_STORM_MIN_COFIRES
    assert out.iloc[5]["burst_storm_badge"] == 1
    # The 5th row (index 4) sees 4 prior -> below threshold.
    assert out.iloc[4]["burst_storm_badge"] == 0


def test_burst_storm_respects_window_eviction() -> None:
    # Spread 6 fires across 60 min so older ones evict.
    base = pd.to_datetime("2026-04-01 14:00:00+00:00", utc=True)
    tickers = list("ABCDEF")
    rows = []
    for i, tk in enumerate(tickers):
        t = base + pd.Timedelta(minutes=i * 7)  # 0, 7, 14, 21, 28, 35
        rows.append(_lot_row(
            id_=i, fire_time=t.isoformat(), chain=f"{tk}_X",
            underlying=tk, option_type="C", strike=100, spot=100,
        ))
    df = pd.DataFrame(rows)
    df = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    out = add_burst_storm(df)
    # Last row at minute 35; window is 30 minutes; prior in-window fires happen
    # at minutes 7, 14, 21, 28 (4 distinct). Minute 0 evicted.
    assert out.iloc[5]["burst_storm_distinct_count"] == 4


# ── add_cofire_flag ──────────────────────────────────────────────────────────


def test_cofire_flag_within_window_prior_counterpart() -> None:
    """Counterpart fires BEFORE target's fire_time -> within window -> flag=1.

    PIT-correct: only prior counterparts count.
    """
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")

    # Counterpart 3 min BEFORE target (within COFIRE_WINDOW_MIN=5).
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base - pd.Timedelta(minutes=3)).isoformat(),
                chain="SPY_500C", underlying="SPY", option_type="C",
                strike=500, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_flag(target, other, "silent_boom_cofire_within_5min")
    assert out["silent_boom_cofire_within_5min"].iloc[0] == 1


def test_cofire_flag_future_counterpart_not_counted() -> None:
    """Counterpart fires AFTER target's fire_time -> leakage -> flag=0.

    At production scoring time the counterpart wouldn't exist yet, so future
    cofires must not contribute.
    """
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base + pd.Timedelta(minutes=2)).isoformat(),
                chain="SPY_500C", underlying="SPY", option_type="C",
                strike=500, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_flag(target, other, "silent_boom_cofire_within_5min")
    assert out["silent_boom_cofire_within_5min"].iloc[0] == 0


def test_cofire_flag_outside_window_prior_counterpart() -> None:
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base - pd.Timedelta(minutes=COFIRE_WINDOW_MIN + 1)).isoformat(),
                chain="SPY_500C", underlying="SPY", option_type="C",
                strike=500, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_flag(target, other, "silent_boom_cofire_within_5min")
    assert out["silent_boom_cofire_within_5min"].iloc[0] == 0


def test_cofire_flag_different_chain_id_not_counted() -> None:
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=base.isoformat(),
                chain="SPY_510C", underlying="SPY", option_type="C",
                strike=510, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_flag(target, other, "silent_boom_cofire_within_5min")
    assert out["silent_boom_cofire_within_5min"].iloc[0] == 0


def test_cofire_flag_empty_other_yields_zeros() -> None:
    base = "2026-04-01 14:30:00+00:00"
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base, chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame(columns=["option_chain_id", "fire_time"])
    out = add_cofire_flag(target, other, "silent_boom_cofire_within_5min")
    assert out["silent_boom_cofire_within_5min"].iloc[0] == 0


# ── add_cofire_diff_chain_flag ───────────────────────────────────────────────


def test_diff_chain_cofire_sibling_within_window() -> None:
    """Sibling chain (same ticker + option_type, different chain id) fires
    within window strictly prior → flag = 1."""
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base - pd.Timedelta(minutes=2)).isoformat(),
                chain="SPY_505C", underlying="SPY", option_type="C",
                strike=505, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_diff_chain_flag(
        target, other, "silent_boom_cofire_diff_chain_within_5min"
    )
    assert out["silent_boom_cofire_diff_chain_within_5min"].iloc[0] == 1


def test_diff_chain_cofire_same_chain_excluded() -> None:
    """Same chain id only → flag = 0 (same-chain hits belong to the regular
    cofire flag, not the diff-chain flag)."""
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base - pd.Timedelta(minutes=2)).isoformat(),
                chain="SPY_500C", underlying="SPY", option_type="C",
                strike=500, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_diff_chain_flag(
        target, other, "silent_boom_cofire_diff_chain_within_5min"
    )
    assert out["silent_boom_cofire_diff_chain_within_5min"].iloc[0] == 0


def test_diff_chain_cofire_opposite_option_type_excluded() -> None:
    """Same ticker, OPPOSITE option_type → flag = 0 (direction-locked)."""
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base - pd.Timedelta(minutes=2)).isoformat(),
                chain="SPY_500P", underlying="SPY", option_type="P",
                strike=500, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_diff_chain_flag(
        target, other, "silent_boom_cofire_diff_chain_within_5min"
    )
    assert out["silent_boom_cofire_diff_chain_within_5min"].iloc[0] == 0


def test_diff_chain_cofire_outside_window_excluded() -> None:
    """Sibling chain fire outside COFIRE_WINDOW_MIN → flag = 0."""
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10,
                fire_time=(base - pd.Timedelta(minutes=COFIRE_WINDOW_MIN + 1)).isoformat(),
                chain="SPY_505C", underlying="SPY", option_type="C",
                strike=505, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_diff_chain_flag(
        target, other, "silent_boom_cofire_diff_chain_within_5min"
    )
    assert out["silent_boom_cofire_diff_chain_within_5min"].iloc[0] == 0


def test_diff_chain_cofire_future_excluded_pit_correct() -> None:
    """Sibling chain fire in the FUTURE → flag = 0 (PIT-correct)."""
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base + pd.Timedelta(minutes=2)).isoformat(),
                chain="SPY_505C", underlying="SPY", option_type="C",
                strike=505, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_diff_chain_flag(
        target, other, "silent_boom_cofire_diff_chain_within_5min"
    )
    assert out["silent_boom_cofire_diff_chain_within_5min"].iloc[0] == 0


def test_diff_chain_cofire_independent_of_same_chain() -> None:
    """Two prior fires — one on the SAME chain, one on a SIBLING chain — both
    within window. Diff-chain flag must flip because the sibling exists. This
    is the not-mutually-exclusive contract from the Phase 6 spec."""
    base = pd.to_datetime("2026-04-01 14:30:00+00:00", utc=True)
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base.isoformat(), chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame([
        _sb_row(id_=10, fire_time=(base - pd.Timedelta(minutes=2)).isoformat(),
                chain="SPY_500C", underlying="SPY", option_type="C",
                strike=500, spot=500),
        _sb_row(id_=11, fire_time=(base - pd.Timedelta(minutes=3)).isoformat(),
                chain="SPY_505C", underlying="SPY", option_type="C",
                strike=505, spot=500),
    ])
    other = derive_common_features(other, "underlying_price_at_spike", "ask_pct")
    out = add_cofire_diff_chain_flag(
        target, other, "silent_boom_cofire_diff_chain_within_5min"
    )
    assert out["silent_boom_cofire_diff_chain_within_5min"].iloc[0] == 1


def test_diff_chain_cofire_empty_other_yields_zeros() -> None:
    base = "2026-04-01 14:30:00+00:00"
    target = pd.DataFrame([
        _lot_row(id_=1, fire_time=base, chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    target = derive_common_features(target, "spot_at_first", "trigger_ask_pct")
    other = pd.DataFrame(
        columns=["option_chain_id", "underlying_symbol", "option_type", "fire_time"]
    )
    out = add_cofire_diff_chain_flag(
        target, other, "silent_boom_cofire_diff_chain_within_5min"
    )
    assert out["silent_boom_cofire_diff_chain_within_5min"].iloc[0] == 0


# ── add_sequential_features ──────────────────────────────────────────────────


def test_same_dir_count_uses_only_prior_fires() -> None:
    """Critical leakage check: at row N, n_same_dir_fires_last_30min counts only
    fires with fire_time strictly less than row N's fire_time."""
    base = pd.to_datetime("2026-04-01 14:00:00+00:00", utc=True)
    rows = [
        _lot_row(id_=i, fire_time=(base + pd.Timedelta(minutes=i * 5)).isoformat(),
                 chain=f"SPY_{i}", underlying="SPY", option_type="C",
                 strike=500, spot=500, peak_ceiling_pct=25.0)
        for i in range(4)
    ]
    df = pd.DataFrame(rows)
    df = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    out = add_sequential_features(df)
    out = out.sort_values("fire_time").reset_index(drop=True)
    # Row 0: no prior -> 0; Row 1: 1 prior; Row 2: 2 prior; Row 3: 3 prior.
    assert list(out["n_same_dir_fires_last_30min"]) == [0, 1, 2, 3]


def test_prior_session_win_rate_nan_for_first_ever_ticker_fire() -> None:
    """A ticker firing for the FIRST time has no history -> prior_session_win_rate
    must be NaN."""
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="OBSCURE", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=30.0),
    ]
    df = pd.DataFrame(rows)
    df = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    out = add_sequential_features(df)
    assert pd.isna(out.iloc[0]["prior_session_win_rate_same_ticker"])
    assert out.iloc[0]["n_same_dir_fires_last_30min"] == 0


def test_prior_session_win_rate_excludes_current_day() -> None:
    """A win on day D must NOT contribute to prior_session_win_rate for any
    alert on day D — only to alerts on day D+1 or later."""
    rows = [
        # Day 1: one fire on SPY, won.
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=50.0),  # win
        # Day 1: another SPY fire same day. Must NOT see day 1 win.
        _lot_row(id_=2, fire_time="2026-04-01 15:00:00+00:00", chain="B",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=5.0),  # loss
        # Day 2: SPY fire. Should see day 1's daily win rate = 0.5.
        _lot_row(id_=3, fire_time="2026-04-02 14:30:00+00:00", chain="C",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=10.0),
    ]
    df = pd.DataFrame(rows)
    df = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    out = add_sequential_features(df)
    by_id = out.set_index("id")
    # Both Day 1 fires must have NaN (no prior history).
    assert pd.isna(by_id.loc[1, "prior_session_win_rate_same_ticker"])
    assert pd.isna(by_id.loc[2, "prior_session_win_rate_same_ticker"])
    # Day 2 fire should see Day 1's win rate = (1 win + 0 win)/2 = 0.5.
    assert by_id.loc[3, "prior_session_win_rate_same_ticker"] == pytest.approx(0.5)


def test_prior_session_win_rate_no_cross_ticker_leak() -> None:
    """AUD-C3: the expanding-mean shift must be per-ticker. A bare global
    `.shift(1)` on the grouped expanding mean makes ticker B's first date
    inherit ticker A's final win rate (future + wrong-ticker). Each ticker's
    first-ever date must be NaN regardless of other tickers' history."""
    rows = [
        # Ticker AAA: two winning days -> expanding win rate 1.0.
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A1",
                 underlying="AAA", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=80.0),  # win
        _lot_row(id_=2, fire_time="2026-04-02 14:30:00+00:00", chain="A2",
                 underlying="AAA", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=80.0),  # win
        # Ticker BBB: first-ever fire — must be NaN, NOT AAA's 1.0.
        _lot_row(id_=3, fire_time="2026-04-03 14:30:00+00:00", chain="B1",
                 underlying="BBB", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=5.0),  # loss
        # Ticker BBB second day: sees only BBB day-1 (loss) -> 0.0.
        _lot_row(id_=4, fire_time="2026-04-04 14:30:00+00:00", chain="B2",
                 underlying="BBB", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=5.0),
    ]
    df = pd.DataFrame(rows)
    df = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    out = add_sequential_features(df)
    by_id = out.set_index("id")
    col = "prior_session_win_rate_same_ticker"
    assert pd.isna(by_id.loc[1, col])  # AAA first fire — no prior
    assert pd.isna(by_id.loc[3, col])  # BBB first-ever — would leak AAA's 1.0
    assert by_id.loc[4, col] == pytest.approx(0.0)  # BBB sees only its own loss
    assert by_id.loc[2, col] == pytest.approx(1.0)  # AAA day-2 sees its day-1 win


# ── add_label ────────────────────────────────────────────────────────────────


def test_label_threshold_at_default() -> None:
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=WIN_LABEL_THRESHOLD_PCT - 0.01),
        _lot_row(id_=2, fire_time="2026-04-01 14:30:00+00:00", chain="B",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=WIN_LABEL_THRESHOLD_PCT),
        _lot_row(id_=3, fire_time="2026-04-01 14:30:00+00:00", chain="C",
                 underlying="SPY", option_type="C", strike=500, spot=500,
                 peak_ceiling_pct=WIN_LABEL_THRESHOLD_PCT + 10),
    ]
    df = pd.DataFrame(rows)
    out = add_label(df, WIN_LABEL_THRESHOLD_PCT)
    assert list(out["win"]) == [0, 1, 1]


# ── End-to-end pipeline smoke ────────────────────────────────────────────────


def test_build_lottery_from_raw_produces_expected_columns() -> None:
    # SB alert at 14:28 fires BEFORE the SPY_500C lottery at 14:30 -> cofire=1
    # (PIT-correct: counterpart must precede target).
    lot_raw = pd.DataFrame([
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=505,
                 peak_ceiling_pct=30.0),
        _lot_row(id_=2, fire_time="2026-04-01 14:32:00+00:00", chain="QQQ_400C",
                 underlying="QQQ", option_type="C", strike=400, spot=395,
                 peak_ceiling_pct=5.0),
    ])
    sb_raw = pd.DataFrame([
        _sb_row(id_=10, fire_time="2026-04-01 14:28:00+00:00", chain="SPY_500C",
                underlying="SPY", option_type="C", strike=500, spot=505),
    ])
    out = build_lottery_from_raw(lot_raw, sb_raw, WIN_LABEL_THRESHOLD_PCT)
    # Required derived columns present.
    for col in [
        "win",
        "is_itm_at_fire",
        "otm_distance_pct",
        "session_phase",
        "minute_of_day_ct",
        "day_of_week",
        "aggressive_premium_flag",
        "burst_storm_badge",
        "burst_storm_distinct_count",
        "silent_boom_cofire_within_5min",
        "silent_boom_cofire_diff_chain_within_5min",
        "n_same_dir_fires_last_30min",
        "prior_session_win_rate_same_ticker",
    ]:
        assert col in out.columns, f"missing column {col}"
    # Cofire wired correctly: SPY_500C has a SB alert within 5 min -> 1; QQQ_400C none -> 0.
    spy_row = out[out["option_chain_id"] == "SPY_500C"].iloc[0]
    qqq_row = out[out["option_chain_id"] == "QQQ_400C"].iloc[0]
    assert spy_row["silent_boom_cofire_within_5min"] == 1
    assert qqq_row["silent_boom_cofire_within_5min"] == 0
    # Diff-chain cofire: SB is on the SAME chain (SPY_500C), no sibling fire — flag stays 0.
    assert spy_row["silent_boom_cofire_diff_chain_within_5min"] == 0
    assert qqq_row["silent_boom_cofire_diff_chain_within_5min"] == 0
    # Labels.
    assert spy_row["win"] == 1
    assert qqq_row["win"] == 0


def test_build_silentboom_from_raw_produces_expected_columns() -> None:
    sb_raw = pd.DataFrame([
        _sb_row(id_=10, fire_time="2026-04-01 14:31:00+00:00", chain="SPY_500C",
                underlying="SPY", option_type="C", strike=500, spot=505,
                peak_ceiling_pct=30.0),
    ])
    lot_raw = pd.DataFrame([
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="SPY_500C",
                 underlying="SPY", option_type="C", strike=500, spot=505),
    ])
    out = build_silentboom_from_raw(sb_raw, lot_raw, WIN_LABEL_THRESHOLD_PCT)
    assert "lottery_cofire_within_5min" in out.columns
    assert "lottery_cofire_diff_chain_within_5min" in out.columns
    assert out["lottery_cofire_within_5min"].iloc[0] == 1
    # Lottery fire is on the SAME chain (SPY_500C), no sibling — diff-chain flag = 0.
    assert out["lottery_cofire_diff_chain_within_5min"].iloc[0] == 0
    assert out["win"].iloc[0] == 1


# ── Leakage smoke: no outcome columns other than the label leak through ──────


# ── Phase 3: 7-phase session_phase_cat ───────────────────────────────────────


def test_session_phase_cat_left_inclusive_boundaries() -> None:
    """Boundary convention is LEFT-inclusive — 08:30:00 → 'open', 09:00:00 →
    'opening_30'. Mirrors api/_lib/takeit-features.ts sessionPhaseCatFromMinuteCt.
    """
    # Mid-bucket samples.
    assert _session_phase_cat_from_minute_ct(8 * 60) == "pre_open"
    assert _session_phase_cat_from_minute_ct(8 * 60 + 30) == "open"
    assert _session_phase_cat_from_minute_ct(9 * 60) == "opening_30"
    assert _session_phase_cat_from_minute_ct(9 * 60 + 30) == "morning"
    assert _session_phase_cat_from_minute_ct(11 * 60) == "lunch"
    assert _session_phase_cat_from_minute_ct(13 * 60) == "afternoon"
    assert _session_phase_cat_from_minute_ct(14 * 60) == "closing"
    # Late after-hours stays in 'closing' bucket (no separate post-close label).
    assert _session_phase_cat_from_minute_ct(20 * 60) == "closing"


def test_session_phases_constant_order_is_stable() -> None:
    """SESSION_PHASES order must NOT change — the trainer pins one-hot column
    names like `session_phase_cat_open` and a reorder silently invalidates
    every existing bundle. See SESSION_PHASES doc comment in TS counterpart.
    """
    assert SESSION_PHASES == (
        "pre_open",
        "open",
        "opening_30",
        "morning",
        "lunch",
        "afternoon",
        "closing",
    )


def test_derive_common_features_emits_session_phase_cat() -> None:
    """derive_common_features adds the new session_phase_cat column alongside
    the legacy numeric session_phase."""
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500),  # 9:30 CT
        _lot_row(id_=2, fire_time="2026-04-01 19:30:00+00:00", chain="B",
                 underlying="SPY", option_type="C", strike=500, spot=500),  # 14:30 CT
    ]
    df = pd.DataFrame(rows)
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    assert "session_phase_cat" in out.columns
    assert list(out["session_phase_cat"]) == ["morning", "closing"]


# ── Phase 5: Forced-flow features ────────────────────────────────────────────


def test_quarter_end_last_hour_only_fires_on_last_weekday_of_quarter() -> None:
    """Mar/Jun/Sep/Dec last-weekday, 14:00 ≤ minute < 15:00 CT only."""
    # Mar 31 2026 = Tuesday → last weekday of Q1.
    assert _is_quarter_end_last_hour_ct(
        pd.Timestamp("2026-03-31 14:30", tz="America/Chicago")
    )
    # Mar 30 2026 (Monday) — not the last weekday.
    assert not _is_quarter_end_last_hour_ct(
        pd.Timestamp("2026-03-30 14:30", tz="America/Chicago")
    )
    # Quarter-end month + last weekday, but before 14:00 CT.
    assert not _is_quarter_end_last_hour_ct(
        pd.Timestamp("2026-03-31 13:59", tz="America/Chicago")
    )
    # Quarter-end month + last weekday, exactly 15:00 (right-exclusive).
    assert not _is_quarter_end_last_hour_ct(
        pd.Timestamp("2026-03-31 15:00", tz="America/Chicago")
    )
    # Non-quarter-end month (April) — flag stays 0 even on last weekday.
    assert not _is_quarter_end_last_hour_ct(
        pd.Timestamp("2026-04-30 14:30", tz="America/Chicago")
    )


def test_quarter_end_last_hour_handles_weekend_last_calendar_day() -> None:
    """When the last calendar day of the quarter falls on a weekend, the last
    weekday (Mon-Fri) is the quarter-end day. Mar 31 2024 = Sunday → last
    weekday is Fri Mar 29.
    """
    assert _is_quarter_end_last_hour_ct(
        pd.Timestamp("2024-03-29 14:30", tz="America/Chicago")
    )
    assert not _is_quarter_end_last_hour_ct(
        pd.Timestamp("2024-03-31 14:30", tz="America/Chicago")
    )


def test_forced_flow_features_present_with_stub_defaults() -> None:
    """derive_common_features emits all 4 forced-flow features. Stubbed ones
    are 0 by design; calendar_adjacency reflects real CT-time gating.
    """
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ]
    df = pd.DataFrame(rows)
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    for col in (
        "bilateral_flow_score",
        "cross_name_cluster_score",
        "calendar_adjacency_flag",
        "cross_asset_stress_flag",
    ):
        assert col in out.columns, f"missing column {col}"
    # Stubs default to 0 — alert row carries no bilateral / cluster context.
    assert out.iloc[0]["bilateral_flow_score"] == 0
    assert out.iloc[0]["cross_name_cluster_score"] == 0
    # Apr 1 2026 14:30 CT is not a quarter-end day.
    assert out.iloc[0]["calendar_adjacency_flag"] == 0
    # No vix_intraday_change column → cross_asset_stress stubs to 0.
    assert out.iloc[0]["cross_asset_stress_flag"] == 0


def test_calendar_adjacency_fires_on_quarter_end_last_hour() -> None:
    """Mar 31 2026 14:30 CT (Tue, last weekday of Q1) → calendar_adjacency = 1."""
    rows = [
        # 19:30 UTC = 14:30 CT (CDT, daylight time) on Mar 31 2026.
        _lot_row(id_=1, fire_time="2026-03-31 19:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ]
    df = pd.DataFrame(rows)
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    assert out.iloc[0]["calendar_adjacency_flag"] == 1


def test_cross_asset_stress_uses_vix_intraday_change_when_present() -> None:
    """If the training row carries `vix_intraday_change`, flag fires for
    values strictly greater than +3 pts."""
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500),
        _lot_row(id_=2, fire_time="2026-04-01 14:30:00+00:00", chain="B",
                 underlying="SPY", option_type="C", strike=500, spot=500),
        _lot_row(id_=3, fire_time="2026-04-01 14:30:00+00:00", chain="C",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ]
    df = pd.DataFrame(rows)
    # Inject vix_intraday_change post-hoc to simulate a future SQL join.
    df["vix_intraday_change"] = [3.0, 3.01, 5.0]
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    # Strict-greater than +3 — 3.0 itself is NOT stressed.
    assert list(out["cross_asset_stress_flag"]) == [0, 1, 1]


# ── Phase 2 / Phase 4 multileg + wave2 columns flow through unchanged ────────


def test_multileg_and_wave2_columns_pass_through_unchanged() -> None:
    """The SQL SELECT pulls inferred_structure, is_isolated_leg,
    match_confidence, pattern_group_id, wave2_status, wave2_detected_at.
    derive_common_features must NOT mutate them — they ride along into the
    output DataFrame so train.py can either use them as features (multileg)
    or exclude them (wave2 — see NON_FEATURE_COLS in train.py).
    """
    rows = [
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="A",
                 underlying="SPY", option_type="C", strike=500, spot=500),
        _lot_row(id_=2, fire_time="2026-04-01 14:35:00+00:00", chain="B",
                 underlying="SPY", option_type="P", strike=500, spot=500),
    ]
    df = pd.DataFrame(rows)
    df["inferred_structure"] = ["vertical", None]
    df["is_isolated_leg"] = [False, None]
    df["match_confidence"] = [0.85, None]
    df["pattern_group_id"] = ["hash_abc", None]
    df["wave2_status"] = ["confirmed", "fizzled"]
    df["wave2_detected_at"] = [pd.Timestamp("2026-04-01 14:42:00+00:00"), None]
    out = derive_common_features(df, "spot_at_first", "trigger_ask_pct")
    # All new columns flow through unchanged. pandas may surface None as NaN
    # in object columns; both forms mean "unclassified" which is what XGBoost
    # treats as missing.
    assert out.iloc[0]["inferred_structure"] == "vertical"
    assert pd.isna(out.iloc[1]["inferred_structure"])
    assert out.iloc[0]["is_isolated_leg"] is False or (
        out.iloc[0]["is_isolated_leg"] == 0  # noqa: PLR2004
    )
    assert pd.isna(out.iloc[1]["is_isolated_leg"])
    assert out.iloc[0]["match_confidence"] == pytest.approx(0.85)
    assert list(out["wave2_status"]) == ["confirmed", "fizzled"]


def test_no_realized_columns_leak_into_feature_set() -> None:
    """The SELECT statements should pull peak_ceiling_pct as the ONLY outcome
    column. This test verifies the built feature frames don't carry
    realized_eod_pct, realized_trail30_10_pct, or minutes_to_peak — which would
    indicate the SQL accidentally selected outcome columns."""
    lot_raw = pd.DataFrame([
        _lot_row(id_=1, fire_time="2026-04-01 14:30:00+00:00", chain="X",
                 underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    sb_raw = pd.DataFrame([
        _sb_row(id_=10, fire_time="2026-04-01 14:30:00+00:00", chain="Y",
                underlying="SPY", option_type="C", strike=500, spot=500),
    ])
    out_lot = build_lottery_from_raw(lot_raw, sb_raw, WIN_LABEL_THRESHOLD_PCT)
    out_sb = build_silentboom_from_raw(sb_raw, lot_raw, WIN_LABEL_THRESHOLD_PCT)
    for df in (out_lot, out_sb):
        for forbidden in [
            "realized_eod_pct",
            "realized_trail30_10_pct",
            "realized_hard30m_pct",
            "realized_tier50_holdeod_pct",
            "realized_flow_inversion_pct",
            "realized_30m_pct",
            "realized_60m_pct",
            "realized_120m_pct",
            "minutes_to_peak",
            "enriched_at",
        ]:
            assert forbidden not in df.columns, (
                f"leaked outcome column {forbidden}; only peak_ceiling_pct (label) is allowed"
            )
