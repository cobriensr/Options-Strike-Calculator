"""
ML Data Visualizations

Generates plots that make trading patterns and feature relationships
visually obvious. Saves all plots to ml/plots/.

Usage:
    python3 ml/visualize.py

Requires: pip install psycopg2-binary pandas matplotlib seaborn
"""

import sys
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    import numpy as np
    import pandas as pd
    import seaborn as sns
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas matplotlib seaborn")
    sys.exit(1)

from statsmodels.stats.proportion import proportion_confint

from utils import load_data, validate_dataframe

PLOT_DIR = Path(__file__).resolve().parent / "plots"
PLOT_DIR.mkdir(exist_ok=True)

# ── Style ────────────────────────────────────────────────────

sns.set_theme(style="darkgrid", palette="muted")
plt.rcParams.update({
    "figure.facecolor": "#1a1a2e",
    "axes.facecolor": "#16213e",
    "axes.edgecolor": "#555",
    "axes.labelcolor": "#ccc",
    "text.color": "#ccc",
    "xtick.color": "#aaa",
    "ytick.color": "#aaa",
    "grid.color": "#333",
    "grid.alpha": 0.5,
    "font.size": 11,
})

COLORS = {
    "green": "#2ecc71",
    "red": "#e74c3c",
    "blue": "#3498db",
    "orange": "#f39c12",
    "purple": "#9b59b6",
    "cyan": "#1abc9c",
    "pink": "#e91e63",
    "gray": "#95a5a6",
}

STRUCTURE_COLORS = {
    "PUT CREDIT SPREAD": COLORS["green"],
    "CALL CREDIT SPREAD": COLORS["red"],
    "IRON CONDOR": COLORS["blue"],
}

CHARM_COLORS = {
    "all_negative": COLORS["red"],
    "all_positive": COLORS["green"],
    "pcs_confirming": COLORS["cyan"],
    "ccs_confirming": COLORS["orange"],
    "mixed": COLORS["gray"],
}

RANGE_COLORS = {
    "NARROW": COLORS["green"],
    "NORMAL": COLORS["blue"],
    "WIDE": COLORS["orange"],
    "EXTREME": COLORS["red"],
}


# ── Data Loading ─────────────────────────────────────────────

def load_data_viz() -> pd.DataFrame:
    return load_data("""
        SELECT f.*, o.settlement, o.day_open, o.day_high, o.day_low,
               o.day_range_pts, o.day_range_pct, o.close_vs_open,
               o.vix_close, o.vix1d_close,
               l.recommended_structure, l.structure_correct,
               l.confidence AS label_confidence,
               l.range_category, l.settlement_direction
        FROM training_features f
        LEFT JOIN outcomes o ON o.date = f.date
        LEFT JOIN day_labels l ON l.date = f.date
        ORDER BY f.date ASC
    """)


def save(fig: plt.Figure, name: str) -> None:
    path = PLOT_DIR / name
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: ml/plots/{name}")


# ── Plot 1: Feature Correlation Heatmap ──────────────────────

