#!/usr/bin/env python
"""V2.2 Phase D Pre-Work — Pre-Fire Context Feature Lift Study.

For each of 7 candidate context features on lottery_finder_fires, compute
per-quintile outcome stats and measure lift + monotonicity. Used to decide
which features are worth adding to the V2 scoring model in Phase D.

Decision thresholds:
  STRONG  : lift_pct > 50% AND monotonicity > 0.6
  MODERATE: lift_pct > 30% AND monotonicity > 0.4
  SKIP    : otherwise

Read-only — no DB writes.

Output:
  docs/tmp/v22-phase-d-context-feature-lift-study-2026-05-22.md

Usage:
    ml/.venv/bin/python scripts/context_feature_lift_study.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import NamedTuple

import numpy as np
import pandas as pd
import psycopg2

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
REPORT_PATH = (
    ROOT / "docs" / "tmp" / "v22-phase-d-context-feature-lift-study-2026-05-22.md"
)

# ---------------------------------------------------------------------------
# Features under study
# ---------------------------------------------------------------------------

FEATURES = [
    "mkt_tide_otm_diff",
    "mkt_tide_diff",
    "spx_spot_gamma_oi",
    "spx_spot_charm_oi",
    "spx_spot_vanna_oi",
    "mkt_tide_ncp",
    "mkt_tide_npp",
]

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f"Missing env file: {ENV_FILE}")
    with ENV_FILE.open() as fh:
        for line in fh:
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


# ---------------------------------------------------------------------------
# SQL — 90-day window, aligned, non-structure, outcome available
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
    {cols}
FROM lottery_finder_fires f
WHERE
    f.date >= CURRENT_DATE - INTERVAL '90 days'
    AND f.score IS NOT NULL
    AND f.inferred_structure IS NULL
    AND f.cum_ncp_at_fire IS NOT NULL
    AND f.cum_npp_at_fire IS NOT NULL
    AND (
        (f.option_type = 'C' AND f.cum_ncp_at_fire > f.cum_npp_at_fire)
        OR (f.option_type = 'P' AND f.cum_npp_at_fire > f.cum_ncp_at_fire)
    )
    AND COALESCE(f.realized_flow_inversion_pct, f.realized_eod_pct) IS NOT NULL
ORDER BY f.id
"""


# ---------------------------------------------------------------------------
# Monotonicity helper
# ---------------------------------------------------------------------------


def monotonicity_score(values: list[float]) -> float:
    """Return fraction of consecutive pairs that move in the majority direction.

    1.0 = perfectly monotonic (up or down).
    0.0 = perfectly alternating.
    Only meaningful for sequences of length >= 2.
    """
    if len(values) < 2:
        return float("nan")
    diffs = [values[i + 1] - values[i] for i in range(len(values) - 1)]
    n_pos = sum(1 for d in diffs if d > 0)
    n_neg = sum(1 for d in diffs if d < 0)
    # Monotonicity = how consistently diffs go one direction
    n_pairs = len(diffs)
    return max(n_pos, n_neg) / n_pairs if n_pairs > 0 else float("nan")


# ---------------------------------------------------------------------------
# Per-feature analysis
# ---------------------------------------------------------------------------


class FeatureResult(NamedTuple):
    feature: str
    n_non_null: int
    quintile_means: list[float]
    quintile_ns: list[int]
    quintile_win_rates: list[float]
    quintile_hit50s: list[float]
    boundaries: list[float]
    overall_mean: float
    min_mean: float
    max_mean: float
    lift_pct: float         # (max_mean - min_mean) / abs(overall_mean) * 100
    monotonicity: float
    verdict: str


