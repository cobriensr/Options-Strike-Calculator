#!/usr/bin/env python
"""V2.2 Phase A.5 — VIX-conditioned tier performance for lottery_finder_fires.

Buckets last-90-day aligned fires by VIX regime (< 15 / 15-20 / 20-25 /
25-30 / 30+) and computes per-(tier, bucket) outcome stats.

VIX source: outcomes.vix_close joined to lottery_finder_fires on date.
Aligned filter mirrors mine_outcome_patterns.py:
  - score IS NOT NULL
  - cum_ncp / cum_npp aligned to option_type
  - inferred_structure IS NULL
  - outcome available (realized_flow_inversion_pct or realized_eod_pct)

Writes: docs/tmp/v22-vix-regime-2026-05-22.md

Usage:
    ml/.venv/bin/python scripts/vix_regime_analysis.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import pandas as pd
import psycopg2

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
REPORT_PATH = ROOT / "docs" / "tmp" / "v22-vix-regime-2026-05-22.md"

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
# SQL
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
    f.id,
    f.date,
    f.score,
    f.realized_flow_inversion_pct,
    f.realized_eod_pct,
    f.peak_ceiling_pct,
    o.vix_close
FROM lottery_finder_fires f
LEFT JOIN outcomes o ON o.date = f.date
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
    AND o.vix_close IS NOT NULL
ORDER BY f.id
"""

# ---------------------------------------------------------------------------
# Tier assignment — uses ml/output/lottery_score_weights.json cutoffs
# (t1=9, t2=7 as of rescore-v1-2026-05-22, the 95th/85th percentile
# of the training-set score distribution).
#
# NOTE: api/_lib/lottery-score-weights.ts hardcodes 18/12 as design-intent
# placeholders but the live max score is 17, yielding zero tier1 rows.
# The operational cutoffs from the weights file (P95/P85) are used here.
# ---------------------------------------------------------------------------

import json as _json

def _load_tier_cutoffs() -> tuple[int, int]:
    weights_path = ROOT / "ml" / "output" / "lottery_score_weights.json"
    if weights_path.exists():
        w = _json.loads(weights_path.read_text())
        t1 = int(w.get("cutoffs", {}).get("t1", 9))
        t2 = int(w.get("cutoffs", {}).get("t2", 7))
        return t1, t2
    return 9, 7

TIER1_MIN, TIER2_MIN = _load_tier_cutoffs()


def score_to_tier(score: int) -> str:
    if score >= TIER1_MIN:
        return "tier1"
    if score >= TIER2_MIN:
        return "tier2"
    return "tier3"


# ---------------------------------------------------------------------------
# VIX bucket assignment
# ---------------------------------------------------------------------------

BUCKETS = [
    ("<15", lambda v: v < 15),
    ("15-20", lambda v: 15 <= v < 20),
    ("20-25", lambda v: 20 <= v < 25),
    ("25-30", lambda v: 25 <= v < 30),
    ("30+", lambda v: v >= 30),
]


def vix_bucket(vix: float) -> str:
    for label, pred in BUCKETS:
        if pred(vix):
            return label
    return "30+"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def fetch_fires() -> pd.DataFrame:
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set — run load_env() first")

    print("Connecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=15)
    print("Fetching fires + VIX...")
    df = pd.read_sql_query(FETCH_QUERY, conn)
    conn.close()
    print(f"Fetched {len(df):,} rows")
    return df


def process(df: pd.DataFrame) -> pd.DataFrame:
    # Outcome: prefer flow_inversion, fall back to eod
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )

    # Drop enrichment-bug rows (flow_inv > peak * 1.05)
    mask_bug = (
        df["realized_flow_inversion_pct"].notna()
        & df["peak_ceiling_pct"].notna()
        & (df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * 1.05)
    )
    dropped = mask_bug.sum()
    if dropped:
        print(f"Dropped {dropped:,} enrichment-bug rows (flow_inv > peak*1.05)")
    df = df[~mask_bug].copy()

    df["tier"] = df["score"].apply(score_to_tier)
    df["vix_bucket"] = df["vix_close"].apply(vix_bucket)
    df["win"] = df["outcome_pct"] >= 0
    df["hit_50"] = df["outcome_pct"] >= 50

    print(f"Final sample: {len(df):,} fires")
    print(f"  tier1={df[df.tier=='tier1'].shape[0]:,}  "
          f"tier2={df[df.tier=='tier2'].shape[0]:,}  "
          f"tier3={df[df.tier=='tier3'].shape[0]:,}")
    print(f"VIX range: {df['vix_close'].min():.1f} – {df['vix_close'].max():.1f}")
    return df


BUCKET_ORDER = ["<15", "15-20", "20-25", "25-30", "30+"]


def aggregate(df: pd.DataFrame, tier: str) -> pd.DataFrame:
    sub = df[df["tier"] == tier]
    rows = []
    for bucket in BUCKET_ORDER:
        g = sub[sub["vix_bucket"] == bucket]
        n = len(g)
        if n == 0:
            rows.append({"vix_bucket": bucket, "n": 0,
                         "mean_pct": float("nan"),
                         "win_rate": float("nan"),
                         "hit_50_pct": float("nan")})
        else:
            rows.append({
                "vix_bucket": bucket,
                "n": n,
                "mean_pct": g["outcome_pct"].mean(),
                "win_rate": g["win"].mean() * 100,
                "hit_50_pct": g["hit_50"].mean() * 100,
            })
    return pd.DataFrame(rows)