def plot_correlation_heatmap(df: pd.DataFrame) -> None:
    features = [
        "vix", "vix1d", "vix1d_vix_ratio",
        "gex_oi_t1", "gex_dir_t1", "gex_vol_t1",
        "agg_net_gamma", "charm_slope", "dte0_charm_pct",
        "flow_agreement_t1", "mt_ncp_t1",
        "spx_ncp_t1", "spy_ncp_t1", "qqq_ncp_t1",
        "spy_etf_ncp_t1",
        "dp_total_premium", "dp_support_resistance_ratio",
        "dp_concentration",
        "opt_vol_pcr", "opt_premium_ratio",
        "iv_open", "iv_crush_rate",
        "max_pain_dist",
        "day_range_pts",
    ]
    available = [f for f in features if f in df.columns]
    subset = df[available].dropna(axis=0, how="all").astype(float)

    if len(subset) < 5:
        return

    # Shorter labels for readability
    labels = {
        "vix1d_vix_ratio": "VIX1D/VIX",
        "gex_oi_t1": "GEX OI",
        "gex_dir_t1": "GEX Dir",
        "gex_vol_t1": "GEX Vol",
        "agg_net_gamma": "Agg Gamma",
        "charm_slope": "Charm Slope",
        "dte0_charm_pct": "0DTE Charm%",
        "flow_agreement_t1": "Flow Agree",
        "mt_ncp_t1": "Mkt Tide",
        "spx_ncp_t1": "SPX Flow",
        "spy_ncp_t1": "SPY Flow",
        "qqq_ncp_t1": "QQQ Flow",
        "spy_etf_ncp_t1": "SPY ETF",
        "dp_total_premium": "DP Premium",
        "dp_support_resistance_ratio": "DP S/R Ratio",
        "dp_concentration": "DP Conc.",
        "opt_vol_pcr": "Opt PCR",
        "opt_premium_ratio": "Prem Ratio",
        "iv_open": "IV Open",
        "iv_crush_rate": "IV Crush",
        "max_pain_dist": "Max Pain Dist",
        "day_range_pts": "Day Range",
    }

    corr = subset.corr()
    corr = corr.rename(index=labels, columns=labels)

    fig, ax = plt.subplots(figsize=(14, 12))
    mask = np.triu(np.ones_like(corr, dtype=bool))
    sns.heatmap(corr, mask=mask, annot=True, fmt=".2f", cmap="RdBu_r",
                center=0, vmin=-1, vmax=1, square=True, ax=ax,
                linewidths=0.5, annot_kws={"size": 8},
                cbar_kws={"shrink": 0.8})
    ax.set_title("Feature Correlations (incl. Dark Pool, Options, IV)",
                 fontsize=14, pad=15)
    save(fig, "correlations.png")


# ── Plot 2: Range by Regime ──────────────────────────────────

def plot_range_by_regime(df: pd.DataFrame) -> None:
    has_range = df[df["day_range_pts"].notna()].copy()
    has_range["day_range_pts"] = has_range["day_range_pts"].astype(float)

    fig, axes = plt.subplots(1, 3, figsize=(16, 5))

    # Helper to add n= labels below each box
    def _add_n_labels(ax, data, col, categories):
        for i, cat in enumerate(categories):
            n = len(data[data[col] == cat])
            ax.text(i, ax.get_ylim()[0] + 2, f"n={n}",
                    ha="center", fontsize=8, color="#aaa")

    # By charm pattern
    ax = axes[0]
    charm_data = has_range[has_range["charm_pattern"].notna()]
    if len(charm_data) > 0:
        order = ["all_negative", "mixed", "ccs_confirming", "pcs_confirming", "all_positive"]
        order = [o for o in order if o in charm_data["charm_pattern"].values]
        palette = [CHARM_COLORS.get(o, COLORS["gray"]) for o in order]
        sns.boxplot(data=charm_data, x="charm_pattern", y="day_range_pts",
                    order=order, hue="charm_pattern", hue_order=order,
                    palette=palette, ax=ax, width=0.6, legend=False)
        sns.swarmplot(data=charm_data, x="charm_pattern", y="day_range_pts",
                      order=order, color="white", size=5, alpha=0.6, ax=ax)
        _add_n_labels(ax, charm_data, "charm_pattern", order)
        ax.set_xlabel("")
        ax.set_ylabel("Day Range (pts)")
        ax.set_title("Range by Charm Pattern")
        ax.tick_params(axis="x", rotation=30)

    # By VIX regime
    ax = axes[1]
    has_vix = has_range[has_range["vix"].notna()].copy()
    if len(has_vix) > 0:
        has_vix["vix_f"] = has_vix["vix"].astype(float)
        has_vix["VIX Regime"] = pd.cut(
            has_vix["vix_f"],
            bins=[0, 18, 22, 26, 50],
            labels=["<18\n(Low)", "18-22\n(Normal)", "22-26\n(Elevated)", ">26\n(High)"],
        )
        palette = [COLORS["green"], COLORS["blue"], COLORS["orange"], COLORS["red"]]
        sns.boxplot(data=has_vix, x="VIX Regime", y="day_range_pts",
                    hue="VIX Regime", palette=palette, ax=ax,
                    width=0.6, legend=False)
        sns.swarmplot(data=has_vix, x="VIX Regime", y="day_range_pts",
                      color="white", size=5, alpha=0.6, ax=ax)
        _add_n_labels(ax, has_vix, "VIX Regime",
                      ["<18\n(Low)", "18-22\n(Normal)", "22-26\n(Elevated)", ">26\n(High)"])
        ax.set_xlabel("")
        ax.set_ylabel("")
        ax.set_title("Range by VIX Regime")

    # By GEX regime
    ax = axes[2]
    has_gex = has_range[has_range["gex_oi_t1"].notna()].copy()
    if len(has_gex) > 0:
        has_gex["gex_f"] = has_gex["gex_oi_t1"].astype(float) / 1e9
        has_gex["GEX Regime"] = pd.cut(
            has_gex["gex_f"],
            bins=[-200, -50, 0, 200],
            labels=["Deep Neg\n(<-50B)", "Mild Neg\n(-50 to 0)", "Positive\n(>0)"],
        )
        palette = [COLORS["red"], COLORS["orange"], COLORS["green"]]
        sns.boxplot(data=has_gex, x="GEX Regime", y="day_range_pts",
                    hue="GEX Regime", palette=palette, ax=ax,
                    width=0.6, legend=False)
        sns.swarmplot(data=has_gex, x="GEX Regime", y="day_range_pts",
                      color="white", size=5, alpha=0.6, ax=ax)
        _add_n_labels(ax, has_gex, "GEX Regime",
                      ["Deep Neg\n(<-50B)", "Mild Neg\n(-50 to 0)", "Positive\n(>0)"])
        ax.set_xlabel("")
        ax.set_ylabel("")
        ax.set_title("Range by GEX Regime")

    fig.suptitle("What Drives Day Range?", fontsize=14, y=1.02)
    fig.tight_layout()
    save(fig, "range_by_regime.png")