def analyze_feature(df: pd.DataFrame, feature: str) -> FeatureResult:
    col = pd.to_numeric(df[feature], errors="coerce")
    outcome = pd.to_numeric(df["outcome_pct"], errors="coerce")

    valid = col.notna() & outcome.notna()
    col_v = col[valid]
    out_v = outcome[valid]
    n_non_null = int(valid.sum())

    if n_non_null < 50:
        # Not enough data to be meaningful
        return FeatureResult(
            feature=feature,
            n_non_null=n_non_null,
            quintile_means=[float("nan")] * 5,
            quintile_ns=[0] * 5,
            quintile_win_rates=[float("nan")] * 5,
            quintile_hit50s=[float("nan")] * 5,
            boundaries=[float("nan")] * 4,
            overall_mean=float("nan"),
            min_mean=float("nan"),
            max_mean=float("nan"),
            lift_pct=float("nan"),
            monotonicity=float("nan"),
            verdict="SKIP (insufficient data)",
        )

    # Compute quintile boundaries (P20/P40/P60/P80)
    quantiles = [0.20, 0.40, 0.60, 0.80]
    boundaries = [float(col_v.quantile(q)) for q in quantiles]

    # Assign quintile 0-4
    def assign_q(v: float) -> int:
        for i, b in enumerate(boundaries):
            if v < b:
                return i
        return 4

    labels = col_v.apply(assign_q)

    quintile_means: list[float] = []
    quintile_ns: list[int] = []
    quintile_win_rates: list[float] = []
    quintile_hit50s: list[float] = []

    for q in range(5):
        mask = labels == q
        grp = out_v[mask]
        n = int(mask.sum())
        if n == 0:
            quintile_means.append(float("nan"))
            quintile_ns.append(0)
            quintile_win_rates.append(float("nan"))
            quintile_hit50s.append(float("nan"))
        else:
            quintile_means.append(float(grp.mean()))
            quintile_ns.append(n)
            quintile_win_rates.append(float((grp > 0).mean() * 100))
            quintile_hit50s.append(float((grp >= 50).mean() * 100))

    overall_mean = float(out_v.mean())

    valid_means = [m for m in quintile_means if not np.isnan(m)]
    if len(valid_means) < 2:
        min_mean = max_mean = overall_mean
        lift_pct = 0.0
        mono = float("nan")
        verdict = "SKIP (insufficient quintile coverage)"
    else:
        min_mean = min(valid_means)
        max_mean = max(valid_means)
        denom = abs(overall_mean) if abs(overall_mean) > 1e-9 else 1.0
        lift_pct = (max_mean - min_mean) / denom * 100.0
        mono = monotonicity_score(quintile_means)

        if lift_pct > 50 and mono > 0.6:
            verdict = "STRONG"
        elif lift_pct > 30 and mono > 0.4:
            verdict = "MODERATE"
        else:
            verdict = "SKIP"

    return FeatureResult(
        feature=feature,
        n_non_null=n_non_null,
        quintile_means=quintile_means,
        quintile_ns=quintile_ns,
        quintile_win_rates=quintile_win_rates,
        quintile_hit50s=quintile_hit50s,
        boundaries=boundaries,
        overall_mean=overall_mean,
        min_mean=min_mean,
        max_mean=max_mean,
        lift_pct=lift_pct,
        monotonicity=mono,
        verdict=verdict,
    )


# ---------------------------------------------------------------------------
# Markdown report generation
# ---------------------------------------------------------------------------


def _fmt(v: float, decimals: int = 1) -> str:
    return f"{v:.{decimals}f}" if not np.isnan(v) else "—"


