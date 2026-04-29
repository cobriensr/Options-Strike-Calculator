"""Outlier visualization — produces PNGs + CSVs from the full pipeline.

Output goes to ml/plots/outlier-discovery/ — a five-PNG visual summary plus
three CSVs of the underlying tables for spreadsheet exploration.

Run:
    set -a; source .env.local; set +a
    ml/.venv/bin/python ml/notebooks/outlier-plots.py

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md (Phase 5/6 viz)
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import polars as pl

_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from flow_archive import list_archive_dates, load_flow  # noqa: E402
from flow_outcomes import compute_outcomes, synthesize_minute_bars  # noqa: E402
from flow_outliers import find_outliers, score_prints, summarize_outliers  # noqa: E402

MIN_SCORE = int(os.environ.get("MIN_SCORE", "4"))
OUT_DIR = Path(__file__).resolve().parent.parent / "plots" / "outlier-discovery"

plt.rcParams.update(
    {
        "figure.dpi": 100,
        "savefig.dpi": 140,
        "axes.grid": True,
        "grid.alpha": 0.25,
        "axes.spines.top": False,
        "axes.spines.right": False,
    }
)


def _load_pipeline() -> tuple[pl.DataFrame, pl.DataFrame, list]:
    """Run the same per-day pipeline outlier-discovery.py uses, return
    (outliers, enriched_outcomes, dates)."""
    dates = list_archive_dates()
    per_day_outliers: list[pl.DataFrame] = []
    for d in dates:
        per_day_outliers.append(find_outliers(d, min_score=MIN_SCORE))
    outliers = pl.concat(per_day_outliers, how="vertical_relaxed")

    needed_tickers = outliers["underlying_symbol"].unique().to_list()
    per_day_bars: list[pl.DataFrame] = []
    for d in dates:
        flow_day = load_flow(
            d,
            tickers=needed_tickers,
            columns=["executed_at", "underlying_symbol", "underlying_price"],
        ).collect()
        per_day_bars.append(synthesize_minute_bars(flow_day))
    bars = pl.concat(per_day_bars, how="vertical_relaxed")

    outcomes = compute_outcomes(outliers, bars)
    return outliers, outcomes, dates


def plot_per_day_counts(outliers: pl.DataFrame, out: Path) -> None:
    per_day = (
        outliers.with_columns(date=pl.col("executed_at").dt.date())
        .group_by("date")
        .len()
        .sort("date")
    )
    fig, ax = plt.subplots(figsize=(10, 5))
    dates = [str(d) for d in per_day["date"].to_list()]
    counts = per_day["len"].to_list()
    colors = ["#2ecc71" if 10 <= c <= 500 else "#e74c3c" for c in counts]
    ax.bar(dates, counts, color=colors, edgecolor="#222", linewidth=0.5)
    ax.axhline(10, color="#888", linestyle=":", linewidth=1, label="Floor (10/day)")
    ax.axhline(500, color="#888", linestyle=":", linewidth=1, label="Ceiling (500/day)")
    ax.set_ylabel("Outlier count")
    ax.set_title(
        f"Outliers per day (min_score={MIN_SCORE}) — green = in sweet spot, red = out"
    )
    ax.tick_params(axis="x", rotation=45)
    ax.legend(loc="upper right", frameon=False)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def _heatmap_panel(
    summary: pl.DataFrame,
    *,
    ticker_family: str,
    dte_bucket: str,
    ax: plt.Axes,
):
    """Draw one win-rate heatmap (signed_direction × time_bucket).
    Returns the matplotlib AxesImage so the caller can attach a colorbar."""
    subset = summary.filter(
        (pl.col("ticker_family") == ticker_family)
        & (pl.col("dte_bucket") == dte_bucket)
    )

    directions = ["bullish_call_buy", "bullish_put_sell", "bearish_call_sell", "bearish_put_buy"]
    times = ["open", "morning", "midday", "afternoon", "close"]

    grid = np.full((len(directions), len(times)), np.nan)
    n_grid = np.zeros((len(directions), len(times)), dtype=int)
    for r in subset.iter_rows(named=True):
        if r["signed_direction"] in directions and r["time_bucket"] in times:
            i = directions.index(r["signed_direction"])
            j = times.index(r["time_bucket"])
            grid[i, j] = r["win_rate"]
            n_grid[i, j] = r["n"]

    im = ax.imshow(grid, cmap="RdYlGn", vmin=0.0, vmax=1.0, aspect="auto")
    for i in range(len(directions)):
        for j in range(len(times)):
            if not np.isnan(grid[i, j]):
                txt = f"{grid[i, j]:.0%}\nn={n_grid[i, j]}"
                color = "black" if grid[i, j] > 0.4 else "white"
                ax.text(j, i, txt, ha="center", va="center", color=color, fontsize=8)
    ax.set_xticks(range(len(times)))
    ax.set_xticklabels(times, rotation=30, ha="right")
    ax.set_yticks(range(len(directions)))
    ax.set_yticklabels([d.replace("_", " ") for d in directions], fontsize=8)
    ax.set_title(f"{ticker_family} × {dte_bucket}", fontsize=10)
    ax.grid(False)
    return im


def plot_bucket_heatmap(outcomes: pl.DataFrame, out: Path) -> None:
    summary = summarize_outliers(outcomes).filter(pl.col("n") >= 5)

    families = ["index_etf", "spx_complex", "single_name"]
    dtes = ["0DTE", "1DTE", "2-7DTE", "8DTE+"]
    fig, axes = plt.subplots(
        len(families), len(dtes), figsize=(16, 9), squeeze=False
    )
    last_im = None
    for i, fam in enumerate(families):
        for j, dte in enumerate(dtes):
            last_im = _heatmap_panel(summary, ticker_family=fam, dte_bucket=dte, ax=axes[i, j])
    if last_im is not None:
        cbar = fig.colorbar(last_im, ax=axes.ravel().tolist(), label="Win rate", shrink=0.7)
        cbar.set_ticks([0, 0.25, 0.5, 0.6, 0.75, 1.0])
    fig.suptitle(
        f"Win rate by signed direction × time-of-day, faceted by family × DTE "
        f"(buckets with n ≥ 5; min_score={MIN_SCORE})"
    )
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)


def plot_top_tickers(outcomes: pl.DataFrame, out: Path, *, top_n: int = 20) -> None:
    won_only = outcomes.filter(pl.col("won") == True)  # noqa: E712
    by_ticker = (
        won_only.group_by("underlying_symbol")
        .agg(
            n_wins=pl.len(),
            avg_premium_m=(pl.col("premium") / 1_000_000).mean(),
        )
        .sort("n_wins", descending=True)
        .head(top_n)
    )
    fig, ax = plt.subplots(figsize=(11, 6))
    tickers = by_ticker["underlying_symbol"].to_list()
    n_wins = by_ticker["n_wins"].to_list()
    ax.barh(tickers[::-1], n_wins[::-1], color="#3498db", edgecolor="#222")
    ax.set_xlabel("Number of wins (touch-ITM)")
    ax.set_title(f"Top {len(tickers)} tickers by outlier wins (min_score={MIN_SCORE})")
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def plot_time_to_itm_vs_mfe(outcomes: pl.DataFrame, out: Path) -> None:
    """Scatter: did fast-ITM wins keep their gains? Slow-ITM round-trip more often."""
    buyer_wins = outcomes.filter(
        (pl.col("won") == True) & (pl.col("side") == "ask")  # noqa: E712
    )
    if buyer_wins.is_empty():
        return
    fig, ax = plt.subplots(figsize=(10, 6))
    won_close = buyer_wins.filter(pl.col("close_won") == True)  # noqa: E712
    lost_close = buyer_wins.filter(pl.col("close_won") == False)  # noqa: E712
    for label, subset, color, marker in (
        ("close_won = True (kept gains)", won_close, "#2ecc71", "o"),
        ("close_won = False (round-tripped)", lost_close, "#e74c3c", "x"),
    ):
        if not subset.is_empty():
            ax.scatter(
                subset["time_to_itm_min"].to_list(),
                subset["mfe_pts"].to_list(),
                alpha=0.5,
                s=30,
                color=color,
                marker=marker,
                label=label,
            )
    ax.set_xlabel("Time to ITM (minutes from print)")
    ax.set_ylabel("MFE in underlying points")
    ax.set_title("Buyer wins: path-shape — fast wins keep gains, slow wins round-trip")
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def plot_score_distribution(out: Path, *, dates: list) -> None:
    """Distribution of significance_score for ALL prints (not just outliers).
    Helps decide if min_score=4 is the right threshold."""
    # Sample a few days rather than scoring 120M rows — distribution
    # is stable across days.
    sample_dates = dates[: min(3, len(dates))]
    all_scored: list[pl.DataFrame] = []
    for d in sample_dates:
        from flow_outliers import enrich_print_features

        df = load_flow(d).collect()
        scored = score_prints(enrich_print_features(df))
        all_scored.append(scored.select(["significance_score"]))
    combined = pl.concat(all_scored)

    fig, ax = plt.subplots(figsize=(10, 5))
    score_counts = (
        combined.drop_nulls("significance_score")
        .group_by("significance_score")
        .len()
        .sort("significance_score")
    )
    scores = score_counts["significance_score"].to_list()
    counts = score_counts["len"].to_list()
    colors = ["#3498db" if s < MIN_SCORE else "#e67e22" for s in scores]
    ax.bar(scores, counts, color=colors, edgecolor="#222", linewidth=0.5)
    ax.axvline(MIN_SCORE - 0.5, color="#e74c3c", linestyle="--", label=f"min_score = {MIN_SCORE}")
    ax.set_yscale("log")
    ax.set_xlabel("significance_score")
    ax.set_ylabel("Count of prints (log)")
    ax.set_title(
        f"Score distribution — {len(sample_dates)}-day sample, "
        f"~{combined.height / 1_000_000:.1f}M prints"
    )
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("→ Running pipeline...")
    t0 = time.perf_counter()
    outliers, outcomes, dates = _load_pipeline()
    print(
        f"  {outliers.height:,} outliers, {outcomes.height:,} with outcomes "
        f"in {time.perf_counter() - t0:.1f}s"
    )

    print(f"→ Writing CSVs to {OUT_DIR}/")
    # Drop nested `score_breakdown` struct — CSV can't represent it.
    # Inspect via Parquet/JSON if needed.
    csv_outcomes = outcomes.drop("score_breakdown") if "score_breakdown" in outcomes.columns else outcomes
    csv_outcomes.write_csv(OUT_DIR / "outliers_with_outcomes.csv")
    summary = summarize_outliers(outcomes)
    summary.write_csv(OUT_DIR / "bucket_summary.csv")
    summary.filter(pl.col("n") >= 5).sort("win_rate", descending=True).write_csv(
        OUT_DIR / "top_edge_buckets.csv"
    )

    print(f"→ Generating plots in {OUT_DIR}/")
    plot_per_day_counts(outliers, OUT_DIR / "01-per-day-counts.png")
    print("  01 ✓")
    plot_bucket_heatmap(outcomes, OUT_DIR / "02-bucket-winrate-heatmap.png")
    print("  02 ✓")
    plot_top_tickers(outcomes, OUT_DIR / "03-top-tickers-by-wins.png")
    print("  03 ✓")
    plot_time_to_itm_vs_mfe(outcomes, OUT_DIR / "04-time-to-itm-vs-mfe.png")
    print("  04 ✓")
    plot_score_distribution(OUT_DIR / "05-score-distribution.png", dates=dates)
    print("  05 ✓")

    print(f"\nDone in {time.perf_counter() - t0:.1f}s. Open {OUT_DIR}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