# ── Plot 3: Flow Source Reliability ──────────────────────────

def plot_flow_reliability(df: pd.DataFrame) -> None:
    has_flow = df[df["settlement_direction"].notna()].copy()

    sources = [
        ("spy_etf_ncp_t1", "SPY ETF Tide"),
        ("qqq_etf_ncp_t1", "QQQ ETF Tide"),
        ("mt_ncp_t1", "Market Tide"),
        ("qqq_ncp_t1", "QQQ Net Flow"),
        ("zero_dte_ncp_t1", "0DTE Index"),
        ("spy_ncp_t1", "SPY Net Flow"),
        ("spx_ncp_t1", "SPX Net Flow"),
    ]

    results = []
    for col, label in sources:
        if col not in has_flow.columns:
            continue
        subset = has_flow[[col, "settlement_direction"]].dropna()
        if len(subset) < 5:
            continue
        ncp = subset[col].astype(float)
        actual_up = subset["settlement_direction"] == "UP"
        correct = ((ncp > 0) == actual_up).sum()
        total = len(subset)
        results.append((label, correct / total, total))

    if not results:
        return

    results.sort(key=lambda x: x[1])
    labels = [r[0] for r in results]
    accuracies = [r[1] for r in results]
    counts = [r[2] for r in results]

    fig, ax = plt.subplots(figsize=(10, 5))
    colors = []
    for acc in accuracies:
        if acc >= 0.55:
            colors.append(COLORS["green"])
        elif acc >= 0.45:
            colors.append(COLORS["gray"])
        else:
            colors.append(COLORS["red"])

    ci_errors = []
    sig_markers = []
    for label, acc, n in results:
        correct_count = int(round(acc * n))
        lo, hi = proportion_confint(correct_count, n, method='wilson')
        ci_errors.append([acc - lo, hi - acc])
        # Significant if CI doesn't contain 0.50
        if hi < 0.50:
            sig_markers.append("*")
        elif lo > 0.50:
            sig_markers.append("*")
        else:
            sig_markers.append("")

    xerr = [[e[0] for e in ci_errors], [e[1] for e in ci_errors]]
    bars = ax.barh(labels, accuracies, color=colors, height=0.6, edgecolor="#333",
                   xerr=xerr, capsize=4, error_kw={"color": "#aaa", "linewidth": 1})

    # Add 50% reference line
    ax.axvline(x=0.5, color="#fff", linestyle="--", alpha=0.5, linewidth=1)
    ax.text(0.505, len(labels) - 0.3, "coin flip", color="#aaa", fontsize=9, va="top")

    # Add accuracy labels on bars
    for bar, acc, n, sig in zip(bars, accuracies, counts, sig_markers):
        x = bar.get_width()
        label_text = f" {acc:.0%} (n={n}){sig}"
        ax.text(x + 0.02, bar.get_y() + bar.get_height() / 2,
                label_text, va="center", fontsize=10, color="#eee")

    ax.set_xlim(0, 0.85)
    ax.set_xlabel("Direction Prediction Accuracy")
    ax.set_title("Flow Source Reliability: Which Sources Predict Settlement Direction?",
                 fontsize=13, pad=15)

    # Legend
    patches = [
        mpatches.Patch(color=COLORS["green"], label="Useful (>55%)"),
        mpatches.Patch(color=COLORS["gray"], label="Coin flip (45-55%)"),
        mpatches.Patch(color=COLORS["red"], label="Anti-signal (<45%)"),
    ]
    ax.legend(handles=patches, loc="lower right", fontsize=9)

    # Action footer
    useful_names = [r[0] for r in results if r[1] >= 0.55]
    anti_names = [r[0] for r in results if r[1] < 0.40]
    footer_parts = []
    if useful_names:
        footer_parts.append(f"Trust: {', '.join(useful_names)}")
    if anti_names:
        footer_parts.append(f"Fade: {', '.join(anti_names)}")
    if footer_parts:
        footer = "  |  ".join(footer_parts) + "  |  * = statistically significant (CI excludes 50%)"
        fig.text(0.5, -0.04, footer, ha="center", fontsize=8, color="#888")

    fig.tight_layout()
    save(fig, "flow_reliability.png")


