"""Periscope EDA 07 — Vol-compression-by-gamma test.

Tests the academic claim: when MM are net long gamma, intraday realized
range compresses below VIX-implied expected range.

Per trading_date:
    signed_distance_pct = (spx_open - zero_gamma_at_open) / spx_open * 100
                          (positive → spot ABOVE zero-gamma → dealers LONG γ → suppressive)
    net_gamma_at_open   = direct $-value of dealer net γ at spot (from
                          zero_gamma_levels.net_gamma_at_spot)
    realized_range_pct  = (day_high - day_low) /
                          (spx_open * vix_open/100 * sqrt(1/252))
                          1.0 = realized range matches VIX-implied expected
                          <1.0 = compression; >1.0 = expansion

Hypothesis: spearman(signed_distance_pct, realized_range_pct) < 0
            (positive γ → compressed range)

Run::

    set -a; source .env.local; set +a
    ml/.venv/bin/python ml/src/periscope_eda/07_vol_compression_by_gamma.py

Outputs:
    ml/plots/periscope-eda/vol_compression_by_gamma.png
    Console: regression + correlation + bucketed table
"""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2
from scipy.stats import pearsonr, spearmanr

PLOT_PATH = Path("ml/plots/periscope-eda/vol_compression_by_gamma.png")
TRADING_DAYS_PER_YEAR = 252


def fetch_data(database_url: str) -> pd.DataFrame:
    """One row per trading_date with all the inputs we need.

    Joins:
      - index_candles_1m: spx_open, spx_high, spx_low (regular hours only)
      - market_snapshots: vix_open (first entry per day)
      - zero_gamma_levels: spot, zero_gamma, net_gamma_at_spot at open
        (earliest ts on or after 8:30 CT for each date)
    """
    sql = """
        WITH spx_daily AS (
          SELECT
            date,
            (array_agg(open ORDER BY timestamp))[1]::float AS spx_open,
            MAX(high)::float AS spx_high,
            MIN(low)::float AS spx_low
          FROM index_candles_1m
          WHERE symbol = 'SPX' AND market_time = 'r'
          GROUP BY date
        ),
        vix_daily AS (
          SELECT
            date,
            (array_agg(vix ORDER BY entry_time))[1]::float AS vix_open,
            (array_agg(vix1d ORDER BY entry_time))[1]::float AS vix1d_open
          FROM market_snapshots
          WHERE vix IS NOT NULL
          GROUP BY date
        ),
        zg_open AS (
          SELECT DISTINCT ON (ts::date)
            ts::date AS date,
            spot::float AS zg_spot,
            zero_gamma::float AS zero_gamma,
            net_gamma_at_spot::float AS net_gamma_at_spot,
            confidence::float AS zg_confidence,
            ts AS zg_ts
          FROM zero_gamma_levels
          WHERE ticker = 'SPX'
            AND ts >= (ts::date + INTERVAL '13 hours 25 minutes')
                AT TIME ZONE 'UTC'
          ORDER BY ts::date, ts
        )
        SELECT
          s.date,
          s.spx_open, s.spx_high, s.spx_low,
          v.vix_open, v.vix1d_open,
          z.zero_gamma, z.net_gamma_at_spot, z.zg_confidence, z.zg_ts
        FROM spx_daily s
        INNER JOIN vix_daily v USING (date)
        INNER JOIN zg_open z USING (date)
        ORDER BY s.date
    """
    with psycopg2.connect(database_url) as conn:
        df = pd.read_sql_query(sql, conn)
    return df


def compute_metrics(df: pd.DataFrame) -> pd.DataFrame:
    """Derive the experiment metrics."""
    df = df.copy()
    daily_vol_factor = math.sqrt(1.0 / TRADING_DAYS_PER_YEAR)
    df["expected_daily_range_pts"] = (
        df["spx_open"] * (df["vix_open"] / 100.0) * daily_vol_factor
    )
    df["realized_range_pts"] = df["spx_high"] - df["spx_low"]
    df["realized_range_pct"] = df["realized_range_pts"] / df["expected_daily_range_pts"]
    df["signed_distance_pct"] = (
        (df["spx_open"] - df["zero_gamma"]) / df["spx_open"] * 100.0
    )
    df["net_gamma_at_spot_M"] = df["net_gamma_at_spot"] / 1_000_000.0
    return df


