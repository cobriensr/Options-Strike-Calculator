"""Periscope EDA 01 — Confidence calibration.

Validates that the model's ``confidence`` label is monotone with realized R.
If "high" wins less often than "low", the confidence field is anti-signal
and should not be trusted by downstream consumers.

Output:
    ml/plots/periscope-eda/confidence_calibration.png
    Console summary table (mean R, hit rate %, n) per band.

CLI::

    ml/.venv/bin/python ml/src/periscope_eda/01_confidence_calibration.py \\
        --min-samples 5 --mode all

Becomes meaningful at n >= 10 per confidence band.

Dependencies: psycopg2, pandas, numpy, matplotlib.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

CONFIDENCE_ORDER = ["low", "medium", "high"]
PLOT_PATH = Path("ml/plots/periscope-eda/confidence_calibration.png")
EMPTY_THRESHOLD = 10


def fetch_rows(database_url: str, mode: str) -> pd.DataFrame:
    """Pull confidence + realized R from periscope_analyses.

    The ``mode`` filter narrows to one of pre_trade/intraday or accepts all
    rows when mode == 'all'.
    """
    sql = """
        SELECT mode, confidence, realized_r
        FROM periscope_analyses
        WHERE confidence IS NOT NULL
          AND realized_r IS NOT NULL
    """
    params: tuple = ()
    if mode != "all":
        sql += " AND mode = %s"
        params = (mode,)

    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn, params=params)


def summarize(df: pd.DataFrame) -> pd.DataFrame:
    """Group by confidence band and compute mean R, hit rate, sample count."""
    df = df.copy()
    df["confidence"] = pd.Categorical(
        df["confidence"], categories=CONFIDENCE_ORDER, ordered=True
    )
    grouped = (
        df.groupby("confidence", observed=False)["realized_r"]
        .agg(
            mean_r="mean",
            hit_rate=lambda x: float((x > 0).mean()) if len(x) else float("nan"),
            n="count",
        )
        .reset_index()
    )
    return grouped


def print_summary(summary: pd.DataFrame) -> None:
    print("Confidence calibration summary")
    print("-" * 56)
    print(f"{'band':<10}{'mean_r':>12}{'hit_rate':>14}{'n':>10}")
    for _, row in summary.iterrows():
        mean_r = row["mean_r"]
        hit_rate = row["hit_rate"]
        n_val = int(row["n"])
        mean_str = f"{mean_r:.3f}" if pd.notna(mean_r) else "n/a"
        hit_str = f"{hit_rate * 100:.1f}%" if pd.notna(hit_rate) else "n/a"
        print(f"{str(row['confidence']):<10}{mean_str:>12}{hit_str:>14}{n_val:>10}")
    print("-" * 56)


def plot_calibration(summary: pd.DataFrame, min_samples: int, mode: str) -> None:
    """Bar chart of mean R per confidence band, with sample-count annotations.

    Bands with n < min_samples render in faded grey and get a '*' marker so
    the reader knows the bar is statistically thin.
    """
    PLOT_PATH.parent.mkdir(parents=True, exist_ok=True)

    bands = summary["confidence"].astype(str).tolist()
    means = summary["mean_r"].fillna(0).tolist()
    counts = summary["n"].astype(int).tolist()

    colors = []
    labels = []
    for n in counts:
        if n < min_samples:
            colors.append("#cccccc")
            labels.append("low confidence due to small sample (*)")
        else:
            colors.append("#1f77b4")
            labels.append("sufficient n")

    fig, ax = plt.subplots(figsize=(8, 5))
    bars = ax.bar(bands, means, color=colors, edgecolor="black")

    for bar, n, mean in zip(bars, counts, means, strict=False):
        marker = "*" if n < min_samples else ""
        ax.annotate(
            f"n={n}{marker}\n{mean:+.2f}",
            xy=(bar.get_x() + bar.get_width() / 2, bar.get_height()),
            xytext=(0, 5 if mean >= 0 else -18),
            textcoords="offset points",
            ha="center",
            fontsize=9,
        )

    ax.axhline(0, color="black", linewidth=0.8)
    title_mode = mode if mode != "all" else "all modes"
    ax.set_title(
        f"Confidence calibration — mean realized R per band ({title_mode})"
    )
    ax.set_xlabel("Confidence band")
    ax.set_ylabel("Mean realized R")

    legend_seen: set[str] = set()
    handles = []
    for color, label in zip(colors, labels, strict=False):
        if label in legend_seen:
            continue
        legend_seen.add(label)
        handles.append(plt.Rectangle((0, 0), 1, 1, color=color, ec="black"))
    if handles:
        ax.legend(
            handles, list(legend_seen), loc="best", fontsize=8, framealpha=0.9
        )

    fig.tight_layout()
    fig.savefig(PLOT_PATH, dpi=120)
    plt.close(fig)
    print(f"Saved plot to {PLOT_PATH}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--min-samples",
        type=int,
        default=5,
        help="Bands with n < this count render faded with '*' marker.",
    )
    parser.add_argument(
        "--mode",
        choices=["pre_trade", "intraday", "all"],
        default="all",
        help="Filter by analysis mode (default: all).",
    )
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL not set in environment.", file=sys.stderr)
        return 1

    df = fetch_rows(database_url, args.mode)
    if df.empty:
        print(
            "No rows match query — corpus may be too small. "
            f"Need at least {EMPTY_THRESHOLD} rows per confidence band."
        )
        return 0

    summary = summarize(df)
    print_summary(summary)
    plot_calibration(summary, args.min_samples, args.mode)
    return 0


if __name__ == "__main__":
    sys.exit(main())