# ── Plot 4: GEX vs Range Scatter ─────────────────────────────

def plot_gex_vs_range(df: pd.DataFrame) -> None:
    subset = df[["gex_oi_t1", "day_range_pts", "charm_pattern", "structure_correct"]].dropna()
    if len(subset) < 5:
        return

    subset = subset.copy()
    subset["gex_b"] = subset["gex_oi_t1"].astype(float) / 1e9
    subset["range"] = subset["day_range_pts"].astype(float)

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Left: colored by charm pattern
    ax = axes[0]
    for pattern in sorted(subset["charm_pattern"].unique()):
        mask = subset["charm_pattern"] == pattern
        color = CHARM_COLORS.get(pattern, COLORS["gray"])
        ax.scatter(subset.loc[mask, "gex_b"], subset.loc[mask, "range"],
                   c=color, label=pattern, s=70, alpha=0.8,
                   edgecolors="white", linewidth=0.5)
    ax.axvline(x=0, color="#555", linestyle="--", alpha=0.5)
    ax.set_xlabel("GEX OI at T1 (billions)")
    ax.set_ylabel("Day Range (pts)")
    ax.set_title("GEX vs Range, by Charm Pattern")
    ax.legend(fontsize=8, loc="upper right")

    # Right: colored by structure correctness
    ax = axes[1]
    correct = subset[subset["structure_correct"] == True]
    incorrect = subset[subset["structure_correct"] == False]
    ax.scatter(correct["gex_b"], correct["range"],
               c=COLORS["green"], label="Correct", s=70, alpha=0.8,
               edgecolors="white", linewidth=0.5)
    ax.scatter(incorrect["gex_b"], incorrect["range"],
               c=COLORS["red"], label="Incorrect", s=120, alpha=0.9,
               edgecolors="white", linewidth=1, marker="X")
    ax.axvline(x=0, color="#555", linestyle="--", alpha=0.5)
    ax.set_xlabel("GEX OI at T1 (billions)")
    ax.set_ylabel("")
    ax.set_title("GEX vs Range, by Structure Correctness")
    ax.legend(fontsize=9, loc="upper right")

    fig.suptitle("GEX Regime and Day Outcomes", fontsize=14, y=1.02)
    fig.tight_layout()
    save(fig, "gex_vs_range.png")


# ── Plot 5: Daily Timeline ──────────────────────────────────

