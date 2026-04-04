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

from utils import ML_ROOT, load_data, validate_dataframe, save_section_findings

PLOT_DIR = ML_ROOT / "plots"
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


# ── Plot 9: Failure Condition Heatmap (GEX × VIX) ──────────

def plot_failure_heatmap(df: pd.DataFrame) -> None:
    """2D heatmap of GEX vs VIX colored by accuracy rate."""
    has_data = df[
        df["gex_oi_t1"].notna() & df["vix"].notna()
        & df["structure_correct"].notna()
    ].copy()
    if len(has_data) < 10:
        return

    has_data["gex_b"] = has_data["gex_oi_t1"].astype(float) / 1e9
    has_data["vix_f"] = has_data["vix"].astype(float)
    has_data["correct"] = has_data["structure_correct"].astype(float)

    gex_bins = [-100, -50, -25, 0, 100]
    gex_labels = ["< -50B", "-50 to -25B", "-25 to 0", "> 0"]
    vix_bins = [0, 20, 24, 35]
    vix_labels = ["< 20", "20-24", "> 24"]

    has_data["gex_bin"] = pd.cut(has_data["gex_b"], bins=gex_bins, labels=gex_labels)
    has_data["vix_bin"] = pd.cut(has_data["vix_f"], bins=vix_bins, labels=vix_labels)

    pivot_acc = has_data.groupby(["vix_bin", "gex_bin"], observed=True)["correct"].mean()
    pivot_n = has_data.groupby(["vix_bin", "gex_bin"], observed=True)["correct"].count()

    acc_matrix = pivot_acc.unstack(fill_value=float("nan"))
    n_matrix = pivot_n.unstack(fill_value=0)

    if acc_matrix.empty or acc_matrix.shape[0] < 2 or acc_matrix.shape[1] < 2:
        return

    fig, ax = plt.subplots(figsize=(10, 6))
    im = ax.imshow(acc_matrix.values, cmap="RdYlGn", vmin=0.5, vmax=1.0,
                   aspect="auto", origin="lower")

    ax.set_xticks(range(len(acc_matrix.columns)))
    ax.set_xticklabels(acc_matrix.columns, fontsize=10)
    ax.set_yticks(range(len(acc_matrix.index)))
    ax.set_yticklabels(acc_matrix.index, fontsize=10)
    ax.set_xlabel("GEX OI Regime")
    ax.set_ylabel("VIX Regime")

    # Annotate cells
    for i in range(len(acc_matrix.index)):
        for j in range(len(acc_matrix.columns)):
            val = acc_matrix.values[i, j]
            n = int(n_matrix.values[i, j])
            if n > 0 and not np.isnan(val):
                color = "#111" if val > 0.75 else "#eee"
                ax.text(j, i, f"{val:.0%}\nn={n}", ha="center", va="center",
                        fontsize=11, fontweight="bold", color=color)

    ax.set_title("Structure Accuracy by GEX × VIX Regime", fontsize=14, pad=15)
    fig.colorbar(im, ax=ax, label="Accuracy", shrink=0.8)
    fig.tight_layout()
    save(fig, "failure_heatmap.png")


# ── Plot 10: Dark Pool Premium vs Range ─────────────────────

