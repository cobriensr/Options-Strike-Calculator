"""
V2 lottery score component recovery.

The V2 model in api/_lib/lottery-score-weights-v2.ts (and its Python
mirror in ml/src/lottery_scoring.py) is a deterministic linear sum of
per-feature weights. Given a fire's input fields and the weights JSON,
we can recover the per-component contribution to the fire's score
without persisting anything.

Used by:
- scripts/mine_outcome_patterns.py — builds the feature tuple
- scripts/score_lineage_audit.py — bucks fires by per-component
  contribution to detect anti-predictive coefficients

Spec: docs/superpowers/specs/lottery-outcome-mining-and-lineage-2026-05-22.md (Phase 0)
"""

from __future__ import annotations


def assign_quintile(value: float | None, boundaries: list[float]) -> int | None:
    """
    Map a continuous value to a quintile label 0-4.

    Matches `pd.cut(right=True)` semantics from lottery_scoring.py:
      (-inf, b0]  -> 0   (i.e., value <= b0)
      (b0,   b1]  -> 1
      (b1,   b2]  -> 2
      (b2,   b3]  -> 3
      (b3,  inf)  -> 4

    Returns None for null inputs (caller treats as 0 contribution).
    """
    if value is None:
        return None
    for i, b in enumerate(boundaries):
        if value <= b:
            return i
    return 4


def compute_components(
    fire_row: dict, weights: dict
) -> dict[str, int]:
    """
    Recover the per-component score contributions for a fire.

    Returns a dict with keys: ticker, tod, dte, vol_oi_q, gamma_q,
    ask_pct_q, option_type, total. All ints. `total` equals the sum
    of the other components and should match the stored `score`
    column on lottery_finder_fires (verified by the sum-invariant
    test in ml/tests/test_score_components.py).

    fire_row expected keys (all required EXCEPT vol_oi_window /
    gamma / ask_pct, which may be None):
      ticker (str), tod (str), dte (int), option_type ('C'|'P'),
      vol_oi_window (float|None), gamma (float|None),
      ask_pct (float|None)

    weights is the loaded JSON from ml/output/lottery_score_weights.json
    (or its sync_lottery_score_weights_v2.py-rendered TS mirror).

    Returns 0 contributions for null continuous features. Does NOT
    enforce the alignment gate — callers must filter to aligned
    in-universe fires before relying on `total` matching the
    stored score.
    """
    f = weights["features"]
    components: dict[str, int] = {
        "ticker": int(f["ticker_weights"].get(fire_row["ticker"], 0)),
        "tod": int(f["tod_weights"].get(fire_row["tod"], 0)),
        "dte": int(f["dte_weights"].get(str(fire_row["dte"]), 0)),
        "option_type": int(
            f["option_type_weights"].get(fire_row["option_type"], 0)
        ),
    }

    vol_oi_q = assign_quintile(
        fire_row.get("vol_oi_window"), f["vol_oi_quintile_boundaries"]
    )
    components["vol_oi_q"] = (
        int(f["vol_oi_quintile_weights"][vol_oi_q]) if vol_oi_q is not None else 0
    )

    gamma_q = assign_quintile(
        fire_row.get("gamma"), f["gamma_quintile_boundaries"]
    )
    components["gamma_q"] = (
        int(f["gamma_quintile_weights"][gamma_q]) if gamma_q is not None else 0
    )

    ask_pct_q = assign_quintile(
        fire_row.get("ask_pct"), f["ask_pct_quintile_boundaries"]
    )
    components["ask_pct_q"] = (
        int(f["ask_pct_quintile_weights"][ask_pct_q])
        if ask_pct_q is not None
        else 0
    )

    components["total"] = sum(
        v for k, v in components.items() if k != "total"
    )
    return components