def print_summary(df: pd.DataFrame) -> None:
    print(f"=== Vol-compression test: N = {len(df)} trading days ===")
    print(f"    Range: {df['date'].min()} → {df['date'].max()}")
    print()

    # Sample
    print("Per-day snapshot (first/last 5 rows):")
    cols = [
        "date",
        "spx_open",
        "vix_open",
        "zero_gamma",
        "signed_distance_pct",
        "net_gamma_at_spot_M",
        "realized_range_pts",
        "expected_daily_range_pts",
        "realized_range_pct",
    ]
    print(df[cols].head().to_string(index=False))
    print("...")
    print(df[cols].tail().to_string(index=False))
    print()

    # Headline correlations
    print("=== Correlations (one-sided: more +γ → tighter range) ===")
    for label, x_col in (
        ("signed_distance_pct (% above zero-gamma)", "signed_distance_pct"),
        ("net_gamma_at_spot ($M, raw)", "net_gamma_at_spot_M"),
    ):
        sub = df.dropna(subset=[x_col, "realized_range_pct"])
        x = sub[x_col].to_numpy()
        y = sub["realized_range_pct"].to_numpy()
        n_used = len(sub)
        if n_used < len(df):
            print(f"  (dropped {len(df) - n_used} rows with NaN in {x_col})")
        r_pearson, p_pearson = pearsonr(x, y)
        r_spear, p_spear = spearmanr(x, y)
        print(f"\n{label} vs realized_range_pct:")
        print(f"  Pearson r  = {r_pearson:+.3f}  p = {p_pearson:.4f}")
        print(f"  Spearman ρ = {r_spear:+.3f}  p = {p_spear:.4f}")
        print(
            f"  (Hypothesis: r < 0; one-sided p ≈ {p_pearson / 2 if r_pearson < 0 else 1 - p_pearson / 2:.4f})"
        )
    print()

    # Bucket analysis on signed_distance_pct
    print("=== Bucketed: mean realized_range_pct by signed_distance bucket ===")
    df_b = df.copy()
    # Quartile buckets on signed_distance_pct
    df_b["bucket"] = pd.qcut(
        df_b["signed_distance_pct"],
        q=4,
        labels=["Q1: most -γ", "Q2: slight -γ", "Q3: slight +γ", "Q4: most +γ"],
    )
    agg = (
        df_b.groupby("bucket", observed=True)
        .agg(
            n=("date", "size"),
            mean_signed_dist=("signed_distance_pct", "mean"),
            mean_realized_pct=("realized_range_pct", "mean"),
            median_realized_pct=("realized_range_pct", "median"),
        )
        .round(3)
    )
    print(agg.to_string())
    print()

    # Sign of net_gamma_at_spot
    print("=== Net-gamma sign cut (raw) ===")
    pos = df[df["net_gamma_at_spot_M"] > 0]
    neg = df[df["net_gamma_at_spot_M"] < 0]
    print(
        f"  Net γ > 0 (LONG):  n={len(pos)}, mean realized_range_pct = {pos['realized_range_pct'].mean():.3f}"
    )
    print(
        f"  Net γ < 0 (SHORT): n={len(neg)}, mean realized_range_pct = {neg['realized_range_pct'].mean():.3f}"
    )


def plot_scatter(df: pd.DataFrame, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(1, 2, figsize=(13, 6))

    for ax, x_col, x_label in (
        (
            axes[0],
            "signed_distance_pct",
            "Signed distance from zero-gamma (% of spot)\n← spot below zero-γ (short γ)    spot above zero-γ (long γ) →",
        ),
        (
            axes[1],
            "net_gamma_at_spot_M",
            "Net gamma at spot ($M)\n← dealers short γ    dealers long γ →",
        ),
    ):
        sub = df.dropna(subset=[x_col, "realized_range_pct"])
        x = sub[x_col].to_numpy()
        y = sub["realized_range_pct"].to_numpy()
        ax.scatter(x, y, alpha=0.7, s=50, edgecolors="black", color="#1f77b4")
        # Trendline
        slope, intercept = np.polyfit(x, y, 1)
        xs = np.linspace(x.min(), x.max(), 100)
        ax.plot(
            xs,
            slope * xs + intercept,
            color="#d62728",
            linewidth=2,
            label=f"slope = {slope:+.4f}",
        )
        # Reference lines
        ax.axhline(
            1.0,
            color="gray",
            linestyle=":",
            linewidth=0.7,
            label="realized = expected (VIX-implied)",
        )
        ax.axvline(0.0, color="black", linewidth=0.7)
        r, p = spearmanr(x, y)
        ax.set_xlabel(x_label)
        ax.set_ylabel("Realized range / expected (VIX-implied)")
        ax.set_title(f"Spearman ρ = {r:+.3f}  (p = {p:.3f})")
        ax.legend(loc="best", fontsize=8)
        ax.grid(alpha=0.3)

    fig.suptitle(
        f"Vol compression vs dealer net gamma  (n = {len(df)} trading days)\n"
        "Hypothesis: more +γ → realized range below VIX-implied (negative correlation)",
        fontsize=11,
    )
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 1

    print("Fetching per-day inputs (SPX OHLC, VIX, zero-gamma at open)…")
    df = fetch_data(database_url)
    if df.empty:
        print(
            "ERROR: no joined rows. Check that zero_gamma_levels has SPX coverage.",
            file=sys.stderr,
        )
        return 1

    df = compute_metrics(df)

    print_summary(df)
    print(f"\nWriting plot to {PLOT_PATH}…")
    plot_scatter(df, PLOT_PATH)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
