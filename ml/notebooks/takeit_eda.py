"""Take-It Score Phase 1 EDA.

Produces:
- ml/plots/takeit_phase1_class_balance.png
- ml/plots/takeit_phase1_missingness.png
- ml/plots/takeit_phase1_winrate_by_session_phase.png
- ml/plots/takeit_phase1_winrate_by_dte.png
- ml/plots/takeit_phase1_winrate_by_ticker.png
- ml/plots/takeit_phase1_winrate_binary_features.png
- ml/plots/takeit_phase1_winrate_quantile_features.png
- ml/plots/takeit_phase1_correlation_matrix.png

Run:
    ml/.venv/bin/python ml/notebooks/takeit_eda.py
"""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

DATA_DIR = Path("ml/data/takeit")
PLOTS_DIR = Path("ml/plots")
PLOTS_DIR.mkdir(parents=True, exist_ok=True)


# Features expected to be informative; binary (one-hot or 0/1) vs continuous numeric.
BINARY_FEATURES = [
    "is_itm_at_fire",
    "aggressive_premium_flag",
    "burst_storm_badge",
    "direction_gated",
    "day_of_week",  # treated categorically
]
LOTTERY_BINARY_EXTRAS = [
    "cheap_call_pm_tagged",
    "reload_tagged",
    "silent_boom_cofire_within_5min",
]
SILENTBOOM_BINARY_EXTRAS = [
    "lottery_cofire_within_5min",
]

NUMERIC_FEATURES = [
    "score",
    "dte",
    "minute_of_day_ct",
    "session_phase",
    "otm_distance_pct",
    "n_same_dir_fires_last_30min",
    "burst_storm_distinct_count",
    "prior_session_win_rate_same_ticker",
    "mkt_tide_otm_diff",
    "spx_spot_gamma_oi",
    "zero_dte_diff",
]
LOTTERY_NUMERIC_EXTRAS = [
    "trigger_ask_pct",
    "trigger_iv",
    "trigger_delta",
    "burst_ratio_vs_prev",
]
SILENTBOOM_NUMERIC_EXTRAS = [
    "ask_pct",
    "spike_ratio",
    "vol_oi",
    "multi_leg_share",
]


def _load(alert_type: str) -> pd.DataFrame:
    return pd.read_parquet(DATA_DIR / f"{alert_type}_training.parquet")


def plot_class_balance(lot: pd.DataFrame, sb: pd.DataFrame) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    for ax, df, name in zip(axes, [lot, sb], ["lottery", "silentboom"]):
        counts = df["win"].value_counts().sort_index()
        ax.bar(["loss (0)", "win (1)"], counts.values, color=["#cc4444", "#44aa44"])
        ax.set_title(f"{name}: n={len(df):,}, win_rate={df['win'].mean():.3f}")
        for i, v in enumerate(counts.values):
            ax.text(i, v, f"{v:,}", ha="center", va="bottom")
    fig.suptitle("Take-It Phase 1 — Class Balance (peak_ceiling_pct ≥ 20)")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "takeit_phase1_class_balance.png", dpi=120)
    plt.close(fig)


def plot_missingness(lot: pd.DataFrame, sb: pd.DataFrame) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(14, 8))
    for ax, df, name in zip(axes, [lot, sb], ["lottery", "silentboom"]):
        miss = (df.isna().mean() * 100).sort_values(ascending=True)
        miss = miss[miss > 0]
        if miss.empty:
            ax.text(0.5, 0.5, "no missing values", ha="center", va="center")
            ax.set_title(f"{name}: complete")
            continue
        ax.barh(miss.index, miss.values, color="#888888")
        ax.set_xlabel("% missing")
        ax.set_title(f"{name}: columns with missing values")
    fig.suptitle("Take-It Phase 1 — Missingness Audit")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "takeit_phase1_missingness.png", dpi=120)
    plt.close(fig)


