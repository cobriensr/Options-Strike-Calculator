"""
MOC Imbalance — Phase 2: Exploratory Data Analysis

Answers the research question: given the QQQ MOC imbalance state at 15:50 ET,
does it predict last-10-minute price behavior cleanly enough to be a trading
signal?

Produces 8 plots in ml/plots/moc/:

  1. targets_distributions.png
     Histograms of return, MFE, MAE, and range. Shows the "shape of the
     problem" and highlights the fat-tail days (the ones that kill iron flies).

  2. size_predicts_chaos.png
     Scatter of |signed_imbalance_T50| vs realized_range_bps. The core
     "does imbalance size predict intraday chaos" question. Includes OLS
     trendline, R^2, Pearson/Spearman correlation.

  3. direction_scatter.png
     Scatter of signed_imbalance_T50 (with sign) vs realized_return_bps.
     Tests whether the *direction* of the imbalance predicts the direction
     of the move. Overlaid with sign-agreement stats.

  4. delta_predicts_direction.png
     Scatter of imbalance_delta_50_to_55 (growth between snapshots) vs
     realized return. Tests the "growing imbalance = confirmed, fading =
     noise" hypothesis.

  5. decile_binning.png
     Days bucketed into 10 groups by |signed_imbalance_T50|. Each bucket
     shows median MAE and 95th-percentile MAE. If the top decile dwarfs
     the bottom decile, there's a signal. If the buckets are flat,
     there isn't.

  6. side_flip_effect.png
     Boxplot of MAE/range for days where the side flipped between 15:50
     and 15:55 vs days where it stayed stable. A "book in flux" signal.

  7. annual_tail_regimes.png
     Annual 95th-percentile MAE and realized-range to check whether the
     microstructure signal is stable across market regimes (2018 calm,
     2020 COVID, 2022 bear, 2023-26).

  8. threshold_rules.png
     For a grid of |imbalance| thresholds, plot the median and 95th-pct
     MAE of days above the threshold vs below. This is the "close flies
     if imbalance > X" rule visualization.

Also prints to stdout:
  - Correlation matrix (Pearson + Spearman) for key features vs targets.
  - Threshold-rule summary table with counts, medians, tail percentiles,
    and a naive "expected savings" metric.

Usage:
    ml/.venv/bin/python ml/src/moc_eda.py

Requires: pandas, numpy, matplotlib, seaborn, scipy
"""

import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns
    from scipy import stats
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install matplotlib seaborn scipy")
    sys.exit(1)

from utils import ML_ROOT, section, subsection, takeaway


PLOTS_DIR = ML_ROOT / "plots" / "moc"
DEFAULT_INPUT = ML_ROOT / "data" / "moc_features_qqq.parquet"

# Match the project's dark theme so plots are consistent with the dashboard.
sns.set_theme(style="darkgrid", context="notebook")
plt.rcParams.update(
    {
        "figure.dpi": 110,
        "savefig.dpi": 140,
        "figure.facecolor": "white",
        "axes.facecolor": "#f8f9fb",
    }
)


# ── Load & prep ──────────────────────────────────────────────


def load_features() -> pd.DataFrame:
    if not DEFAULT_INPUT.exists():
        print(f"ERROR: {DEFAULT_INPUT} not found. Run moc_features.py first.")
        sys.exit(1)
    frame = pd.read_parquet(DEFAULT_INPUT)
    print(f"  Loaded {len(frame):,} trading days")
    # Drop rows missing the core feature (can't analyse without it).
    complete = frame.dropna(subset=["T50_signed_imbalance", "realized_mae_down_bps"])
    dropped = len(frame) - len(complete)
    if dropped:
        print(f"  Dropped {dropped} rows missing T50 imbalance or MAE")
    return complete


# ── Plot 1: Target distributions ──────────────────────────────


