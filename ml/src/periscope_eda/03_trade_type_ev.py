"""Periscope EDA 03 — Per (trade_type x regime) realized R.

Explodes the JSONB ``trade_types_recommended`` array and bins the realized R
by (trade_type, regime_tag). Emits one bar chart per regime so each regime's
playbook can be inspected independently.

Output:
    ml/plots/periscope-eda/trade_type_ev_<regime>.png   (one per regime)
    Console: top 10 (trade_type, regime) cells by |mean R| with n >= min.

CLI::

    ml/.venv/bin/python ml/src/periscope_eda/03_trade_type_ev.py \\
        --min-samples 3

Becomes meaningful at n >= 30 total rows. Trade-type cells are sparser than
regime/bias cells, hence the lower default --min-samples of 3.

Dependencies: psycopg2, pandas, numpy, matplotlib.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

PLOT_DIR = Path("ml/plots/periscope-eda")
EMPTY_THRESHOLD = 30
SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    """Make a filesystem-safe slug from a regime tag."""
    return SLUG_RE.sub("-", value.strip().lower()).strip("-") or "unknown"


def fetch_rows(database_url: str) -> pd.DataFrame:
    """Pull (trade_type, regime, realized_r) triples by unrolling the JSONB array.

    Postgres' ``jsonb_array_elements_text`` explodes the recommended trade types
    so each row in the result is a single (trade_type, regime, r) observation.
    """
    sql = """
        SELECT
            elem AS trade_type,
            p.regime_tag,
            p.realized_r
        FROM periscope_analyses p
        CROSS JOIN LATERAL jsonb_array_elements_text(p.trade_types_recommended) AS elem
        WHERE p.realized_r IS NOT NULL
          AND p.regime_tag IS NOT NULL
          AND p.trade_types_recommended IS NOT NULL
          AND jsonb_typeof(p.trade_types_recommended) = 'array'
    """
    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn)


def aggregate(df: pd.DataFrame) -> pd.DataFrame:
    """Group by (regime, trade_type) and compute mean R + n."""
    return (
        df.groupby(["regime_tag", "trade_type"])["realized_r"]
        .agg(mean_r="mean", n="count")
        .reset_index()
    )


def plot_per_regime(agg: pd.DataFrame, min_samples: int) -> list[Path]:
    """Render one bar chart per regime, faded bars for n < min_samples."""
    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []

    for regime, group in agg.groupby("regime_tag"):
        group = group.sort_values("mean_r", ascending=False).reset_index(drop=True)
        if group.empty:
            continue

        fig, ax = plt.subplots(figsize=(max(6, len(group) * 0.7), 5))
        colors = [
            "#1f77b4" if int(n) >= min_samples else "#cccccc"
            for n in group["n"].tolist()
        ]
        bars = ax.bar(
            group["trade_type"].tolist(),
            group["mean_r"].tolist(),
            color=colors,
            edgecolor="black",
        )
        for bar, n, mean in zip(
            bars, group["n"].astype(int).tolist(), group["mean_r"].tolist(), strict=False
        ):
            marker = "*" if n < min_samples else ""
            ax.annotate(
                f"n={n}{marker}",
                xy=(bar.get_x() + bar.get_width() / 2, bar.get_height()),
                xytext=(0, 4 if mean >= 0 else -14),
                textcoords="offset points",
                ha="center",
                fontsize=8,
            )
        ax.axhline(0, color="black", linewidth=0.8)
        ax.set_title(f"Trade-type EV — regime: {regime}")
        ax.set_xlabel("Recommended trade type")
        ax.set_ylabel("Mean realized R")
        plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
        fig.tight_layout()

        out = PLOT_DIR / f"trade_type_ev_{slugify(str(regime))}.png"
        fig.savefig(out, dpi=120)
        plt.close(fig)
        saved.append(out)
        print(f"Saved {out}")

    return saved


def print_top_cells(agg: pd.DataFrame, min_samples: int) -> None:
    """Print top 10 (trade_type, regime) cells by |mean R| with n >= min."""
    eligible = agg[agg["n"] >= min_samples].copy()
    if eligible.empty:
        print(f"No (trade_type, regime) cells meet n >= {min_samples}.")
        return
    eligible["abs_r"] = eligible["mean_r"].abs()
    eligible = eligible.sort_values("abs_r", ascending=False).head(10)

    print(f"Top 10 (trade_type, regime) cells by |mean R| with n >= {min_samples}:")
    print("-" * 72)
    print(f"{'trade_type':<28}{'regime':<18}{'mean_r':>12}{'n':>10}")
    for _, row in eligible.iterrows():
        print(
            f"{str(row['trade_type']):<28}"
            f"{str(row['regime_tag']):<18}"
            f"{row['mean_r']:>+12.3f}"
            f"{int(row['n']):>10}"
        )
    print("-" * 72)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--min-samples",
        type=int,
        default=3,
        help="Minimum n for a cell to count toward the top-10 console summary.",
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

    agg = aggregate(df)
    plot_per_regime(agg, args.min_samples)
    print_top_cells(agg, args.min_samples)
    return 0


if __name__ == "__main__":
    sys.exit(main())
