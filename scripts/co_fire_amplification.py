#!/usr/bin/env python
"""V2.2 Phase A.4 — Co-fire amplification analysis.

For each tier1 fire (score >= 9, aligned, with outcome), counts how many
OTHER distinct tickers also fired tier1 within ±5 minutes of its
trigger_time_ct.  Buckets by cluster size (1=isolated, 2, 3-4, 5+) and
computes mean_pct, win_rate, hit_50_pct per bucket.

Writes findings to:
  docs/tmp/v22-co-fire-analysis-2026-05-22.md

Usage:
    ml/.venv/bin/python scripts/co_fire_amplification.py
"""

from __future__ import annotations

import os
import re
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import psycopg2

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
REPORT_DIR = ROOT / "docs" / "tmp"
REPORT_PATH = REPORT_DIR / "v22-co-fire-analysis-2026-05-22.md"

# ---------------------------------------------------------------------------
# Env loading
# ---------------------------------------------------------------------------


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f"Missing env file: {ENV_FILE}")
    with ENV_FILE.open() as fh:
        for line in fh:
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                os.environ.setdefault(m.group(1), m.group(2).strip('"').strip("'"))


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
    id,
    underlying_symbol,
    trigger_time_ct,
    realized_flow_inversion_pct,
    realized_eod_pct,
    peak_ceiling_pct
FROM lottery_finder_fires
WHERE
    date >= CURRENT_DATE - INTERVAL '30 days'
    AND score >= 9
    AND score IS NOT NULL
    AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
