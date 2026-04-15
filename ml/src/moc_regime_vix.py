"""
MOC Imbalance — Phase 3: VIX Regime Split

The Phase 2 EDA showed that MOC imbalance is only a weak predictor of
QQQ last-10-min chaos (all raw correlations r < 0.25). The annual
breakdown, however, showed that *volatility regime* is a huge driver:
2020 and 2022 had ~2x the tail MAE of 2019 and 2023.

This phase asks the conditional question:

    "Does MOC imbalance predict chaos BETTER on high-VIX days than
    on low-VIX days?"

If yes, you've got a conditional rule ("watch imbalance only when VIX
is elevated"). If no, the hypothesis is fully dead and the simple
VIX-only rule is the right protective mechanism.

Approach:
  1. Pull daily VIX close from yfinance (free, cached to parquet).
  2. Join to the per-day QQQ features on trade_date.
  3. Bucket days into VIX regimes: Calm / Normal / Elevated / Stress
     (cutoffs at 15 / 20 / 30 by VIX close).
  4. Per-bucket summary: n, median MAE, p95 MAE, p95 range.
  5. Per-bucket conditional correlations (|imbalance| vs MAE).
  6. Plots:
       - Bar chart of p95 MAE by VIX bucket (shows vol-regime effect)
       - Scatter of |imbalance| vs MAE, colored by VIX bucket
         (shows whether imbalance-chaos relationship differs by regime)
       - Annual p95 MAE overlaid with annual mean VIX
         (shows how tightly the vol regime drives the tail)

Usage:
    ml/.venv/bin/python ml/src/moc_regime_vix.py

Requires: yfinance, pandas, numpy, matplotlib, seaborn, scipy
"""

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
    print("  ml/.venv/bin/pip install yfinance matplotlib seaborn scipy")
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

sns.set_theme(style="darkgrid", context="notebook")
plt.rcParams.update({"figure.dpi": 110, "savefig.dpi": 140})


# ── Data loading ─────────────────────────────────────────────


def load_features() -> pd.DataFrame:
    if not FEATURES_PATH.exists():
        print(f"ERROR: {FEATURES_PATH} not found. Run moc_features.py first.")
        sys.exit(1)
    frame = pd.read_parquet(FEATURES_PATH)
    print(f"  Loaded {len(frame):,} feature-days")
    return frame


def load_vix_daily() -> pd.DataFrame:
    """Fetch VIX daily close from yfinance, cached to parquet."""
    if VIX_CACHE.exists():
        print(f"  Loading VIX cache: {VIX_CACHE.name}")
        return pd.read_parquet(VIX_CACHE)

    print("  Fetching ^VIX from yfinance (2018-01-01 -> 2026-04-15) ...")
    vix = yf.download(
        "^VIX",
        start="2018-01-01",
        end="2026-04-15",
        progress=False,
        auto_adjust=False,
    )
    # yfinance returns multi-level columns in newer versions; flatten.
    if isinstance(vix.columns, pd.MultiIndex):
        vix.columns = vix.columns.get_level_values(0)
    vix = vix[["Close"]].rename(columns={"Close": "vix_close"})
    vix.index = pd.to_datetime(vix.index).tz_localize(None)
    vix.index.name = "trade_date"

    VIX_CACHE.parent.mkdir(parents=True, exist_ok=True)
    vix.to_parquet(VIX_CACHE)
    print(f"  Cached {len(vix):,} VIX days -> {VIX_CACHE.name}")
    return vix


def join_vix(features: pd.DataFrame, vix: pd.DataFrame) -> pd.DataFrame:
    """Join VIX close to features on trade_date."""
    features = features.copy()
    features.index = pd.to_datetime(features.index).tz_localize(None)
    joined = features.join(vix, how="left")
    missing = joined["vix_close"].isna().sum()
    if missing:
        print(f"  WARN: {missing} feature-days have no VIX match (likely holidays)")
    joined = joined.dropna(subset=["vix_close", "T50_signed_imbalance", "realized_mae_down_bps"])
    print(f"  Joined: {len(joined):,} days with full data")
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


# ── Analyses ─────────────────────────────────────────────────


def summary_by_bucket(frame: pd.DataFrame) -> pd.DataFrame:
    summary = (
        frame.groupby("vix_bucket", observed=True)
        .agg(
            n=("realized_mae_down_bps", "count"),
            median_vix=("vix_close", "median"),
            median_mae=("realized_mae_down_bps", "median"),
            p95_mae=("realized_mae_down_bps", lambda s: s.quantile(0.95)),
            p99_mae=("realized_mae_down_bps", lambda s: s.quantile(0.99)),
            p95_range=("realized_range_bps", lambda s: s.quantile(0.95)),
        )
        .round(2)
    )
    subsection("MAE & range distribution by VIX regime")
    print(summary.to_string())
    return summary


def conditional_correlations(frame: pd.DataFrame) -> pd.DataFrame:
    """
    Pearson & Spearman correlations of |imbalance| vs MAE/range, computed
    separately within each VIX bucket. If the signal exists *only* in
    high-VIX regimes, this table will show it.
    """
    rows = []
    for bucket, grp in frame.groupby("vix_bucket", observed=True):
        x = grp["T50_signed_imbalance"].abs()
        for target in ["realized_mae_down_bps", "realized_range_bps", "realized_return_bps"]:
            y = grp[target]
            mask = x.notna() & y.notna()
            if mask.sum() < 20:
                pearson = spearman = np.nan
            else:
                # For return we want SIGNED imbalance, not absolute — fix for
                # the directional-prediction case.
                x_signed = grp["T50_signed_imbalance"] if target == "realized_return_bps" else x
                pearson, _ = stats.pearsonr(x_signed[mask], y[mask])
                spearman, _ = stats.spearmanr(x_signed[mask], y[mask])
            rows.append(
                {
                    "vix_bucket": bucket,
                    "target": target,
                    "n": int(mask.sum()),
                    "pearson": round(pearson, 3),
                    "spearman": round(spearman, 3),
                }
            )
    table = pd.DataFrame(rows)
    subsection("Conditional correlations — |imbalance_T50| by VIX regime")
    print(table.to_string(index=False))
    return table


