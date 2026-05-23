#!/usr/bin/env python
"""V2.2 Phase A.6 — Tier1 intra-day sub-ranking analysis.

For each of the last 30 days, pulls all aligned tier1 fires (score >= 9),
ranks them within the day by score descending (Approach A), then splits
into top-3 / 4-10 / 11+ buckets.

Computes mean outcome, win%, and hit_50% per rank bucket aggregated over
30 days to test whether top-3 by score outperforms the rest.

Outcome metric: realized_trail30_10_pct (primary), falling back to
realized_eod_pct if absent (consistent with other v22 scripts).

Writes: docs/tmp/v22-tier1-subrank-2026-05-22.md

Usage:
    ml/.venv/bin/python scripts/tier1_subrank_analysis.py
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
REPORT_PATH = ROOT / "docs" / "tmp" / "v22-tier1-subrank-2026-05-22.md"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TIER1_MIN_SCORE = 9       # per spec (A.6 uses score >= 9 as tier1 boundary)
WINDOW_DAYS = 30
SHIP_THRESHOLD_PP = 15.0  # top-3 uplift over rest to recommend SHIP


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
    f.realized_trail30_10_pct,
    f.realized_eod_pct,
    f.peak_ceiling_pct,
    f.realized_flow_inversion_pct
FROM lottery_finder_fires f
WHERE
    f.date >= CURRENT_DATE - INTERVAL '{days} days'
    AND f.date < CURRENT_DATE
    AND f.score >= {tier1_min}
    AND f.score IS NOT NULL
    AND (
        f.realized_trail30_10_pct IS NOT NULL
        OR f.realized_eod_pct IS NOT NULL
    )
ORDER BY f.date, f.score DESC, f.id
""".format(days=WINDOW_DAYS, tier1_min=TIER1_MIN_SCORE)


# ---------------------------------------------------------------------------
# Data fetch
# ---------------------------------------------------------------------------


