"""Periscope EDA 02 — Regime x Bias realized-R lookup table.

Builds the (regime_tag x bias) -> mean realized R lookup the user wants for
sanity-checking the playbook output. Emits a CSV pivot table, a sample-count
companion CSV, and a heatmap PNG annotated with the cell means.

Output:
    ml/plots/periscope-eda/regime_bias_table.csv         (mean R)
    ml/plots/periscope-eda/regime_bias_table_n.csv       (sample counts)
    ml/plots/periscope-eda/regime_bias_table.png         (heatmap)
    Console: top 5 (regime, bias) cells by absolute mean R with n >= min.

CLI::

    ml/.venv/bin/python ml/src/periscope_eda/02_regime_bias_table.py \\
        --min-samples 5

Becomes meaningful at n >= 30 total rows.

Dependencies: psycopg2, pandas, numpy, matplotlib, seaborn.
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

PLOT_DIR = Path("ml/plots/periscope-eda")
TABLE_CSV = PLOT_DIR / "regime_bias_table.csv"
COUNT_CSV = PLOT_DIR / "regime_bias_table_n.csv"
HEATMAP_PNG = PLOT_DIR / "regime_bias_table.png"
EMPTY_THRESHOLD = 30


def fetch_rows(database_url: str) -> pd.DataFrame:
    """Pull regime/bias/realized_r triplets from periscope_analyses."""
    sql = """
        SELECT regime_tag, bias, realized_r
        FROM periscope_analyses
        WHERE regime_tag IS NOT NULL
          AND bias IS NOT NULL
          AND realized_r IS NOT NULL
    """
    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn)


def build_pivots(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (mean_r_pivot, count_pivot) keyed by regime_tag x bias."""
    mean_pivot = (
        df.pivot_table(
            index="regime_tag",
            columns="bias",
            values="realized_r",
            aggfunc="mean",
        )
        .sort_index()
        .sort_index(axis=1)
    )
    count_pivot = (
        df.pivot_table(
            index="regime_tag",
            columns="bias",
            values="realized_r",
            aggfunc="count",
            fill_value=0,
        )
        .sort_index()
        .sort_index(axis=1)
    )
    return mean_pivot, count_pivot


def save_csvs(mean_pivot: pd.DataFrame, count_pivot: pd.DataFrame) -> None:
    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    mean_pivot.to_csv(TABLE_CSV, float_format="%.4f")
    count_pivot.to_csv(COUNT_CSV)
    print(f"Saved mean R pivot to {TABLE_CSV}")
    print(f"Saved sample-count pivot to {COUNT_CSV}")


def plot_heatmap(mean_pivot: pd.DataFrame, count_pivot: pd.DataFrame) -> None:
    """Render a heatmap of mean R with n annotations beneath each cell."""
    PLOT_DIR.mkdir(parents=True, exist_ok=True)

    try:
        import seaborn as sns

        fig, ax = plt.subplots(
            figsize=(
                max(6, mean_pivot.shape[1] * 1.4),
                max(4, mean_pivot.shape[0] * 0.9),
            )
        )
        annotations = mean_pivot.copy().astype(object)
        for r in mean_pivot.index:
            for c in mean_pivot.columns:
                mean_val = mean_pivot.loc[r, c]
                n_val = int(count_pivot.loc[r, c])
                if pd.isna(mean_val):
                    annotations.loc[r, c] = ""
                else:
                    annotations.loc[r, c] = f"{mean_val:+.2f}\nn={n_val}"
        sns.heatmap(
            mean_pivot.astype(float),
            annot=annotations.values,
            fmt="",
            cmap="RdBu_r",
            center=0,
            ax=ax,
            cbar_kws={"label": "mean realized R"},
        )
    except ImportError:
        # Fallback to matplotlib imshow if seaborn isn't installed.
        fig, ax = plt.subplots(
            figsize=(
                max(6, mean_pivot.shape[1] * 1.4),
                max(4, mean_pivot.shape[0] * 0.9),
            )
        )
        data = mean_pivot.astype(float).values
        im = ax.imshow(
            data,
            cmap="RdBu_r",
            aspect="auto",
            vmin=-np.nanmax(np.abs(data)),
            vmax=np.nanmax(np.abs(data)),
        )
        ax.set_xticks(range(mean_pivot.shape[1]))
        ax.set_xticklabels(mean_pivot.columns, rotation=45, ha="right")
        ax.set_yticks(range(mean_pivot.shape[0]))
        ax.set_yticklabels(mean_pivot.index)
        for i, r in enumerate(mean_pivot.index):
            for j, c in enumerate(mean_pivot.columns):
                mean_val = mean_pivot.loc[r, c]
                n_val = int(count_pivot.loc[r, c])
                if pd.isna(mean_val):
                    continue
                ax.text(
                    j,
                    i,
                    f"{mean_val:+.2f}\nn={n_val}",
                    ha="center",
                    va="center",
                    fontsize=8,
                    color="black",
                )
        fig.colorbar(im, ax=ax, label="mean realized R")

    ax.set_title("Regime x Bias — mean realized R")
    ax.set_xlabel("Bias")
    ax.set_ylabel("Regime tag")
    fig.tight_layout()
    fig.savefig(HEATMAP_PNG, dpi=120)
    plt.close(fig)
    print(f"Saved heatmap to {HEATMAP_PNG}")


def print_top_cells(
    mean_pivot: pd.DataFrame, count_pivot: pd.DataFrame, min_samples: int
) -> None:
    """Print top 5 cells by absolute mean R with n >= min_samples."""
    rows = []
    for r in mean_pivot.index:
        for c in mean_pivot.columns:
            mean_val = mean_pivot.loc[r, c]
            n_val = int(count_pivot.loc[r, c])
            if pd.isna(mean_val) or n_val < min_samples:
                continue
            rows.append((r, c, float(mean_val), n_val))

    if not rows:
        print(f"No (regime, bias) cells meet n >= {min_samples}.")
        return

    rows.sort(key=lambda t: abs(t[2]), reverse=True)
    print(f"Top 5 (regime, bias) cells by |mean R| with n >= {min_samples}:")
    print("-" * 64)
    print(f"{'regime':<18}{'bias':<14}{'mean_r':>12}{'n':>10}")
    for r, c, mean_val, n_val in rows[:5]:
        print(f"{r:<18}{c:<14}{mean_val:>+12.3f}{n_val:>10}")
    print("-" * 64)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--min-samples",
        type=int,
        default=5,
        help="Minimum n required for a cell to appear in the top-5 console summary.",
    )
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL not set in environment.", file=sys.stderr)
        return 1

    df = fetch_rows(database_url)
    if df.empty:
        print(
            "No rows match query — corpus may be too small. "
            f"Need at least {EMPTY_THRESHOLD} rows total."
        )
        return 0

    mean_pivot, count_pivot = build_pivots(df)
    save_csvs(mean_pivot, count_pivot)
    plot_heatmap(mean_pivot, count_pivot)
    print_top_cells(mean_pivot, count_pivot, args.min_samples)
    return 0


if __name__ == "__main__":
    sys.exit(main())