def plot_target_distributions(frame: pd.DataFrame) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    targets = {
        "realized_return_bps": ("Close-to-close return (bps)", "#4c72b0"),
        "realized_mfe_bps": ("Max favorable excursion (bps)", "#55a868"),
        "realized_mae_down_bps": ("Max adverse excursion — downside (bps)", "#c44e52"),
        "realized_range_bps": ("Intra-window range (bps)", "#8172b2"),
    }
    for ax, (col, (title, color)) in zip(axes.flatten(), targets.items()):
        # Clip the very worst 1% to keep the histogram readable without
        # discarding the fat-tail information — annotate the max on-plot.
        series = frame[col]
        upper = series.quantile(0.99)
        ax.hist(series.clip(upper=upper), bins=60, color=color, edgecolor="white")
        ax.axvline(series.median(), color="black", linestyle="--", linewidth=1)
        ax.set_title(title)
        ax.set_xlabel("bps")
        ax.set_ylabel("days")
        ax.text(
            0.98,
            0.95,
            f"median = {series.median():.1f}\n"
            f"95th pct = {series.quantile(0.95):.1f}\n"
            f"max = {series.max():.1f}",
            transform=ax.transAxes,
            ha="right",
            va="top",
            bbox=dict(facecolor="white", alpha=0.8, edgecolor="none"),
            fontsize=9,
        )
    fig.suptitle("QQQ last-10-min target distributions (15:50 -> 16:00 ET)", fontsize=13)
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "1_targets_distributions.png")
    plt.close(fig)


# ── Plot 2: Size predicts chaos ──────────────────────────────


def plot_size_predicts_chaos(frame: pd.DataFrame) -> None:
    x = frame["T50_signed_imbalance"].abs()
    y = frame["realized_range_bps"]

    # Log-scale x because imbalance spans ~5 orders of magnitude.
    x_log = np.log10(x.replace(0, np.nan).clip(lower=1))
    mask = x_log.notna() & y.notna()

    pearson, p_p = stats.pearsonr(x_log[mask], y[mask])
    spearman, p_s = stats.spearmanr(x_log[mask], y[mask])
    slope, intercept, r, p_r, _ = stats.linregress(x_log[mask], y[mask])

    fig, ax = plt.subplots(figsize=(10, 6))
    ax.scatter(x_log[mask], y[mask], s=8, alpha=0.25, color="#4c72b0")
    xs = np.linspace(x_log[mask].min(), x_log[mask].max(), 100)
    ax.plot(xs, intercept + slope * xs, color="#c44e52", linewidth=2, label="OLS fit")
    ax.set_xlabel("log10( |signed_imbalance_T50|, shares )")
    ax.set_ylabel("realized_range_bps (last 10 min)")
    ax.set_title("Does imbalance size predict intra-window range?")
    ax.set_ylim(0, y.quantile(0.99))  # hide 1% tail so trend is visible
    ax.legend(loc="upper left")
    ax.text(
        0.98,
        0.95,
        f"Pearson r = {pearson:.3f} (p={p_p:.2e})\n"
        f"Spearman r = {spearman:.3f} (p={p_s:.2e})\n"
        f"R^2 = {r**2:.3f}\nn = {mask.sum():,}",
        transform=ax.transAxes,
        ha="right",
        va="top",
        bbox=dict(facecolor="white", alpha=0.85, edgecolor="none"),
        fontsize=10,
    )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "2_size_predicts_chaos.png")
    plt.close(fig)

    subsection("Plot 2 — size vs range")
    print(f"  Pearson r = {pearson:+.3f}   Spearman r = {spearman:+.3f}   R^2 = {r**2:.3f}")


# ── Plot 3: Direction ────────────────────────────────────────


