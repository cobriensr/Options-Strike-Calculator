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


def _fire_matches_composite(
    fire_row: dict,
    match: dict,
    vol_oi_q: int | None,
    gamma_q: int | None,
    ask_pct_q: int | None,
) -> bool:
    """
    Return True when all keys in `match` agree with the fire's feature values.

    `match` keys:
      ticker      — compared against fire_row["ticker"] (string equality)
      tod         — compared against fire_row["tod"] (string equality)
      gamma_q     — compared against gamma_q label ("0".."4" or "null")
      vol_oi_q    — compared against vol_oi_q label ("0".."4" or "null")
      ask_pct_q   — compared against ask_pct_q label ("0".."4" or "null")

    Quintile values in `match` are stored as strings ("0".."4"). A None
    quintile is represented as the string "null" in the match dict. Missing
    keys in `match` are wildcards.
    """
    def _q_label(q: int | None) -> str:
        return "null" if q is None else str(q)

    for key, expected in match.items():
        if key == "ticker":
            if fire_row.get("ticker") != expected:
                return False
        elif key == "tod":
            if fire_row.get("tod") != expected:
                return False
        elif key == "gamma_q":
            if _q_label(gamma_q) != str(expected):
                return False
        elif key == "vol_oi_q":
            if _q_label(vol_oi_q) != str(expected):
                return False
        elif key == "ask_pct_q":
            if _q_label(ask_pct_q) != str(expected):
                return False
        # Unknown match keys are silently ignored (forward-compat).
    return True


def compute_components(
    fire_row: dict, weights: dict, dow: str | None = None
) -> dict[str, int]:
    """
    Recover the per-component score contributions for a fire.

    Returns a dict with keys: ticker, tod, dte, vol_oi_q, gamma_q,
    ask_pct_q, option_type, composite, total. All ints. `total` equals the
    sum of the other components and should match the stored `score` column on
    lottery_finder_fires (verified by the sum-invariant test in
    ml/tests/test_score_components.py).

    fire_row expected keys (all required EXCEPT vol_oi_window /
    gamma / ask_pct, which may be None):
      ticker (str), tod (str), dte (int), option_type ('C'|'P'),
      vol_oi_window (float|None), gamma (float|None),
      ask_pct (float|None)

    weights is the loaded JSON from ml/output/lottery_score_weights.json
    (or its sync_lottery_score_weights_v2.py-rendered TS mirror).

    dow (optional): day-of-week name (e.g. "Monday"). When provided AND
    the weights JSON contains a matching tod_weights_dow_overrides[dow]
    entry, that override table is used for the tod component instead of
    the global tod_weights. Falls back to global tod_weights when dow is
    None, when the overrides key is absent, or when dow has no entry.

    Returns 0 contributions for null continuous features. Does NOT
    enforce the alignment gate — callers must filter to aligned
    in-universe fires before relying on `total` matching the
    stored score.
    """
    f = weights["features"]

    # Resolve TOD weights: use DOW override if available, else global.
    overrides = f.get("tod_weights_dow_overrides", {})
    tod_weights_to_use = (
        overrides[dow]
        if dow is not None and dow in overrides
        else f["tod_weights"]
    )

    components: dict[str, int] = {
        "ticker": int(f["ticker_weights"].get(fire_row["ticker"], 0)),
        "tod": int(tod_weights_to_use.get(fire_row["tod"], 0)),
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

    # Composite bonuses/penalties — sum all matching entries.
    composite_total = 0
    for entry in f.get("composite_bonuses", []):
        if _fire_matches_composite(
            fire_row, entry["match"], vol_oi_q, gamma_q, ask_pct_q
        ):
            composite_total += int(entry["bonus"])
    components["composite"] = composite_total

    components["total"] = sum(
        v for k, v in components.items() if k != "total"
    )
    return components
