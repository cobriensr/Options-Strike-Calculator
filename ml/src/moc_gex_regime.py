"""
MOC Imbalance — Phase 5: Does SPX dealer net-gamma improve on VIX alone?

Uses a UW 1-year SPX GEX export (daily aggregated: call_gex, put_gex,
net_gex, put_call_gex_ratio) to test whether the gamma regime adds
predictive power BEYOND the VIX regime we already gate on.

Data shape caveat: this CSV is DAILY AGGREGATED, not strike-level, so it
cannot test pin-riding (which needs the max-gamma strike). It CAN test:

  1. Does net_gex sign (long- vs short-gamma regime) predict SPX daily
     range / absolute return independent of VIX?
  2. Does net_gex magnitude scale tail risk above/beyond VIX?
  3. Does put_call_gex_ratio predict directional skew?

If any of these show material signal, the VIX-only gating banner we
shipped could be upgraded to a VIX+GEX gating rule.

Targets (daily SPX, from yfinance):
  - daily_range_bps  = (High - Low) / Open * 10_000
  - daily_abs_return_bps = |Close - Open| / Open * 10_000
  - daily_return_bps     = (Close - Open) / Open * 10_000 (signed)

Secondary: we also join QQQ last-10-min MAE from the earlier phases,
since that's the original protective-rule target. SPX-GEX predicting
QQQ MAE is a meaningful bonus test — not perfect (SPX vs NDX composition
differs) but useful cross-validation.

Usage:
    ml/.venv/bin/python ml/src/moc_gex_regime.py \\
        --gex-csv ~/Downloads/order-23f990ec-ca61-4282-ab33-24cbb75c2bd6/gamma_exposure/1y/2025-04-15-through-2026-04-14/SPX.csv
"""

import argparse
import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns
    import yfinance as yf
    from scipy import stats
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install yfinance matplotlib seaborn scipy pandas")
    sys.exit(1)

from utils import ML_ROOT, section, subsection, takeaway


PLOTS_DIR = ML_ROOT / "plots" / "moc"
FEATURES_PATH = ML_ROOT / "data" / "moc_features_qqq.parquet"
VIX_CACHE = ML_ROOT / "data" / "vix_daily.parquet"
SPX_CACHE = ML_ROOT / "data" / "spx_daily.parquet"

VIX_BUCKETS = [
    ("Calm (<15)", 0, 15),
    ("Normal (15-20)", 15, 20),
    ("Elevated (20-30)", 20, 30),
    ("Stress (>30)", 30, 200),
]

sns.set_theme(style="darkgrid", context="notebook")
plt.rcParams.update({"figure.dpi": 110, "savefig.dpi": 140})


# ── Args ─────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gex-csv",
        type=Path,
        required=True,
        help="UW SPX GEX CSV (daily aggregated)",
    )
    return parser.parse_args()


# ── Loaders ──────────────────────────────────────────────────


def load_gex(path: Path) -> pd.DataFrame:
    if not path.exists():
        print(f"ERROR: GEX CSV not found: {path}")
        sys.exit(1)
    frame = pd.read_csv(path, parse_dates=["date"])
    frame = frame.set_index("date").sort_index()
    # Normalize to tz-naive so joins work with yfinance output.
    frame.index = frame.index.tz_localize(None)
    print(f"  GEX: {len(frame):,} days from {frame.index.min().date()} -> {frame.index.max().date()}")
    print(f"  Columns: {list(frame.columns)}")
    return frame


def load_spx_daily(start: str, end: str) -> pd.DataFrame:
    """Fetch SPX daily OHLC (^GSPC) from yfinance, cached."""
    if SPX_CACHE.exists():
        print(f"  Loading SPX cache: {SPX_CACHE.name}")
        cached = pd.read_parquet(SPX_CACHE)
        # Extend cache if date range is insufficient.
        if cached.index.min() <= pd.Timestamp(start) and cached.index.max() >= pd.Timestamp(end):
            return cached
        print("  Cache range insufficient, refetching...")

    print(f"  Fetching ^GSPC from yfinance ({start} -> {end}) ...")
    spx = yf.download("^GSPC", start=start, end=end, progress=False, auto_adjust=False)
    if isinstance(spx.columns, pd.MultiIndex):
        spx.columns = spx.columns.get_level_values(0)
    spx = spx[["Open", "High", "Low", "Close"]].rename(
        columns={"Open": "spx_open", "High": "spx_high", "Low": "spx_low", "Close": "spx_close"}
    )
    spx.index = pd.to_datetime(spx.index).tz_localize(None)
    spx.index.name = "date"
    SPX_CACHE.parent.mkdir(parents=True, exist_ok=True)
    spx.to_parquet(SPX_CACHE)
    print(f"  Cached {len(spx):,} SPX days -> {SPX_CACHE.name}")
    return spx