def plot_timeline(df: pd.DataFrame) -> None:
    has_data = df[df["day_range_pts"].notna()].copy()
    has_data["range"] = has_data["day_range_pts"].astype(float)

    fig, axes = plt.subplots(4, 1, figsize=(16, 12), sharex=True)

    dates = has_data.index
    x = range(len(dates))

    # Panel 1: Day range with structure correctness
    ax = axes[0]
    range_colors = []
    for _, row in has_data.iterrows():
        if row.get("structure_correct") == False:
            range_colors.append(COLORS["red"])
        elif row.get("range_category") == "EXTREME":
            range_colors.append(COLORS["orange"])
        else:
            range_colors.append(COLORS["blue"])

    ax.bar(x, has_data["range"], color=range_colors, width=0.7, edgecolor="#333")
    ax.axhline(y=has_data["range"].mean(), color=COLORS["cyan"], linestyle="--",
               alpha=0.5, label=f'Avg {has_data["range"].mean():.0f} pts')
    ax.set_ylabel("Day Range (pts)")
    ax.set_title("Daily Overview", fontsize=13)
    ax.legend(fontsize=9)

    # Add structure labels on each bar
    for i, (_, row) in enumerate(has_data.iterrows()):
        struct = row.get("recommended_structure", "")
        if pd.notna(struct) and isinstance(struct, str):
            short = {"PUT CREDIT SPREAD": "PCS", "CALL CREDIT SPREAD": "CCS",
                     "IRON CONDOR": "IC"}.get(struct, "")
            if short:
                label_color = COLORS["red"] if row.get("structure_correct") == False else "#888"
                ax.text(i, 3, short, ha="center", va="bottom",
                        fontsize=6, color=label_color, rotation=90, alpha=0.7)

    # Add failure markers and shade failure columns across all panels
    for i, (_, row) in enumerate(has_data.iterrows()):
        if row.get("structure_correct") == False:
            ax.annotate("MISS", (i, row["range"]), ha="center", va="bottom",
                        fontsize=8, color=COLORS["red"], fontweight="bold")
            # Shade this day across all panels
            for panel in axes:
                panel.axvspan(i - 0.4, i + 0.4, color=COLORS["red"],
                              alpha=0.08, zorder=0)

    # Panel 2: VIX and VIX1D
    ax = axes[1]
    if "vix" in has_data.columns:
        vix = has_data["vix"].astype(float)
        ax.plot(x, vix, color=COLORS["red"], linewidth=1.5, label="VIX", marker="o", markersize=4)
    if "vix1d" in has_data.columns:
        vix1d = has_data["vix1d"].dropna().astype(float)
        vix1d_x = [i for i, d in enumerate(dates) if d in vix1d.index]
        ax.plot(vix1d_x, vix1d.values, color=COLORS["cyan"], linewidth=1.5,
                label="VIX1D", marker="s", markersize=4)
    ax.axhline(y=22, color=COLORS["orange"], linestyle=":", alpha=0.4, label="Caution (22)")
    ax.axhline(y=26, color=COLORS["red"], linestyle=":", alpha=0.4, label="Stop (26)")
    ax.set_ylabel("Level")
    ax.legend(fontsize=8, ncol=4)

    # Panel 3: GEX OI
    ax = axes[2]
    if "gex_oi_t1" in has_data.columns:
        gex = has_data["gex_oi_t1"].dropna().astype(float) / 1e9
        gex_x = [i for i, d in enumerate(dates) if d in gex.index]
        gex_colors = [COLORS["green"] if v > 0 else COLORS["red"] for v in gex.values]
        ax.bar(gex_x, gex.values, color=gex_colors, width=0.7, edgecolor="#333")
        ax.axhline(y=0, color="#555", linewidth=0.5)
        ax.axhline(y=-50, color=COLORS["red"], linestyle=":", alpha=0.4, label="Deep Neg (-50B)")
    ax.set_ylabel("GEX OI (B)")
    ax.legend(fontsize=8)

    # Panel 4: Flow Agreement
    ax = axes[3]
    if "flow_agreement_t1" in has_data.columns:
        fa = has_data["flow_agreement_t1"].astype(float)
        fa_colors = [COLORS["green"] if v >= 6 else COLORS["blue"] if v >= 4 else COLORS["red"]
                     for v in fa.values]
        ax.bar(x, fa, color=fa_colors, width=0.7, edgecolor="#333")
        ax.axhline(y=4, color=COLORS["orange"], linestyle=":", alpha=0.4)
    ax.set_ylabel("Agreement\n(of 9)")
    ax.set_ylim(0, 9)

    # X-axis labels
    ax.set_xticks(x)
    ax.set_xticklabels([d.strftime("%m/%d") for d in dates], rotation=45, ha="right", fontsize=8)

    # Summary footer
    n_days = len(has_data)
    n_correct = has_data["structure_correct"].sum() if "structure_correct" in has_data.columns else 0
    n_labeled = has_data["structure_correct"].notna().sum() if "structure_correct" in has_data.columns else 0
    avg_range = has_data["range"].mean()
    footer = (f"{n_days} days  |  {int(n_correct)}/{n_labeled} correct  |  "
              f"avg range {avg_range:.0f} pts  |  "
              f"red shading = structure miss")
    fig.text(0.5, -0.02, footer, ha="center", fontsize=9, color="#888")

    fig.tight_layout()
    save(fig, "timeline.png")


