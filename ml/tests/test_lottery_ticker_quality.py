"""Tests for the ticker-quality refit logic appended to enrich_lottery_outcomes.py."""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))

from enrich_lottery_outcomes import (
    inversion_blend,
    quintile_cuts,
    wilson_lcb,
)


def test_wilson_lcb_below_floor_returns_none():
    assert wilson_lcb(wins=5, n=9) is None  # N < 10


def test_wilson_lcb_at_floor_with_perfect_record():
    val = wilson_lcb(wins=10, n=10)
    assert val is not None
    assert 0.6 < val < 1.0


def test_wilson_lcb_at_floor_with_zero_wins():
    val = wilson_lcb(wins=0, n=10)
    assert val is not None
    assert math.isclose(val, 0.0, abs_tol=1e-9)


def test_wilson_lcb_typical_case():
    val = wilson_lcb(wins=60, n=100)
    assert val is not None
    assert 0.48 < val < 0.52


def test_inversion_blend_both_windows_present():
    val = inversion_blend(lcb_21d=0.5, lcb_90d=0.7)
    assert math.isclose(val, 0.58, abs_tol=1e-9)


def test_inversion_blend_only_21d():
    assert inversion_blend(lcb_21d=0.5, lcb_90d=None) == 0.5


def test_inversion_blend_only_90d():
    assert inversion_blend(lcb_21d=None, lcb_90d=0.7) == 0.7


def test_inversion_blend_neither():
    assert inversion_blend(lcb_21d=None, lcb_90d=None) is None


def test_quintile_cuts_basic_universe():
    blends = {f'T{i:02d}': i * 0.01 for i in range(1, 26)}
    quintiles = quintile_cuts(blends)
    from collections import Counter
    counts = Counter(quintiles.values())
    for q in (1, 2, 3, 4, 5):
        assert counts[q] == 5, f"quintile {q} has {counts[q]}, expected 5"


def test_quintile_cuts_skips_none_values():
    blends = {'A': 0.1, 'B': None, 'C': 0.9, 'D': None}
    quintiles = quintile_cuts(blends)
    assert 'B' not in quintiles
    assert 'D' not in quintiles
    assert quintiles['A'] == 1
    assert quintiles['C'] == 5


def test_quintile_cuts_empty_universe():
    assert quintile_cuts({}) == {}
    assert quintile_cuts({'A': None}) == {}
