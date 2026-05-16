"""Unit tests for features.py — especially the cumulative-vol gotcha.

Run from repo root:
    ml/.venv/bin/pytest ml/experiments/round-trip-suppression-eda/tests/ -v
"""
from __future__ import annotations

from datetime import datetime, timezone

import polars as pl
import pytest

# pytest discovery: add experiment dir to path so we can import features.
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from features import (  # noqa: E402
    annotate_per_print_sides,
    compute_per_print_multi_leg_size,
    features_for_alert,
    _parse_tag_set,
    _side_from_tags,
    _nbbo_reclassify,
)


def _make_fulltape(rows: list[dict]) -> pl.DataFrame:
    """Construct a minimal fulltape-shaped frame for testing."""
    schema = {
        'option_chain_id': pl.Utf8,
        'executed_at': pl.Datetime('us', 'UTC'),
        'size': pl.Int32,
        'price': pl.Float64,
        'premium': pl.Float64,
        'nbbo_bid': pl.Float64,
        'nbbo_ask': pl.Float64,
        'open_interest': pl.Int32,
        'tags': pl.Utf8,
        'multi_vol': pl.Int32,
        'canceled': pl.Boolean,
    }
    return pl.DataFrame(rows, schema=schema)


# ─────────────────────────────────────────────────────────────────
# Tag parsing
# ─────────────────────────────────────────────────────────────────

def test_parse_tag_set_empty():
    assert _parse_tag_set('{}') == set()
    assert _parse_tag_set('') == set()
    assert _parse_tag_set(None) == set()


def test_parse_tag_set_single():
    assert _parse_tag_set('{ask_side}') == {'ask_side'}


def test_parse_tag_set_multi():
    assert _parse_tag_set('{ask_side,bullish,earnings_next_week}') == {
        'ask_side', 'bullish', 'earnings_next_week'
    }


def test_side_from_tags():
    assert _side_from_tags('{ask_side,bullish}') == 'ask'
    assert _side_from_tags('{bid_side,bearish}') == 'bid'
    assert _side_from_tags('{mid_side}') == 'mid'
    assert _side_from_tags('{no_side}') == 'unknown'
    assert _side_from_tags('{bullish}') == 'unknown'  # no side literal
    assert _side_from_tags(None) == 'unknown'
    assert _side_from_tags('{}') == 'unknown'


# ─────────────────────────────────────────────────────────────────
# NBBO reclassification
# ─────────────────────────────────────────────────────────────────

def test_nbbo_reclassify_ask_lean():
    # bid=10, ask=11, price=10.80 → pos=0.80 → ask
    assert _nbbo_reclassify(10.80, 10.0, 11.0) == 'ask'


def test_nbbo_reclassify_bid_lean():
    # bid=10, ask=11, price=10.20 → pos=0.20 → bid
    assert _nbbo_reclassify(10.20, 10.0, 11.0) == 'bid'


def test_nbbo_reclassify_true_mid():
    # bid=10, ask=11, price=10.50 → pos=0.50 → mid
    assert _nbbo_reclassify(10.50, 10.0, 11.0) == 'mid'


def test_nbbo_reclassify_degenerate_spread():
    # ask <= bid → mid (no information)
    assert _nbbo_reclassify(10.0, 10.5, 10.0) == 'mid'
    assert _nbbo_reclassify(10.0, 10.0, 10.0) == 'mid'


# ─────────────────────────────────────────────────────────────────
# Cumulative multi_vol → per-print delta (THE GOTCHA)
# ─────────────────────────────────────────────────────────────────

def test_multi_vol_delta_basic():
    """multi_vol is CUMULATIVE; per-print should be the delta."""
    base_ts = datetime(2026, 5, 14, 14, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        # 3 prints, multi_vol grows cumulatively: 0 → 100 → 100 → 250
        # per-print multi = [0, 100, 0, 150]
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=0),
         'size': 50, 'price': 1.0, 'premium': 5000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=1),
         'size': 100, 'price': 1.0, 'premium': 10000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 100, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=2),
         'size': 30, 'price': 1.0, 'premium': 3000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 100, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=3),
         'size': 150, 'price': 1.0, 'premium': 15000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 250, 'canceled': False},
    ])
    result = compute_per_print_multi_leg_size(df)
    assert result['per_print_multi_size'].to_list() == [0, 100, 0, 150]


def test_multi_vol_delta_clamped_to_size():
    """If cumulative drops or jumps non-monotonically, clip at [0, size]."""
    base_ts = datetime(2026, 5, 14, 14, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        # multi_vol jumps to 200 on a size=50 print — clamp delta to 50
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=0),
         'size': 50, 'price': 1.0, 'premium': 5000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=1),
         'size': 50, 'price': 1.0, 'premium': 5000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 200, 'canceled': False},
    ])
    result = compute_per_print_multi_leg_size(df)
    # Second row: delta = 200, capped at size=50
    assert result['per_print_multi_size'].to_list() == [0, 50]