def build_report(results: list[FeatureResult], n_total: int) -> str:
    strong = [r for r in results if r.verdict == "STRONG"]
    moderate = [r for r in results if r.verdict == "MODERATE"]
    skip = [r for r in results if r.verdict not in ("STRONG", "MODERATE")]

    lines: list[str] = []
    lines.append("# V2.2 Phase D Pre-Work — Pre-Fire Context Feature Lift Study")
    lines.append("")
    lines.append("## Method")
    lines.append("")
    lines.append(
        "- 90-day aligned non-structure window "
        f"(total rows in window: {n_total:,})"
    )
    lines.append("- Alignment filter: score IS NOT NULL + inferred_structure IS NULL")
    lines.append(
        "  + cum_ncp/npp present + option_type-aligned + outcome available"
    )
    lines.append("- Per-feature quintile bucketing (P20/P40/P60/P80 boundaries)")
    lines.append(
        "- Lift = (max_bucket_mean - min_bucket_mean) / |overall_mean| × 100%"
    )
    lines.append(
        "- Monotonicity = fraction of consecutive quintile pairs moving same direction"
    )
    lines.append("- outcome_pct = COALESCE(realized_flow_inversion_pct, realized_eod_pct)")
    lines.append("")
    lines.append("## Per-feature lift table")
    lines.append("")
    lines.append(
        "| Feature | n_non_null | overall_mean | min_mean | max_mean "
        "| lift_pct | monotonicity | verdict |"
    )
    lines.append(
        "|---------|-----------|-------------|---------|---------|"
        "---------|-------------|---------|"
    )
    for r in results:
        lines.append(
            f"| {r.feature} | {r.n_non_null:,} | {_fmt(r.overall_mean)} "
            f"| {_fmt(r.min_mean)} | {_fmt(r.max_mean)} "
            f"| {_fmt(r.lift_pct)}% | {_fmt(r.monotonicity, 2)} | **{r.verdict}** |"
        )

    lines.append("")
    lines.append("## Per-feature quintile detail")
    lines.append("")
    for r in results:
        lines.append(f"### {r.feature}")
        lines.append("")
        lines.append(
            f"n_non_null={r.n_non_null:,}  overall_mean={_fmt(r.overall_mean)}%  "
            f"lift={_fmt(r.lift_pct)}%  mono={_fmt(r.monotonicity, 2)}"
        )
        lines.append("")
        # Boundaries
        b = r.boundaries
        lines.append(
            f"Boundaries: P20={_fmt(b[0], 3)}  P40={_fmt(b[1], 3)}  "
            f"P60={_fmt(b[2], 3)}  P80={_fmt(b[3], 3)}"
        )
        lines.append("")
        lines.append("| Quintile | n | mean_pct | win_rate | hit_50_pct |")
        lines.append("|---------|---|---------|---------|-----------|")
        for q in range(5):
            lines.append(
                f"| Q{q} ({"lowest" if q == 0 else ("highest" if q == 4 else f"q{q}")})"
                f" | {r.quintile_ns[q]:,}"
                f" | {_fmt(r.quintile_means[q])}%"
                f" | {_fmt(r.quintile_win_rates[q])}%"
                f" | {_fmt(r.quintile_hit50s[q])}% |"
            )
        lines.append("")
        lines.append(f"**Verdict: {r.verdict}**")
        lines.append("")

    lines.append("## Recommended next-step features")
    lines.append("")
    if strong:
        lines.append(f"- **STRONG** ({len(strong)}): " + ", ".join(r.feature for r in strong))
    else:
        lines.append("- **STRONG** (0): none")
    if moderate:
        lines.append(
            f"- **MODERATE** ({len(moderate)}): " + ", ".join(r.feature for r in moderate)
        )
    else:
        lines.append("- **MODERATE** (0): none")
    lines.append(
        f"- **SKIP** ({len(skip)}): " + ", ".join(r.feature for r in skip)
    )

    lines.append("")
    lines.append("## Phase D scope recommendation")
    lines.append("")
    n_features = len(strong) + len(moderate)
    lines.append(f"- Total new features to add: {n_features}")

    baseline_h = 3  # Monday TOD overlay
    if n_features == 0:
        effort = "0h — skip Phase D entirely"
        worth_it = (
            "**Skip Phase D.** No feature clears the minimum lift threshold. "
            "Investing implementation time here is not justified."
        )
    elif n_features <= 2:
        effort = f"~{n_features * 2}h (2h per quintile-encoded feature)"
        worth_it = (
            f"**Proceed with STRONG only** ({len(strong)} feature(s)). "
            "Comparable effort to the Monday TOD overlay (~3h baseline). "
            "MODERATE candidates can be revisited after more data accumulates."
            if strong
            else "**Marginal.** Only MODERATE candidates — consider deferring."
        )
    else:
        effort = f"~{n_features * 2}h (2h per quintile-encoded feature)"
        worth_it = (
            f"**Full Phase D justified** ({n_features} features). "
            "Expected lift is meaningful; proceed."
        )

    lines.append(f"- Estimated implementation effort: {effort}")
    lines.append(
        f"- Baseline comparison: Monday TOD overlay = ~{baseline_h}h"
    )
    lines.append(f"- Whether full Phase D is worth doing: {worth_it}")

    if strong or moderate:
        lines.append("")
        lines.append("### Implementation notes for passing features")
        lines.append("")
        lines.append(
            "Each feature would be added as a quintile-encoded score component, "
            "identical to the existing `vol_oi_q`, `gamma_q`, `ask_pct_q` pattern:"
        )
        lines.append("")
        lines.append("1. Add quintile boundaries to `lottery_score_weights.json`")
        lines.append(
            "2. Add weight array `[w0, w1, w2, w3, w4]` for each quintile bucket"
        )
        lines.append(
            "3. Update `computeLotteryScoreV2` in `api/_lib/lottery-score-weights.ts`"
        )
        lines.append("4. Re-backfill scores")
        lines.append("5. Compare tier1 hit rate on held-out window (≥3pp improvement gate)")

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    load_env()
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]
    conn = psycopg2.connect(db_url)

    cols = ", ".join(
        ["f.realized_flow_inversion_pct", "f.realized_eod_pct"] + [f"f.{feat}" for feat in FEATURES]
    )
    query = FETCH_QUERY.format(cols=cols)

    print("[context_feature_lift] Fetching data...")
    df = pd.read_sql(query, conn)
    conn.close()

    n_total = len(df)
    print(f"[context_feature_lift] {n_total:,} rows in 90-day aligned window")

    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )

    results: list[FeatureResult] = []
    for feat in FEATURES:
        r = analyze_feature(df, feat)
        verdict_display = r.verdict if len(r.verdict) <= 20 else r.verdict[:20]
        print(
            f"  {feat:<25s} n={r.n_non_null:>6,}  "
            f"lift={r.lift_pct:>6.1f}%  mono={r.monotonicity:.2f}  "
            f"=> {verdict_display}"
        )
        results.append(r)

    report = build_report(results, n_total)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"\n[context_feature_lift] Report written to {REPORT_PATH}")

    strong = [r for r in results if r.verdict == "STRONG"]
    moderate = [r for r in results if r.verdict == "MODERATE"]
    print(f"\nSUMMARY  STRONG={len(strong)}  MODERATE={len(moderate)}")
    if strong:
        print("  STRONG  :", ", ".join(r.feature for r in strong))
    if moderate:
        print("  MODERATE:", ", ".join(r.feature for r in moderate))


if __name__ == "__main__":
    main()
