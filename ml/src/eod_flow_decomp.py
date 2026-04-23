"""
Bot EOD options flow — decomposition analyses.

Two separate tests addressing blind spots from the premium-threshold work:

A. (option_type × aggression_side) decomposition
   Split candidates into {call, put} × {buy-dominant, sell-dominant,
   mixed} sub-populations and run the premium threshold sweep on each.
   Expected: touch rate concentrates in BUY-dominant calls AND puts,
   because both leave the dealer short gamma → magnet physics. Sell-
   dominant flow leaves dealer long gamma → anti-magnet (price fades).

B. Gamma-weighted threshold sweep
   Use `gamma_notional_per_pct` (dollar exposure per 1% spot move)
   instead of `total_premium` as the threshold variable. If dealer
   hedging is the causal mechanism, gamma-weighting should produce
   a cleaner / steeper touch-rate curve than raw dollar premium.

Outputs under `ml/plots/eod-flow-decomp/`:
  decomp_summary_{N}min.csv         — touch rate per (sym, type,
                                       aggression, distance, premium)
  decomp_heatmap_{N}min.png         — visualization of (A)
  gamma_sweep_{N}min.csv            — gamma-based threshold sweep
  gamma_vs_premium_{N}min.png       — side-by-side comparison of (B)

Usage:
  ml/.venv/bin/python src/eod_flow_decomp.py
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
from eod_flow_premium_threshold import (  # noqa: E402
    DISTANCE_BUCKETS,
    MIN_CELL_N,
    PREMIUM_THRESHOLDS,
    _assign_buckets,
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
PLOT_ROOT = ML_ROOT / "plots" / "eod-flow-decomp"
PLOT_ROOT.mkdir(parents=True, exist_ok=True)

BUCKET_SIZES: tuple[int, ...] = (1, 5)

# Aggression regime thresholds (on buy_premium_pct):
#   buy  >= 0.60   — strongly buy-dominant (dealer short gamma)
#   sell <= 0.40   — strongly sell-dominant (dealer long gamma)
#   otherwise      — mixed (no clear hedging direction)
BUY_DOM_THRESHOLD = 0.60
SELL_DOM_THRESHOLD = 0.40

# Gamma-notional thresholds for sweep. Units are dollars per 1% spot
# move. Picked to span the observed range of ~$100-100M per 1% move
# across the dataset on a log scale.
GAMMA_THRESHOLDS: tuple[float, ...] = (
    1_000,
    5_000,
    25_000,
    100_000,
    500_000,
    2_500_000,
    10_000_000,
    50_000_000,
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


# ── Load buckets (with gamma columns) ────────────────────


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _load_all_otm_buckets(
    conn: duckdb.DuckDBPyConnection, bucket_min: int
) -> pd.DataFrame:
    """Same as eod_flow_premium_threshold._load_all_otm_buckets but
    pulls the new gamma columns too."""
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
            bucket_gamma_shares,
            buy_gamma_shares,
            sell_gamma_shares,
            dealer_short_gamma_shares,
            gamma_notional_per_pct,
            avg_delta_size_weighted,
            CAST(bucket_start AS DATE) AS date
        FROM read_parquet('{glob}', hive_partitioning = true)
        WHERE is_otm = TRUE
          AND abs(moneyness_pct) >= 0.003
          AND total_premium >= 1000
        """
    ).fetchdf()


# ── Aggression regime assignment ─────────────────────────


