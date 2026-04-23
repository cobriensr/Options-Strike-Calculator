"""
Bot EOD options flow — premium-threshold magnet discovery.

Tests whether the "strike-as-magnet" effect scales with the premium
concentrated at an OTM strike. Stratifies candidates by
(symbol, distance-to-strike bucket, premium bucket) and reports
touch rate + MFE/MAE per cell.

Question: for a given setup (symbol, strike distance), is there a
premium threshold ABOVE which dealer gamma hedging kicks in and
price is pulled toward the strike? If yes, that threshold becomes
a live-trading alert rule. If no, the magnet hypothesis is dead
regardless of scale.

Key difference from eod_flow_forward_returns.py: this script drops
the p90 composite-score filter and sweeps premium directly as the
stratification variable. The p90 filter was a ranking device; for
threshold discovery we want the full population including baseline
low-premium buckets.

Outputs under `ml/plots/eod-flow-premium-threshold/`:
  summary_{N}min.csv              — per (symbol, distance, premium) cell
  touch_heatmap_{symbol}_{N}min.png — heatmap of touch %
  threshold_sweep_{N}min.png      — touch_rate vs premium threshold by dist

Usage:
  ml/.venv/bin/python src/eod_flow_premium_threshold.py
"""

from __future__ import annotations

import sys
import time

try:
    import duckdb
    import matplotlib.pyplot as plt
    import pandas as pd
    import seaborn as sns
except ImportError as e:
    print(f"Missing dependency: {e}")
    sys.exit(1)

from eod_flow_forward_returns import (  # noqa: E402
    _attach_direction_and_signed,
    _attach_forward_returns,
    _attach_path_stats,
    _load_minute_spot,
)
from utils import (  # noqa: E402
    ML_ROOT,
    save_section_findings,
    section,
    subsection,
    takeaway,
)

FLOW_PARQUET_ROOT = ML_ROOT / "data" / "eod-flow"
BUCKETS_PARQUET_ROOT = ML_ROOT / "data" / "eod-flow-buckets"
PLOT_ROOT = ML_ROOT / "plots" / "eod-flow-premium-threshold"
PLOT_ROOT.mkdir(parents=True, exist_ok=True)

BUCKET_SIZES: tuple[int, ...] = (1, 5)

# Low premium floor — we want to see the full sweep including
# baseline noise so high-premium signal (if any) stands out.
MIN_PREMIUM = 1_000.0
MIN_MONEYNESS_PCT = 0.003
MIN_CELL_N = 10  # below this, cell stats are noise; drop from summary.

# Distance-to-strike bins. Chosen so each bucket covers a physically
# meaningful regime: near-ATM gamma, weekly OTM territory, tail wing.
DISTANCE_BUCKETS: tuple[tuple[float, float, str], ...] = (
    (0.003, 0.005, "0.3-0.5%"),
    (0.005, 0.010, "0.5-1%"),
    (0.010, 0.015, "1-1.5%"),
    (0.015, 0.020, "1.5-2%"),
    (0.020, 0.030, "2-3%"),
    (0.030, 1.000, "3%+"),
)

# Premium bins on a log scale. If a gamma-pin threshold exists, it's
# likely at one of these decade boundaries.
PREMIUM_BUCKETS: tuple[tuple[float, float, str], ...] = (
    (1_000, 5_000, "$1-5k"),
    (5_000, 25_000, "$5-25k"),
    (25_000, 100_000, "$25-100k"),
    (100_000, 500_000, "$100-500k"),
    (500_000, 2_500_000, "$500k-2.5M"),
    (2_500_000, float("inf"), "$2.5M+"),
)

# Premium thresholds for the sweep plot (cumulative: "touch rate for
# candidates with premium >= X").
PREMIUM_THRESHOLDS: tuple[float, ...] = (
    1_000,
    5_000,
    25_000,
    50_000,
    100_000,
    250_000,
    500_000,
    1_000_000,
    2_500_000,
    5_000_000,
)

sns.set_theme(style="darkgrid", palette="muted")
plt.rcParams.update(
    {
        "figure.facecolor": "#1a1a2e",
        "axes.facecolor": "#16213e",
        "axes.edgecolor": "#555",
        "axes.labelcolor": "#ccc",
        "text.color": "#ccc",
        "xtick.color": "#aaa",
        "ytick.color": "#aaa",
        "grid.color": "#333",
        "grid.alpha": 0.5,
        "font.size": 9,
        "text.parse_math": False,
    }
)