def load_vix() -> pd.DataFrame:
    if not VIX_CACHE.exists():
        print(f"ERROR: {VIX_CACHE} missing. Run moc_regime_vix.py first to populate VIX cache.")
        sys.exit(1)
    return pd.read_parquet(VIX_CACHE)


def load_qqq_mae() -> pd.DataFrame:
    """Optional join — QQQ last-10-min realized MAE from earlier phases."""
    if not FEATURES_PATH.exists():
        return pd.DataFrame()
    frame = pd.read_parquet(FEATURES_PATH)[["realized_mae_down_bps", "realized_range_bps"]]
    frame = frame.rename(
        columns={
            "realized_mae_down_bps": "qqq_mae_10min_bps",
            "realized_range_bps": "qqq_range_10min_bps",
        }
    )
    frame.index = pd.to_datetime(frame.index).tz_localize(None)
    return frame


# ── Derivations ──────────────────────────────────────────────


def build_joined(gex: pd.DataFrame, spx: pd.DataFrame, vix: pd.DataFrame, qqq: pd.DataFrame) -> pd.DataFrame:
    # CRITICAL: UW confirmed the GEX CSV is end-of-day only, so same-day
    # correlations are contaminated (the EOD snapshot partially reflects
    # the day's own move). Shift the GEX series forward by 1 trading day
    # so "yesterday's EOD GEX" predicts "today's range" — the real-world
    # tradeable scenario.
    #
    # We align on SPX trading days: reindex GEX onto SPX dates, then shift
    # by one ROW (one trading day), which correctly skips weekends/holidays.
    gex_aligned = gex.reindex(spx.index).shift(1)

    joined = spx.join(gex_aligned, how="inner").join(vix, how="left")
    if not qqq.empty:
        joined = joined.join(qqq, how="left")

    # Daily SPX volatility measures (bps of open).
    joined["spx_range_bps"] = (joined["spx_high"] - joined["spx_low"]) / joined["spx_open"] * 10_000
    joined["spx_abs_return_bps"] = (joined["spx_close"] - joined["spx_open"]).abs() / joined["spx_open"] * 10_000
    joined["spx_return_bps"] = (joined["spx_close"] - joined["spx_open"]) / joined["spx_open"] * 10_000

    # GEX-derived regime features.
    joined["gex_sign"] = np.where(joined["net_gex"] >= 0, "long_gamma", "short_gamma")
    joined["gex_abs"] = joined["net_gex"].abs()

    # VIX bucket for stratification.
    labels = []
    for v in joined["vix_close"]:
        if pd.isna(v):
            labels.append(None)
            continue
        for label, lo, hi in VIX_BUCKETS:
            if lo <= v < hi:
                labels.append(label)
                break
        else:
            labels.append("Stress (>30)")
    joined["vix_bucket"] = pd.Categorical(
        labels,
        categories=[b[0] for b in VIX_BUCKETS],
        ordered=True,
    )

    # Drop rows missing core targets.
    joined = joined.dropna(subset=["net_gex", "spx_range_bps", "vix_close"])
    print(f"  Joined: {len(joined):,} days with GEX + SPX + VIX")
    return joined


# ── Analyses ─────────────────────────────────────────────────


def summary_by_gex_sign(frame: pd.DataFrame) -> None:
    subsection("SPX daily range by gamma regime (both signs, all VIX)")
    summary = (
        frame.groupby("gex_sign", observed=True)
        .agg(
            n=("net_gex", "count"),
            median_vix=("vix_close", "median"),
            median_range=("spx_range_bps", "median"),
            p95_range=("spx_range_bps", lambda s: s.quantile(0.95)),
            median_abs_return=("spx_abs_return_bps", "median"),
            p95_abs_return=("spx_abs_return_bps", lambda s: s.quantile(0.95)),
        )
        .round(2)
    )
    print(summary.to_string())