def plot_winrate_by_session_phase(lot: pd.DataFrame, sb: pd.DataFrame) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    for ax, df, name in zip(axes, [lot, sb], ["lottery", "silentboom"]):
        grp = df.groupby("session_phase")["win"].agg(["count", "mean"]).reset_index()
        ax.bar(grp["session_phase"].astype(str), grp["mean"], color="#4477aa")
        ax.axhline(df["win"].mean(), color="red", linestyle="--", label=f"base={df['win'].mean():.2f}")
        for i, (cnt, mn) in enumerate(zip(grp["count"], grp["mean"])):
            ax.text(i, mn, f"n={cnt:,}\n{mn:.2f}", ha="center", va="bottom", fontsize=8)
        ax.set_ylim(0, 1)
        ax.set_xlabel("session_phase (1=8:30-9:00 ... 5=14:00-15:00)")
        ax.set_ylabel("win rate")
        ax.set_title(name)
        ax.legend()
    fig.suptitle("Take-It Phase 1 — Win Rate by Session Phase")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "takeit_phase1_winrate_by_session_phase.png", dpi=120)
    plt.close(fig)


def plot_winrate_by_dte(lot: pd.DataFrame, sb: pd.DataFrame) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    for ax, df, name in zip(axes, [lot, sb], ["lottery", "silentboom"]):
        df2 = df.copy()
        df2["dte_bucket"] = df2["dte"].clip(upper=5)
        grp = df2.groupby("dte_bucket")["win"].agg(["count", "mean"]).reset_index()
        ax.bar(grp["dte_bucket"].astype(str), grp["mean"], color="#aa7744")
        ax.axhline(df["win"].mean(), color="red", linestyle="--")
        for i, (cnt, mn) in enumerate(zip(grp["count"], grp["mean"])):
            ax.text(i, mn, f"n={cnt:,}\n{mn:.2f}", ha="center", va="bottom", fontsize=8)
        ax.set_ylim(0, 1)
        ax.set_xlabel("dte (5+ pooled)")
        ax.set_ylabel("win rate")
        ax.set_title(name)
    fig.suptitle("Take-It Phase 1 — Win Rate by DTE")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "takeit_phase1_winrate_by_dte.png", dpi=120)
    plt.close(fig)


def plot_winrate_by_ticker(lot: pd.DataFrame, sb: pd.DataFrame, top_n: int = 15) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    for ax, df, name in zip(axes, [lot, sb], ["lottery", "silentboom"]):
        top = df["underlying_symbol"].value_counts().head(top_n).index
        sub = df[df["underlying_symbol"].isin(top)]
        grp = (
            sub.groupby("underlying_symbol")["win"]
            .agg(["count", "mean"])
            .sort_values("mean", ascending=True)
            .reset_index()
        )
        ax.barh(grp["underlying_symbol"], grp["mean"], color="#5577cc")
        ax.axvline(df["win"].mean(), color="red", linestyle="--", label=f"base={df['win'].mean():.2f}")
        for i, (cnt, mn) in enumerate(zip(grp["count"], grp["mean"])):
            ax.text(mn, i, f" n={cnt:,}", va="center", fontsize=7)
        ax.set_xlim(0, 1)
        ax.set_xlabel("win rate")
        ax.set_title(f"{name} — top {top_n} tickers by volume")
        ax.legend()
    fig.suptitle("Take-It Phase 1 — Win Rate by Ticker (top-15)")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "takeit_phase1_winrate_by_ticker.png", dpi=120)
    plt.close(fig)


def plot_winrate_binary_features(df: pd.DataFrame, alert_type: str, extras: list[str]) -> None:
    features = BINARY_FEATURES + extras
    features = [f for f in features if f in df.columns]
    base = df["win"].mean()
    fig, ax = plt.subplots(figsize=(11, 0.5 * len(features) + 2))
    rows = []
    for f in features:
        col = df[f]
        try:
            distinct = sorted(col.dropna().unique().tolist())
        except TypeError:
            distinct = list(col.dropna().unique())
        for v in distinct:
            sub = df[df[f] == v]
            if len(sub) < 30:
                continue
            rows.append((f"{f} == {v}", len(sub), sub["win"].mean()))
    rows.sort(key=lambda r: r[2])
    labels = [r[0] for r in rows]
    rates = [r[2] for r in rows]
    counts = [r[1] for r in rows]
    ax.barh(labels, rates, color="#5577cc")
    ax.axvline(base, color="red", linestyle="--", label=f"base={base:.2f}")
    for i, (cnt, mn) in enumerate(zip(counts, rates)):
        ax.text(mn, i, f" n={cnt:,}", va="center", fontsize=7)
    ax.set_xlim(0, 1)
    ax.set_xlabel("win rate")
    ax.set_title(f"{alert_type} — win rate by binary/categorical feature value")
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / f"takeit_phase1_winrate_binary_features_{alert_type}.png", dpi=120)
    plt.close(fig)


