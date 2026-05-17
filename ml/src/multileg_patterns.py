"""Multileg option spread pattern definitions.

Patterns are declared as DATA (dataclasses), not code. The matcher in
``multileg_assembler`` iterates over ``PATTERNS`` and applies each
template's constraint functions to candidate trade groups.

Adding a 5th pattern in v2 = add one entry to ``PATTERNS``, no edits to
the assembler loop.

Pattern set (v1, fixed):
    - vertical       — 2 legs, same option_type, opposite direction
    - strangle       — 2 legs, different option_type, same direction
    - risk_reversal  — 2 legs, different option_type, opposite direction
    - butterfly      — 3 legs, same option_type, equidistant strikes,
                       body size = 2x wings, body direction opposite wings

Iron condor + diagonal explicitly DEFERRED to v2.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Final, Literal

# A "leg" in candidate-evaluation form. Plain dict to keep the pattern
# layer decoupled from any DataFrame library.
Leg = dict[str, object]

Direction = Literal["buy", "sell", "mid"]


# ── Direction helpers ──────────────────────────────────────────────────────


def _dirs_compatible(a: Direction, b: Direction, *, opposite: bool) -> bool:
    """Direction compatibility check that treats 'mid' as ambiguous-compatible.

    A 'mid' trade matches either side. This avoids dropping multi-leg
    blocks that printed at the midpoint (common for size).
    """
    if a == "mid" or b == "mid":
        return True
    if opposite:
        return a != b
    return a == b


def _all_same_direction(legs: list[Leg], *, opposite_to_others: bool) -> bool:
    """For butterfly: body direction opposite the (matching) wings.

    Wings (idx 0 and 2 by strike) must agree with each other; body (idx 1)
    must be opposite. Mids are compatible with anything.
    """
    wing_a = legs[0]["side"]
    wing_b = legs[2]["side"]
    body = legs[1]["side"]
    if not _dirs_compatible(wing_a, wing_b, opposite=False):  # type: ignore[arg-type]
        return False
    if opposite_to_others:
        # body should be opposite to whichever wing has a non-mid side
        ref = wing_a if wing_a != "mid" else wing_b
        if ref == "mid":
            # both wings mid — accept everything
            return True
        return _dirs_compatible(body, ref, opposite=True)  # type: ignore[arg-type]
    return True


# ── Strike layout constraints ──────────────────────────────────────────────


_NEAR_DUPLICATE_STRIKE_FRACTION: Final = 1e-4
"""Strikes within this *fraction* of the larger strike are treated as the
same contract, not as two distinct legs. Sized to catch floating-point
noise and rounding (e.g. 190.0 vs 190.005) while preserving real spreads
(e.g. a $5-wide vertical at SPY 200 = 2.5% gap, well above the threshold).