def test_multi_vol_delta_nonmonotonic_floored_at_zero():
    """If cumulative goes backwards (e.g. cancellation), delta floors at 0.

    First print: multi_vol jumps to 200 on size=50 → delta capped at size = 50.
    Second print: multi_vol drops to 100 (delta = -100) → floored at 0.
    """
    base_ts = datetime(2026, 5, 14, 14, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=0),
         'size': 50, 'price': 1.0, 'premium': 5000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 200, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': base_ts.replace(minute=1),
         'size': 50, 'price': 1.0, 'premium': 5000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 100, 'canceled': False},
    ])
    result = compute_per_print_multi_leg_size(df)
    # First row: delta=200, capped at size=50. Second row: delta=-100, floored to 0.
    assert result['per_print_multi_size'].to_list() == [50, 0]


# ─────────────────────────────────────────────────────────────────
# annotate_per_print_sides
# ─────────────────────────────────────────────────────────────────

def test_annotate_per_print_sides_uses_tag_when_available():
    base_ts = datetime(2026, 5, 14, 14, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        {'option_chain_id': 'X', 'executed_at': base_ts,
         'size': 100, 'price': 1.04, 'premium': 10400.0, 'nbbo_bid': 1.0, 'nbbo_ask': 1.1,
         'open_interest': 50, 'tags': '{ask_side,bullish}', 'multi_vol': 0, 'canceled': False},
    ])
    out = annotate_per_print_sides(df)
    assert out['tag_side'][0] == 'ask'
    assert out['final_side'][0] == 'ask'


def test_annotate_per_print_sides_falls_back_to_nbbo_for_mid():
    """When tag is mid/unknown, fall back to NBBO position to refine."""
    base_ts = datetime(2026, 5, 14, 14, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        # tag is mid, but price is at 0.95*spread above bid → should reclassify to ask
        {'option_chain_id': 'X', 'executed_at': base_ts,
         'size': 100, 'price': 1.095, 'premium': 10950.0, 'nbbo_bid': 1.0, 'nbbo_ask': 1.10,
         'open_interest': 50, 'tags': '{mid_side}', 'multi_vol': 0, 'canceled': False},
    ])
    out = annotate_per_print_sides(df)
    assert out['tag_side'][0] == 'mid'
    assert out['nbbo_side'][0] == 'ask'  # 0.95 position
    assert out['final_side'][0] == 'ask'  # falls back to nbbo since tag was mid


# ─────────────────────────────────────────────────────────────────
# Full features_for_alert — end-to-end round-trip detection
# ─────────────────────────────────────────────────────────────────

def test_features_for_alert_clean_round_trip():
    """Classic round-trip: 100c ask at fire, 100c bid 30 min later. net = 0."""
    fire = datetime(2026, 5, 14, 18, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        # pre-fire opening print
        {'option_chain_id': 'MU260522P00702500', 'executed_at': fire,
         'size': 100, 'price': 26.18, 'premium': 261800.0, 'nbbo_bid': 26.0, 'nbbo_ask': 26.20,
         'open_interest': 50, 'tags': '{ask_side,bullish}', 'multi_vol': 0, 'canceled': False},
        # post-fire close at +30 min
        {'option_chain_id': 'MU260522P00702500', 'executed_at': fire.replace(minute=30),
         'size': 100, 'price': 22.00, 'premium': 220000.0, 'nbbo_bid': 22.0, 'nbbo_ask': 22.20,
         'open_interest': 50, 'tags': '{bid_side,bearish}', 'multi_vol': 0, 'canceled': False},
    ])
    feats = features_for_alert(df, 'MU260522P00702500', fire, window_minutes=60)
    assert feats.post_fire_print_count == 1
    assert feats.post_fire_total_size == 100
    assert feats.post_fire_ask_size == 0
    assert feats.post_fire_bid_size == 100
    assert feats.post_fire_net_ask_minus_bid == -100
    assert feats.post_fire_net_pct_of_volume == -1.0
    # OI unchanged → suggests intraday round-trip (no overnight hold)
    assert feats.oi_delta_intraday == 0
    # 50% reversal: cum_bid >= 0.5 * cum_ask. cum_ask = 0 post-fire, so condition never satisfied
    assert feats.time_to_50pct_reversal_min is None  # cum_ask == 0 in post-fire