ORDER BY trigger_time_ct
"""


def fetch_fires() -> pd.DataFrame:
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set")

    print("Connecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=15)
    print("Fetching tier1 fires (last 30 days)...")
    df = pd.read_sql_query(FETCH_QUERY, conn)
    conn.close()
    print(f"  Fetched {len(df):,} fires")
    return df


# ---------------------------------------------------------------------------
# Outcome column + enrichment bug filter
# ---------------------------------------------------------------------------


def build_outcome(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )
    # Drop enrichment-bug rows (flow_inv implausibly exceeds peak)
    pre = len(df)
    mask_bug = (
        df["realized_flow_inversion_pct"].notna()
        & df["peak_ceiling_pct"].notna()
        & (df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * 1.05)
    )
    df = df[~mask_bug].copy()
    dropped = pre - len(df)
    if dropped:
        print(f"  Dropped {dropped:,} enrichment-bug rows")
    return df


# ---------------------------------------------------------------------------
# Co-fire cluster sizing
# ---------------------------------------------------------------------------

WINDOW_SECONDS = 5 * 60  # ±5 minutes


def compute_cluster_sizes(df: pd.DataFrame) -> pd.Series:
    """
    For each fire i, count distinct OTHER tickers that fired tier1 within
    ±5 min of df.trigger_time_ct[i].

    Returns a Series of n_other_tickers (same index as df).
    """
    # datetime64[us, UTC] → int64 gives microseconds
    times = df["trigger_time_ct"].values.astype("int64")  # microseconds
    tickers = df["underlying_symbol"].values
    window_ns = WINDOW_SECONDS * 1_000_000  # 5 min in microseconds

    n_others = []
    for i in range(len(df)):
        t = times[i]
        lo = t - window_ns
        hi = t + window_ns
        # boolean mask: within window AND different ticker
        in_window = (times >= lo) & (times <= hi)
        other_ticker = tickers != tickers[i]
        other_symbols = set(tickers[in_window & other_ticker])
        n_others.append(len(other_symbols))

    return pd.Series(n_others, index=df.index, name="n_other_tickers")


def assign_cluster_bucket(n: int) -> str:
    if n == 0:
        return "1 (isolated)"
    if n == 1:
        return "2"
    if n <= 3:
        return "3-4"
    return "5+"


BUCKET_ORDER = ["1 (isolated)", "2", "3-4", "5+"]

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


def analyze(df: pd.DataFrame) -> pd.DataFrame:
    """Return a summary DataFrame with one row per cluster bucket."""
    rows = []
    for bucket in BUCKET_ORDER:
        grp = df[df["cluster_bucket"] == bucket]
        if grp.empty:
            continue
        mean_pct = grp["outcome_pct"].mean()
        win_rate = (grp["outcome_pct"] > 0).mean() * 100
        hit_50 = (grp["outcome_pct"] >= 50).mean() * 100
        rows.append(
            {
                "cluster_size": bucket,
                "n_fires": len(grp),
                "mean_pct": round(mean_pct, 2),
                "win_pct": round(win_rate, 1),
                "hit_50_pct": round(hit_50, 1),
            }
        )
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------


def render_report(
    summary: pd.DataFrame,
    lift_pp: float,
    recommendation: str,
    bonus_suggestion: str | None,
    n_total: int,
) -> str:
    today = date.today().strftime("%Y-%m-%d")

    table_header = (
        "| cluster_size | n_fires | mean_pct | win% | hit_50% |\n"
        "| --- | --- | --- | --- | --- |"
    )
    table_rows = []
    for _, row in summary.iterrows():
        table_rows.append(
            f"| {row['cluster_size']} "
            f"| {int(row['n_fires'])} "
            f"| {row['mean_pct']:.2f}% "
            f"| {row['win_pct']:.1f}% "
            f"| {row['hit_50_pct']:.1f}% |"
        )

    lines = [
        f"# V2.2 Co-Fire Amplification Analysis — {today}",
        "",
        "## Method",
        "- 30-day window of tier1 fires only (score >= 9, aligned, outcome present)",
        "- Cluster = N distinct OTHER tickers firing tier1 within ±5 min of this fire",
        f"- Total fires analyzed: {n_total:,}",
        "",
        "## Cluster size distribution",
        "",
        table_header,
    ]
    lines.extend(table_rows)
    lines += [
        "",
        "## Decision",
        f"- Lift (largest cluster vs isolated) = {lift_pp:+.1f} pp mean outcome",
        f"- Recommendation: {recommendation}",
    ]
    if bonus_suggestion:
        lines.append(f"- {bonus_suggestion}")
    lines += [
        "",
        "## Caveats",
        "- 30-day window only (~22 trading days)",
        "- Tier1 itself is score-gated sparse — cluster opportunities are limited",
        "- Cluster detection is purely temporal; no causal claim about direction",
        "- ±5-min window may conflate market-wide macro moves with option-specific flow",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    load_env()

    df_raw = fetch_fires()
    df = build_outcome(df_raw)

    print("Computing co-fire cluster sizes (this may take ~30s for 5k+ rows)...")
    df["n_other_tickers"] = compute_cluster_sizes(df)
    df["cluster_bucket"] = df["n_other_tickers"].apply(assign_cluster_bucket)

    print("\nCluster bucket distribution:")
    for b in BUCKET_ORDER:
        n = (df["cluster_bucket"] == b).sum()
        print(f"  {b}: {n:,}")

    summary = analyze(df)
    print(f"\n{summary.to_string(index=False)}")

    # Lift: compare largest cluster bucket with outcome vs isolated
    isolated_mean = summary.loc[
        summary["cluster_size"] == "1 (isolated)", "mean_pct"
    ].values
    if len(isolated_mean) == 0:
        sys.exit("No isolated fires found — cannot compute lift.")
    isolated_mean = isolated_mean[0]

    # Find the non-isolated bucket with highest n_fires for the lift comparison
    non_isolated = summary[summary["cluster_size"] != "1 (isolated)"]
    if non_isolated.empty:
        lift_pp = 0.0
        cluster_label = "none"
    else:
        # Use 5+ if populated; otherwise the densest bucket
        fivep = non_isolated[non_isolated["cluster_size"] == "5+"]
        if not fivep.empty and fivep.iloc[0]["n_fires"] >= 30:
            best_row = fivep.iloc[0]
        else:
            best_row = non_isolated.loc[non_isolated["n_fires"].idxmax()]
        lift_pp = best_row["mean_pct"] - isolated_mean
        cluster_label = best_row["cluster_size"]

    print(f"\nLift ({cluster_label} vs isolated) = {lift_pp:+.2f} pp")

    # Decision
    if lift_pp >= 20:
        recommendation = "SHIP cluster bonus"
        # Bonus magnitude: scale proportionally, cap at +3
        bonus_pts = min(3, max(1, round(lift_pp / 10)))
        bonus_suggestion = (
            f"Suggested bonus magnitude = +{bonus_pts} pts "
            f"(proportional to {lift_pp:.1f} pp lift, capped at +3)"
        )
    elif lift_pp > 0:
        recommendation = "MARGINAL — defer to longer window (60-90 days)"
        bonus_suggestion = None
    else:
        recommendation = "DROP cluster bonus"
        bonus_suggestion = None

    report = render_report(
        summary=summary,
        lift_pp=lift_pp,
        recommendation=recommendation,
        bonus_suggestion=bonus_suggestion,
        n_total=len(df),
    )

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"\nWrote report: {REPORT_PATH}")
    print(f"Recommendation: {recommendation}")


if __name__ == "__main__":
    main()