NOTE: distinct from the matcher's ``strike_tolerance`` parameter, which
governs *how loose* a layout match can be (gap symmetry, etc.). Here we
want the *tightest* meaningful gap, so a separate constant is correct.
"""


def _two_strikes_differ(legs: list[Leg], _tol: float) -> bool:
    """Two-strike patterns (vertical/strangle/risk_reversal) require strikes
    that are *meaningfully* different — not just non-equal floats.

    Near-duplicates from float noise or rounding (e.g. 190.0 vs 190.005)
    must NOT count as two distinct legs. ``_tol`` (the caller's
    strike-tolerance for layout matching) is intentionally unused here:
    real-world verticals can be as tight as $1 wide, which is well below
    the layout-tolerance fraction (5% by default). A separate
    near-duplicate fraction (``_NEAR_DUPLICATE_STRIKE_FRACTION``) defines
    "indistinguishable" instead.
    """
    a = float(legs[0]["strike"])  # type: ignore[arg-type]
    b = float(legs[1]["strike"])  # type: ignore[arg-type]
    return abs(a - b) > _NEAR_DUPLICATE_STRIKE_FRACTION * max(a, b)


def _equidistant_three(legs: list[Leg], tol: float) -> bool:
    """Strikes of 3 legs (sorted) are evenly spaced within tol fraction."""
    strikes = sorted(float(leg["strike"]) for leg in legs)  # type: ignore[arg-type]
    lo, mid, hi = strikes
    gap_lo = mid - lo
    gap_hi = hi - mid
    if gap_lo <= 0 or gap_hi <= 0:
        return False
    avg_gap = (gap_lo + gap_hi) / 2.0
    return abs(gap_lo - gap_hi) <= tol * avg_gap


# ── Size constraints ──────────────────────────────────────────────────────


def _equal_sizes(legs: list[Leg], tol: float) -> bool:
    """All legs have equal size within tol fraction."""
    sizes = [float(leg["size"]) for leg in legs]  # type: ignore[arg-type]
    avg = sum(sizes) / len(sizes)
    if avg <= 0:
        return False
    return all(abs(s - avg) <= tol * avg for s in sizes)


def _butterfly_size_ratio(legs: list[Leg], tol: float) -> bool:
    """Body size ≈ 2x average wing size; wings ≈ equal."""
    by_strike = sorted(legs, key=lambda L: float(L["strike"]))  # type: ignore[arg-type]
    wing_a = float(by_strike[0]["size"])  # type: ignore[arg-type]
    body = float(by_strike[1]["size"])  # type: ignore[arg-type]
    wing_b = float(by_strike[2]["size"])  # type: ignore[arg-type]
    avg_wing = (wing_a + wing_b) / 2.0
    if avg_wing <= 0:
        return False
    # Wings within tol of each other
    if abs(wing_a - wing_b) > tol * avg_wing:
        return False
    # Body within tol of 2x avg wing
    expected_body = 2.0 * avg_wing
    return abs(body - expected_body) <= tol * expected_body


# ── Pattern dataclass ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class PatternSpec:
    """Declarative spec for one multileg pattern."""

    name: str
    leg_count: int
    same_option_type: bool
    same_expiry: bool
    # Direction relationship between legs.
    # 'opposite' — for 2-leg patterns, legs must trade opposite sides.
    # 'same'     — for 2-leg patterns, legs must trade same side.
    # 'butterfly'— body opposite wings (3-leg).
    direction_rule: Literal["opposite", "same", "butterfly"]
    # Strike layout — returns True if strikes satisfy the pattern shape.
    strike_constraint: Callable[[list[Leg], float], bool]
    # Size relationship — returns True if sizes satisfy the pattern.
    size_constraint: Callable[[list[Leg], float], bool]


# ── Pattern registry ──────────────────────────────────────────────────────

PATTERNS: Final[tuple[PatternSpec, ...]] = (
    PatternSpec(
        name="vertical",
        leg_count=2,
        same_option_type=True,
        same_expiry=True,
        direction_rule="opposite",
        strike_constraint=_two_strikes_differ,
        size_constraint=_equal_sizes,
    ),
    PatternSpec(
        name="strangle",
        leg_count=2,
        same_option_type=False,
        same_expiry=True,
        direction_rule="same",
        strike_constraint=_two_strikes_differ,
        size_constraint=_equal_sizes,
    ),
    PatternSpec(
        name="risk_reversal",
        leg_count=2,
        same_option_type=False,
        same_expiry=True,
        direction_rule="opposite",
        strike_constraint=_two_strikes_differ,
        size_constraint=_equal_sizes,
    ),
    PatternSpec(
        name="butterfly",
        leg_count=3,
        same_option_type=True,
        same_expiry=True,
        direction_rule="butterfly",
        strike_constraint=_equidistant_three,
        size_constraint=_butterfly_size_ratio,
    ),
)


# ── Pattern evaluation helpers ────────────────────────────────────────────


def check_shared_attrs(
    legs: list[Leg],
    *,
    same_option_type: bool,
    same_expiry: bool,
) -> bool:
    """Check the shared-attribute prerequisites for a candidate group."""
    if same_expiry:
        expiries: set[date] = {leg["expiry"] for leg in legs}  # type: ignore[misc]
        if len(expiries) != 1:
            return False
    if same_option_type:
        types = {leg["option_type"] for leg in legs}
        if len(types) != 1:
            return False
    else:
        # Pattern needs two distinct types (one call + one put).
        types = {leg["option_type"] for leg in legs}
        if len(types) < 2:
            return False
    return True


def check_directions(legs: list[Leg], rule: str) -> bool:
    """Check the direction rule for a candidate group."""
    sides: list[Direction] = [leg["side"] for leg in legs]  # type: ignore[misc]
    if rule == "opposite":
        # 2-leg: one buy, one sell (mids compatible with both).
        return _dirs_compatible(sides[0], sides[1], opposite=True)
    if rule == "same":
        return _dirs_compatible(sides[0], sides[1], opposite=False)
    if rule == "butterfly":
        return _all_same_direction(legs, opposite_to_others=True)
    return False