def plot_dark_pool_vs_range(df: pd.DataFrame) -> None:
    """Dark pool premium vs range, colored by S/R ratio."""
    cols = ["dp_total_premium", "day_range_pts", "dp_support_resistance_ratio",
            "structure_correct"]
    has_data = df[[c for c in cols if c in df.columns]].dropna(
        subset=["dp_total_premium", "day_range_pts"],
    )
    if len(has_data) < 5:
        return

    has_data = has_data.copy()
    has_data["dp_m"] = has_data["dp_total_premium"].astype(float) / 1e9
    has_data["range"] = has_data["day_range_pts"].astype(float)

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Left: colored by S/R ratio
    ax = axes[0]
    if "dp_support_resistance_ratio" in has_data.columns:
        sr = has_data["dp_support_resistance_ratio"].astype(float)
        has_sr = has_data[sr.notna()].copy()
        if len(has_sr) >= 3:
            sr_vals = has_sr["dp_support_resistance_ratio"].astype(float)
            support_heavy = has_sr[sr_vals > 1.0]
            resist_heavy = has_sr[sr_vals <= 1.0]
            ax.scatter(support_heavy["dp_m"], support_heavy["range"],
                       c=COLORS["green"], label=f"Support > Resist (n={len(support_heavy)})",
                       s=80, alpha=0.8, edgecolors="white", linewidth=0.5)
            ax.scatter(resist_heavy["dp_m"], resist_heavy["range"],
                       c=COLORS["red"], label=f"Resist >= Support (n={len(resist_heavy)})",
                       s=80, alpha=0.8, edgecolors="white", linewidth=0.5)
            ax.legend(fontsize=9, loc="upper right")
    else:
        ax.scatter(has_data["dp_m"], has_data["range"],
                   c=COLORS["blue"], s=80, alpha=0.8, edgecolors="white")
    ax.set_xlabel("Dark Pool Total Premium ($B)")
    ax.set_ylabel("Day Range (pts)")
    ax.set_title("DP Premium vs Range, by S/R Ratio")

    # Right: colored by structure correctness
    ax = axes[1]
    if "structure_correct" in has_data.columns:
        has_sc = has_data[has_data["structure_correct"].notna()]
        correct = has_sc[has_sc["structure_correct"] == True]
        incorrect = has_sc[has_sc["structure_correct"] == False]
        ax.scatter(correct["dp_m"], correct["range"],
                   c=COLORS["green"], label="Correct", s=80, alpha=0.8,
                   edgecolors="white", linewidth=0.5)
        ax.scatter(incorrect["dp_m"], incorrect["range"],
                   c=COLORS["red"], label="Incorrect", s=120, alpha=0.9,
                   edgecolors="white", linewidth=1, marker="X")
        ax.legend(fontsize=9, loc="upper right")
    else:
        ax.scatter(has_data["dp_m"], has_data["range"],
                   c=COLORS["blue"], s=80, alpha=0.8, edgecolors="white")
    ax.set_xlabel("Dark Pool Total Premium ($B)")
    ax.set_ylabel("")
    ax.set_title("DP Premium vs Range, by Correctness")

    fig.suptitle("Dark Pool Institutional Activity and Day Outcomes",
                 fontsize=14, y=1.02)
    fig.tight_layout()
    save(fig, "dark_pool_vs_range.png")


# ── Plot 11: Cone Consumption vs Correctness ────────────────

def plot_cone_consumption(df: pd.DataFrame) -> None:
    """Opening range cone consumption vs structure correctness."""
    if "opening_range_pct_consumed" not in df.columns:
        return

    has_data = df[
        df["opening_range_pct_consumed"].notna()
        & df["structure_correct"].notna()
    ].copy()
    if len(has_data) < 5:
        return

    has_data["cone_pct"] = has_data["opening_range_pct_consumed"].astype(float)
    has_data["correct"] = has_data["structure_correct"].astype(bool)

    fig, axes = plt.subplots(1, 2, figsize=(13, 5))

    # Left: distribution by correctness
    ax = axes[0]
    correct = has_data[has_data["correct"]]["cone_pct"]
    incorrect = has_data[~has_data["correct"]]["cone_pct"]
    bins = np.arange(0, 1.1, 0.1)
    ax.hist(correct, bins=bins, color=COLORS["green"], alpha=0.7,
            label=f"Correct (n={len(correct)})", edgecolor="#333")
    ax.hist(incorrect, bins=bins, color=COLORS["red"], alpha=0.7,
            label=f"Incorrect (n={len(incorrect)})", edgecolor="#333")
    ax.axvline(x=0.65, color=COLORS["orange"], linestyle="--", alpha=0.6,
               label="Danger zone (65%)")
    ax.set_xlabel("Cone % Consumed at Entry")
    ax.set_ylabel("Days")
    ax.set_title("Cone Consumption Distribution")
    ax.legend(fontsize=9)

    # Right: accuracy by cone consumption bucket
    ax = axes[1]
    has_data["cone_bucket"] = pd.cut(
        has_data["cone_pct"],
        bins=[0, 0.3, 0.5, 0.65, 1.0],
        labels=["< 30%", "30-50%", "50-65%", "> 65%"],
    )
    bucket_data = has_data.groupby("cone_bucket", observed=True).agg(
        correct_sum=("correct", "sum"),
        total=("correct", "count"),
    )
    bucket_data["accuracy"] = bucket_data["correct_sum"] / bucket_data["total"]

    bar_colors = [COLORS["green"], COLORS["blue"], COLORS["orange"], COLORS["red"]]
    bars = ax.bar(
        range(len(bucket_data)), bucket_data["accuracy"],
        color=bar_colors[:len(bucket_data)], width=0.6, edgecolor="#333",
    )
    ax.set_xticks(range(len(bucket_data)))
    ax.set_xticklabels(bucket_data.index, fontsize=10)
    ax.set_ylim(0, 1.1)
    ax.set_ylabel("Accuracy")
    ax.set_xlabel("Cone % Consumed at Entry")
    ax.set_title("Accuracy by Cone Consumption")
    for bar, (_, row) in zip(bars, bucket_data.iterrows()):
        n = int(row["total"])
        acc = row["accuracy"]
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                f"{acc:.0%}\n(n={n})", ha="center", fontsize=10, color="#eee")

    fig.suptitle("Does Entering Late in the Cone Hurt Accuracy?",
                 fontsize=14, y=1.02)
    fig.tight_layout()
    save(fig, "cone_consumption.png")


