"""Whale move detection visualizations.

Builds all 13 charts derived from the whale-detection checklist
(`docs/whale-detection-checklist.md`) against the EOD options-flow
parquet archive at `scripts/eod-flow-analysis/output/by-day/`.

Outputs to `ml/plots/whale-detection/`.

Run:
    ml/.venv/bin/python ml/src/whale_plots.py
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    import numpy as np
    import polars as pl
    import seaborn as sns
    from matplotlib.patches import Patch
    from matplotlib.lines import Line2D
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PARQUET_DIR = REPO_ROOT / "scripts" / "eod-flow-analysis" / "output" / "by-day"
OUTPUT_DIR = REPO_ROOT / "ml" / "plots" / "whale-detection"

INDEX_ETF = ["SPX", "SPXW", "NDX", "NDXP", "QQQ", "SPY", "IWM"]

# Style
plt.rcParams.update({
    "figure.dpi": 100,
    "savefig.dpi": 150,
    "savefig.bbox": "tight",
    "font.size": 10,
    "axes.titlesize": 12,
    "axes.labelsize": 10,
    "axes.grid": True,
    "grid.alpha": 0.3,
})

BULL_COLOR = "#16a34a"  # green
BEAR_COLOR = "#dc2626"  # red
NEUTRAL_COLOR = "#737373"


# ---------------------------------------------------------------------------
# Data loading and filtering
# ---------------------------------------------------------------------------

def load_data() -> pl.DataFrame:
    files = sorted(PARQUET_DIR.glob("*-chains.parquet"))
    if not files:
        raise FileNotFoundError(f"No parquet files in {PARQUET_DIR}")
    df = pl.concat([pl.read_parquet(f) for f in files])
    df = df.with_columns(
        pl.when((pl.col("ask_size") + pl.col("bid_size")) > 0)
          .then(pl.col("ask_size") / (pl.col("ask_size") + pl.col("bid_size")))
          .otherwise(0.5).alias("ask_pct"),
        pl.col("first_ts").dt.convert_time_zone("America/Chicago").alias("first_ct"),
        pl.col("last_ts").dt.convert_time_zone("America/Chicago").alias("last_ct"),
        ((pl.col("expiry").cast(pl.Datetime).dt.replace_time_zone("UTC") - pl.col("first_ts"))
            .dt.total_days()).alias("dte"),
        (pl.col("strike") / pl.col("first_underlying").fill_null(1.0) - 1)
            .alias("moneyness"),
    )
    return df


def compute_thresholds(df: pl.DataFrame) -> dict[str, float]:
    out = {}
    for tkr in INDEX_ETF:
        sub = df.filter(pl.col("ticker") == tkr)
        if sub.height == 0:
            continue
        out[tkr] = sub.select(pl.col("total_premium").quantile(0.95)).item()
    return out


def apply_checklist(df: pl.DataFrame, thresholds: dict) -> pl.DataFrame:
    threshold_expr = pl.lit(False)
    for tkr, thresh in thresholds.items():
        threshold_expr = threshold_expr | ((pl.col("ticker") == tkr) & (pl.col("total_premium") >= thresh))
    qual = df.filter(
        threshold_expr
        & pl.col("ticker").is_in(INDEX_ETF)
        & (pl.col("trade_count") >= 5)
        & (pl.col("dte") <= 14)
        & ((pl.col("ask_pct") >= 0.85) | (pl.col("ask_pct") <= 0.15))
        & (
            (pl.col("first_underlying").is_not_null() & (pl.col("moneyness").abs() <= 0.05))
            | pl.col("first_underlying").is_null()
        )
    ).with_columns(
        pl.when(pl.col("ask_pct") >= 0.85).then(pl.lit("ASK")).otherwise(pl.lit("BID")).alias("side"),
    )
    qual = qual.with_columns(
        pl.when((pl.col("side") == "BID") & (pl.col("option_type") == "put")).then(pl.lit("bullish"))
          .when((pl.col("side") == "BID") & (pl.col("option_type") == "call")).then(pl.lit("bearish"))
          .when((pl.col("side") == "ASK") & (pl.col("option_type") == "put")).then(pl.lit("bearish"))
          .otherwise(pl.lit("bullish")).alias("direction"),
    )
    return qual


def detect_pairs(qual: pl.DataFrame, all_df: pl.DataFrame) -> dict:
    pairs = {}
    for r in qual.iter_rows(named=True):
        opp = "put" if r["option_type"] == "call" else "call"
        match = all_df.filter(
            (pl.col("trade_date") == r["trade_date"])
            & (pl.col("ticker") == r["ticker"])
            & (pl.col("strike") == r["strike"])
            & (pl.col("expiry") == r["expiry"])
            & (pl.col("option_type") == opp)
        )
        if match.height == 0:
            pairs[r["option_chain_id"]] = None
            continue
        m = match.row(0, named=True)
        ovl = (min(r["last_ts"], m["last_ts"]) - max(r["first_ts"], m["first_ts"])).total_seconds()
        pairs[r["option_chain_id"]] = ("simultaneous" if ovl > 60 else "sequential", m)
    return pairs


# ---------------------------------------------------------------------------
# Plot 1 — Daily whale footprint (faceted by date, per ticker)
# ---------------------------------------------------------------------------

def plot_01_daily_footprint(qual: pl.DataFrame, output_dir: Path) -> None:
    for ticker in ["SPXW", "NDXP"]:
        tdf = qual.filter(pl.col("ticker") == ticker)
        if tdf.height == 0:
            continue
        dates = sorted(tdf["trade_date"].unique().to_list())
        n = len(dates)
        ncols = 4
        nrows = (n + ncols - 1) // ncols
        fig, axes = plt.subplots(nrows, ncols, figsize=(4*ncols, 3*nrows),
                                 constrained_layout=True, sharey=False)
        axes = np.atleast_2d(axes).flatten()
        for i, date in enumerate(dates):
            ax = axes[i]
            day = tdf.filter(pl.col("trade_date") == date)
            for r in day.iter_rows(named=True):
                color = BULL_COLOR if r["direction"] == "bullish" else BEAR_COLOR
                marker = "o" if r["option_type"] == "put" else "^"
                size = 50 + (r["total_premium"] / 1e6) * 5
                # x: hour-of-day in CT
                hr = r["first_ct"].hour + r["first_ct"].minute / 60
                ax.scatter(hr, r["strike"], s=size, c=color, marker=marker,
                           alpha=0.7, edgecolors="black", linewidth=0.5)
                ax.annotate(f"${r['total_premium']/1e6:.1f}M",
                            xy=(hr, r["strike"]), fontsize=7, ha="center", va="bottom")
            ax.set_title(date, fontsize=10)
            ax.set_xlim(8, 15.5)
            ax.set_xticks([9, 10, 11, 12, 13, 14, 15])
            ax.set_xlabel("Hour CT")
            if i % ncols == 0:
                ax.set_ylabel("Strike")
        for j in range(i+1, len(axes)):
            axes[j].set_visible(False)
        legend_elements = [
            Line2D([0], [0], marker="o", color="w", markerfacecolor=BULL_COLOR,
                   markersize=10, label="Bullish put"),
            Line2D([0], [0], marker="^", color="w", markerfacecolor=BULL_COLOR,
                   markersize=10, label="Bullish call"),
            Line2D([0], [0], marker="o", color="w", markerfacecolor=BEAR_COLOR,
                   markersize=10, label="Bearish put"),
            Line2D([0], [0], marker="^", color="w", markerfacecolor=BEAR_COLOR,
                   markersize=10, label="Bearish call"),
        ]
        fig.legend(handles=legend_elements, loc="upper right", bbox_to_anchor=(1.0, 1.0),
                   ncol=4, fontsize=9)
        fig.suptitle(f"Daily Whale Footprint — {ticker}", fontsize=14, fontweight="bold")
        path = output_dir / f"01_daily_footprint_{ticker.lower()}.png"
        fig.savefig(path)
        plt.close(fig)
        print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 2 — 11-day whale timeline
# ---------------------------------------------------------------------------

def plot_02_timeline(qual: pl.DataFrame, df: pl.DataFrame, output_dir: Path) -> None:
    fig, axes = plt.subplots(2, 1, figsize=(14, 10), constrained_layout=True)
    for ax, ticker in zip(axes, ["SPXW", "NDXP"]):
        tdf = qual.filter(pl.col("ticker") == ticker)
        # Daily price proxy: median first_underlying for each day's chains
        price_df = (df.filter(
            (pl.col("ticker").is_in([ticker, "SPX" if ticker == "SPXW" else "NDX"]))
            & pl.col("first_underlying").is_not_null()
        ).group_by("trade_date").agg(
            pl.col("first_underlying").median().alias("median_und"),
        ).sort("trade_date"))
        if price_df.height > 0:
            xs = price_df["trade_date"].to_list()
            ys = price_df["median_und"].to_list()
            ax.plot(xs, ys, color="#404040", linewidth=1.5, alpha=0.6, label="Median spot")
        for r in tdf.iter_rows(named=True):
            color = BULL_COLOR if r["direction"] == "bullish" else BEAR_COLOR
            marker = "o" if r["option_type"] == "put" else "^"
            size = 50 + (r["total_premium"] / 1e6) * 8
            ax.scatter(r["trade_date"], r["strike"], s=size, c=color, marker=marker,
                       alpha=0.7, edgecolors="black", linewidth=0.5, zorder=5)
        ax.set_title(f"{ticker} — 11-day whale timeline", fontsize=12, fontweight="bold")
        ax.set_ylabel("Strike")
        ax.set_xlabel("Date")
        ax.tick_params(axis="x", rotation=45)
    fig.suptitle("Whale Strike Levels vs. Underlying — 11 Days", fontsize=14, fontweight="bold")
    path = output_dir / "02_eleven_day_timeline.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 3 — Today's level map (most recent date)
# ---------------------------------------------------------------------------

def plot_03_todays_level_map(qual: pl.DataFrame, df: pl.DataFrame, output_dir: Path) -> None:
    latest_date = qual["trade_date"].max()
    today = qual.filter(pl.col("trade_date") == latest_date)
    if today.height == 0:
        print(f"  ⏭  no whales on {latest_date}; skipping")
        return
    fig, ax = plt.subplots(figsize=(12, 7), constrained_layout=True)
    # Underlying spot trajectory: pull all chain first_underlying values and order by time
    spot_df = (df.filter(
        (pl.col("trade_date") == latest_date)
        & (pl.col("ticker") == "SPXW")
        & pl.col("first_underlying").is_not_null()
    ).select(["first_ts", "first_underlying"]).sort("first_ts"))
    if spot_df.height > 0:
        times = [t.replace(tzinfo=None) for t in
                 spot_df["first_ts"].dt.convert_time_zone("America/Chicago").to_list()]
        prices = spot_df["first_underlying"].to_list()
        ax.plot(times, prices, color="#404040", linewidth=1.5, alpha=0.7, label="SPX spot")
    for r in today.iter_rows(named=True):
        color = BULL_COLOR if r["direction"] == "bullish" else BEAR_COLOR
        ax.axhline(r["strike"], color=color, linestyle="--", alpha=0.6, linewidth=1.5)
        ax.text(0.99, r["strike"], f"  {r['ticker']} {r['strike']:.0f}{r['option_type'][0].upper()} "
                f"${r['total_premium']/1e6:.1f}M ({r['side']})",
                transform=ax.get_yaxis_transform(), va="center", ha="right", fontsize=8,
                color=color, fontweight="bold")
    ax.set_title(f"Today's Level Map — {latest_date}", fontsize=14, fontweight="bold")
    ax.set_xlabel("Time CT")
    ax.set_ylabel("Price / Strike")
    ax.legend(loc="upper left")
    path = output_dir / "03_todays_level_map.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 4 — Whale outcome scatter (approximate using last_underlying)
# ---------------------------------------------------------------------------

def plot_04_outcome_scatter(qual: pl.DataFrame, output_dir: Path) -> None:
    # Reached: did last_underlying cross the strike in the favorable direction?
    qual2 = qual.filter(pl.col("first_underlying").is_not_null()).with_columns(
        pl.col("first_ct").dt.hour().alias("hour"),
    ).with_columns(
        pl.when((pl.col("direction") == "bullish") & (pl.col("last_underlying") >= pl.col("strike")))
          .then(pl.lit("hit"))
          .when((pl.col("direction") == "bearish") & (pl.col("last_underlying") <= pl.col("strike")))
          .then(pl.lit("hit"))
          .otherwise(pl.lit("miss")).alias("outcome"),
        ((pl.col("strike") / pl.col("first_underlying") - 1) * 100).alias("pct_to_strike"),
    )
    fig, axes = plt.subplots(1, 2, figsize=(14, 6), constrained_layout=True)
    for ax, direction in zip(axes, ["bullish", "bearish"]):
        sub = qual2.filter(pl.col("direction") == direction)
        if sub.height == 0:
            continue
        for r in sub.iter_rows(named=True):
            color = BULL_COLOR if r["outcome"] == "hit" else BEAR_COLOR
            marker = "o" if r["outcome"] == "hit" else "x"
            ax.scatter(r["hour"], r["pct_to_strike"], s=80, c=color, marker=marker,
                       alpha=0.7, edgecolors="black" if r["outcome"] == "hit" else None)
        ax.axhline(0, color="black", linewidth=0.5)
        n_hit = sub.filter(pl.col("outcome") == "hit").height
        ax.set_title(f"{direction.capitalize()} whales: {n_hit}/{sub.height} hit "
                     f"({n_hit/sub.height*100:.0f}%)", fontsize=12)
        ax.set_xlabel("Hour CT (print time)")
        ax.set_ylabel("% from spot to target strike")
    fig.suptitle("Whale Outcome Scatter — did price reach the strike?",
                 fontsize=14, fontweight="bold")
    path = output_dir / "04_outcome_scatter.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 5 — Time-to-target heatmap (chain duration as proxy)
# ---------------------------------------------------------------------------

def plot_05_time_to_target(qual: pl.DataFrame, output_dir: Path) -> None:
    qual2 = qual.with_columns(
        ((pl.col("last_ts") - pl.col("first_ts")).dt.total_minutes()).alias("duration_min"),
        pl.col("first_ct").dt.hour().alias("hour"),
    )
    grid = (qual2.group_by(["ticker", "hour"]).agg(
        pl.col("duration_min").median().alias("median_dur"),
        pl.len().alias("count"),
    ).sort(["ticker", "hour"]))
    if grid.height == 0:
        return
    tickers = sorted(grid["ticker"].unique().to_list())
    hours = list(range(8, 16))
    matrix = np.full((len(tickers), len(hours)), np.nan)
    for r in grid.iter_rows(named=True):
        if r["ticker"] in tickers and r["hour"] in hours:
            matrix[tickers.index(r["ticker"]), hours.index(r["hour"])] = r["median_dur"]
    fig, ax = plt.subplots(figsize=(10, 5), constrained_layout=True)
    im = ax.imshow(matrix, cmap="viridis", aspect="auto")
    ax.set_xticks(range(len(hours)))
    ax.set_xticklabels(hours)
    ax.set_yticks(range(len(tickers)))
    ax.set_yticklabels(tickers)
    ax.set_xlabel("Hour CT")
    ax.set_ylabel("Ticker")
    plt.colorbar(im, ax=ax, label="Median chain duration (minutes)")
    for i, tkr in enumerate(tickers):
        for j, hr in enumerate(hours):
            v = matrix[i, j]
            if not np.isnan(v):
                ax.text(j, i, f"{int(v)}", ha="center", va="center",
                        fontsize=8, color="white" if v > np.nanmedian(matrix) else "black")
    ax.set_title("Median Whale Chain Duration — proxy for time-to-target",
                 fontsize=12, fontweight="bold")
    path = output_dir / "05_time_to_target.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 6 — R:R distribution
# ---------------------------------------------------------------------------

def plot_06_rr_distribution(qual: pl.DataFrame, output_dir: Path) -> None:
    # Approximate R:R: distance to strike vs assumed 0.3% stop
    STOP_PCT = 0.003
    qual2 = qual.filter(pl.col("first_underlying").is_not_null()).with_columns(
        ((pl.col("strike") / pl.col("first_underlying") - 1).abs() / STOP_PCT).alias("rr"),
    )
    fig, ax = plt.subplots(figsize=(10, 6), constrained_layout=True)
    bull = qual2.filter(pl.col("direction") == "bullish")["rr"].to_numpy()
    bear = qual2.filter(pl.col("direction") == "bearish")["rr"].to_numpy()
    bins = np.linspace(0, max(np.max(bull), np.max(bear)) if len(bull) and len(bear) else 10, 20)
    ax.hist(bull, bins=bins, alpha=0.6, color=BULL_COLOR, label=f"Bullish (n={len(bull)})", edgecolor="black")
    ax.hist(bear, bins=bins, alpha=0.6, color=BEAR_COLOR, label=f"Bearish (n={len(bear)})", edgecolor="black")
    ax.axvline(1, color="black", linestyle="--", alpha=0.5, label="1:1 R:R")
    ax.axvline(2, color="orange", linestyle="--", alpha=0.5, label="2:1 R:R")
    ax.set_xlabel("R:R ratio (assumes 0.3% stop)")
    ax.set_ylabel("Count")
    ax.set_title("Whale R:R Distribution — strike-to-spot vs assumed stop",
                 fontsize=12, fontweight="bold")
    ax.legend()
    path = output_dir / "06_rr_distribution.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 7 — Per-ticker premium distribution (log scale)
# ---------------------------------------------------------------------------

def plot_07_premium_distribution(df: pl.DataFrame, thresholds: dict, output_dir: Path) -> None:
    fig, axes = plt.subplots(2, 4, figsize=(16, 8), constrained_layout=True)
    axes = axes.flatten()
    for i, ticker in enumerate(INDEX_ETF):
        ax = axes[i]
        sub = df.filter(pl.col("ticker") == ticker)
        if sub.height == 0:
            ax.set_visible(False)
            continue
        prems = sub["total_premium"].to_numpy()
        prems_log = np.log10(prems[prems > 0])
        ax.hist(prems_log, bins=40, color="steelblue", edgecolor="black", alpha=0.7)
        p95 = np.log10(thresholds[ticker])
        ax.axvline(p95, color="red", linestyle="--", linewidth=2,
                   label=f"p95 = ${thresholds[ticker]/1e6:.1f}M")
        ax.set_title(f"{ticker} (n={sub.height})", fontsize=11, fontweight="bold")
        ax.set_xlabel("log10(premium $)")
        ax.set_ylabel("Count")
        ax.legend(fontsize=8)
    # Hide unused panels
    for j in range(len(INDEX_ETF), len(axes)):
        axes[j].set_visible(False)
    fig.suptitle("Per-Ticker Premium Distribution (11-day outsized universe)",
                 fontsize=14, fontweight="bold")
    path = output_dir / "07_premium_distribution.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 8 — Filter funnel
# ---------------------------------------------------------------------------

def plot_08_filter_funnel(df: pl.DataFrame, thresholds: dict, output_dir: Path) -> None:
    threshold_expr = pl.lit(False)
    for tkr, thresh in thresholds.items():
        threshold_expr = threshold_expr | ((pl.col("ticker") == tkr) & (pl.col("total_premium") >= thresh))
    stages = [
        ("All outsized chains", df.height),
        ("Index/ETF only", df.filter(pl.col("ticker").is_in(INDEX_ETF)).height),
        ("After per-ticker p95", df.filter(pl.col("ticker").is_in(INDEX_ETF) & threshold_expr).height),
        ("After trade_count ≥5", df.filter(
            pl.col("ticker").is_in(INDEX_ETF) & threshold_expr
            & (pl.col("trade_count") >= 5)).height),
        ("After DTE ≤14", df.filter(
            pl.col("ticker").is_in(INDEX_ETF) & threshold_expr
            & (pl.col("trade_count") >= 5) & (pl.col("dte") <= 14)).height),
        ("After moneyness ≤5%", df.filter(
            pl.col("ticker").is_in(INDEX_ETF) & threshold_expr
            & (pl.col("trade_count") >= 5) & (pl.col("dte") <= 14)
            & ((pl.col("first_underlying").is_null()) | (pl.col("moneyness").abs() <= 0.05))).height),
        ("After ≥85% one-sided", df.filter(
            pl.col("ticker").is_in(INDEX_ETF) & threshold_expr
            & (pl.col("trade_count") >= 5) & (pl.col("dte") <= 14)
            & ((pl.col("first_underlying").is_null()) | (pl.col("moneyness").abs() <= 0.05))
            & ((pl.col("ask_pct") >= 0.85) | (pl.col("ask_pct") <= 0.15))).height),
    ]
    fig, ax = plt.subplots(figsize=(11, 6), constrained_layout=True)
    labels, counts = zip(*stages)
    y_pos = np.arange(len(labels))[::-1]
    cmap = plt.cm.viridis(np.linspace(0.2, 0.9, len(stages)))
    bars = ax.barh(y_pos, counts, color=cmap, edgecolor="black")
    for bar, count in zip(bars, counts):
        ax.text(count, bar.get_y() + bar.get_height()/2,
                f" {count:,}", va="center", fontsize=10)
    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels)
    ax.set_xlabel("Chains remaining")
    ax.set_title("Whale Detection Filter Funnel", fontsize=13, fontweight="bold")
    ax.set_xscale("log")
    path = output_dir / "08_filter_funnel.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 9 — Trade-count distribution
# ---------------------------------------------------------------------------

def plot_09_trade_count_distribution(df: pl.DataFrame, thresholds: dict, output_dir: Path) -> None:
    threshold_expr = pl.lit(False)
    for tkr, thresh in thresholds.items():
        threshold_expr = threshold_expr | ((pl.col("ticker") == tkr) & (pl.col("total_premium") >= thresh))
    sub = df.filter(pl.col("ticker").is_in(INDEX_ETF) & threshold_expr & (pl.col("dte") <= 14))
    fig, ax = plt.subplots(figsize=(10, 6), constrained_layout=True)
    counts = sub["trade_count"].to_numpy()
    counts_clipped = np.clip(counts, 0, 100)
    ax.hist(counts_clipped, bins=50, color="steelblue", edgecolor="black", alpha=0.7)
    ax.axvline(5, color="red", linestyle="--", linewidth=2, label="Filter cutoff (≥5)")
    ax.set_xlabel("Trade count per chain (clipped at 100)")
    ax.set_ylabel("Number of chains")
    ax.set_title("Trade-Count Distribution — premium-qualified chains",
                 fontsize=12, fontweight="bold")
    ax.legend()
    path = output_dir / "09_trade_count_distribution.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 10 — Cross-ticker alignment matrix
# ---------------------------------------------------------------------------

def plot_10_alignment_matrix(qual: pl.DataFrame, output_dir: Path) -> None:
    grid = (qual.with_columns(
        pl.when(pl.col("direction") == "bullish").then(1).otherwise(-1).alias("dir_score"),
    ).group_by(["trade_date", "ticker"]).agg(
        pl.col("dir_score").sum().alias("net_score"),
    ))
    dates = sorted(qual["trade_date"].unique().to_list())
    tickers = ["SPXW", "NDXP", "SPY", "QQQ", "SPX", "NDX", "IWM"]
    matrix = np.zeros((len(tickers), len(dates)))
    for r in grid.iter_rows(named=True):
        if r["ticker"] in tickers and r["trade_date"] in dates:
            matrix[tickers.index(r["ticker"]), dates.index(r["trade_date"])] = r["net_score"]
    fig, ax = plt.subplots(figsize=(12, 5), constrained_layout=True)
    vmax = max(abs(matrix.min()), abs(matrix.max()), 1)
    im = ax.imshow(matrix, cmap="RdYlGn", aspect="auto", vmin=-vmax, vmax=vmax)
    ax.set_xticks(range(len(dates)))
    ax.set_xticklabels(dates, rotation=45, ha="right")
    ax.set_yticks(range(len(tickers)))
    ax.set_yticklabels(tickers)
    plt.colorbar(im, ax=ax, label="Net direction (bullish − bearish whale count)")
    for i in range(len(tickers)):
        for j in range(len(dates)):
            v = matrix[i, j]
            if v != 0:
                ax.text(j, i, f"{int(v):+d}", ha="center", va="center",
                        fontsize=9, color="white" if abs(v) > vmax/2 else "black")
    ax.set_title("Cross-Ticker Whale Alignment — net direction by day",
                 fontsize=12, fontweight="bold")
    path = output_dir / "10_alignment_matrix.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 11 — Synthetic structure detector
# ---------------------------------------------------------------------------

def plot_11_synthetic_detector(qual: pl.DataFrame, pairs: dict, output_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(12, 6), constrained_layout=True)
    dates = sorted(qual["trade_date"].unique().to_list())
    date_idx = {d: i for i, d in enumerate(dates)}
    sim_pts, seq_pts, alone_pts = [], [], []
    for r in qual.iter_rows(named=True):
        info = pairs.get(r["option_chain_id"])
        x = date_idx[r["trade_date"]]
        y = r["strike"]
        size = 50 + (r["total_premium"] / 1e6) * 5
        if info is None:
            alone_pts.append((x, y, size))
        elif info[0] == "simultaneous":
            sim_pts.append((x, y, size))
        else:
            seq_pts.append((x, y, size))
    if alone_pts:
        ax.scatter(*zip(*[(p[0], p[1]) for p in alone_pts]),
                   s=[p[2] for p in alone_pts],
                   c="steelblue", alpha=0.6, edgecolors="black", label=f"Alone (n={len(alone_pts)})")
    if seq_pts:
        ax.scatter(*zip(*[(p[0], p[1]) for p in seq_pts]),
                   s=[p[2] for p in seq_pts],
                   c="gold", alpha=0.7, edgecolors="black", marker="D",
                   label=f"Sequential roll (n={len(seq_pts)})")
    if sim_pts:
        ax.scatter(*zip(*[(p[0], p[1]) for p in sim_pts]),
                   s=[p[2] for p in sim_pts],
                   c="gray", alpha=0.5, edgecolors="black", marker="x",
                   label=f"Simultaneous synthetic (n={len(sim_pts)})")
    ax.set_xticks(range(len(dates)))
    ax.set_xticklabels(dates, rotation=45, ha="right")
    ax.set_xlabel("Trade date")
    ax.set_ylabel("Strike")
    ax.set_title("Pairing Status of Whale Prints — synthetic vs roll vs standalone",
                 fontsize=12, fontweight="bold")
    ax.legend()
    path = output_dir / "11_synthetic_detector.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 12 — Whale clustering by minute (across all 11 days)
# ---------------------------------------------------------------------------

def plot_12_minute_clustering(qual: pl.DataFrame, output_dir: Path) -> None:
    qual2 = qual.with_columns(
        (pl.col("first_ct").dt.hour() * 60 + pl.col("first_ct").dt.minute()).alias("min_of_day"),
    )
    fig, ax = plt.subplots(figsize=(14, 6), constrained_layout=True)
    tickers = sorted(qual2["ticker"].unique().to_list())
    bins = np.arange(8*60, 15*60 + 30, 15)  # 15-min bins from 8:00 to 15:30 CT
    bottom = np.zeros(len(bins) - 1)
    palette = plt.cm.tab10(np.linspace(0, 1, len(tickers)))
    for color, tkr in zip(palette, tickers):
        sub = qual2.filter(pl.col("ticker") == tkr)
        if sub.height == 0:
            continue
        hist, _ = np.histogram(sub["min_of_day"].to_numpy(), bins=bins)
        ax.bar(bins[:-1], hist, width=15, bottom=bottom, color=color,
               edgecolor="black", linewidth=0.3, label=tkr, align="edge")
        bottom += hist
    # Format x as HH:MM
    xticks = np.arange(8*60, 15*60+1, 60)
    ax.set_xticks(xticks)
    ax.set_xticklabels([f"{h//60:02d}:{h%60:02d}" for h in xticks])
    ax.set_xlabel("Time CT (15-min bins)")
    ax.set_ylabel("Whale prints")
    ax.set_title("Whale Print Clustering by Minute of Day — 11 days combined",
                 fontsize=12, fontweight="bold")
    ax.legend(loc="upper right")
    path = output_dir / "12_minute_clustering.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Plot 13 — Strike magnet score
# ---------------------------------------------------------------------------

def plot_13_strike_magnet(qual: pl.DataFrame, output_dir: Path) -> None:
    # Per-ticker, count distinct days each strike appears as a whale level
    fig, axes = plt.subplots(1, 2, figsize=(14, 6), constrained_layout=True)
    for ax, ticker in zip(axes, ["SPXW", "NDXP"]):
        tdf = qual.filter(pl.col("ticker") == ticker)
        if tdf.height == 0:
            ax.set_visible(False)
            continue
        grid = (tdf.group_by(["trade_date", "strike"]).agg(
            pl.col("direction").n_unique().alias("dir_count"),
            pl.col("direction").mode().first().alias("net_dir"),
        ))
        dates = sorted(tdf["trade_date"].unique().to_list())
        strikes = sorted(tdf["strike"].unique().to_list())
        matrix = np.zeros((len(strikes), len(dates)))
        for r in grid.iter_rows(named=True):
            i = strikes.index(r["strike"])
            j = dates.index(r["trade_date"])
            matrix[i, j] = 1 if r["net_dir"] == "bullish" else -1
        im = ax.imshow(matrix, cmap="RdYlGn", aspect="auto", vmin=-1, vmax=1)
        ax.set_xticks(range(len(dates)))
        ax.set_xticklabels(dates, rotation=45, ha="right", fontsize=8)
        ax.set_yticks(range(len(strikes)))
        ax.set_yticklabels([f"{s:.0f}" for s in strikes], fontsize=8)
        ax.set_title(f"{ticker} — Whale strike levels by day", fontsize=11, fontweight="bold")
        ax.set_xlabel("Date")
        ax.set_ylabel("Strike")
    fig.suptitle("Strike-Level Magnet Score — green=bullish whale, red=bearish whale",
                 fontsize=13, fontweight="bold")
    path = output_dir / "13_strike_magnet.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"  ✅ {path.name}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"→ Loading data from {PARQUET_DIR}")
    df = load_data()
    print(f"  loaded {df.height:,} chains, {df['ticker'].n_unique()} tickers, "
          f"{df['trade_date'].min()} → {df['trade_date'].max()}")

    print(f"→ Computing per-ticker p95 thresholds")
    thresholds = compute_thresholds(df)
    for tkr, t in thresholds.items():
        print(f"    {tkr}: ${t:,.0f}")

    print(f"→ Applying checklist")
    qual = apply_checklist(df, thresholds)
    print(f"  {qual.height} qualifying whale prints")

    print(f"→ Detecting pairs")
    pairs = detect_pairs(qual, df)

    print(f"→ Building plots into {OUTPUT_DIR}")
    plot_01_daily_footprint(qual, OUTPUT_DIR)
    plot_02_timeline(qual, df, OUTPUT_DIR)
    plot_03_todays_level_map(qual, df, OUTPUT_DIR)
    plot_04_outcome_scatter(qual, OUTPUT_DIR)
    plot_05_time_to_target(qual, OUTPUT_DIR)
    plot_06_rr_distribution(qual, OUTPUT_DIR)
    plot_07_premium_distribution(df, thresholds, OUTPUT_DIR)
    plot_08_filter_funnel(df, thresholds, OUTPUT_DIR)
    plot_09_trade_count_distribution(df, thresholds, OUTPUT_DIR)
    plot_10_alignment_matrix(qual, OUTPUT_DIR)
    plot_11_synthetic_detector(qual, pairs, OUTPUT_DIR)
    plot_12_minute_clustering(qual, OUTPUT_DIR)
    plot_13_strike_magnet(qual, OUTPUT_DIR)

    print(f"\n✅ All plots written to {OUTPUT_DIR}")
    print_pipeline_summary(df["trade_date"].max())
    return 0


def print_pipeline_summary(latest_date) -> None:
    """Print the nightly pipeline output summary using the date from the loaded
    data — owned here (not the Makefile) because Make expands
    `DATE ?= $(shell ls ...)` lazily, so the date silently goes empty after
    ingest-flow.py deletes the source CSV.
    """
    iso = (
        latest_date.isoformat()
        if hasattr(latest_date, "isoformat")
        else str(latest_date)
    )
    y, m, d = iso.split("-")
    bar = "═" * 64
    print()
    print(bar)
    print(f"  ✅ Nightly pipeline complete for {iso}")
    print(bar)
    print()
    print("Outputs:")
    print(
        "  • EOD aggregate:  "
        f"scripts/eod-flow-analysis/output/by-day/{iso}-chains.parquet"
    )
    print(
        "  • Cumulative:     "
        "scripts/eod-flow-analysis/output/cumulative-headlines.txt"
    )
    print(
        "  • Vercel Blob:    "
        f"flow/year={y}/month={m}/day={d}/data.parquet"
    )
    print(f"  • Archive:        ~/Desktop/Bot-Eod-parquet/{iso}-trades.parquet")
    print("  • Plots:          ml/plots/whale-detection/*.png")
    print()
    print(
        "Next: review cumulative-headlines.txt, scan plots, "
        "commit per-day artifacts."
    )


if __name__ == "__main__":
    sys.exit(main())