# ── Data loading ──────────────────────────────────────────


def _load_all_otm_buckets(
    conn: duckdb.DuckDBPyConnection, bucket_min: int
) -> pd.DataFrame:
    """Load all OTM buckets meeting the coarse distance/premium floor.

    Note: no composite-score filter — we want the full distribution so
    the premium sweep is meaningful.
    """
    glob = str(
        BUCKETS_PARQUET_ROOT / f"bucket={bucket_min}min" / "date=*" / "data.parquet"
    )
    return conn.execute(
        f"""
        SELECT
            symbol,
            option_chain_id,
            strike,
            option_type,
            expiry,
            bucket_start,
            bucket_end,
            bucket_spot,
            moneyness_pct,
            is_otm,
            n_prints,
            total_volume,
            total_premium,
            buy_premium_pct,
            CAST(bucket_start AS DATE) AS date
        FROM read_parquet('{glob}', hive_partitioning = true)
        WHERE is_otm = TRUE
          AND abs(moneyness_pct) >= {MIN_MONEYNESS_PCT}
          AND total_premium >= {MIN_PREMIUM}
        """
    ).fetchdf()


def _build_spot_cache(
    conn: duckdb.DuckDBPyConnection, dates: list[str]
) -> dict[tuple[str, str], pd.DataFrame]:
    cache: dict[tuple[str, str], pd.DataFrame] = {}
    for d in dates:
        full = _load_minute_spot(conn, d)
        if full.empty:
            continue
        for sym in full["symbol"].unique():
            cache[(sym, d)] = full[full["symbol"] == sym].copy()
    return cache


# ── Binning ───────────────────────────────────────────────


def _distance_bucket_labels() -> list[str]:
    return [label for _, _, label in DISTANCE_BUCKETS]


def _premium_bucket_labels() -> list[str]:
    return [label for _, _, label in PREMIUM_BUCKETS]


def _distance_bucket(mny_pct: float) -> str | None:
    abs_m = abs(mny_pct)
    for lo, hi, label in DISTANCE_BUCKETS:
        if lo <= abs_m < hi:
            return label
    return None


def _premium_bucket(premium: float) -> str | None:
    for lo, hi, label in PREMIUM_BUCKETS:
        if lo <= premium < hi:
            return label
    return None