def plot_winrate_quantile_features(df: pd.DataFrame, alert_type: str, extras: list[str], n_bins: int = 5) -> None:
    features = NUMERIC_FEATURES + extras
    features = [f for f in features if f in df.columns]
    base = df["win"].mean()
    fig, axes = plt.subplots(
        nrows=(len(features) + 2) // 3, ncols=3,
        figsize=(14, 3 * ((len(features) + 2) // 3)),
    )
    axes = axes.flatten()
    for ax, f in zip(axes, features):
        col = df[f]
        if col.dropna().empty:
            ax.set_visible(False)
            continue
        try:
            df["_q"] = pd.qcut(col, q=n_bins, labels=False, duplicates="drop")
        except ValueError:
            ax.set_visible(False)
            continue
        grp = df.groupby("_q")["win"].agg(["count", "mean"]).reset_index()
        if grp.empty:
            ax.set_visible(False)
            continue
        ax.bar(grp["_q"].astype(str), grp["mean"], color="#778877")
        ax.axhline(base, color="red", linestyle="--")
        ax.set_ylim(0, 1)
        ax.set_title(f, fontsize=9)
        ax.tick_params(labelsize=7)
    df.drop(columns=["_q"], errors="ignore", inplace=True)
    for ax in axes[len(features):]:
        ax.set_visible(False)
    fig.suptitle(f"{alert_type} — win rate by quantile bin (5-bin)")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / f"takeit_phase1_winrate_quantile_features_{alert_type}.png", dpi=120)
    plt.close(fig)


def plot_correlation_matrix(df: pd.DataFrame, alert_type: str, extras: list[str]) -> None:
    features = NUMERIC_FEATURES + extras + ["win"]
    features = [f for f in features if f in df.columns]
    sub = df[features].copy()
    sub = sub.dropna()
    if len(sub) < 100:
        return
    corr = sub.corr(method="spearman")
    fig, ax = plt.subplots(figsize=(10, 8))
    im = ax.imshow(corr.values, cmap="RdBu_r", vmin=-1, vmax=1)
    ax.set_xticks(range(len(features)))
    ax.set_yticks(range(len(features)))
    ax.set_xticklabels(features, rotation=90, fontsize=8)
    ax.set_yticklabels(features, fontsize=8)
    for i in range(len(features)):
        for j in range(len(features)):
            val = corr.values[i, j]
            ax.text(j, i, f"{val:.2f}", ha="center", va="center",
                    fontsize=6, color="white" if abs(val) > 0.5 else "black")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    ax.set_title(f"{alert_type} — Spearman correlation (numeric features + win)")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / f"takeit_phase1_correlation_matrix_{alert_type}.png", dpi=120)
    plt.close(fig)


def main() -> None:
    print(f"[takeit-eda] loading from {DATA_DIR}")
    lot = _load("lottery")
    sb = _load("silentboom")
    print(f"[takeit-eda] lottery={lot.shape}, silentboom={sb.shape}")

    print("[takeit-eda] plotting class balance...")
    plot_class_balance(lot, sb)
    print("[takeit-eda] plotting missingness...")
    plot_missingness(lot, sb)
    print("[takeit-eda] plotting winrate by session phase...")
    plot_winrate_by_session_phase(lot, sb)
    print("[takeit-eda] plotting winrate by dte...")
    plot_winrate_by_dte(lot, sb)
    print("[takeit-eda] plotting winrate by ticker...")
    plot_winrate_by_ticker(lot, sb)

    for alert_type, df, bin_extras, num_extras in [
        ("lottery", lot, LOTTERY_BINARY_EXTRAS, LOTTERY_NUMERIC_EXTRAS),
        ("silentboom", sb, SILENTBOOM_BINARY_EXTRAS, SILENTBOOM_NUMERIC_EXTRAS),
    ]:
        print(f"[takeit-eda] plotting binary features for {alert_type}...")
        plot_winrate_binary_features(df, alert_type, bin_extras)
        print(f"[takeit-eda] plotting quantile features for {alert_type}...")
        plot_winrate_quantile_features(df, alert_type, num_extras)
        print(f"[takeit-eda] plotting correlation matrix for {alert_type}...")
        plot_correlation_matrix(df, alert_type, num_extras)

    print(f"[takeit-eda] done. plots in {PLOTS_DIR}/")


if __name__ == "__main__":
    main()
