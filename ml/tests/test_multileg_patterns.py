"""Tests for multileg_patterns — declarative pattern definitions.

These are PURE-FUNCTION tests over plain ``Leg`` dicts. No DataFrame, no
database, no I/O. This module is vendored into two production Railway
services (sidecar + classifier under ``_vendored_ml/``), so these tests are
a genuine safety net for the spread-classification constraint logic.

Pattern set (v1, fixed): vertical | strangle | risk_reversal | butterfly.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from datetime import date

import pytest

import multileg_patterns
from multileg_patterns import (
    PATTERNS,
    PatternSpec,
    check_directions,
    check_shared_attrs,
)

EXP_A = date(2026, 5, 23)
EXP_B = date(2026, 6, 20)


# ── Leg builders ────────────────────────────────────────────────────────────


def _leg(
    *,
    side: str = "buy",
    strike: float = 200.0,
    size: float = 10.0,
    option_type: str = "call",
    expiry: date = EXP_A,
) -> dict[str, object]:
    """Build a single candidate-evaluation leg dict."""
    return {
        "side": side,
        "strike": float(strike),
        "size": float(size),
        "option_type": option_type,
        "expiry": expiry,
    }


# ── _dirs_compatible ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("a", "b", "opposite", "expected"),
    [
        # opposite=True truth table (non-mid)
        ("buy", "sell", True, True),
        ("sell", "buy", True, True),
        ("buy", "buy", True, False),
        ("sell", "sell", True, False),
        # opposite=False truth table (non-mid)
        ("buy", "buy", False, True),
        ("sell", "sell", False, True),
        ("buy", "sell", False, False),
        ("sell", "buy", False, False),
        # 'mid' is ambiguous-compatible with either rule / either position
        ("mid", "sell", True, True),
        ("buy", "mid", True, True),
        ("mid", "buy", False, True),
        ("sell", "mid", False, True),
        ("mid", "mid", True, True),
        ("mid", "mid", False, True),
    ],
)
def test_dirs_compatible(a: str, b: str, opposite: bool, expected: bool) -> None:
    assert (
        multileg_patterns._dirs_compatible(a, b, opposite=opposite) is expected
    )


# ── _all_same_direction (butterfly direction rule) ──────────────────────────


def _three_legs(wing_a: str, body: str, wing_b: str) -> list[dict[str, object]]:
    """Three legs at ascending strikes: idx0=wing, idx1=body, idx2=wing."""
    return [
        _leg(side=wing_a, strike=195.0),
        _leg(side=body, strike=200.0),
        _leg(side=wing_b, strike=205.0),
    ]


def test_all_same_direction_body_opposite_wings_accept() -> None:
    # Wings agree (buy/buy), body opposite (sell) — valid butterfly.
    legs = _three_legs("buy", "sell", "buy")
    assert (
        multileg_patterns._all_same_direction(legs, opposite_to_others=True)
        is True
    )


def test_all_same_direction_body_same_as_wings_reject() -> None:
    # Wings buy/buy, body also buy — body not opposite → reject.
    legs = _three_legs("buy", "buy", "buy")
    assert (
        multileg_patterns._all_same_direction(legs, opposite_to_others=True)
        is False
    )


def test_all_same_direction_wing_disagreement_reject() -> None:
    # Wings disagree (buy vs sell, neither mid) → reject before body check.
    legs = _three_legs("buy", "sell", "sell")
    assert (
        multileg_patterns._all_same_direction(legs, opposite_to_others=True)
        is False
    )


def test_all_same_direction_both_wings_mid_early_accept() -> None:
    # Both wings mid → ref resolves to mid → accept regardless of body.
    legs = _three_legs("mid", "buy", "mid")
    assert (
        multileg_patterns._all_same_direction(legs, opposite_to_others=True)
        is True
    )


def test_all_same_direction_one_wing_mid_uses_other_as_ref() -> None:
    # wing_a mid, wing_b sell → ref=sell; body buy is opposite → accept.
    legs = _three_legs("mid", "buy", "sell")
    assert (
        multileg_patterns._all_same_direction(legs, opposite_to_others=True)
        is True
    )
    # body sell == ref sell → not opposite → reject.
    legs_bad = _three_legs("mid", "sell", "sell")
    assert (
        multileg_patterns._all_same_direction(legs_bad, opposite_to_others=True)
        is False
    )


def test_all_same_direction_not_opposite_flag_short_circuits() -> None:
    # opposite_to_others=False: only the wings-agree check matters.
    legs = _three_legs("buy", "buy", "buy")
    assert (
        multileg_patterns._all_same_direction(legs, opposite_to_others=False)
        is True
    )
    # Wings disagree → still rejected even when not requiring body-opposite.
    legs_bad = _three_legs("buy", "buy", "sell")
    assert (
        multileg_patterns._all_same_direction(
            legs_bad, opposite_to_others=False
        )
        is False
    )


# ── _two_strikes_differ ─────────────────────────────────────────────────────


def test_two_strikes_differ_near_duplicate_is_same() -> None:
    # 190.0 vs 190.005 → within near-duplicate fraction → NOT distinct.
    legs = [_leg(strike=190.0), _leg(strike=190.005)]
    assert multileg_patterns._two_strikes_differ(legs, _tol=0.05) is False


def test_two_strikes_differ_dollar_wide_vertical_is_distinct() -> None:
    # $1-wide vertical at 190 → 0.53% gap, above the 1e-4 fraction → distinct.
    legs = [_leg(strike=190.0), _leg(strike=191.0)]
    assert multileg_patterns._two_strikes_differ(legs, _tol=0.05) is True


def test_two_strikes_differ_tol_arg_is_ignored() -> None:
    # _tol is intentionally unused: a huge tol does not change the verdict.
    legs = [_leg(strike=190.0), _leg(strike=191.0)]
    assert multileg_patterns._two_strikes_differ(legs, _tol=10.0) is True


# ── _equidistant_three ──────────────────────────────────────────────────────


def test_equidistant_three_even_spacing_accept() -> None:
    legs = [_leg(strike=195.0), _leg(strike=200.0), _leg(strike=205.0)]
    assert multileg_patterns._equidistant_three(legs, tol=0.05) is True


def test_equidistant_three_sorts_before_checking() -> None:
    # Out-of-order input still equidistant once sorted.
    legs = [_leg(strike=205.0), _leg(strike=195.0), _leg(strike=200.0)]
    assert multileg_patterns._equidistant_three(legs, tol=0.05) is True


def test_equidistant_three_duplicate_strike_zero_gap_reject() -> None:
    # Two equal strikes → gap_lo == 0 → reject.
    legs = [_leg(strike=200.0), _leg(strike=200.0), _leg(strike=205.0)]
    assert multileg_patterns._equidistant_three(legs, tol=0.05) is False


def test_equidistant_three_asymmetric_gaps_reject() -> None:
    # gap_lo=5, gap_hi=15 → asymmetric beyond tol → reject.
    legs = [_leg(strike=195.0), _leg(strike=200.0), _leg(strike=215.0)]
    assert multileg_patterns._equidistant_three(legs, tol=0.05) is False


# ── _equal_sizes ────────────────────────────────────────────────────────────


def test_equal_sizes_equal_within_tol_accept() -> None:
    legs = [_leg(size=10.0), _leg(size=10.2)]
    assert multileg_patterns._equal_sizes(legs, tol=0.05) is True


def test_equal_sizes_zero_average_reject() -> None:
    legs = [_leg(size=0.0), _leg(size=0.0)]
    assert multileg_patterns._equal_sizes(legs, tol=0.05) is False


def test_equal_sizes_out_of_tol_reject() -> None:
    legs = [_leg(size=10.0), _leg(size=20.0)]
    assert multileg_patterns._equal_sizes(legs, tol=0.05) is False


# ── _butterfly_size_ratio ───────────────────────────────────────────────────


def test_butterfly_size_ratio_valid_accept() -> None:
    # wings 10/10, body 20 = 2x avg wing → valid.
    legs = [
        _leg(strike=195.0, size=10.0),
        _leg(strike=200.0, size=20.0),
        _leg(strike=205.0, size=10.0),
    ]
    assert multileg_patterns._butterfly_size_ratio(legs, tol=0.05) is True


def test_butterfly_size_ratio_sorts_by_strike() -> None:
    # Unsorted input: body (20) given first; sort by strike fixes layout.
    legs = [
        _leg(strike=200.0, size=20.0),
        _leg(strike=195.0, size=10.0),
        _leg(strike=205.0, size=10.0),
    ]
    assert multileg_patterns._butterfly_size_ratio(legs, tol=0.05) is True


def test_butterfly_size_ratio_zero_avg_wing_reject() -> None:
    legs = [
        _leg(strike=195.0, size=0.0),
        _leg(strike=200.0, size=20.0),
        _leg(strike=205.0, size=0.0),
    ]
    assert multileg_patterns._butterfly_size_ratio(legs, tol=0.05) is False


def test_butterfly_size_ratio_wing_mismatch_reject() -> None:
    # Wings 10 vs 30 → unequal beyond tol → reject.
    legs = [
        _leg(strike=195.0, size=10.0),
        _leg(strike=200.0, size=40.0),
        _leg(strike=205.0, size=30.0),
    ]
    assert multileg_patterns._butterfly_size_ratio(legs, tol=0.05) is False


def test_butterfly_size_ratio_body_ratio_off_reject() -> None:
    # Wings equal (10/10) but body=15, not ~2x avg wing (20) → reject.
    legs = [
        _leg(strike=195.0, size=10.0),
        _leg(strike=200.0, size=15.0),
        _leg(strike=205.0, size=10.0),
    ]
    assert multileg_patterns._butterfly_size_ratio(legs, tol=0.05) is False


# ── check_shared_attrs ──────────────────────────────────────────────────────


def test_check_shared_attrs_same_expiry_violation() -> None:
    legs = [
        _leg(expiry=EXP_A, option_type="call"),
        _leg(expiry=EXP_B, option_type="put"),
    ]
    assert (
        check_shared_attrs(legs, same_option_type=False, same_expiry=True)
        is False
    )


def test_check_shared_attrs_same_type_violation() -> None:
    # same_option_type=True but a call + a put present → reject.
    legs = [_leg(option_type="call"), _leg(option_type="put")]
    assert (
        check_shared_attrs(legs, same_option_type=True, same_expiry=True)
        is False
    )


def test_check_shared_attrs_same_type_accept() -> None:
    legs = [_leg(option_type="call"), _leg(option_type="call")]
    assert (
        check_shared_attrs(legs, same_option_type=True, same_expiry=True)
        is True
    )


def test_check_shared_attrs_distinct_types_required_reject() -> None:
    # same_option_type=False (strangle/RR) but both calls → <2 types → reject.
    legs = [_leg(option_type="call"), _leg(option_type="call")]
    assert (
        check_shared_attrs(legs, same_option_type=False, same_expiry=True)
        is False
    )


def test_check_shared_attrs_distinct_types_required_accept() -> None:
    legs = [_leg(option_type="call"), _leg(option_type="put")]
    assert (
        check_shared_attrs(legs, same_option_type=False, same_expiry=True)
        is True
    )


def test_check_shared_attrs_expiry_check_skipped_when_flag_false() -> None:
    # same_expiry=False → mixed expiries allowed; types still match.
    legs = [
        _leg(expiry=EXP_A, option_type="call"),
        _leg(expiry=EXP_B, option_type="call"),
    ]
    assert (
        check_shared_attrs(legs, same_option_type=True, same_expiry=False)
        is True
    )


# ── check_directions ────────────────────────────────────────────────────────


def test_check_directions_opposite() -> None:
    legs = [_leg(side="buy"), _leg(side="sell")]
    assert check_directions(legs, "opposite") is True
    same = [_leg(side="buy"), _leg(side="buy")]
    assert check_directions(same, "opposite") is False


def test_check_directions_same() -> None:
    legs = [_leg(side="buy"), _leg(side="buy")]
    assert check_directions(legs, "same") is True
    opp = [_leg(side="buy"), _leg(side="sell")]
    assert check_directions(opp, "same") is False


def test_check_directions_butterfly() -> None:
    legs = _three_legs("buy", "sell", "buy")
    assert check_directions(legs, "butterfly") is True
    bad = _three_legs("buy", "buy", "buy")
    assert check_directions(bad, "butterfly") is False


def test_check_directions_unknown_rule_returns_false() -> None:
    legs = [_leg(side="buy"), _leg(side="sell")]
    assert check_directions(legs, "diagonal") is False


# ── PATTERNS / PatternSpec structure ────────────────────────────────────────


def test_patterns_registry_shape() -> None:
    assert len(PATTERNS) == 4
    names = [p.name for p in PATTERNS]
    assert names == ["vertical", "strangle", "risk_reversal", "butterfly"]
    leg_counts = {p.name: p.leg_count for p in PATTERNS}
    assert leg_counts == {
        "vertical": 2,
        "strangle": 2,
        "risk_reversal": 2,
        "butterfly": 3,
    }


def test_pattern_spec_is_frozen() -> None:
    spec = PATTERNS[0]
    assert isinstance(spec, PatternSpec)
    with pytest.raises(FrozenInstanceError):
        spec.name = "mutated"  # type: ignore[misc]


def test_pattern_constraints_are_callable_and_wired() -> None:
    # Each pattern's constraint callables run end-to-end on a valid group.
    vertical = next(p for p in PATTERNS if p.name == "vertical")
    legs = [_leg(strike=200.0, size=10.0), _leg(strike=205.0, size=10.0)]
    assert vertical.strike_constraint(legs, 0.05) is True
    assert vertical.size_constraint(legs, 0.05) is True