def plot_direction_scatter(frame: pd.DataFrame) -> None:
    x = frame["T50_signed_imbalance"]
    y = frame["realized_return_bps"]

    # Sign-agreement rate: of days with non-zero imbalance AND non-zero return,
    # how often do the signs agree?
    mask = (x != 0) & (y != 0)
    sign_agree = (np.sign(x[mask]) == np.sign(y[mask])).mean()

    pearson, _ = stats.pearsonr(x[mask], y[mask])
    spearman, _ = stats.spearmanr(x[mask], y[mask])

    fig, ax = plt.subplots(figsize=(10, 6))
    colors = np.where(np.sign(x) == np.sign(y), "#55a868", "#c44e52")
    ax.scatter(x, y, s=10, alpha=0.4, c=colors)
    ax.axhline(0, color="black", linewidth=0.5)
    ax.axvline(0, color="black", linewidth=0.5)
    ax.set_xlabel("signed_imbalance_T50 (shares, +buy / -sell)")
    ax.set_ylabel("realized_return_bps (close-to-close)")
    ax.set_title("Does directional imbalance predict directional move?")
    # Clip scatter axes to 99th pct for readability.
    ax.set_xlim(x.quantile(0.01), x.quantile(0.99))
    ax.set_ylim(y.quantile(0.01), y.quantile(0.99))
    ax.text(
        0.98,
        0.95,
        f"sign agreement = {sign_agree:.1%}\n"
        f"(50% = random chance)\n"
        f"Pearson r = {pearson:+.3f}\n"
        f"Spearman r = {spearman:+.3f}\nn = {mask.sum():,}",
        transform=ax.transAxes,
        ha="right",
        va="top",
        bbox=dict(facecolor="white", alpha=0.85, edgecolor="none"),
        fontsize=10,
    )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "3_direction_scatter.png")
    plt.close(fig)

    subsection("Plot 3 — directional accuracy")
    print(f"  Sign-agreement rate = {sign_agree:.1%}  (Pearson r = {pearson:+.3f})")


# ── Plot 4: Delta (growth/fade) ──────────────────────────────


def plot_delta_predicts_direction(frame: pd.DataFrame) -> None:
    x = frame["imbalance_delta_50_to_55"]
    y = frame["realized_return_bps"]
    mask = x.notna() & y.notna() & (x != 0) & (y != 0)
    sign_agree = (np.sign(x[mask]) == np.sign(y[mask])).mean()
    pearson, _ = stats.pearsonr(x[mask], y[mask])
    spearman, _ = stats.spearmanr(x[mask], y[mask])

    fig, ax = plt.subplots(figsize=(10, 6))
    colors = np.where(np.sign(x) == np.sign(y), "#55a868", "#c44e52")
    ax.scatter(x, y, s=10, alpha=0.4, c=colors)
    ax.axhline(0, color="black", linewidth=0.5)
    ax.axvline(0, color="black", linewidth=0.5)
    ax.set_xlabel("imbalance_delta_50_to_55 (shares, +growing / -fading)")
    ax.set_ylabel("realized_return_bps")
    ax.set_title(
        "Does the growth/fade of imbalance from 15:50 -> 15:55 predict the close?"
    )
    ax.set_xlim(x.quantile(0.01), x.quantile(0.99))
    ax.set_ylim(y.quantile(0.01), y.quantile(0.99))
    ax.text(
        0.98,
        0.95,
        f"sign agreement = {sign_agree:.1%}\n"
        f"Pearson r = {pearson:+.3f}\n"
        f"Spearman r = {spearman:+.3f}\nn = {mask.sum():,}",
        transform=ax.transAxes,
        ha="right",
        va="top",
        bbox=dict(facecolor="white", alpha=0.85, edgecolor="none"),
        fontsize=10,
    )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "4_delta_predicts_direction.png")
    plt.close(fig)

    subsection("Plot 4 — imbalance growth predicts direction")
    print(f"  Sign-agreement = {sign_agree:.1%}  (Pearson r = {pearson:+.3f})")


# ── Plot 5: Decile binning ───────────────────────────────────