def summary_by_vix_and_gex(frame: pd.DataFrame) -> None:
    subsection("SPX daily range by (VIX bucket x gamma sign)")
    summary = (
        frame.groupby(["vix_bucket", "gex_sign"], observed=True)
        .agg(
            n=("net_gex", "count"),
            median_range=("spx_range_bps", "median"),
            p95_range=("spx_range_bps", lambda s: s.quantile(0.95)),
            median_abs_return=("spx_abs_return_bps", "median"),
        )
        .round(2)
    )
    print(summary.to_string())


def correlations(frame: pd.DataFrame) -> None:
    subsection("Correlations — GEX features vs SPX targets")
    targets = ["spx_range_bps", "spx_abs_return_bps", "spx_return_bps"]
    if "qqq_mae_10min_bps" in frame.columns:
        targets.append("qqq_mae_10min_bps")
    features = ["net_gex", "gex_abs", "call_gex", "put_gex", "put_call_gex_ratio", "vix_close"]

    rows = []
    for f in features:
        row = {"feature": f}
        for t in targets:
            mask = frame[f].notna() & frame[t].notna()
            if mask.sum() < 20:
                row[t] = np.nan
                continue
            p, _ = stats.pearsonr(frame.loc[mask, f], frame.loc[mask, t])
            row[t] = round(p, 3)
        rows.append(row)
    print(pd.DataFrame(rows).to_string(index=False))


def directional_skew(frame: pd.DataFrame) -> None:
    subsection("put_call_gex_ratio vs directional return (directional skew test)")
    x = frame["put_call_gex_ratio"]
    y = frame["spx_return_bps"]
    mask = x.notna() & y.notna()
    p, pp = stats.pearsonr(x[mask], y[mask])
    s, sp = stats.spearmanr(x[mask], y[mask])
    # Also bucket: does ratio > 1 predict negative return?
    high_put = frame[x > 1]["spx_return_bps"]
    low_put = frame[x <= 1]["spx_return_bps"]
    print(f"  Pearson r  = {p:+.3f} (p={pp:.3f})")
    print(f"  Spearman r = {s:+.3f} (p={sp:.3f})")
    print(f"  Mean SPX return when put_call_ratio > 1 (n={len(high_put)}): {high_put.mean():+.1f} bps")
    print(f"  Mean SPX return when put_call_ratio <= 1 (n={len(low_put)}): {low_put.mean():+.1f} bps")
    print(f"  Difference: {(high_put.mean() - low_put.mean()):+.1f} bps")


def incremental_r2(frame: pd.DataFrame) -> None:
    """Does net_gex add predictive power BEYOND VIX for SPX range?"""
    subsection("Incremental R^2: net_gex on top of VIX")
    from sklearn.linear_model import LinearRegression

    valid = frame.dropna(subset=["vix_close", "net_gex", "spx_range_bps"])
    y = valid["spx_range_bps"].to_numpy()

    X_vix = valid[["vix_close"]].to_numpy()
    X_both = valid[["vix_close", "net_gex", "gex_abs"]].to_numpy()

    r2_vix = LinearRegression().fit(X_vix, y).score(X_vix, y)
    r2_both = LinearRegression().fit(X_both, y).score(X_both, y)

    print(f"  R^2 with VIX only:             {r2_vix:.4f}")
    print(f"  R^2 with VIX + net_gex + |gex|: {r2_both:.4f}")
    print(f"  Incremental R^2 from GEX:       {r2_both - r2_vix:+.4f}")
    if r2_both - r2_vix > 0.02:
        print("  --> GEX meaningfully improves on VIX alone.")
    elif r2_both - r2_vix > 0.005:
        print("  --> GEX adds marginal signal.")
    else:
        print("  --> GEX adds essentially nothing on top of VIX.")


# ── Plots ────────────────────────────────────────────────────


