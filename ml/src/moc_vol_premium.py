"""
MOC Imbalance — Phase 4 (Tier 0): Is realized last-10-min vol above
VIX-implied last-10-min vol?

This is the long-vol mirror of the short-gamma protective research. Instead
of "is MOC dangerous?", the question is "is MOC a mispriced opportunity?"

The test is simple:

    realized_sigma_10min > implied_sigma_10min  ?

If yes in elevated-VIX regimes, a long-straddle-at-15:50-hold-to-close
strategy has positive expected value. If no, the options market is
correctly pricing the risk and there's no edge for retail.

Tier 0 caveat: VIX is a 30-day constant-maturity proxy, NOT the 0DTE
10-min implied vol. This analysis gets you a directional hint, not a
tradeable number. A positive signal here justifies spending $10-30 on
actual options data for Tier 1. A null result closes the thread.

Measures:
  - Implied 10-min sigma (bps): VIX * sqrt(1 / (252 * 6.5 * 60 / 10)) * 100
    ~= VIX * 3.191 bps per unit of VIX. For VIX=20, implied_sigma ~= 6.4 bps.
  - Realized 10-min abs return (bps): already in feature table.
  - Realized 10-min MAE (bps): already in feature table.
  - Realized 10-min MFE (bps): already in feature table.

Plus a simulated ATM straddle P&L:
  - Straddle cost at 15:50 ~= 0.8 * implied_sigma_10min (Black-Scholes ATM
    approximation).
  - Straddle payoff at 16:00 = |realized return| (0DTE, zero time value
    remaining at close; closes are cash-settled at last print).
  - Net P&L per day = |realized return| - straddle cost.

Plots:
  1. vol_premium_by_bucket.png   - realized / implied ratio boxplot per VIX bucket
  2. straddle_pnl_by_bucket.png  - simulated straddle net P&L distribution per bucket
  3. cumulative_straddle.png     - equity curve of daily straddle P&L, per bucket

Usage:
    ml/.venv/bin/python ml/src/moc_vol_premium.py
"""

import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install matplotlib seaborn pandas numpy")
    sys.exit(1)

from utils import ML_ROOT, section, subsection, takeaway


PLOTS_DIR = ML_ROOT / "plots" / "moc"
FEATURES_PATH = ML_ROOT / "data" / "moc_features_qqq.parquet"
VIX_CACHE = ML_ROOT / "data" / "vix_daily.parquet"

VIX_BUCKETS = [
    ("Calm (<15)", 0, 15),
    ("Normal (15-20)", 15, 20),
    ("Elevated (20-30)", 20, 30),
    ("Stress (>30)", 30, 200),
]

# Market session constants.
TRADING_DAYS_PER_YEAR = 252
MINUTES_PER_SESSION = 6.5 * 60  # 390
WINDOW_MINUTES = 10  # 15:50 -> 16:00 ET

# sqrt(T) where T = window / (trading_days_per_year * minutes_per_session).
# For 10 min: sqrt(10 / 98280) ~= 0.003191.
SQRT_T = np.sqrt(WINDOW_MINUTES / (TRADING_DAYS_PER_YEAR * MINUTES_PER_SESSION))

# Black-Scholes ATM straddle cost in units of (sigma * S), approximately
# 2 * sqrt(2 / pi) / sqrt(2 * pi) = sqrt(2/pi) ~= 0.7979. See Hull.
ATM_STRADDLE_FACTOR = np.sqrt(2 / np.pi)

sns.set_theme(style="darkgrid", context="notebook")
plt.rcParams.update({"figure.dpi": 110, "savefig.dpi": 140})


# ── Load ─────────────────────────────────────────────────────


def load_joined() -> pd.DataFrame:
    if not FEATURES_PATH.exists() or not VIX_CACHE.exists():
        print("ERROR: missing features or VIX cache. Run prior phases first.")
        sys.exit(1)
    features = pd.read_parquet(FEATURES_PATH)
    features.index = pd.to_datetime(features.index).tz_localize(None)
    vix = pd.read_parquet(VIX_CACHE)
    joined = features.join(vix, how="inner").dropna(
        subset=["vix_close", "realized_return_bps", "realized_mae_down_bps"]
    )
    print(f"  {len(joined):,} days with realized + VIX")
    return joined