def _assign_buckets(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    d["distance_bucket"] = d["moneyness_pct"].map(_distance_bucket)
    d["premium_bucket"] = d["total_premium"].map(_premium_bucket)
    return d


# ── Cell-level aggregation ────────────────────────────────


def _summarize_cells(df: pd.DataFrame, bucket_min: int) -> pd.DataFrame:
    """Per (symbol, distance_bucket, premium_bucket) aggregate stats."""
    rows = []
    for (sym, dist, prem), grp in df.groupby(
        ["symbol", "distance_bucket", "premium_bucket"],
        observed=True,
    ):
        if len(grp) < MIN_CELL_N:
            continue
        touched = grp[grp["touched_strike"]]
        mfe = grp["peak_toward_bps"].dropna()
        mae = grp["peak_against_bps"].dropna()
        med_mfe = float(mfe.median()) if len(mfe) else None
        med_mae = float(mae.median()) if len(mae) else None
        rows.append(
            {
                "bucket_min": bucket_min,
                "symbol": sym,
                "distance_bucket": dist,
                "premium_bucket": prem,
                "n": len(grp),
                "touch_pct": float(grp["touched_strike"].mean() * 100),
                "median_minutes_to_touch": (
                    float(touched["minutes_to_touch"].median())
                    if not touched.empty
                    else None
                ),
                "median_mfe_bps": med_mfe,
                "median_mae_bps": med_mae,
                "mfe_mae_ratio": (
                    (med_mfe / med_mae)
                    if med_mfe is not None and med_mae is not None and med_mae > 0
                    else None
                ),
                "mean_end_ret_bps": float(grp["end_of_window_ret_bps"].mean()),
            }
        )
    return pd.DataFrame(rows)


def _threshold_sweep(df: pd.DataFrame, bucket_min: int) -> pd.DataFrame:
    """Cumulative touch rate at each premium threshold, per (symbol, distance)."""
    rows = []
    for sym in sorted(df["symbol"].dropna().unique()):
        for _lo, _hi, dist_label in DISTANCE_BUCKETS:
            for threshold in PREMIUM_THRESHOLDS:
                sub = df[
                    (df["symbol"] == sym)
                    & (df["distance_bucket"] == dist_label)
                    & (df["total_premium"] >= threshold)
                ]
                if len(sub) < MIN_CELL_N:
                    continue
                rows.append(
                    {
                        "bucket_min": bucket_min,
                        "symbol": sym,
                        "distance_bucket": dist_label,
                        "threshold": threshold,
                        "n": len(sub),
                        "touch_pct": float(sub["touched_strike"].mean() * 100),
                        "median_mfe_bps": float(sub["peak_toward_bps"].median()),
                        "median_mae_bps": float(sub["peak_against_bps"].median()),
                    }
                )
    return pd.DataFrame(rows)


# ── Plots ─────────────────────────────────────────────────


def _plot_touch_heatmap(summary: pd.DataFrame, bucket_min: int) -> None:
    """Heatmap: touch_pct over (premium_bucket × distance_bucket), one per symbol."""
    symbols = sorted(summary["symbol"].dropna().unique())
    if not symbols:
        return
    fig, axes = plt.subplots(
        1,
        len(symbols),
        figsize=(4.8 * len(symbols), 4.5),
        constrained_layout=True,
    )
    if len(symbols) == 1:
        axes = [axes]

    for ax, sym in zip(axes, symbols, strict=True):
        sub = summary[summary["symbol"] == sym]
        if sub.empty:
            continue
        pivot = sub.pivot_table(
            index="premium_bucket",
            columns="distance_bucket",
            values="touch_pct",
            aggfunc="first",
        )
        # Enforce display order.
        pivot = pivot.reindex(
            index=[p for p in _premium_bucket_labels() if p in pivot.index],
            columns=[d for d in _distance_bucket_labels() if d in pivot.columns],
        )
        sns.heatmap(
            pivot,
            ax=ax,
            annot=True,
            fmt=".1f",
            cmap="RdYlGn",
            center=15,  # random-walk-ish baseline in %
            vmin=0,
            vmax=40,
            cbar_kws={"label": "touch %"},
            linewidths=0.4,
            linecolor="#333",
        )
        ax.set_title(f"{sym} — touch % (rows=premium, cols=distance)", color="#fff")
        ax.set_xlabel("distance to strike")
        ax.set_ylabel("premium bucket")

    fig.suptitle(
        f"Touch-rate heatmap ({bucket_min}-min buckets) — "
        "does larger premium → higher touch rate?",
        color="#fff",
        fontsize=12,
    )
    plt.savefig(PLOT_ROOT / f"touch_heatmap_{bucket_min}min.png", dpi=130)
    plt.close(fig)
    print(
        f"  wrote {(PLOT_ROOT / f'touch_heatmap_{bucket_min}min.png').relative_to(ML_ROOT)}"
    )


def _plot_threshold_sweep(sweep: pd.DataFrame, bucket_min: int) -> None:
    """Line chart: touch % vs premium threshold, one line per distance bucket."""
    symbols = sorted(sweep["symbol"].dropna().unique())
    if not symbols:
        return
    fig, axes = plt.subplots(
        1,
        len(symbols),
        figsize=(5.0 * len(symbols), 4.5),
        sharey=True,
        constrained_layout=True,
    )
    if len(symbols) == 1:
        axes = [axes]

    cmap = plt.get_cmap("viridis")
    dist_labels = _distance_bucket_labels()

    for ax, sym in zip(axes, symbols, strict=True):
        sub = sweep[sweep["symbol"] == sym]
        if sub.empty:
            continue
        for i, dist in enumerate(dist_labels):
            line = sub[sub["distance_bucket"] == dist].sort_values("threshold")
            if line.empty:
                continue
            color = cmap(i / max(len(dist_labels) - 1, 1))
            ax.plot(
                line["threshold"],
                line["touch_pct"],
                marker="o",
                color=color,
                label=dist,
                linewidth=1.5,
            )
        ax.set_xscale("log")
        ax.set_xlabel("premium threshold $ (log)")
        ax.set_title(sym, color="#fff")
        ax.axhline(
            15,
            color="#aaa",
            linewidth=0.8,
            linestyle="--",
            alpha=0.5,
            label="~baseline 15%",
        )
        ax.legend(loc="best", fontsize=7, facecolor="#1a1a2e", edgecolor="#555")
    axes[0].set_ylabel("touch % (cumulative: premium >= threshold)")
    fig.suptitle(
        f"Threshold sweep ({bucket_min}-min buckets) — "
        "does touch rate rise with premium threshold for a given distance?",
        color="#fff",
        fontsize=11,
    )
    plt.savefig(PLOT_ROOT / f"threshold_sweep_{bucket_min}min.png", dpi=130)
    plt.close(fig)
    print(
        f"  wrote {(PLOT_ROOT / f'threshold_sweep_{bucket_min}min.png').relative_to(ML_ROOT)}"
    )


# ── Main ─────────────────────────────────────────────────


def main() -> int:
    section("EOD Flow Premium-Threshold Discovery")

    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    conn.execute("PRAGMA memory_limit='6GB'")

    all_dates = sorted(
        {p.name.removeprefix("date=") for p in FLOW_PARQUET_ROOT.glob("date=*")}
    )
    print(f"  dates: {len(all_dates)}")

    subsection("Build minute-spot cache")
    t0 = time.monotonic()
    spot_cache = _build_spot_cache(conn, all_dates)
    print(f"  cache entries: {len(spot_cache)} in {time.monotonic() - t0:.1f}s")

    for bucket_min in BUCKET_SIZES:
        subsection(f"Load + enrich all OTM buckets — {bucket_min}min")
        raw = _load_all_otm_buckets(conn, bucket_min)
        print(f"  raw OTM buckets: {len(raw):,}")
        raw["date"] = pd.to_datetime(raw["date"]).dt.date.astype(str)

        t_enrich = time.monotonic()
        enriched = _attach_forward_returns(raw, spot_cache)
        enriched = _attach_direction_and_signed(enriched)
        enriched = _attach_path_stats(enriched, spot_cache)
        enriched = _assign_buckets(enriched)
        print(f"  enriched in {time.monotonic() - t_enrich:.1f}s")

        subsection(f"Cell stats per (symbol × dist × premium) — {bucket_min}min")
        cells = _summarize_cells(enriched, bucket_min)
        cells.to_csv(PLOT_ROOT / f"summary_{bucket_min}min.csv", index=False)
        print(f"  cells kept (n≥{MIN_CELL_N}): {len(cells)}")
        # Pretty-print the top of the table for eyeballing.
        if not cells.empty:
            show = cells.sort_values(
                ["symbol", "distance_bucket", "premium_bucket"]
            ).round(1)
            print()
            print(show.to_string(index=False))

        subsection(f"Threshold sweep — {bucket_min}min")
        sweep = _threshold_sweep(enriched, bucket_min)
        sweep.to_csv(PLOT_ROOT / f"threshold_sweep_{bucket_min}min.csv", index=False)
        if not sweep.empty:
            # Show a condensed view: for each (symbol, distance), touch% at key thresholds.
            pivot = sweep.pivot_table(
                index=["symbol", "distance_bucket"],
                columns="threshold",
                values="touch_pct",
                aggfunc="first",
            )
            print(
                "\n  Cumulative touch % at premium threshold (cols) by (symbol, distance):"
            )
            print(pivot.round(1).to_string())

        subsection(f"Plots — {bucket_min}min")
        _plot_touch_heatmap(cells, bucket_min)
        _plot_threshold_sweep(sweep, bucket_min)

    conn.close()

    save_section_findings(
        "eod_flow_premium_threshold",
        {
            "min_premium_floor": MIN_PREMIUM,
            "min_moneyness_pct": MIN_MONEYNESS_PCT,
            "distance_buckets": [b[2] for b in DISTANCE_BUCKETS],
            "premium_buckets": [b[2] for b in PREMIUM_BUCKETS],
        },
    )
    takeaway(
        f"Premium-threshold analysis complete. CSVs + plots under "
        f"{PLOT_ROOT.relative_to(ML_ROOT)}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