def plot_decile_binning(frame: pd.DataFrame) -> None:
    # Bucket by |T50| imbalance into deciles and compute median + 95th pct MAE.
    abs_imb = frame["T50_signed_imbalance"].abs()
    deciles = pd.qcut(abs_imb, q=10, labels=False, duplicates="drop")
    grouped = (
        frame.assign(decile=deciles)
        .groupby("decile")
        .agg(
            median_abs_imbalance=("T50_signed_imbalance", lambda s: s.abs().median()),
            median_mae=("realized_mae_down_bps", "median"),
            p95_mae=("realized_mae_down_bps", lambda s: s.quantile(0.95)),
            p95_range=("realized_range_bps", lambda s: s.quantile(0.95)),
            median_range=("realized_range_bps", "median"),
            n=("realized_mae_down_bps", "count"),
        )
    )

    fig, ax = plt.subplots(figsize=(11, 6))
    x = grouped.index
    ax.plot(x, grouped["median_mae"], "-o", color="#c44e52", label="median MAE")
    ax.plot(x, grouped["p95_mae"], "-o", color="#4c72b0", label="95th-pct MAE")
    ax.plot(x, grouped["median_range"], "--o", color="#c44e52", alpha=0.4, label="median range")
    ax.plot(x, grouped["p95_range"], "--o", color="#4c72b0", alpha=0.4, label="95th-pct range")
    ax.set_xlabel("|imbalance_T50| decile  (0 = smallest, 9 = largest)")
    ax.set_ylabel("bps")
    ax.set_title("Last-10-min MAE & range by imbalance decile")
    ax.legend()
    for i, row in grouped.iterrows():
        ax.annotate(
            f"{row['median_abs_imbalance']:,.0f}",
            xy=(i, row["p95_mae"]),
            xytext=(0, 6),
            textcoords="offset points",
            ha="center",
            fontsize=8,
            color="#4c72b0",
        )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "5_decile_binning.png")
    plt.close(fig)

    subsection("Plot 5 — decile binning table")
    print(grouped.to_string())


# ── Plot 6: Side-flip effect ─────────────────────────────────


def plot_side_flip_effect(frame: pd.DataFrame) -> None:
    if "side_flipped" not in frame.columns:
        return
    flipped = frame[frame["side_flipped"]]
    stable = frame[~frame["side_flipped"]]

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for ax, col, title in zip(
        axes,
        ["realized_mae_down_bps", "realized_range_bps"],
        ["MAE (bps)", "Range (bps)"],
    ):
        data = [stable[col].dropna(), flipped[col].dropna()]
        bp = ax.boxplot(
            data,
            labels=[f"stable\nn={len(data[0]):,}", f"flipped\nn={len(data[1]):,}"],
            patch_artist=True,
            showfliers=False,
        )
        for patch, color in zip(bp["boxes"], ["#55a868", "#c44e52"]):
            patch.set_facecolor(color)
            patch.set_alpha(0.7)
        ax.set_ylabel(title)
        ax.set_title(f"{title} by side-flip status (outliers hidden)")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "6_side_flip_effect.png")
    plt.close(fig)

    subsection("Plot 6 — side-flip effect")
    for metric in ["realized_mae_down_bps", "realized_range_bps"]:
        s_med = stable[metric].median()
        f_med = flipped[metric].median()
        print(
            f"  {metric:24s}  stable_median={s_med:5.1f}  flipped_median={f_med:5.1f}  "
            f"lift={f_med - s_med:+5.1f} bps"
        )


# ── Plot 7: Annual tail regimes ──────────────────────────────


def plot_annual_tail_regimes(frame: pd.DataFrame) -> None:
    annual = (
        frame.groupby(frame.index.year)
        .agg(
            median_mae=("realized_mae_down_bps", "median"),
            p95_mae=("realized_mae_down_bps", lambda s: s.quantile(0.95)),
            p95_range=("realized_range_bps", lambda s: s.quantile(0.95)),
            n=("realized_mae_down_bps", "count"),
        )
    )
    fig, ax = plt.subplots(figsize=(11, 5))
    ax.plot(annual.index, annual["median_mae"], "-o", color="#c44e52", label="median MAE")
    ax.plot(annual.index, annual["p95_mae"], "-o", color="#4c72b0", label="95th-pct MAE")
    ax.plot(annual.index, annual["p95_range"], "--o", color="#8172b2", label="95th-pct range")
    ax.set_xlabel("Year")
    ax.set_ylabel("bps")
    ax.set_title("Annual last-10-min MAE & range — is the pattern stable over regimes?")
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "7_annual_tail_regimes.png")
    plt.close(fig)

    subsection("Plot 7 — annual tails")
    print(annual.to_string())