# ── Plot 6: Confidence & Structure ───────────────────────────

def plot_structure_confidence(df: pd.DataFrame) -> None:
    labeled = df[df["structure_correct"].notna()].copy()
    if len(labeled) < 5:
        return

    fig, axes = plt.subplots(1, 2, figsize=(13, 5))

    # Left: Structure accuracy
    ax = axes[0]
    structs = ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"]
    correct_counts = []
    incorrect_counts = []
    colors = []
    for s in structs:
        subset = labeled[labeled["recommended_structure"] == s]
        c = subset["structure_correct"].sum()
        ic = len(subset) - c
        correct_counts.append(c)
        incorrect_counts.append(ic)
        colors.append(STRUCTURE_COLORS.get(s, COLORS["gray"]))

    short_labels = ["PCS", "CCS", "IC"]
    y_pos = range(len(structs))
    ax.barh(y_pos, correct_counts, color=colors, height=0.5,
            edgecolor="#333", label="Correct")
    ax.barh(y_pos, incorrect_counts, left=correct_counts, color=COLORS["red"],
            height=0.5, edgecolor="#333", alpha=0.7, label="Incorrect")
    ax.set_yticks(y_pos)
    ax.set_yticklabels(short_labels)
    ax.set_xlabel("Days")
    ax.set_title("Structure Accuracy")
    ax.legend(fontsize=9)

    # Add count labels
    for i, (c, ic) in enumerate(zip(correct_counts, incorrect_counts)):
        total = c + ic
        ax.text(total + 0.3, i, f"{c}/{total} ({c/total:.0%})",
                va="center", fontsize=10, color="#eee")

    # Right: Confidence calibration
    ax = axes[1]
    conf_order = ["HIGH", "MODERATE", "LOW"]
    conf_colors = [COLORS["green"], COLORS["orange"], COLORS["red"]]
    accs = []
    counts = []
    valid_confs = []
    valid_colors = []

    for conf, color in zip(conf_order, conf_colors):
        subset = labeled[labeled["label_confidence"] == conf]
        if len(subset) == 0:
            continue
        c = subset["structure_correct"].sum()
        t = len(subset)
        accs.append(c / t)
        counts.append(t)
        valid_confs.append(conf)
        valid_colors.append(color)

    if valid_confs:
        ci_los = []
        ci_his = []
        for acc, n in zip(accs, counts):
            correct_count = int(round(acc * n))
            lo, hi = proportion_confint(correct_count, n, method='wilson')
            ci_los.append(acc - lo)
            ci_his.append(hi - acc)

        bars = ax.bar(valid_confs, accs, color=valid_colors, width=0.5,
                      edgecolor="#333", yerr=[ci_los, ci_his],
                      capsize=5, error_kw={"color": "#aaa", "linewidth": 1.5})

        for bar, n in zip(bars, counts):
            if n < 3:
                bar.set_alpha(0.4)

        ax.axhline(y=0.5, color="#555", linestyle="--", alpha=0.3)
        ax.set_ylim(0, 1.1)
        ax.set_ylabel("Accuracy")
        ax.set_title("Confidence Calibration")

        for bar, acc, n in zip(bars, accs, counts):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                    f"{acc:.0%}\n(n={n})", ha="center", fontsize=10, color="#eee")

    fig.suptitle("Structure & Confidence Performance", fontsize=14, y=1.02)
    fig.tight_layout()
    save(fig, "structure_confidence.png")


# ── Plot 7: Day of Week ─────────────────────────────────────