# ── Plots ────────────────────────────────────────────────────


def plot_tails_by_bucket(summary: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    x = np.arange(len(summary))
    width = 0.28
    ax.bar(x - width, summary["median_mae"], width, label="median MAE", color="#55a868")
    ax.bar(x, summary["p95_mae"], width, label="95th-pct MAE", color="#4c72b0")
    ax.bar(x + width, summary["p99_mae"], width, label="99th-pct MAE", color="#c44e52")
    ax.set_xticks(x)
    ax.set_xticklabels(summary.index, rotation=15)
    ax.set_ylabel("bps")
    ax.set_title(
        "QQQ last-10-min MAE by VIX regime — does vol regime drive tail risk?"
    )
    ax.legend()
    # Annotate bar heights with n for context.
    for i, n in enumerate(summary["n"]):
        ax.annotate(f"n={n}", xy=(i, 0), xytext=(0, -20),
                    textcoords="offset points", ha="center", fontsize=9, color="gray")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "9_tails_by_vix_bucket.png")
    plt.close(fig)


def plot_scatter_colored_by_bucket(frame: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    colors = {
        "Calm (<15)": "#55a868",
        "Normal (15-20)": "#4c72b0",
        "Elevated (20-30)": "#dd8452",
        "Stress (>30)": "#c44e52",
    }
    abs_imb = frame["T50_signed_imbalance"].abs().replace(0, np.nan)
    x_log = np.log10(abs_imb.clip(lower=1))
    for bucket, color in colors.items():
        mask = (frame["vix_bucket"] == bucket) & x_log.notna()
        ax.scatter(
            x_log[mask],
            frame.loc[mask, "realized_mae_down_bps"],
            s=12,
            alpha=0.5,
            c=color,
            label=f"{bucket} (n={mask.sum()})",
        )
    ax.set_xlabel("log10( |signed_imbalance_T50| )")
    ax.set_ylabel("realized_mae_down_bps")
    ax.set_title(
        "|imbalance| vs MAE, colored by VIX regime — does the relationship differ?"
    )
    # Clip outliers for readability.
    ax.set_ylim(0, frame["realized_mae_down_bps"].quantile(0.99))
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "10_scatter_by_vix_bucket.png")
    plt.close(fig)


def plot_annual_vix_overlay(frame: pd.DataFrame) -> None:
    annual = frame.groupby(frame.index.year).agg(
        p95_mae=("realized_mae_down_bps", lambda s: s.quantile(0.95)),
        median_vix=("vix_close", "median"),
        max_vix=("vix_close", "max"),
    )
    fig, ax_mae = plt.subplots(figsize=(11, 5))
    ax_vix = ax_mae.twinx()

    ax_mae.bar(annual.index, annual["p95_mae"], color="#4c72b0", alpha=0.6, label="95th-pct MAE")
    ax_vix.plot(annual.index, annual["median_vix"], "-o", color="#c44e52", label="median VIX")
    ax_vix.plot(annual.index, annual["max_vix"], "--o", color="#c44e52", alpha=0.5, label="max VIX")
    ax_mae.set_xlabel("Year")
    ax_mae.set_ylabel("p95 MAE (bps)", color="#4c72b0")
    ax_vix.set_ylabel("VIX level", color="#c44e52")
    ax_mae.set_title("Annual p95 MAE vs VIX level — visual correlation check")

    # Legend for both axes
    h1, l1 = ax_mae.get_legend_handles_labels()
    h2, l2 = ax_vix.get_legend_handles_labels()
    ax_mae.legend(h1 + h2, l1 + l2, loc="upper left")

    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "11_annual_vix_overlay.png")
    plt.close(fig)


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    section("MOC Imbalance — Phase 3: VIX Regime Split")
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    features = load_features()
    vix = load_vix_daily()
    joined = join_vix(features, vix)
    joined = assign_bucket(joined)

    summary = summary_by_bucket(joined)
    conditional_correlations(joined)

    # Also report the headline VIX-vs-tail correlation — this is the
    # "simple VIX-only rule" evidence.
    subsection("VIX-only predictive power (day-of VIX close vs realized MAE)")
    p, _ = stats.pearsonr(joined["vix_close"], joined["realized_mae_down_bps"])
    s, _ = stats.spearmanr(joined["vix_close"], joined["realized_mae_down_bps"])
    print(f"  Pearson r (vix_close -> mae_down_bps) = {p:+.3f}")
    print(f"  Spearman r                             = {s:+.3f}")

    plot_tails_by_bucket(summary)
    plot_scatter_colored_by_bucket(joined)
    plot_annual_vix_overlay(joined)

    takeaway(
        "Wrote 3 plots -> plots/moc/. Look at the conditional-correlation "
        "table: if the high-VIX row shows r > 0.3 for imbalance vs MAE, you "
        "have a conditional rule. If it's flat like the aggregate, the "
        "VIX-only rule is the right answer and imbalance is noise."
    )


if __name__ == "__main__":
    main()