# ── Plot 8: Threshold rules ──────────────────────────────────


def plot_threshold_rules(frame: pd.DataFrame) -> pd.DataFrame:
    """
    For a grid of |imbalance| thresholds, compare the MAE distributions
    above-threshold vs below-threshold. This is the "rule" visualization.
    """
    abs_imb = frame["T50_signed_imbalance"].abs()
    thresholds = [0, 25_000, 50_000, 100_000, 200_000, 400_000, 800_000]
    rows: list[dict] = []
    for thr in thresholds:
        above = frame[abs_imb > thr]["realized_mae_down_bps"]
        below = frame[abs_imb <= thr]["realized_mae_down_bps"]
        rows.append(
            {
                "threshold": thr,
                "n_above": len(above),
                "median_mae_above": above.median(),
                "p95_mae_above": above.quantile(0.95),
                "median_mae_below": below.median(),
                "p95_mae_below": below.quantile(0.95),
                "mae_lift_95th": above.quantile(0.95) - below.quantile(0.95),
            }
        )
    table = pd.DataFrame(rows).set_index("threshold")

    fig, ax = plt.subplots(figsize=(11, 6))
    ax.plot(table.index, table["median_mae_above"], "-o", color="#c44e52", label="median MAE (above threshold)")
    ax.plot(table.index, table["p95_mae_above"], "-o", color="#4c72b0", label="95th-pct MAE (above threshold)")
    ax.plot(table.index, table["median_mae_below"], "--o", color="#c44e52", alpha=0.4, label="median MAE (below)")
    ax.plot(table.index, table["p95_mae_below"], "--o", color="#4c72b0", alpha=0.4, label="95th-pct MAE (below)")
    ax.set_xscale("symlog", linthresh=10_000)
    ax.set_xlabel("|imbalance_T50| threshold (shares)")
    ax.set_ylabel("bps")
    ax.set_title(
        'Rule evaluation — "close flies if |imbalance| > threshold" lift curve'
    )
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "8_threshold_rules.png")
    plt.close(fig)

    subsection("Plot 8 — threshold rule table")
    print(table.to_string())
    return table


# ── Correlation matrix ───────────────────────────────────────


def print_correlation_matrix(frame: pd.DataFrame) -> None:
    features = [
        "T50_signed_imbalance",
        "T55_signed_imbalance",
        "imbalance_delta_50_to_55",
        "T50_paired_ratio",
        "T50_market_share",
        "T50_cont_drift_bps",
        "T50_cross_drift_bps",
        "T55_cont_drift_bps",
        "T55_cross_drift_bps",
    ]
    targets = [
        "realized_return_bps",
        "realized_mae_down_bps",
        "realized_range_bps",
    ]
    available = [c for c in features if c in frame.columns]

    subsection("Pearson correlation (features vs targets)")
    print(frame[available + targets].corr().loc[available, targets].round(3).to_string())

    subsection("Spearman correlation (features vs targets)")
    print(
        frame[available + targets]
        .corr(method="spearman")
        .loc[available, targets]
        .round(3)
        .to_string()
    )


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    section("MOC Imbalance — Phase 2: EDA")
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    frame = load_features()

    print_correlation_matrix(frame)

    plot_target_distributions(frame)
    plot_size_predicts_chaos(frame)
    plot_direction_scatter(frame)
    plot_delta_predicts_direction(frame)
    plot_decile_binning(frame)
    plot_side_flip_effect(frame)
    plot_annual_tail_regimes(frame)
    plot_threshold_rules(frame)

    takeaway(
        f"Wrote 8 plots -> plots/moc/. "
        "Next phase depends on what the correlations and decile plot show. "
        "If top decile MAE >> bottom decile, write a threshold rule + validate "
        "with walk-forward. If buckets are flat, signal is weaker than hoped "
        "and you'd want to try regime splits (VIX, DTE, day-of-week) before "
        "abandoning."
    )


if __name__ == "__main__":
    main()
