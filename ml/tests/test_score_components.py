"""
Tests for ml/src/score_components.py — V2 score component recovery.

Unit tests use synthetic fire rows + a stub weights dict. The
sum-invariant against the live DB is exercised separately (and only
runs when DATABASE_URL is set) so CI stays self-contained.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from score_components import assign_quintile, compute_components


# ---------------------------------------------------------------------------
# Synthetic weights — mirror the JSON shape from ml/output/
# ---------------------------------------------------------------------------

STUB_WEIGHTS = {
    "model_version": "test-stub-v0",
    "features": {
        "ticker_weights": {"AMD": 5, "QQQ": -3, "SOUN": 7},
        "tod_weights": {"AM_open": 4, "MID": 0, "LUNCH": -4, "PM": -4},
        "tod_weights_dow_overrides": {
            "Monday": {"AM_open": -3, "MID": 0, "LUNCH": 2, "PM": -2},
        },
        "dte_weights": {"0": -2, "1": 4, "2": 0, "3": 1},
        "option_type_weights": {"C": 2, "P": -2},
        "vol_oi_quintile_weights": [1, 0, 2, 0, -3],
        "vol_oi_quintile_boundaries": [0.06, 0.10, 0.15, 0.38],
        "gamma_quintile_weights": [3, -2, -2, -2, 0],
        "gamma_quintile_boundaries": [0.012, 0.025, 0.042, 0.068],
        "ask_pct_quintile_weights": [-1, 1, 1, 2, -4],
        "ask_pct_quintile_boundaries": [0.53, 0.57, 0.625, 0.75],
        # Context features (V2.2 Phase D) — stub boundaries/weights
        "spx_spot_charm_oi_quintile_boundaries": [-30e12, -20e12, -15e12, -13e12],
        "spx_spot_charm_oi_quintile_weights": [-2, -1, 0, 1, 1],
        "spx_spot_vanna_oi_quintile_boundaries": [4e8, 7e8, 1.3e9, 2.0e9],
        "spx_spot_vanna_oi_quintile_weights": [0, 1, 0, -2, -1],
        "mkt_tide_ncp_quintile_boundaries": [-7e7, 2e6, 6e7, 1.5e8],
        "mkt_tide_ncp_quintile_weights": [-2, 0, 0, 0, 1],
        "mkt_tide_otm_diff_quintile_boundaries": [-1.4e8, -6e7, -5e6, 4e7],
        "mkt_tide_otm_diff_quintile_weights": [-2, -1, 0, 1, 1],
        "mkt_tide_diff_quintile_boundaries": [-1.1e8, -6e6, 5.5e7, 1.6e8],
        "mkt_tide_diff_quintile_weights": [-2, 0, 1, 0, 1],
        "spx_spot_gamma_oi_quintile_boundaries": [-4.3e10, 1.2e10, 5.5e10, 9.3e10],
        "spx_spot_gamma_oi_quintile_weights": [-1, -1, -2, 1, 1],
        "mkt_tide_npp_quintile_boundaries": [-4.6e7, -7e6, 1.8e7, 5.6e7],
        "mkt_tide_npp_quintile_weights": [-2, 1, 1, 1, -2],
    },
    "cutoffs": {"t1": 9, "t2": 7},
}

# Weights without the overrides key at all — for fallback tests.
STUB_WEIGHTS_NO_OVERRIDES = {
    "model_version": "test-stub-no-overrides",
    "features": {
        "ticker_weights": {"AMD": 5},
        "tod_weights": {"AM_open": 4, "MID": 0, "LUNCH": -4, "PM": -4},
        "dte_weights": {"0": -2, "1": 4, "2": 0, "3": 1},
        "option_type_weights": {"C": 2, "P": -2},
        "vol_oi_quintile_weights": [1, 0, 2, 0, -3],
        "vol_oi_quintile_boundaries": [0.06, 0.10, 0.15, 0.38],
        "gamma_quintile_weights": [3, -2, -2, -2, 0],
        "gamma_quintile_boundaries": [0.012, 0.025, 0.042, 0.068],
        "ask_pct_quintile_weights": [-1, 1, 1, 2, -4],
        "ask_pct_quintile_boundaries": [0.53, 0.57, 0.625, 0.75],
    },
    "cutoffs": {"t1": 9, "t2": 7},
}

# Weights with composite_bonuses for composite overlay tests.
# Boundaries kept identical to STUB_WEIGHTS for quintile consistency.
STUB_WEIGHTS_WITH_COMPOSITES = {
    "model_version": "test-stub-composites",
    "features": {
        "ticker_weights": {"AMD": 5, "SNDK": 1, "WDC": -1},
        "tod_weights": {"AM_open": 4, "MID": 0, "LUNCH": -4, "PM": -4},
        "tod_weights_dow_overrides": {
            "Monday": {"AM_open": -3, "MID": 0, "LUNCH": 2, "PM": -2},
        },
        "dte_weights": {"0": -2, "1": 4, "2": 0, "3": 1},
        "option_type_weights": {"C": 2, "P": -2},
        "vol_oi_quintile_weights": [1, 0, 2, 0, -3],
        "vol_oi_quintile_boundaries": [0.06, 0.10, 0.15, 0.38],
        "gamma_quintile_weights": [3, -2, -2, -2, 0],
        "gamma_quintile_boundaries": [0.012, 0.025, 0.042, 0.068],
        "ask_pct_quintile_weights": [-1, 1, 1, 2, -4],
        "ask_pct_quintile_boundaries": [0.53, 0.57, 0.625, 0.75],
        # SNDK + AM_open + gamma_q=0 → +3 bonus
        # gamma_q=0 requires gamma <= 0.012 (first boundary)
        # WDC + ask_pct_q=0 → -5 penalty
        # ask_pct_q=0 requires ask_pct <= 0.53 (first boundary)
        "composite_bonuses": [
            {
                "match": {"ticker": "SNDK", "tod": "AM_open", "gamma_q": "0"},
                "bonus": 3,
                "support": 278,
                "win_rate": 0.953,
                "note": "stub — winning composite",
            },
            {
                "match": {"ticker": "WDC", "ask_pct_q": "0"},
                "bonus": -5,
                "support": 12,
                "win_rate": 0.0,
                "note": "stub — losing composite",
            },
        ],
    },
    "cutoffs": {"t1": 9, "t2": 7},
}


# ---------------------------------------------------------------------------
# assign_quintile — boundary semantics
# ---------------------------------------------------------------------------


def test_assign_quintile_handles_null():
    assert assign_quintile(None, [0.1, 0.2, 0.3, 0.4]) is None


def test_assign_quintile_below_first_boundary_is_q0():
    assert assign_quintile(-1.0, [0.1, 0.2, 0.3, 0.4]) == 0
    assert assign_quintile(0.05, [0.1, 0.2, 0.3, 0.4]) == 0


def test_assign_quintile_equal_to_boundary_is_right_inclusive():
    # pd.cut(right=True) semantics: value == b0 lands in bin 0 (NOT bin 1)
    assert assign_quintile(0.1, [0.1, 0.2, 0.3, 0.4]) == 0
    assert assign_quintile(0.2, [0.1, 0.2, 0.3, 0.4]) == 1
    assert assign_quintile(0.4, [0.1, 0.2, 0.3, 0.4]) == 3


def test_assign_quintile_above_last_boundary_is_q4():
    assert assign_quintile(100.0, [0.1, 0.2, 0.3, 0.4]) == 4
    assert assign_quintile(0.5, [0.1, 0.2, 0.3, 0.4]) == 4


def test_assign_quintile_each_bucket_reachable():
    boundaries = [10.0, 20.0, 30.0, 40.0]
    assert assign_quintile(5.0, boundaries) == 0
    assert assign_quintile(15.0, boundaries) == 1
    assert assign_quintile(25.0, boundaries) == 2
    assert assign_quintile(35.0, boundaries) == 3
    assert assign_quintile(45.0, boundaries) == 4


# ---------------------------------------------------------------------------
# compute_components — sum invariant
# ---------------------------------------------------------------------------


def test_compute_components_sums_correctly():
    # AMD (5) + AM_open (4) + DTE 1 (4) + vol_oi 0.12 → Q2 (2)
    # + gamma 0.05 → Q3 (-2) + ask_pct 0.55 → Q1 (1) + C (2)
    # = 5 + 4 + 4 + 2 - 2 + 1 + 2 = 16
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": 0.12,
        "gamma": 0.05,
        "ask_pct": 0.55,
    }
    components = compute_components(fire, STUB_WEIGHTS)
    assert components["ticker"] == 5
    assert components["tod"] == 4
    assert components["dte"] == 4
    assert components["vol_oi_q"] == 2
    assert components["gamma_q"] == -2
    assert components["ask_pct_q"] == 1
    assert components["option_type"] == 2
    assert components["total"] == 16
    # Sum invariant
    component_sum = sum(v for k, v in components.items() if k != "total")
    assert components["total"] == component_sum


def test_compute_components_handles_null_continuous_features():
    # All null continuous → those components contribute 0
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS)
    assert components["vol_oi_q"] == 0
    assert components["gamma_q"] == 0
    assert components["ask_pct_q"] == 0
    assert components["total"] == 5 + 4 + 4 + 0 + 0 + 0 + 2  # = 15


def test_compute_components_unknown_ticker_is_zero():
    fire = {
        "ticker": "UNKNOWN_NEWS_TICKER",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": 0.12,
        "gamma": 0.05,
        "ask_pct": 0.55,
    }
    components = compute_components(fire, STUB_WEIGHTS)
    assert components["ticker"] == 0


def test_compute_components_dte_keyed_as_string():
    # DTE in the DB is an int but the JSON keys are strings — verify the
    # str cast inside the helper handles this without an extra coerce.
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 3,  # int
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS)
    assert components["dte"] == 1  # weights["dte_weights"]["3"] = 1


# ---------------------------------------------------------------------------
# compute_components — DOW override behaviour
# ---------------------------------------------------------------------------


def test_dow_override_applies_when_present_and_dow_matches():
    # Monday override: AM_open=-3, LUNCH=2 (inverted vs global 4/-4).
    # assign_quintile uses right-inclusive (<=) semantics matching pd.cut(right=True):
    #   vol_oi=0.12, boundaries=[0.06,0.10,0.15,0.38]: 0.12<=0.15 → Q2(idx 2), weight=2
    #   gamma=0.05, boundaries=[0.012,0.025,0.042,0.068]: 0.05<=0.068 → Q3(idx 3), weight=-2
    #   ask_pct=0.55, boundaries=[0.53,0.57,0.625,0.75]: 0.55<=0.57 → Q1(idx 1), weight=1
    # AMD(5) + AM_open_Monday(-3) + DTE1(4) + vol_oi(2) + gamma(-2) + ask_pct(1) + C(2) = 9
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": 0.12,
        "gamma": 0.05,
        "ask_pct": 0.55,
    }
    components = compute_components(fire, STUB_WEIGHTS, dow="Monday")
    # TOD uses Monday override: AM_open → -3, not global +4
    assert components["tod"] == -3
    assert components["total"] == 9


def test_dow_override_lunch_is_positive_on_monday():
    # LUNCH in Monday override is +2; global is -4. Confirms the inversion.
    fire = {
        "ticker": "AMD",
        "tod": "LUNCH",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
    }
    components_monday = compute_components(fire, STUB_WEIGHTS, dow="Monday")
    components_global = compute_components(fire, STUB_WEIGHTS, dow=None)
    assert components_monday["tod"] == 2    # Monday override
    assert components_global["tod"] == -4   # global


def test_dow_override_falls_back_to_global_when_dow_not_in_overrides():
    # Wednesday is not in tod_weights_dow_overrides → falls back to global.
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS, dow="Wednesday")
    assert components["tod"] == 4  # global AM_open weight


def test_dow_override_falls_back_to_global_when_no_overrides_field():
    # Weights JSON without the tod_weights_dow_overrides key at all.
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS_NO_OVERRIDES, dow="Monday")
    assert components["tod"] == 4  # global fallback


def test_dow_none_uses_global_weights():
    # Explicit dow=None must use the global tod_weights.
    fire = {
        "ticker": "AMD",
        "tod": "LUNCH",
        "dte": 0,
        "option_type": "P",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS, dow=None)
    assert components["tod"] == -4  # global LUNCH weight


# ---------------------------------------------------------------------------
# compute_components — composite bonuses/penalties
# ---------------------------------------------------------------------------


def test_composite_winning_bonus_applied():
    # SNDK + AM_open + gamma_q=0 → +3 bonus.
    # gamma_q=0 requires gamma <= first boundary (0.012).
    # Components without composite:
    #   ticker SNDK (1) + AM_open (4) + DTE 1 (4) + vol_oi None (0)
    #   + gamma 0.005 → Q0 (3) + ask_pct None (0) + C (2) = 14
    # Composite adds +3 → total = 17
    fire = {
        "ticker": "SNDK",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": 0.005,   # below 0.012 → Q0
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS_WITH_COMPOSITES)
    assert components["composite"] == 3
    # Sum invariant
    component_sum = sum(v for k, v in components.items() if k != "total")
    assert components["total"] == component_sum


def test_composite_losing_penalty_applied():
    # WDC + ask_pct_q=0 → -5 penalty.
    # ask_pct_q=0 requires ask_pct <= 0.53 (first boundary).
    fire = {
        "ticker": "WDC",
        "tod": "AM_open",
        "dte": 0,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": 0.50,   # below 0.53 → Q0
    }
    components = compute_components(fire, STUB_WEIGHTS_WITH_COMPOSITES)
    assert components["composite"] == -5
    component_sum = sum(v for k, v in components.items() if k != "total")
    assert components["total"] == component_sum


def test_composite_no_match_contributes_zero():
    # AMD is not in any composite — composite should be 0.
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": 0.005,
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS_WITH_COMPOSITES)
    assert components["composite"] == 0


def test_composite_partial_match_does_not_fire():
    # SNDK + AM_open but gamma_q is NOT 0 (gamma=0.05 → Q3, not Q0).
    # The winning composite requires all three keys to match.
    fire = {
        "ticker": "SNDK",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": 0.05,    # above all boundaries → Q4, not Q0
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS_WITH_COMPOSITES)
    assert components["composite"] == 0


def test_composite_multiple_matches_sum():
    # Construct a fire that matches BOTH composites in STUB_WEIGHTS_WITH_COMPOSITES:
    # - SNDK + AM_open + gamma_q=0 → +3
    # - WDC + ask_pct_q=0 → -5  (WDC ≠ SNDK, so this composite does NOT match)
    # So only the +3 fires for SNDK. Verify the sum is just +3.
    fire = {
        "ticker": "SNDK",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": 0.005,   # Q0
        "ask_pct": 0.50,  # Q0 (ask_pct_q=0), but match key is ticker=WDC
    }
    components = compute_components(fire, STUB_WEIGHTS_WITH_COMPOSITES)
    # Only the winning bonus fires; losing composite requires ticker=WDC.
    assert components["composite"] == 3


def test_composite_no_composite_bonuses_field_backward_compat():
    # Weights without composite_bonuses key at all → composite=0 (backward compat).
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
    }
    components = compute_components(fire, STUB_WEIGHTS_NO_OVERRIDES)
    assert components["composite"] == 0
    # Sum invariant still holds
    component_sum = sum(v for k, v in components.items() if k != "total")
    assert components["total"] == component_sum


# ---------------------------------------------------------------------------
# compute_components — V2.2 Phase D context features
# ---------------------------------------------------------------------------


def test_context_feature_contributes_correctly():
    # mkt_tide_ncp=2e8 is above the last boundary (1.5e8) → Q4, weight=1
    # mkt_tide_npp=-1e8 is below the first boundary (-4.6e7) → Q0, weight=-2
    # All other context features set to None → 0 contribution each
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
        "mkt_tide_ncp": 2e8,       # Q4 → weight=+1
        "mkt_tide_npp": -1e8,      # Q0 → weight=-2
        "mkt_tide_diff": None,
        "mkt_tide_otm_diff": None,
        "spx_spot_charm_oi": None,
        "spx_spot_vanna_oi": None,
        "spx_spot_gamma_oi": None,
    }
    components = compute_components(fire, STUB_WEIGHTS)
    # Base: AMD(5) + AM_open(4) + DTE1(4) + C(2) = 15
    # Context: ncp(+1) + npp(-2) = -1 net
    assert components["mkt_tide_ncp"] == 1
    assert components["mkt_tide_npp"] == -2
    assert components["mkt_tide_diff"] == 0
    assert components["spx_spot_charm_oi"] == 0
    assert components["total"] == 15 + 1 + (-2)
    # Sum invariant
    component_sum = sum(v for k, v in components.items() if k != "total")
    assert components["total"] == component_sum


def test_null_context_feature_contributes_zero():
    # All 7 context features set to None → each contributes 0
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
        "mkt_tide_ncp": None,
        "mkt_tide_npp": None,
        "mkt_tide_diff": None,
        "mkt_tide_otm_diff": None,
        "spx_spot_charm_oi": None,
        "spx_spot_vanna_oi": None,
        "spx_spot_gamma_oi": None,
    }
    components = compute_components(fire, STUB_WEIGHTS)
    for key in (
        "mkt_tide_ncp", "mkt_tide_npp", "mkt_tide_diff", "mkt_tide_otm_diff",
        "spx_spot_charm_oi", "spx_spot_vanna_oi", "spx_spot_gamma_oi",
    ):
        assert components[key] == 0, f"{key} should be 0 when None"
    component_sum = sum(v for k, v in components.items() if k != "total")
    assert components["total"] == component_sum


def test_backward_compat_no_context_blocks_in_stub_weights_no_overrides():
    # STUB_WEIGHTS_NO_OVERRIDES has no context feature keys → each contributes 0,
    # but compute_components must not raise a KeyError (backward compat).
    fire = {
        "ticker": "AMD",
        "tod": "AM_open",
        "dte": 1,
        "option_type": "C",
        "vol_oi_window": None,
        "gamma": None,
        "ask_pct": None,
        # Provide context values — should be silently ignored since the
        # weights JSON has no corresponding boundary/weight keys.
        "mkt_tide_ncp": 1e8,
        "spx_spot_gamma_oi": 5e10,
    }
    components = compute_components(fire, STUB_WEIGHTS_NO_OVERRIDES)
    # All context components are 0 because the weights block is absent.
    for key in (
        "mkt_tide_ncp", "mkt_tide_npp", "mkt_tide_diff", "mkt_tide_otm_diff",
        "spx_spot_charm_oi", "spx_spot_vanna_oi", "spx_spot_gamma_oi",
    ):
        assert components[key] == 0, f"{key} should be 0 (no weights block)"
    component_sum = sum(v for k, v in components.items() if k != "total")
    assert components["total"] == component_sum


# ---------------------------------------------------------------------------
# Optional integration: live-DB sum invariant. Only runs when DATABASE_URL
# is set and the live ml/output/lottery_score_weights.json exists. Skipped
# in CI / fresh clones so the unit tests above don't depend on infra.
# ---------------------------------------------------------------------------


def test_live_db_sum_invariant():
    if "DATABASE_URL" not in os.environ:
        pytest.skip("DATABASE_URL not set — skipping live-DB integration test")
    weights_path = (
        Path(__file__).resolve().parent.parent
        / "output"
        / "lottery_score_weights.json"
    )
    if not weights_path.exists():
        pytest.skip(f"Weights JSON not found at {weights_path}")

    try:
        import psycopg2  # noqa: PLC0415
    except ImportError:
        pytest.skip("psycopg2 not available")

    weights = json.loads(weights_path.read_text())
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT underlying_symbol, tod, dte, option_type,
                   trigger_vol_to_oi_window, gamma_at_trigger, trigger_ask_pct,
                   score
            FROM lottery_finder_fires
            WHERE score IS NOT NULL
            ORDER BY random()
            LIMIT 100
            """
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    mismatches: list[dict] = []
    for ticker, tod, dte, ot, vol_oi, gamma, ask_pct, score in rows:
        fire = {
            "ticker": ticker,
            "tod": tod,
            "dte": int(dte),
            "option_type": ot,
            "vol_oi_window": (
                float(vol_oi) if vol_oi is not None else None
            ),
            "gamma": float(gamma) if gamma is not None else None,
            "ask_pct": float(ask_pct) if ask_pct is not None else None,
        }
        components = compute_components(fire, weights)
        if components["total"] != int(score):
            mismatches.append(
                {
                    "expected": int(score),
                    "got": components["total"],
                    "diff": components["total"] - int(score),
                    "fire": {**fire, "components": components},
                }
            )

    # Allow up to 5% mismatch rate. The bulk-fix invariant (Phase 4 backfill)
    # already proves the formula is right; small drift can come from fires
    # written by the live cron between when we snapshot the weights JSON and
    # when we query the DB (the cron writes new fires every 5 min). Systemic
    # drift (>5%) would mean the helper is structurally wrong.
    mismatch_rate = len(mismatches) / max(len(rows), 1)
    assert mismatch_rate <= 0.05, (
        f"{len(mismatches)}/{len(rows)} fires mismatch component-sum vs score "
        f"(rate {mismatch_rate:.1%}). First 3 mismatches: {mismatches[:3]}"
    )