def test_features_for_alert_held_position_no_reversal():
    """Position is HELD: only ask flow continues post-fire. No reversal."""
    fire = datetime(2026, 5, 14, 18, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        {'option_chain_id': 'X', 'executed_at': fire,
         'size': 100, 'price': 1.0, 'premium': 10000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': fire.replace(minute=15),
         'size': 50, 'price': 1.10, 'premium': 5500.0, 'nbbo_bid': 1.05, 'nbbo_ask': 1.15,
         'open_interest': 200, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': fire.replace(minute=30),
         'size': 30, 'price': 1.20, 'premium': 3600.0, 'nbbo_bid': 1.15, 'nbbo_ask': 1.25,
         'open_interest': 230, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
    ])
    feats = features_for_alert(df, 'X', fire, window_minutes=60)
    assert feats.post_fire_ask_size == 80
    assert feats.post_fire_bid_size == 0
    assert feats.post_fire_net_ask_minus_bid == 80
    assert feats.post_fire_net_pct_of_volume == 1.0  # all ask
    assert feats.oi_delta_intraday == 130  # OI grew 100 → 230
    assert feats.time_to_50pct_reversal_min is None


def test_features_for_alert_partial_reversal():
    """50% reversal: ask 200 then bid 100. cum_bid (100) >= 0.5 * cum_ask (200)."""
    fire = datetime(2026, 5, 14, 18, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        {'option_chain_id': 'X', 'executed_at': fire.replace(minute=5),
         'size': 200, 'price': 1.05, 'premium': 21000.0, 'nbbo_bid': 1.0, 'nbbo_ask': 1.1,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': fire.replace(minute=20),
         'size': 100, 'price': 0.95, 'premium': 9500.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{bid_side}', 'multi_vol': 0, 'canceled': False},
    ])
    feats = features_for_alert(df, 'X', fire, window_minutes=60)
    assert feats.post_fire_ask_size == 200
    assert feats.post_fire_bid_size == 100
    assert feats.post_fire_net_ask_minus_bid == 100
    # 50% reversal lands at the bid print: 20 - 0 = 20 min from fire
    assert feats.time_to_50pct_reversal_min == pytest.approx(20.0)


def test_features_for_alert_empty_post_window():
    """No post-fire prints → all zeros, OI delta still computed if pre-fire prints exist."""
    fire = datetime(2026, 5, 14, 19, 55, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        {'option_chain_id': 'X', 'executed_at': fire.replace(minute=50),
         'size': 100, 'price': 1.0, 'premium': 10000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 100, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
    ])
    feats = features_for_alert(df, 'X', fire, window_minutes=60)
    assert feats.post_fire_print_count == 0
    assert feats.post_fire_total_size == 0
    assert feats.oi_at_fire == 100
    assert feats.oi_at_eod == 100
    assert feats.oi_delta_intraday == 0
    assert feats.time_to_50pct_reversal_min is None


def test_features_for_alert_filters_canceled():
    """Cancelled prints must be filtered out before any computation."""
    fire = datetime(2026, 5, 14, 18, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        {'option_chain_id': 'X', 'executed_at': fire.replace(minute=5),
         'size': 100, 'price': 1.0, 'premium': 10000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 50, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
        {'option_chain_id': 'X', 'executed_at': fire.replace(minute=10),
         'size': 100, 'price': 1.0, 'premium': 10000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 50, 'tags': '{bid_side}', 'multi_vol': 0, 'canceled': True},  # ← excluded
    ])
    feats = features_for_alert(df, 'X', fire, window_minutes=60)
    # Only the ask print survives
    assert feats.post_fire_ask_size == 100
    assert feats.post_fire_bid_size == 0


def test_features_for_alert_requires_utc_tzinfo():
    fire = datetime(2026, 5, 14, 18, 0, 0)  # naive
    df = _make_fulltape([])
    with pytest.raises(ValueError, match='timezone-aware'):
        features_for_alert(df, 'X', fire)


def test_features_for_alert_filters_to_chain_id():
    """Other contracts in the same fulltape day must not bleed in."""
    fire = datetime(2026, 5, 14, 18, 0, 0, tzinfo=timezone.utc)
    df = _make_fulltape([
        {'option_chain_id': 'OTHER', 'executed_at': fire.replace(minute=10),
         'size': 9999, 'price': 1.0, 'premium': 999900.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 1000, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
        {'option_chain_id': 'TARGET', 'executed_at': fire.replace(minute=5),
         'size': 100, 'price': 1.0, 'premium': 10000.0, 'nbbo_bid': 0.95, 'nbbo_ask': 1.05,
         'open_interest': 50, 'tags': '{ask_side}', 'multi_vol': 0, 'canceled': False},
    ])
    feats = features_for_alert(df, 'TARGET', fire, window_minutes=60)
    assert feats.post_fire_total_size == 100  # only TARGET, not OTHER