def fetch_fires() -> pd.DataFrame:
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set")

    print("Connecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=15)
    print("Fetching tier1 fires...")
    df = pd.read_sql_query(FETCH_QUERY, conn)
    conn.close()
    print(f"Fetched {len(df):,} rows across {df['date'].nunique()} days")
    return df


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------


def assign_outcome(df: pd.DataFrame) -> pd.DataFrame:
    """Primary outcome: realized_trail30_10_pct; fall back to realized_eod_pct."""
    df = df.copy()
    df["outcome_pct"] = df["realized_trail30_10_pct"].combine_first(
        df["realized_eod_pct"]
    )

    # Drop enrichment-bug rows (flow_inv > peak * 1.05) — mirrors vix_regime_analysis
    mask_bug = (
        df["realized_flow_inversion_pct"].notna()
        & df["peak_ceiling_pct"].notna()
        & (df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * 1.05)
    )
    dropped = mask_bug.sum()
    if dropped:
        print(f"Dropped {dropped:,} enrichment-bug rows (flow_inv > peak*1.05)")
    df = df[~mask_bug].copy()

    df["win"] = df["outcome_pct"] >= 0
    df["hit_50"] = df["outcome_pct"] >= 50
    return df


RANK_BUCKETS = [
    ("Top 3",  lambda r: r <= 3),
    ("4-10",   lambda r: 4 <= r <= 10),
    ("11+",    lambda r: r >= 11),
]


def assign_rank_bucket(df: pd.DataFrame) -> pd.DataFrame:
    """Within each day, rank fires by score DESC then id ASC (stable). Assign bucket."""
    df = df.copy()
    # rank within day: score descending, id ascending for ties
    df["rank_within_day"] = (
        df.groupby("date")["score"]
        .rank(method="first", ascending=False)
        .astype(int)
    )

    def _bucket(r: int) -> str:
        for label, pred in RANK_BUCKETS:
            if pred(r):
                return label
        return "11+"  # fallback

    df["rank_bucket"] = df["rank_within_day"].apply(_bucket)
    return df


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def aggregate_buckets(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    bucket_order = [label for label, _ in RANK_BUCKETS]
    for label in bucket_order:
        g = df[df["rank_bucket"] == label]
        n = len(g)
        if n == 0:
            rows.append({
                "bucket": label,
                "n": 0,
                "mean_pct": None,
                "win_pct": None,
                "hit_50_pct": None,
            })
        else:
            rows.append({
                "bucket": label,
                "n": n,
                "mean_pct": g["outcome_pct"].mean(),
                "win_pct": g["win"].mean() * 100,
                "hit_50_pct": g["hit_50"].mean() * 100,
            })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

BUCKET_ORDER = ["Top 3", "4-10", "11+"]


def _fmt(v: float | None, decimals: int = 1, suffix: str = "%") -> str:
    if v is None:
        return "—"
    sign = "+" if v > 0 else ""
    return f"{sign}{v:.{decimals}f}{suffix}"


def build_report(
    agg: pd.DataFrame,
    df_full: pd.DataFrame,
    days_with_data: int,
    days_with_tier1: int,
) -> str:
    top3_row = agg[agg["bucket"] == "Top 3"].iloc[0]
    rest_rows = agg[agg["bucket"] != "Top 3"]
    rest_n = rest_rows["n"].sum()
    if rest_n > 0 and rest_rows["mean_pct"].notna().any():
        rest_mean = (
            rest_rows.dropna(subset=["mean_pct"])
            .apply(lambda r: r["mean_pct"] * r["n"], axis=1)
            .sum()
            / rest_rows.dropna(subset=["mean_pct"])["n"].sum()
        )
    else:
        rest_mean = None

    top3_mean = top3_row["mean_pct"]
    uplift = (top3_mean - rest_mean) if (top3_mean is not None and rest_mean is not None) else None

    decision_lines = []
    if uplift is not None:
        decision_lines.append(f"- Top-3 mean uplift over rest: **{uplift:+.1f} pp**")
        if uplift >= SHIP_THRESHOLD_PP:
            decision_lines.append(
                f"- Recommendation: **SHIP** tier1_priority badge"
            )
            decision_lines.append(
                "- If SHIP: render top-3 daily fires with priority badge"
            )
        else:
            decision_lines.append(
                f"- Recommendation: **DROP** tier1_priority badge "
                f"(uplift {uplift:+.1f} pp < {SHIP_THRESHOLD_PP:.0f} pp threshold)"
            )
    else:
        decision_lines.append("- Top-3 mean uplift: **n/a** (insufficient data)")
        decision_lines.append("- Recommendation: **DROP** (no data)")

    # Score distribution among tier1 fires
    score_dist = (
        df_full.groupby("score")["id"]
        .count()
        .sort_index(ascending=False)
    )
    score_lines = []
    for sc, cnt in score_dist.items():
        score_lines.append(f"  - score={sc}: {cnt:,} fires")

    # Per-day stats
    per_day = df_full.groupby("date").agg(
        tier1_n=("id", "count"),
        max_score=("score", "max"),
        top3_n=("rank_within_day", lambda x: (x <= 3).sum()),
    )

    lines = [
        "# V2.2 Tier1 Intra-Day Sub-Ranking — 2026-05-22",
        "",
        "## Method",
        f"- {WINDOW_DAYS}-day window (excluding today)",
        f"- Tier1 definition: score >= {TIER1_MIN_SCORE} (per A.6 spec)",
        "- **Approach A** — intra-day rank by score descending (ties broken by fire id ascending)",
        "- Outcome: `realized_trail30_10_pct` (primary) or `realized_eod_pct` fallback",
        f"- Days in window: {days_with_data} market days, {days_with_tier1} with ≥1 tier1 fire",
        f"- Total tier1 fires: {len(df_full):,}",
        "",
        "## Score distribution within tier1 (all fires)",
        *score_lines,
        "",
        "## Results — rank bucket vs outcome",
        "",
        "| Rank within day | n | mean_pct | win% | hit_50% |",
        "| --- | --- | --- | --- | --- |",
    ]

    for _, row in agg.iterrows():
        n = int(row["n"]) if row["n"] else 0
        mean_s = _fmt(row["mean_pct"])
        win_s = _fmt(row["win_pct"])
        hit50_s = _fmt(row["hit_50_pct"])
        lines.append(f"| {row['bucket']} | {n:,} | {mean_s} | {win_s} | {hit50_s} |")

    if rest_mean is not None:
        lines.append(f"| **Rest (4+)** | {rest_n:,} | {_fmt(rest_mean)} | — | — |")

    lines += [
        "",
        "## Per-day coverage",
        f"- Days with ≥1 tier1 fire: {days_with_tier1}",
        f"- Days with ≥3 tier1 fires (top-3 fully populated): "
        f"{(per_day['tier1_n'] >= 3).sum()}",
        f"- Median tier1 fires/day: {per_day['tier1_n'].median():.0f}",
        f"- Max tier1 fires/day: {per_day['tier1_n'].max()}",
        "",
        "## Decision",
        *decision_lines,
    ]

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    load_env()
    df_raw = fetch_fires()

    if df_raw.empty:
        sys.exit("No tier1 fires found — cannot produce sub-ranking report.")

    df = assign_outcome(df_raw)
    df = assign_rank_bucket(df)

    days_with_data = df["date"].nunique()
    days_with_tier1 = days_with_data  # every day returned has >= 1 fire (score >= 9)

    agg = aggregate_buckets(df)

    print("\n--- Aggregated results by rank bucket ---")
    for _, row in agg.iterrows():
        n = int(row["n"]) if row["n"] else 0
        mean_s = f"{row['mean_pct']:+.1f}%" if row["mean_pct"] is not None else "—"
        print(f"  {row['bucket']:8s}  n={n:6,}  mean={mean_s}")

    report = build_report(agg, df, days_with_data, days_with_tier1)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"\nReport written to {REPORT_PATH}")


if __name__ == "__main__":
    main()