def md_table(agg: pd.DataFrame) -> str:
    header = "| vix_bucket | n | mean_pct | win% | hit_50% |"
    sep = "| --- | --- | --- | --- | --- |"
    lines = [header, sep]
    for _, r in agg.iterrows():
        if r["n"] == 0:
            lines.append(f"| {r['vix_bucket']} | 0 | — | — | — |")
        else:
            lines.append(
                f"| {r['vix_bucket']} | {int(r['n'])} | "
                f"{r['mean_pct']:+.1f}% | "
                f"{r['win_rate']:.1f}% | "
                f"{r['hit_50_pct']:.1f}% |"
            )
    return "\n".join(lines)


MIN_N_FOR_DECISION = 30  # minimum fires to treat a bucket as statistically meaningful


def compute_decision(agg1: pd.DataFrame) -> tuple[str, str, str, str, str, str]:
    """Return (best_bucket, best_mean, worst_bucket, worst_mean, gap_pct, note)."""
    valid = agg1[agg1["n"] >= MIN_N_FOR_DECISION].copy()
    excluded = agg1[agg1["n"] < MIN_N_FOR_DECISION]
    excluded_note = ""
    if len(excluded) > 0:
        small = ", ".join(
            f"{r['vix_bucket']} (n={int(r['n'])})"
            for _, r in excluded.iterrows()
            if r["n"] > 0
        )
        if small:
            excluded_note = f"Excluded from decision (n < {MIN_N_FOR_DECISION}): {small}."
    if len(valid) < 2:
        return ("n/a", "n/a", "n/a", "n/a", "n/a", excluded_note)
    best = valid.loc[valid["mean_pct"].idxmax()]
    worst = valid.loc[valid["mean_pct"].idxmin()]
    # Relative gap: (worst - best) / |best| * 100
    if best["mean_pct"] != 0:
        gap = (worst["mean_pct"] - best["mean_pct"]) / abs(best["mean_pct"]) * 100
    else:
        gap = float("nan")
    return (
        best["vix_bucket"],
        f"{best['mean_pct']:+.1f}%",
        worst["vix_bucket"],
        f"{worst['mean_pct']:+.1f}%",
        f"{gap:.1f}%",
        excluded_note,
    )


def write_report(
    df: pd.DataFrame,
    agg1: pd.DataFrame,
    agg2: pd.DataFrame,
    agg3: pd.DataFrame,
) -> None:
    best_bucket, best_mean, worst_bucket, worst_mean, gap, excl_note = compute_decision(agg1)

    # Decide: >30% relative gap = SHIP gate
    try:
        gap_val = float(gap.rstrip("%"))
    except (ValueError, AttributeError):
        gap_val = 0.0

    if gap_val < -30:
        recommend = "SHIP VIX gate"
        # Best candidate gate threshold: the worst bucket lower bound
        bucket_lower = {
            "<15": 15, "15-20": 20, "20-25": 25, "25-30": 30, "30+": 30
        }
        gate_thresh = bucket_lower.get(worst_bucket, 25)
        gate_note = (
            f"Downgrade tier1 → tier2 when VIX ≥ {gate_thresh} "
            f"(worst bucket: {worst_bucket})"
        )
    else:
        recommend = "DROP VIX gate (insufficient differential)"
        gate_note = (
            f"Relative gap {gap} does not exceed −30% threshold. "
            "Tier1 outcomes are stable across VIX regimes — no gate justified."
        )

    date_range_str = (
        f"{df['date'].min()} to {df['date'].max()}"
        if not df.empty
        else "n/a"
    )

    report = f"""# V2.2 VIX-Conditioned Tier Performance — 2026-05-22

## Method
- 90-day window ({date_range_str}), aligned fires joined to `outcomes.vix_close`
- Aligned filter: `score IS NOT NULL`, `inferred_structure IS NULL`, cum_ncp/npp aligned to option_type, outcome available
- Outcome: `realized_flow_inversion_pct` (preferred) or `realized_eod_pct` fallback
- Buckets: <15, 15-20, 20-25, 25-30, 30+
- Total aligned fires: {len(df):,}
- Tier thresholds: tier1 ≥ {TIER1_MIN} (P95), tier2 ≥ {TIER2_MIN} (P85), tier3 < {TIER2_MIN} (from ml/output/lottery_score_weights.json cutoffs)

## Tier 1 by VIX ({df[df.tier == 'tier1'].shape[0]:,} fires)

{md_table(agg1)}

## Tier 2 by VIX ({df[df.tier == 'tier2'].shape[0]:,} fires)

{md_table(agg2)}

## Tier 3 by VIX ({df[df.tier == 'tier3'].shape[0]:,} fires)

{md_table(agg3)}

## Decision
- Best VIX bucket for tier1: **{best_bucket}** (mean {best_mean})
- Worst VIX bucket: **{worst_bucket}** (mean {worst_mean})
- Relative gap (worst vs best): **{gap}**
- Threshold for gate: −30% relative
- **Recommendation: {recommend}**
- Gate detail: {gate_note}
{('- Sample note: ' + excl_note) if excl_note else ''}
"""
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report)
    print(f"\nReport written: {REPORT_PATH}")


def main() -> None:
    load_env()
    df = fetch_fires()
    df = process(df)

    agg1 = aggregate(df, "tier1")
    agg2 = aggregate(df, "tier2")
    agg3 = aggregate(df, "tier3")

    print("\n--- Tier 1 by VIX bucket ---")
    print(agg1.to_string(index=False))
    print("\n--- Tier 2 by VIX bucket ---")
    print(agg2.to_string(index=False))
    print("\n--- Tier 3 by VIX bucket ---")
    print(agg3.to_string(index=False))

    write_report(df, agg1, agg2, agg3)


if __name__ == "__main__":
    main()