def _assign_aggression_regime(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    bp = pd.to_numeric(d["buy_premium_pct"], errors="coerce").fillna(0.5)
    d["aggression_regime"] = "mixed"
    d.loc[bp >= BUY_DOM_THRESHOLD, "aggression_regime"] = "buy_dom"
    d.loc[bp <= SELL_DOM_THRESHOLD, "aggression_regime"] = "sell_dom"
    return d


# ── Analysis A: 4-way decomposition ──────────────────────


def _decomp_cells(df: pd.DataFrame, bucket_min: int) -> pd.DataFrame:
    """For each (sym, type, aggression, distance, premium) cell, report
    touch rate + MFE/MAE medians.

    Cells with n < MIN_CELL_N are dropped.
    """
    rows = []
    for (sym, otype, aggr, dist, prem), grp in df.groupby(
        [
            "symbol",
            "option_type",
            "aggression_regime",
            "distance_bucket",
            "premium_bucket",
        ],
        observed=True,
    ):
        if len(grp) < MIN_CELL_N:
            continue
        touched = grp[grp["touched_strike"]]
        mfe = grp["peak_toward_bps"].dropna()
        mae = grp["peak_against_bps"].dropna()
        rows.append(
            {
                "bucket_min": bucket_min,
                "symbol": sym,
                "option_type": otype,
                "aggression_regime": aggr,
                "distance_bucket": dist,
                "premium_bucket": prem,
                "n": len(grp),
                "touch_pct": float(grp["touched_strike"].mean() * 100),
                "median_minutes_to_touch": (
                    float(touched["minutes_to_touch"].median())
                    if not touched.empty
                    else None
                ),
                "median_mfe_bps": float(mfe.median()) if len(mfe) else None,
                "median_mae_bps": float(mae.median()) if len(mae) else None,
                "median_end_ret_bps": float(grp["end_of_window_ret_bps"].median()),
            }
        )
    return pd.DataFrame(rows)


def _print_decomp_focus(cells: pd.DataFrame, bucket_min: int) -> None:
    """Focus on the signal band (0.3-1% OTM, $25k-$500k) and compare
    aggression regimes side-by-side."""
    focus = cells[
        cells["distance_bucket"].isin(["0.3-0.5%", "0.5-1%"])
        & cells["premium_bucket"].isin(["$25-100k", "$100-500k", "$500k-2.5M"])
    ]
    if focus.empty:
        print(f"  No signal-band cells for {bucket_min}-min.")
        return

    pivot = focus.pivot_table(
        index=["symbol", "option_type", "distance_bucket", "premium_bucket"],
        columns="aggression_regime",
        values="touch_pct",
        aggfunc="first",
    )
    # Keep consistent column order.
    for col in ("buy_dom", "mixed", "sell_dom"):
        if col not in pivot.columns:
            pivot[col] = None
    pivot = pivot[["buy_dom", "mixed", "sell_dom"]]
    pivot["buy_minus_sell_pp"] = pivot["buy_dom"] - pivot["sell_dom"]

    print(f"\n  Touch % by aggression regime ({bucket_min}-min, signal band):")
    print(pivot.round(1).to_string())


def _plot_decomp_heatmap(cells: pd.DataFrame, bucket_min: int) -> None:
    """Heatmap per symbol × option_type: premium × aggression regime."""
    focus = cells[cells["distance_bucket"].isin(["0.3-0.5%", "0.5-1%"])]
    if focus.empty:
        return
    # One row per symbol, columns for {call, put}.
    symbols = sorted(focus["symbol"].dropna().unique())
    types = ["call", "put"]
    aggr_order = ["buy_dom", "mixed", "sell_dom"]
    prem_order = ["$25-100k", "$100-500k", "$500k-2.5M", "$2.5M+"]

    fig, axes = plt.subplots(
        len(symbols),
        len(types),
        figsize=(4.5 * len(types), 3.4 * len(symbols)),
        constrained_layout=True,
    )
    if len(symbols) == 1:
        axes = [axes]
    if len(types) == 1:
        axes = [[ax] for ax in axes]

    for i, sym in enumerate(symbols):
        for j, otype in enumerate(types):
            ax = axes[i][j]
            sub = focus[
                (focus["symbol"] == sym)
                & (focus["option_type"] == otype)
                & (focus["distance_bucket"] == "0.3-0.5%")
            ]
            if sub.empty:
                ax.set_visible(False)
                continue
            pivot = sub.pivot_table(
                index="premium_bucket",
                columns="aggression_regime",
                values="touch_pct",
                aggfunc="first",
            )
            pivot = pivot.reindex(
                index=[p for p in prem_order if p in pivot.index],
                columns=[a for a in aggr_order if a in pivot.columns],
            )
            if pivot.empty:
                ax.set_visible(False)
                continue
            sns.heatmap(
                pivot,
                ax=ax,
                annot=True,
                fmt=".1f",
                cmap="RdYlGn",
                center=15,
                vmin=0,
                vmax=45,
                cbar=j == len(types) - 1,
                linewidths=0.4,
                linecolor="#333",
            )
            ax.set_title(f"{sym} {otype} (0.3-0.5% OTM)", color="#fff")
            ax.set_xlabel("aggression")
            ax.set_ylabel("premium bucket" if j == 0 else "")

    fig.suptitle(
        f"Touch % by aggression × option type ({bucket_min}-min, 0.3-0.5% OTM)",
        color="#fff",
        fontsize=12,
    )
    out = PLOT_ROOT / f"decomp_heatmap_{bucket_min}min.png"
    plt.savefig(out, dpi=130)
    plt.close(fig)
    print(f"  wrote {out.relative_to(ML_ROOT)}")


# ── Analysis B: Gamma-weighted threshold sweep ───────────


def _gamma_threshold_sweep(df: pd.DataFrame, bucket_min: int) -> pd.DataFrame:
    """Cumulative touch rate when gamma_notional_per_pct >= threshold."""
    rows = []
    for sym in sorted(df["symbol"].dropna().unique()):
        for _lo, _hi, dist in DISTANCE_BUCKETS:
            for g_thresh in GAMMA_THRESHOLDS:
                cell = df[
                    (df["symbol"] == sym)
                    & (df["distance_bucket"] == dist)
                    & (df["gamma_notional_per_pct"] >= g_thresh)
                ]
                if len(cell) < MIN_CELL_N:
                    continue
                rows.append(
                    {
                        "bucket_min": bucket_min,
                        "symbol": sym,
                        "distance_bucket": dist,
                        "gamma_threshold_usd_per_pct": g_thresh,
                        "n": len(cell),
                        "touch_pct": float(cell["touched_strike"].mean() * 100),
                        "median_mfe_bps": float(cell["peak_toward_bps"].median()),
                        "median_mae_bps": float(cell["peak_against_bps"].median()),
                    }
                )
    return pd.DataFrame(rows)


def _premium_threshold_sweep(df: pd.DataFrame, bucket_min: int) -> pd.DataFrame:
    """For comparison: same sweep but using total_premium (the previous
    approach). Duplicates eod_flow_premium_threshold._threshold_sweep
    but scoped to the same df so the comparison is apples-to-apples."""
    rows = []
    for sym in sorted(df["symbol"].dropna().unique()):
        for _lo, _hi, dist in DISTANCE_BUCKETS:
            for p_thresh in PREMIUM_THRESHOLDS:
                cell = df[
                    (df["symbol"] == sym)
                    & (df["distance_bucket"] == dist)
                    & (df["total_premium"] >= p_thresh)
                ]
                if len(cell) < MIN_CELL_N:
                    continue
                rows.append(
                    {
                        "bucket_min": bucket_min,
                        "symbol": sym,
                        "distance_bucket": dist,
                        "premium_threshold_usd": p_thresh,
                        "n": len(cell),
                        "touch_pct": float(cell["touched_strike"].mean() * 100),
                    }
                )
    return pd.DataFrame(rows)


def _plot_gamma_vs_premium(
    gamma_sweep: pd.DataFrame, prem_sweep: pd.DataFrame, bucket_min: int
) -> None:
    """Side-by-side panels: gamma-based vs premium-based threshold curves,
    one subplot per symbol, only showing the signal distance buckets."""
    symbols = sorted(
        set(gamma_sweep["symbol"].dropna().unique())
        & set(prem_sweep["symbol"].dropna().unique())
    )
    signal_dists = ["0.3-0.5%", "0.5-1%"]
    if not symbols:
        return

    fig, axes = plt.subplots(
        2,
        len(symbols),
        figsize=(5.0 * len(symbols), 8),
        sharey=True,
        constrained_layout=True,
    )
    if len(symbols) == 1:
        axes = axes.reshape(2, 1)

    cmap = plt.get_cmap("viridis")
    for col, sym in enumerate(symbols):
        # Top row: premium.
        ax = axes[0, col]
        for i, dist in enumerate(signal_dists):
            line = prem_sweep[
                (prem_sweep["symbol"] == sym) & (prem_sweep["distance_bucket"] == dist)
            ].sort_values("premium_threshold_usd")
            if line.empty:
                continue
            ax.plot(
                line["premium_threshold_usd"],
                line["touch_pct"],
                marker="o",
                color=cmap(i / max(len(signal_dists) - 1, 1)),
                linewidth=1.5,
                label=dist,
            )
        ax.set_xscale("log")
        ax.set_title(f"{sym} — premium $", color="#fff")
        ax.set_xlabel("premium threshold $")
        if col == 0:
            ax.set_ylabel("touch %")
        ax.axhline(15, color="#aaa", linewidth=0.8, linestyle="--", alpha=0.5)
        ax.legend(loc="best", fontsize=8)

        # Bottom row: gamma.
        ax = axes[1, col]
        for i, dist in enumerate(signal_dists):
            line = gamma_sweep[
                (gamma_sweep["symbol"] == sym)
                & (gamma_sweep["distance_bucket"] == dist)
            ].sort_values("gamma_threshold_usd_per_pct")
            if line.empty:
                continue
            ax.plot(
                line["gamma_threshold_usd_per_pct"],
                line["touch_pct"],
                marker="s",
                color=cmap(i / max(len(signal_dists) - 1, 1)),
                linewidth=1.5,
                label=dist,
            )
        ax.set_xscale("log")
        ax.set_title(f"{sym} — gamma $/1%", color="#fff")
        ax.set_xlabel("gamma notional threshold $ per 1% move")
        if col == 0:
            ax.set_ylabel("touch %")
        ax.axhline(15, color="#aaa", linewidth=0.8, linestyle="--", alpha=0.5)
        ax.legend(loc="best", fontsize=8)

    fig.suptitle(
        f"Premium-weighted vs gamma-weighted threshold sweep ({bucket_min}-min)",
        color="#fff",
        fontsize=12,
    )
    out = PLOT_ROOT / f"gamma_vs_premium_{bucket_min}min.png"
    plt.savefig(out, dpi=130)
    plt.close(fig)
    print(f"  wrote {out.relative_to(ML_ROOT)}")


# ── Main ─────────────────────────────────────────────────


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


def main() -> int:
    section("EOD Flow Decomposition — aggression × type + gamma-weighted")

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
    print(f"  cache: {len(spot_cache)} entries in {time.monotonic() - t0:.1f}s")

    for bucket_min in BUCKET_SIZES:
        subsection(f"{bucket_min}-min buckets")

        raw = _load_all_otm_buckets(conn, bucket_min)
        print(f"  raw OTM buckets: {len(raw):,}")
        raw["date"] = pd.to_datetime(raw["date"]).dt.date.astype(str)

        t_enrich = time.monotonic()
        enriched = _attach_forward_returns(raw, spot_cache)
        enriched = _attach_direction_and_signed(enriched)
        enriched = _attach_path_stats(enriched, spot_cache)
        enriched = _assign_buckets(enriched)
        enriched = _assign_aggression_regime(enriched)
        print(f"  enriched in {time.monotonic() - t_enrich:.1f}s")

        # ── Analysis A ──
        subsection(f"A. aggression × type decomposition — {bucket_min}min")
        cells = _decomp_cells(enriched, bucket_min)
        cells.to_csv(PLOT_ROOT / f"decomp_summary_{bucket_min}min.csv", index=False)
        print(f"  wrote decomp_summary_{bucket_min}min.csv ({len(cells)} cells)")
        _print_decomp_focus(cells, bucket_min)
        _plot_decomp_heatmap(cells, bucket_min)

        # ── Analysis B ──
        subsection(f"B. gamma-weighted sweep vs premium — {bucket_min}min")
        gamma_sweep = _gamma_threshold_sweep(enriched, bucket_min)
        prem_sweep = _premium_threshold_sweep(enriched, bucket_min)
        gamma_sweep.to_csv(PLOT_ROOT / f"gamma_sweep_{bucket_min}min.csv", index=False)
        prem_sweep.to_csv(PLOT_ROOT / f"premium_sweep_{bucket_min}min.csv", index=False)
        _plot_gamma_vs_premium(gamma_sweep, prem_sweep, bucket_min)

        # Quick comparison print: signal-band QQQ at matched quantile
        # thresholds — does gamma give a steeper curve?
        print(f"\n  Gamma sweep (signal band, {bucket_min}-min):")
        pivot = gamma_sweep[
            gamma_sweep["distance_bucket"].isin(["0.3-0.5%", "0.5-1%"])
        ].pivot_table(
            index=["symbol", "distance_bucket"],
            columns="gamma_threshold_usd_per_pct",
            values="touch_pct",
            aggfunc="first",
        )
        print(pivot.round(1).to_string())

    conn.close()
    save_section_findings(
        "eod_flow_decomp",
        {"note": "See decomp_summary_*.csv and gamma_sweep_*.csv for details."},
    )
    takeaway(
        f"Decomposition complete. Plots/CSVs under {PLOT_ROOT.relative_to(ML_ROOT)}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