def plot_range_by_vix_gamma(frame: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    buckets = [b[0] for b in VIX_BUCKETS if (frame["vix_bucket"] == b[0]).any()]
    colors = {"long_gamma": "#55a868", "short_gamma": "#c44e52"}

    x_base = np.arange(len(buckets))
    width = 0.38
    for i, sign in enumerate(("long_gamma", "short_gamma")):
        medians = []
        counts = []
        for b in buckets:
            subset = frame[(frame["vix_bucket"] == b) & (frame["gex_sign"] == sign)]
            medians.append(subset["spx_range_bps"].median() if len(subset) else 0)
            counts.append(len(subset))
        offset = (i - 0.5) * width
        ax.bar(
            x_base + offset,
            medians,
            width,
            color=colors[sign],
            alpha=0.8,
            label=sign.replace("_", " "),
        )
        for j, (m, c) in enumerate(zip(medians, counts)):
            ax.annotate(f"n={c}", xy=(x_base[j] + offset, m), xytext=(0, 3),
                        textcoords="offset points", ha="center", fontsize=8, color="gray")

    ax.set_xticks(x_base)
    ax.set_xticklabels(buckets)
    ax.set_ylabel("median SPX daily range (bps of open)")
    ax.set_title("Does gamma regime split within each VIX bucket?\n(gap between bars = GEX is adding regime info on top of VIX)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "15_spx_range_by_vix_gamma.png")
    plt.close(fig)


def plot_scatter(frame: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    # Net GEX on x, SPX range on y, colored by VIX bucket.
    colors = {
        "Calm (<15)": "#55a868",
        "Normal (15-20)": "#4c72b0",
        "Elevated (20-30)": "#dd8452",
        "Stress (>30)": "#c44e52",
    }
    for bucket, color in colors.items():
        subset = frame[frame["vix_bucket"] == bucket]
        if subset.empty:
            continue
        ax.scatter(
            subset["net_gex"],
            subset["spx_range_bps"],
            s=25,
            alpha=0.7,
            c=color,
            label=f"{bucket} (n={len(subset)})",
        )
    ax.axvline(0, color="black", linewidth=0.5, linestyle="--")
    ax.set_xlabel("net_gex (UW daily aggregated)")
    ax.set_ylabel("SPX daily range (bps of open)")
    ax.set_title("net_gex vs SPX daily range, colored by VIX regime")
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "16_netgex_vs_spx_range.png")
    plt.close(fig)


def plot_putcall_direction(frame: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    x = frame["put_call_gex_ratio"]
    y = frame["spx_return_bps"]
    mask = x.notna() & y.notna()
    colors = np.where(y[mask] >= 0, "#55a868", "#c44e52")
    ax.scatter(x[mask], y[mask], s=25, alpha=0.6, c=colors)
    ax.axhline(0, color="black", linewidth=0.5)
    ax.axvline(1.0, color="black", linewidth=0.5, linestyle="--")
    ax.set_xlabel("put_call_gex_ratio  (>1 = puts dominate)")
    ax.set_ylabel("SPX same-day return (bps of open)")
    ax.set_title("Does put-heavy gamma book predict downside returns?")
    # Annotate subset means.
    high_mean = frame[frame["put_call_gex_ratio"] > 1]["spx_return_bps"].mean()
    low_mean = frame[frame["put_call_gex_ratio"] <= 1]["spx_return_bps"].mean()
    ax.text(
        0.98, 0.95,
        f"mean when ratio > 1:  {high_mean:+.1f} bps\n"
        f"mean when ratio <= 1: {low_mean:+.1f} bps",
        transform=ax.transAxes, ha="right", va="top",
        bbox={"facecolor": "white", "alpha": 0.85, "edgecolor": "none"},
        fontsize=10,
    )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "17_putcall_ratio_vs_return.png")
    plt.close(fig)


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    args = parse_args()
    section("MOC — Phase 5: SPX GEX regime vs VIX alone")
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    gex = load_gex(args.gex_csv)
    start = (gex.index.min() - pd.Timedelta(days=5)).strftime("%Y-%m-%d")
    end = (gex.index.max() + pd.Timedelta(days=2)).strftime("%Y-%m-%d")
    spx = load_spx_daily(start, end)
    vix = load_vix()
    qqq = load_qqq_mae()

    joined = build_joined(gex, spx, vix, qqq)

    summary_by_gex_sign(joined)
    summary_by_vix_and_gex(joined)
    correlations(joined)
    directional_skew(joined)
    incremental_r2(joined)

    plot_range_by_vix_gamma(joined)
    plot_scatter(joined)
    plot_putcall_direction(joined)

    takeaway(
        "3 plots in plots/moc/. KEY CELLS:\n"
        "   - Incremental R^2: if > 0.02, GEX meaningfully augments VIX and the\n"
        "     banner rule should be updated to a two-variable gate.\n"
        "   - Summary by (VIX x gex_sign): if short_gamma has materially higher\n"
        "     range than long_gamma WITHIN each VIX bucket, the regime split\n"
        "     is real and actionable.\n"
        "   - put_call ratio: if |difference| > 20 bps between ratio>1 and\n"
        "     ratio<=1, put/call skew carries directional info."
    )


if __name__ == "__main__":
    main()
