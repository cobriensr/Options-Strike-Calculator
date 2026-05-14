"""Periscope EDA 06 — Touch-rate-vs-distance curve at first-read-of-day.

Answers: for each distance d above/below open spot, what % of days did
SPX's close come within ±1pt of (spot + d) or (spot - d)? Then overlays
the actual gamma_ceiling and gamma_floor distances as scatter points
on the curve, to show whether the named walls sit at "specially touched"
distances or just inherit the regime-wide touch rate at their distance.

This is a same-side baseline (we sweep over distances on each side
separately), unlike the cross-spot mirror sham used in the primary
experiment. Tests the wall-specificity claim:
"Is gamma_ceiling touched more often than a random strike at the same
distance above spot?"

Run::

    set -a; source .env.local; set +a
    ml/.venv/bin/python ml/src/periscope_eda/06_open_touch_curve.py

Outputs:
    ml/plots/periscope-eda/open_touch_curve.png
    Console summary (per-distance touch rates, wall overlay points)

Spec link: docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
Follow-up to: ml/src/periscope_eda/05_gamma_wall_reversal.py (which tested
cross-spot sham; this tests same-side sham at open only).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

TOUCH_TOLERANCE_PTS = 1.0
DISTANCE_GRID = np.arange(1, 81, 1)  # 1pt steps from 1 to 80pt
PLOT_PATH = Path("ml/plots/periscope-eda/open_touch_curve.png")


def fetch_first_reads(database_url: str) -> pd.DataFrame:
    """First periscope read of each trading_date with both walls populated."""
    sql = """
        WITH ranked AS (
          SELECT
            id AS read_id, trading_date, read_time AS read_time_utc,
            spot_at_read_time::float AS spot_at_read,
            (key_levels->>'gamma_ceiling')::float AS wall_ceiling,
            (key_levels->>'gamma_floor')::float   AS wall_floor,
            ROW_NUMBER() OVER (PARTITION BY trading_date ORDER BY read_time) AS rn
          FROM periscope_analyses
          WHERE mode IN ('pre_trade', 'intraday')
            AND key_levels->>'gamma_ceiling' IS NOT NULL
            AND key_levels->>'gamma_floor'   IS NOT NULL
            AND read_time < ((trading_date + INTERVAL '15 hours')
                             AT TIME ZONE 'America/Chicago')
        )
        SELECT read_id, trading_date, read_time_utc, spot_at_read,
               wall_ceiling, wall_floor
        FROM ranked
        WHERE rn = 1
        ORDER BY trading_date
    """
    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn)


def fetch_bars(conn, trading_date, read_time_utc) -> pd.DataFrame:
    sql = """
        SELECT close::float AS close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND date = %s
          AND timestamp >= %s
          AND timestamp <= ((%s::date + INTERVAL '15 hours')
                            AT TIME ZONE 'America/Chicago')
          AND market_time = 'r'
        ORDER BY timestamp
    """
    return pd.read_sql_query(
        sql, conn, params=(trading_date, read_time_utc, trading_date)
    )


def touched_at_distance(closes: np.ndarray, target: float) -> bool:
    """True if any close is within TOUCH_TOLERANCE_PTS of target."""
    return bool(np.abs(closes - target).min() <= TOUCH_TOLERANCE_PTS)


def compute_touch_curve(reads: pd.DataFrame, database_url: str) -> dict:
    """For each first-read-of-day, sweep distances on each side of spot.

    Returns dict with:
        above_rates: array len(DISTANCE_GRID), mean touch rate at +d above spot
        below_rates: same, but -d below spot
        per_day_above: 2D array (n_days, n_distances) of 0/1 touched
        per_day_below: same shape, below
        ceiling_distances: list of (distance, touched) for each day
        floor_distances: list of (distance, touched) for each day
    """
    n_days = len(reads)
    n_dist = len(DISTANCE_GRID)
    per_day_above = np.zeros((n_days, n_dist), dtype=int)
    per_day_below = np.zeros((n_days, n_dist), dtype=int)
    ceiling_overlay: list[tuple[float, bool]] = []
    floor_overlay: list[tuple[float, bool]] = []

    with psycopg2.connect(database_url) as conn:
        for i, r in enumerate(reads.itertuples()):
            bars = fetch_bars(conn, r.trading_date, r.read_time_utc)
            if bars.empty:
                continue
            closes = bars["close"].to_numpy()
            spot = float(r.spot_at_read)
            for j, d in enumerate(DISTANCE_GRID):
                per_day_above[i, j] = touched_at_distance(closes, spot + d)
                per_day_below[i, j] = touched_at_distance(closes, spot - d)

            # Overlay points for actual gamma walls
            ceiling_dist = float(r.wall_ceiling) - spot  # signed: positive if above
            floor_dist = spot - float(r.wall_floor)  # signed: positive if below
            ceiling_overlay.append(
                (ceiling_dist, touched_at_distance(closes, float(r.wall_ceiling)))
            )
            floor_overlay.append(
                (floor_dist, touched_at_distance(closes, float(r.wall_floor)))
            )

    return {
        "above_rates": per_day_above.mean(axis=0),
        "below_rates": per_day_below.mean(axis=0),
        "per_day_above": per_day_above,
        "per_day_below": per_day_below,
        "ceiling_overlay": ceiling_overlay,
        "floor_overlay": floor_overlay,
        "n_days": n_days,
    }


def plot_curve(result: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(11, 6))

    # Curve: touch rate vs distance, separately above (+) and below (-) spot
    ax.plot(
        DISTANCE_GRID,
        result["above_rates"],
        marker="o",
        markersize=3,
        color="#1f77b4",
        label="Above open spot (any +d)",
    )
    ax.plot(
        -DISTANCE_GRID,
        result["below_rates"],
        marker="o",
        markersize=3,
        color="#d62728",
        label="Below open spot (any -d)",
    )

    # Overlay: actual gamma_ceiling distances (above spot, blue X = touched, light = not)
    for d, touched in result["ceiling_overlay"]:
        ax.scatter(
            d,
            1.05 if touched else -0.05,
            marker="^",
            s=120,
            edgecolors="black",
            color="#1f77b4" if touched else "white",
            zorder=5,
        )
    # Overlay: actual gamma_floor distances (below spot, but plotted at -distance)
    for d, touched in result["floor_overlay"]:
        ax.scatter(
            -d,
            1.05 if touched else -0.05,
            marker="v",
            s=120,
            edgecolors="black",
            color="#d62728" if touched else "white",
            zorder=5,
        )

    ax.axhline(0.5, color="gray", linestyle=":", linewidth=0.7)
    ax.axvline(0, color="black", linewidth=0.7)
    ax.set_xlabel("Signed distance from open spot (SPX points; + above, − below)")
    ax.set_ylabel(f"Touch rate (n={result['n_days']} days)")
    ax.set_title(
        "Intraday touch rate vs distance from open\n"
        "Triangles = actual gamma_ceiling (▲ above) / gamma_floor (▼ below). "
        "Filled = touched that day; hollow = not touched."
    )
    ax.legend(loc="center right")
    ax.set_xlim(-85, 85)
    ax.set_ylim(-0.12, 1.12)
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def print_summary(reads: pd.DataFrame, result: dict) -> None:
    print(f"=== First-read-of-day events: N = {result['n_days']} days ===\n")

    # Touch rate at the actual gamma_ceiling and gamma_floor distances,
    # compared to the curve's touch rate at that same distance.
    print(
        f"{'date':<12} | {'ceil_dist':>9} | {'ceil_real':>9} | {'ceil_curve_at_dist':>18} || "
        f"{'flr_dist':>8} | {'flr_real':>8} | {'flr_curve_at_dist':>17}"
    )
    print("-" * 124)
    for i, r in enumerate(reads.itertuples()):
        spot = float(r.spot_at_read)
        cd = float(r.wall_ceiling) - spot
        fd = spot - float(r.wall_floor)
        c_real = result["ceiling_overlay"][i][1]
        f_real = result["floor_overlay"][i][1]
        # Curve touch rate at the nearest-integer distance
        c_curve = result["above_rates"][
            int(min(max(round(cd) - 1, 0), len(DISTANCE_GRID) - 1))
        ]
        f_curve = result["below_rates"][
            int(min(max(round(fd) - 1, 0), len(DISTANCE_GRID) - 1))
        ]
        print(
            f"{str(r.trading_date):<12} | {cd:>9.2f} | {str(c_real):>9} | {c_curve:>18.1%} || "
            f"{fd:>8.2f} | {str(f_real):>8} | {f_curve:>17.1%}"
        )

    print()
    print("=== Specificity check (wall_touch_rate vs curve_at_same_distance) ===")
    above = result["above_rates"]
    below = result["below_rates"]
    print("\nAbove spot (ceilings):")
    real_touched = [t for _, t in result["ceiling_overlay"]]
    real_rate = sum(real_touched) / len(real_touched)
    # Mean curve rate at the actual ceiling distances
    curve_at_real_dists = [
        above[int(min(max(round(d) - 1, 0), len(above) - 1))]
        for d, _ in result["ceiling_overlay"]
    ]
    expected = float(np.mean(curve_at_real_dists))
    print(f"  Real ceiling touch rate    : {real_rate:.1%}")
    print(
        f"  Curve avg at same distances: {expected:.1%}  (expected if wall has no specificity)"
    )
    print(f"  Delta                       : {(real_rate - expected) * 100:+.1f} pp")

    print("\nBelow spot (floors):")
    real_touched_f = [t for _, t in result["floor_overlay"]]
    real_rate_f = sum(real_touched_f) / len(real_touched_f)
    curve_at_real_dists_f = [
        below[int(min(max(round(d) - 1, 0), len(below) - 1))]
        for d, _ in result["floor_overlay"]
    ]
    expected_f = float(np.mean(curve_at_real_dists_f))
    print(f"  Real floor touch rate      : {real_rate_f:.1%}")
    print(
        f"  Curve avg at same distances: {expected_f:.1%}  (expected if wall has no specificity)"
    )
    print(f"  Delta                       : {(real_rate_f - expected_f) * 100:+.1f} pp")


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 1

    print("Fetching first-read-of-day reads…")
    reads = fetch_first_reads(database_url)
    print(f"  N = {len(reads)} days")
    print()

    print("Computing touch curves…")
    result = compute_touch_curve(reads, database_url)
    print()

    print_summary(reads, result)
    print()

    print(f"Writing plot to {PLOT_PATH}…")
    plot_curve(result, PLOT_PATH)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