# ── Plot 12: Previous Day → Current Day ─────────────────────

def plot_prev_day_transition(df: pd.DataFrame) -> None:
    """Previous day range/VIX change vs current day outcomes."""
    cols_needed = ["prev_day_range_pts", "day_range_pts", "prev_day_vix_change"]
    available = [c for c in cols_needed if c in df.columns]
    if len(available) < 2 or "day_range_pts" not in available:
        return

    has_data = df[df["day_range_pts"].notna()].copy()
    has_data["range"] = has_data["day_range_pts"].astype(float)

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Left: prev day range vs today's range
    ax = axes[0]
    if "prev_day_range_pts" in has_data.columns:
        sub = has_data[has_data["prev_day_range_pts"].notna()].copy()
        sub["prev_range"] = sub["prev_day_range_pts"].astype(float)
        if len(sub) >= 5:
            if "structure_correct" in sub.columns:
                correct = sub[sub["structure_correct"] == True]
                incorrect = sub[sub["structure_correct"] == False]
                ax.scatter(correct["prev_range"], correct["range"],
                           c=COLORS["green"], label="Correct", s=80,
                           alpha=0.8, edgecolors="white", linewidth=0.5)
                ax.scatter(incorrect["prev_range"], incorrect["range"],
                           c=COLORS["red"], label="Incorrect", s=120,
                           alpha=0.9, edgecolors="white", marker="X")
                ax.legend(fontsize=9)
            else:
                ax.scatter(sub["prev_range"], sub["range"],
                           c=COLORS["blue"], s=80, alpha=0.8)

            # Add diagonal reference
            lims = [min(sub["prev_range"].min(), sub["range"].min()),
                    max(sub["prev_range"].max(), sub["range"].max())]
            ax.plot(lims, lims, color="#555", linestyle="--", alpha=0.4,
                    label="same range")
    ax.set_xlabel("Previous Day Range (pts)")
    ax.set_ylabel("Today's Range (pts)")
    ax.set_title("Range Persistence: Yesterday → Today")

    # Right: prev day VIX change vs today's range
    ax = axes[1]
    if "prev_day_vix_change" in has_data.columns:
        sub = has_data[has_data["prev_day_vix_change"].notna()].copy()
        sub["prev_vix_chg"] = sub["prev_day_vix_change"].astype(float)
        if len(sub) >= 5:
            colors = [COLORS["red"] if v > 0 else COLORS["green"]
                      for v in sub["prev_vix_chg"]]
            ax.scatter(sub["prev_vix_chg"], sub["range"],
                       c=colors, s=80, alpha=0.8, edgecolors="white",
                       linewidth=0.5)
            ax.axvline(x=0, color="#555", linestyle="--", alpha=0.4)

            # Mark failures
            if "structure_correct" in sub.columns:
                fails = sub[sub["structure_correct"] == False]
                if len(fails) > 0:
                    ax.scatter(fails["prev_vix_chg"], fails["range"],
                               c=COLORS["red"], s=150, marker="X",
                               edgecolors="white", linewidth=1.5, zorder=5,
                               label="Failures")
                    ax.legend(fontsize=9)
    ax.set_xlabel("Previous Day VIX Change")
    ax.set_ylabel("")
    ax.set_title("VIX Momentum → Today's Range")

    fig.suptitle("Does Yesterday Predict Today?", fontsize=14, y=1.02)
    fig.tight_layout()
    save(fig, "prev_day_transition.png")