def plot_day_of_week(df: pd.DataFrame) -> None:
    has_range = df[df["day_range_pts"].notna()].copy()
    has_range["range"] = has_range["day_range_pts"].astype(float)
    has_range["dow"] = has_range["day_of_week"].astype(int)

    day_names = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri"}
    has_range["day_name"] = has_range["dow"].map(day_names)
    has_range = has_range[has_range["day_name"].notna()]

    if len(has_range) < 5:
        return

    fig, ax = plt.subplots(figsize=(8, 5))

    order = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    palette = [COLORS["red"], COLORS["blue"], COLORS["green"], COLORS["orange"], COLORS["purple"]]

    sns.boxplot(data=has_range, x="day_name", y="range", order=order,
                hue="day_name", hue_order=order, palette=palette,
                ax=ax, width=0.5, legend=False)
    sns.swarmplot(data=has_range, x="day_name", y="range", order=order,
                  color="white", size=6, alpha=0.6, ax=ax)

    # Add mean, median, and n= labels
    for i, day in enumerate(order):
        subset = has_range[has_range["day_name"] == day]["range"]
        if len(subset) > 0:
            mean_val = subset.mean()
            median_val = subset.median()
            n = len(subset)
            ax.text(i, subset.max() + 3,
                    f"avg {mean_val:.0f} / med {median_val:.0f}\nn={n}",
                    ha="center", fontsize=8, color="#ccc", linespacing=1.4)

    ax.set_xlabel("")
    ax.set_ylabel("Day Range (pts)")
    ax.set_title("Range by Day of Week", fontsize=13)
    fig.tight_layout()
    save(fig, "day_of_week.png")


# ── Plot 8: Feature Stationarity ───────────────────────────

def plot_stationarity(df: pd.DataFrame) -> None:
    """Plot rolling means of key features to assess stationarity."""
    features = {
        "vix": ("VIX", COLORS["red"]),
        "gex_oi_t1": ("GEX OI (B)", COLORS["green"]),
        "day_range_pts": ("Day Range (pts)", COLORS["blue"]),
        "flow_agreement_t1": ("Flow Agreement", COLORS["orange"]),
        "dp_total_premium": ("DP Premium", COLORS["purple"]),
        "opt_vol_pcr": ("Options PCR", COLORS["cyan"]),
        "iv_open": ("IV Open", COLORS["pink"]),
    }

    available = {k: v for k, v in features.items() if k in df.columns}
    if len(available) < 2:
        return

    n_panels = len(available)
    fig, axes = plt.subplots(n_panels, 1, figsize=(14, 3 * n_panels), sharex=True)
    if n_panels == 1:
        axes = [axes]

    window = min(10, len(df) // 3)
    if window < 3:
        return

    for ax, (col, (label, color)) in zip(axes, available.items()):
        vals = df[col].dropna().astype(float)
        if col == "gex_oi_t1":
            vals = vals / 1e9
        elif col == "dp_total_premium":
            vals = vals / 1e6

        # Raw values
        ax.plot(range(len(vals)), vals.values, color=color, alpha=0.4,
                linewidth=1, marker="o", markersize=3)

        # Rolling mean
        rolling = vals.rolling(window, min_periods=max(2, window // 2)).mean()
        ax.plot(range(len(rolling)), rolling.values, color=color,
                linewidth=2.5, label=f"{window}-day rolling mean")

        # Overall mean reference
        ax.axhline(y=vals.mean(), color="#555", linestyle=":", alpha=0.5,
                   label=f"Overall mean ({vals.mean():.1f})")

        ax.set_ylabel(label, fontsize=10)
        ax.legend(fontsize=8, loc="upper right")

    # X-axis labels
    dates = df.index
    ax = axes[-1]
    tick_step = max(1, len(dates) // 15)
    ax.set_xticks(range(0, len(dates), tick_step))
    ax.set_xticklabels([d.strftime("%m/%d") for d in dates[::tick_step]],
                       rotation=45, ha="right", fontsize=8)

    fig.suptitle("Feature Stationarity Check (Rolling Means)", fontsize=14, y=1.02)
    fig.tight_layout()
    save(fig, "stationarity.png")


# ── Main ─────────────────────────────────────────────────────

def main() -> None:
    print("Loading data ...")
    df = load_data_viz()
    validate_dataframe(
        df,
        min_rows=5,
        required_columns=["day_range_pts"],
        range_checks={"vix": (9, 90)},
    )
    print(f"  {len(df)} days loaded\n")

    print("Generating plots ...")
    plot_correlation_heatmap(df)
    plot_range_by_regime(df)
    plot_flow_reliability(df)
    plot_gex_vs_range(df)
    plot_timeline(df)
    plot_structure_confidence(df)
    plot_day_of_week(df)
    plot_stationarity(df)

    print("\nAll plots saved to ml/plots/")


if __name__ == "__main__":
    main()