def assign_bucket(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    labels = []
    for vix in frame["vix_close"]:
        for label, lo, hi in VIX_BUCKETS:
            if lo <= vix < hi:
                labels.append(label)
                break
        else:
            labels.append("Stress (>30)")
    frame["vix_bucket"] = pd.Categorical(
        labels,
        categories=[b[0] for b in VIX_BUCKETS],
        ordered=True,
    )
    return frame


# ── Derivations ──────────────────────────────────────────────


def add_vol_metrics(frame: pd.DataFrame) -> pd.DataFrame:
    """
    Compute implied 10-min sigma, realized |return|, realized/implied
    ratios, and simulated straddle P&L per day.
    """
    out = frame.copy()

    # Implied 10-min sigma from VIX. VIX/100 is annualized sigma in
    # decimal; scale to 10-min window; convert to bps of price (x1e4).
    out["implied_sigma_10min_bps"] = (out["vix_close"] / 100.0) * SQRT_T * 10_000

    # Realized |return| is the "path-free" realized move. MAE/MFE are
    # path-dependent max excursions (more volatile, more informative).
    out["realized_abs_return_bps"] = out["realized_return_bps"].abs()

    # Ratios: realized / implied. >1 means options underpriced this day.
    out["ratio_abs_return"] = (
        out["realized_abs_return_bps"] / out["implied_sigma_10min_bps"]
    )
    out["ratio_mae"] = (
        out["realized_mae_down_bps"] / out["implied_sigma_10min_bps"]
    )
    out["ratio_range"] = (
        out["realized_range_bps"] / out["implied_sigma_10min_bps"]
    )

    # Straddle simulation. Cost = BS ATM approximation at implied vol.
    # Payoff = |realized return|.  Net = payoff - cost.
    out["straddle_cost_bps"] = (
        ATM_STRADDLE_FACTOR * out["implied_sigma_10min_bps"]
    )
    out["straddle_pnl_bps"] = (
        out["realized_abs_return_bps"] - out["straddle_cost_bps"]
    )

    # Win rate indicator: did the straddle cover its cost this day?
    out["straddle_won"] = out["straddle_pnl_bps"] > 0
    return out


# ── Analyses ─────────────────────────────────────────────────


def summary_by_bucket(frame: pd.DataFrame) -> pd.DataFrame:
    summary = (
        frame.groupby("vix_bucket", observed=True)
        .agg(
            n=("realized_return_bps", "count"),
            median_vix=("vix_close", "median"),
            median_implied_bps=("implied_sigma_10min_bps", "median"),
            median_abs_return=("realized_abs_return_bps", "median"),
            median_ratio_abs=("ratio_abs_return", "median"),
            p95_ratio_abs=("ratio_abs_return", lambda s: s.quantile(0.95)),
            median_ratio_mae=("ratio_mae", "median"),
            p95_ratio_mae=("ratio_mae", lambda s: s.quantile(0.95)),
        )
        .round(3)
    )
    subsection("Realized vs VIX-implied 10-min vol by regime")
    print(summary.to_string())
    return summary


def straddle_simulation(frame: pd.DataFrame) -> pd.DataFrame:
    """
    Simulate a naive "buy ATM straddle at 15:50, hold to close" strategy.
    P&L in bps of underlying per trade.
    """
    by_bucket = (
        frame.groupby("vix_bucket", observed=True)
        .agg(
            n=("straddle_pnl_bps", "count"),
            median_cost=("straddle_cost_bps", "median"),
            mean_pnl=("straddle_pnl_bps", "mean"),
            median_pnl=("straddle_pnl_bps", "median"),
            std_pnl=("straddle_pnl_bps", "std"),
            win_rate=("straddle_won", "mean"),
            p95_pnl=("straddle_pnl_bps", lambda s: s.quantile(0.95)),
            best_day=("straddle_pnl_bps", "max"),
            worst_day=("straddle_pnl_bps", "min"),
        )
        .round(2)
    )
    # Sharpe-like ratio on per-trade P&L.
    by_bucket["sharpe_per_trade"] = (
        by_bucket["mean_pnl"] / by_bucket["std_pnl"]
    ).round(3)

    subsection("Simulated ATM straddle P&L (bps per trade) by regime")
    print(by_bucket.to_string())

    overall_mean = frame["straddle_pnl_bps"].mean()
    overall_winrate = frame["straddle_won"].mean()
    print(
        f"\n  Overall mean P&L = {overall_mean:+.2f} bps / trade   "
        f"win rate = {overall_winrate:.1%}"
    )
    return by_bucket


# ── Plots ────────────────────────────────────────────────────


def plot_vol_premium(frame: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    buckets = [b[0] for b in VIX_BUCKETS]
    data = [
        frame[frame["vix_bucket"] == b]["ratio_abs_return"].clip(upper=15)
        for b in buckets
    ]
    bp = ax.boxplot(data, tick_labels=buckets, patch_artist=True, showfliers=False)
    colors = ["#55a868", "#4c72b0", "#dd8452", "#c44e52"]
    for patch, color in zip(bp["boxes"], colors):
        patch.set_facecolor(color)
        patch.set_alpha(0.75)
    ax.axhline(1.0, color="black", linestyle="--", linewidth=1)
    ax.set_ylabel("|realized return| / implied sigma_10min")
    ax.set_title(
        "Realized / Implied move ratio by VIX regime\n"
        "(>1 = options underpriced the move; <1 = options correctly priced it)"
    )
    # Annotate median ratio under each bucket.
    for i, b in enumerate(buckets, start=1):
        m = frame[frame["vix_bucket"] == b]["ratio_abs_return"].median()
        ax.annotate(
            f"median\n{m:.2f}",
            xy=(i, 0),
            xytext=(0, -25),
            textcoords="offset points",
            ha="center",
            fontsize=9,
            color="gray",
        )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "12_vol_premium_by_bucket.png")
    plt.close(fig)


def plot_straddle_pnl(frame: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    buckets = [b[0] for b in VIX_BUCKETS]
    data = [
        frame[frame["vix_bucket"] == b]["straddle_pnl_bps"] for b in buckets
    ]
    bp = ax.boxplot(data, tick_labels=buckets, patch_artist=True, showfliers=True)
    colors = ["#55a868", "#4c72b0", "#dd8452", "#c44e52"]
    for patch, color in zip(bp["boxes"], colors):
        patch.set_facecolor(color)
        patch.set_alpha(0.75)
    ax.axhline(0.0, color="black", linestyle="--", linewidth=1)
    ax.set_ylabel("P&L (bps of underlying per trade)")
    ax.set_title(
        "Simulated ATM straddle P&L — entry 15:50, hold to 16:00\n"
        "(zero line = break-even; positive median = vol is cheap)"
    )
    for i, b in enumerate(buckets, start=1):
        m = frame[frame["vix_bucket"] == b]["straddle_pnl_bps"].mean()
        ax.annotate(
            f"mean\n{m:+.1f}",
            xy=(i, 0),
            xytext=(0, 10),
            textcoords="offset points",
            ha="center",
            fontsize=9,
            color="black",
        )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "13_straddle_pnl_by_bucket.png")
    plt.close(fig)


def plot_cumulative_equity(frame: pd.DataFrame) -> None:
    """
    Equity curve of a daily straddle trader. One trade per session, bps
    of notional. Cumulative sum by bucket shows where the edge lives
    through time.
    """
    frame = frame.sort_index()
    fig, ax = plt.subplots(figsize=(11, 6))
    colors = {
        "Calm (<15)": "#55a868",
        "Normal (15-20)": "#4c72b0",
        "Elevated (20-30)": "#dd8452",
        "Stress (>30)": "#c44e52",
    }
    for bucket, color in colors.items():
        bdata = frame[frame["vix_bucket"] == bucket]["straddle_pnl_bps"]
        if bdata.empty:
            continue
        cumulative = bdata.cumsum()
        ax.plot(cumulative.index, cumulative.values, color=color, label=bucket, linewidth=1.5)

    # Overall (all days, regardless of bucket).
    all_cum = frame["straddle_pnl_bps"].cumsum()
    ax.plot(all_cum.index, all_cum.values, color="black", linestyle="--",
            alpha=0.7, label="All days", linewidth=1)

    ax.axhline(0.0, color="black", linewidth=0.5)
    ax.set_ylabel("Cumulative P&L (bps of underlying)")
    ax.set_title(
        "Equity curve — naive daily MOC straddle by VIX regime\n"
        "(up = buying vol was cheap on average in that regime)"
    )
    ax.legend(loc="upper left")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "14_cumulative_straddle.png")
    plt.close(fig)


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    section("MOC — Phase 4 (Tier 0): Realized vs VIX-implied vol premium")
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    joined = load_joined()
    joined = assign_bucket(joined)
    joined = add_vol_metrics(joined)

    summary_by_bucket(joined)
    straddle_simulation(joined)

    plot_vol_premium(joined)
    plot_straddle_pnl(joined)
    plot_cumulative_equity(joined)

    takeaway(
        "3 plots in plots/moc/. KEY CELLS to read:\n"
        "   - Stress bucket mean straddle P&L: if > +3 bps, Tier 1 is worth "
        "pulling options data for. If negative, the edge isn't there.\n"
        "   - median_ratio_abs across buckets: if it rises with VIX regime, "
        "the market underprices tail days. If it's flat or decreasing, the "
        "market prices regimes correctly and there's no retail edge."
    )


if __name__ == "__main__":
    main()