# ── Plot 13: Confidence Calibration Over Time ───────────────

def plot_confidence_over_time(df: pd.DataFrame) -> None:
    """Rolling accuracy by confidence level to detect calibration drift."""
    if "structure_correct" not in df.columns or "label_confidence" not in df.columns:
        return

    labeled = df[df["structure_correct"].notna()].copy()
    if len(labeled) < 10:
        return

    labeled["correct"] = labeled["structure_correct"].astype(float)

    fig, ax = plt.subplots(figsize=(14, 5))

    window = min(10, len(labeled) // 2)
    if window < 3:
        return

    # Overall rolling accuracy
    rolling_acc = labeled["correct"].rolling(window, min_periods=3).mean()
    ax.plot(range(len(rolling_acc)), rolling_acc.values,
            color=COLORS["blue"], linewidth=2.5,
            label=f"Overall ({window}-day rolling)")

    # Per-confidence rolling
    conf_colors = {"HIGH": COLORS["green"], "MODERATE": COLORS["orange"]}
    for conf, color in conf_colors.items():
        mask = labeled["label_confidence"] == conf
        conf_data = labeled[mask]["correct"]
        if len(conf_data) >= 5:
            conf_rolling = conf_data.rolling(
                min(7, len(conf_data) // 2), min_periods=2,
            ).mean()
            conf_x = [i for i, m in enumerate(mask) if m]
            ax.plot(conf_x, conf_rolling.values,
                    color=color, linewidth=1.5, alpha=0.8, linestyle="--",
                    label=f"{conf} ({min(7, len(conf_data) // 2)}-day rolling)")

    # Mark failure days
    failures = labeled[labeled["correct"] == 0]
    fail_x = [i for i, d in enumerate(labeled.index) if d in failures.index]
    ax.scatter(fail_x, [0.0] * len(fail_x), c=COLORS["red"], s=100,
               marker="v", zorder=5, label="Failures")

    ax.axhline(y=0.90, color=COLORS["cyan"], linestyle=":", alpha=0.5,
               label="90% target")
    ax.set_ylim(-0.05, 1.1)
    ax.set_ylabel("Rolling Accuracy")
    ax.set_title("Confidence Calibration Over Time", fontsize=14)
    ax.legend(fontsize=8, loc="lower left", ncol=2)

    # X-axis
    dates = labeled.index
    tick_step = max(1, len(dates) // 12)
    ax.set_xticks(range(0, len(dates), tick_step))
    ax.set_xticklabels([d.strftime("%m/%d") for d in dates[::tick_step]],
                       rotation=45, ha="right", fontsize=8)

    fig.tight_layout()
    save(fig, "confidence_over_time.png")


# ── Plot 14: Feature Importance Comparison ──────────────────

def plot_feature_importance_comparison(df: pd.DataFrame) -> None:
    """Side-by-side: EDA correlation vs XGBoost gain for top features."""
    from scipy import stats

    labeled = df[df["structure_correct"].notna()].copy()
    if len(labeled) < 15:
        return

    target = labeled["structure_correct"].astype(float)
    numeric_cols = labeled.select_dtypes(include=[np.number]).columns
    exclude = {"feature_completeness", "day_range_pts", "day_range_pct",
               "settlement", "day_open", "day_high", "day_low", "close_vs_open",
               "vix_close", "vix1d_close", "structure_correct",
               "label_completeness", "day_of_week", "is_friday", "is_event_day"}
    feature_cols = [c for c in numeric_cols if c not in exclude]

    # EDA: point-biserial correlation
    eda_scores = {}
    for col in feature_cols:
        vals = labeled[col].dropna().astype(float)
        if len(vals) < 10:
            continue
        common_target = target.loc[vals.index]
        if common_target.std() == 0 or vals.std() == 0:
            continue
        r, _p = stats.pointbiserialr(common_target, vals)
        eda_scores[col] = abs(r)

    if len(eda_scores) < 5:
        return

    eda_top = sorted(eda_scores.items(), key=lambda x: x[1], reverse=True)[:15]
    eda_features = [f for f, _ in eda_top]
    eda_values = [v for _, v in eda_top]

    # Normalize to 0-1 range for comparison
    eda_max = max(eda_values) if eda_values else 1
    eda_norm = [v / eda_max for v in eda_values]

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Left: EDA correlation ranking
    ax = axes[0]
    y_pos = range(len(eda_features))
    bars = ax.barh(y_pos, eda_norm, color=COLORS["blue"], height=0.6,
                   edgecolor="#333")
    ax.set_yticks(y_pos)
    ax.set_yticklabels(eda_features, fontsize=9)
    ax.set_xlabel("Normalized |r| (point-biserial)")
    ax.set_title("EDA: Correlation with Correctness")
    ax.invert_yaxis()
    for bar, val in zip(bars, eda_values):
        ax.text(bar.get_width() + 0.01, bar.get_y() + bar.get_height() / 2,
                f"{val:.3f}", va="center", fontsize=8, color="#ccc")

    # Right: placeholder for XGBoost (read from latest experiment)
    ax = axes[1]
    exp_dir = ML_ROOT / "experiments"
    exp_files = sorted(exp_dir.glob("phase2_early_*.json"), reverse=True)

    if exp_files:
        import json
        try:
            # Pick the experiment with the most features, not just the latest —
            # recent runs may be data-limited (e.g., CI with partial data)
            best_exp = None
            best_feature_count = 0
            for ef in exp_files:
                candidate = json.loads(ef.read_text())
                fc = candidate.get("data", {}).get("feature_count", 0)
                if fc > best_feature_count:
                    best_feature_count = fc
                    best_exp = candidate
            exp = best_exp or json.loads(exp_files[0].read_text())
            xgb_top = exp.get("feature_importance_top10", [])
            if xgb_top:
                xgb_features = [f[0] for f in xgb_top]
                xgb_values = [f[1] for f in xgb_top]
                xgb_max = max(xgb_values) if xgb_values else 1
                xgb_norm = [v / xgb_max for v in xgb_values]

                y_pos2 = range(len(xgb_features))
                bars2 = ax.barh(y_pos2, xgb_norm, color=COLORS["orange"],
                                height=0.6, edgecolor="#333")
                ax.set_yticks(y_pos2)
                ax.set_yticklabels(xgb_features, fontsize=9)
                ax.invert_yaxis()
                for bar, val in zip(bars2, xgb_values):
                    ax.text(bar.get_width() + 0.01,
                            bar.get_y() + bar.get_height() / 2,
                            f"{val:.4f}", va="center", fontsize=8, color="#ccc")

                # Highlight features that appear in both
                eda_set = set(eda_features)
                for i, feat in enumerate(xgb_features):
                    if feat in eda_set:
                        bars2[i].set_edgecolor(COLORS["cyan"])
                        bars2[i].set_linewidth(2)
        except Exception:
            pass

    ax.set_xlabel("Normalized XGBoost Gain")
    ax.set_title("XGBoost: Feature Importance (Gain)")

    fig.suptitle("Where Do Statistics and ML Agree?",
                 fontsize=14, y=1.02)
    # Legend note
    fig.text(0.5, -0.02,
             "Cyan border = feature appears in both top lists (high-signal agreement)",
             ha="center", fontsize=9, color="#888")
    fig.tight_layout()
    save(fig, "feature_importance_comparison.png")


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
    plot_failure_heatmap(df)
    plot_dark_pool_vs_range(df)
    plot_cone_consumption(df)
    plot_prev_day_transition(df)
    plot_confidence_over_time(df)
    plot_feature_importance_comparison(df)

    print("\nAll plots saved to ml/plots/")

    # Save plot manifest as findings
    import os
    manifest = []
    for png in sorted(PLOT_DIR.glob("*.png")):
        size_kb = os.path.getsize(png) / 1024
        manifest.append({
            "name": png.stem,
            "generated": True,
            "file_size_kb": round(size_kb, 1),
        })
    save_section_findings("plots", {"files": manifest, "count": len(manifest)})


if __name__ == "__main__":
    main()
