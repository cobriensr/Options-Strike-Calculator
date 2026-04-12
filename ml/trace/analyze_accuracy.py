"""
Analyze prediction accuracy of TRACE Delta Pressure heatmap close predictions.

Usage:
    ml/.venv/bin/python ml/trace/analyze_accuracy.py

Reads:
    ml/trace/results/predictions.csv   (exported by sync_from_db.py)
    Actual close prices come from the DB via sync_from_db.py — no separate
    actual_prices.csv needed since Refresh Actuals writes to the same table.

Outputs:
    ml/trace/results/accuracy_report.csv
    ml/plots/trace_error_distribution.png
    ml/plots/trace_predicted_vs_actual.png
    ml/plots/trace_accuracy_by_confidence.png
    ml/plots/trace_accuracy_by_vix_regime.png  (only if VIX data available)
"""

import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

RESULTS_DIR = Path(__file__).parent / "results"
PLOTS_DIR = Path(__file__).parent.parent / "plots"
FINDINGS_PATH = Path(__file__).parent.parent / "findings.json"

_CONF_COLORS = {"high": "#2ecc71", "medium": "#f39c12", "low": "#e74c3c"}
_HIT_THRESHOLDS = [5, 10, 15, 20]

_VIX_REGIME_LABELS = ["<15", "15-20", "20-25", "25+"]
_VIX_REGIME_COLORS = {
    "<15": "#2ecc71",    # green — calm
    "15-20": "#3498db",  # blue — normal
    "20-25": "#f39c12",  # orange — elevated
    "25+": "#e74c3c",    # red — high
}
_VIX_BINS = [0, 15, 20, 25, float("inf")]


def load_data() -> pd.DataFrame:
    """Load predictions (with actuals already included) and compute error columns."""
    predictions_path = RESULTS_DIR / "predictions.csv"
    if not predictions_path.exists():
        print(f"Error: {predictions_path} not found.")
        print("Run sync_from_db.py first.")
        sys.exit(1)

    df = pd.read_csv(predictions_path).dropna(subset=["actual_close"])
    df = df.sort_values("date").reset_index(drop=True)

    df["error"] = df["actual_close"] - df["predicted_close"]
    df["abs_error"] = df["error"].abs()
    df["direction_down"] = df["predicted_close"] < df["current_price"]
    df["actual_down"] = df["actual_close"] < df["current_price"]
    df["direction_correct"] = df["direction_down"] == df["actual_down"]

    for pts in _HIT_THRESHOLDS:
        df[f"hit_{pts}pt"] = df["abs_error"] <= pts

    if "vix" in df.columns and df["vix"].notna().any():
        df["vix_regime"] = pd.cut(
            df["vix"],
            bins=_VIX_BINS,
            labels=_VIX_REGIME_LABELS,
            right=False,
        ).astype(str)
        df.loc[df["vix"].isna(), "vix_regime"] = None

    return df


def print_summary(df: pd.DataFrame) -> None:
    n = len(df)
    sep = "=" * 60

    print(f"\n{sep}")
    print("TRACE Delta Pressure — Prediction Accuracy Report")
    print(sep)
    print(f"Sample: {n} trading days\n")

    print("Overall accuracy:")
    print(f"  Mean absolute error:   {df['abs_error'].mean():.1f} pts")
    print(f"  Median absolute error: {df['abs_error'].median():.1f} pts")
    print(f"  Std dev of error:      {df['error'].std():.1f} pts")
    print(f"  Mean signed error:     {df['error'].mean():.1f} pts")
    print(f"  Direction correct:     {df['direction_correct'].mean():.1%}")
    print()

    print("Hit rates (actual close within N points of prediction):")
    for pts in _HIT_THRESHOLDS:
        col = f"hit_{pts}pt"
        rate = df[col].mean()
        count = df[col].sum()
        bar = "█" * int(rate * 20)
        print(f"  ±{pts:2d} pts:  {rate:5.1%}  {bar:<20}  ({count}/{n})")

    conf_col = "confidence"
    if conf_col in df.columns and df[conf_col].nunique() > 1:
        print("\nBreakdown by confidence level:")
        for conf in ["high", "medium", "low"]:
            sub = df[df[conf_col] == conf]
            if sub.empty:
                continue
            print(
                f"  {conf.upper():6s} (n={len(sub):3d}): "
                f"MAE={sub['abs_error'].mean():.1f}  "
                f"±10pt={sub['hit_10pt'].mean():.1%}  "
                f"direction={sub['direction_correct'].mean():.1%}"
            )

    print(f"\n{sep}\n")


def print_vix_breakdown(df: pd.DataFrame) -> None:
    if "vix_regime" not in df.columns:
        return
    vix_data = df.dropna(subset=["vix_regime"])
    if vix_data.empty or vix_data["vix_regime"].nunique() < 2:
        return

    print("Breakdown by VIX regime (session VIX at 9:00 AM CT):")
    for regime in _VIX_REGIME_LABELS:
        sub = vix_data[vix_data["vix_regime"] == regime]
        if sub.empty:
            continue
        print(
            f"  VIX {regime:5s} (n={len(sub):3d}): "
            f"MAE={sub['abs_error'].mean():.1f}  "
            f"±10pt={sub['hit_10pt'].mean():.1%}  "
            f"direction={sub['direction_correct'].mean():.1%}"
        )
    print()


def plot_error_distribution(df: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))

    bins = min(30, max(8, len(df) // 3))
    ax.hist(df["error"], bins=bins, color="#4c9be8", edgecolor="white", alpha=0.85)
    ax.axvline(0, color="red", linestyle="--", linewidth=1.5, label="Perfect (error = 0)")
    ax.axvline(
        df["error"].mean(),
        color="orange",
        linestyle="-",
        linewidth=1.5,
        label=f"Mean error = {df['error'].mean():.1f} pts",
    )

    ax.set_xlabel("Error  (Actual Close − Predicted Close)", fontsize=12)
    ax.set_ylabel("Count", fontsize=12)
    ax.set_title("TRACE Delta Pressure: Prediction Error Distribution", fontsize=14)
    ax.legend(fontsize=11)
    ax.grid(axis="y", alpha=0.3)

    fig.tight_layout()
    out = PLOTS_DIR / "trace_error_distribution.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"  Saved: {out}")


def plot_predicted_vs_actual(df: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(9, 8))

    conf_col = "confidence"
    if conf_col in df.columns:
        for conf, color in _CONF_COLORS.items():
            sub = df[df[conf_col] == conf]
            if sub.empty:
                continue
            ax.scatter(
                sub["predicted_close"],
                sub["actual_close"],
                c=color,
                label=f"{conf} confidence (n={len(sub)})",
                alpha=0.75,
                s=70,
                edgecolors="white",
                linewidths=0.5,
            )
    else:
        ax.scatter(df["predicted_close"], df["actual_close"], alpha=0.7, s=70)

    all_vals = pd.concat([df["predicted_close"], df["actual_close"]])
    pad = 15
    lo, hi = all_vals.min() - pad, all_vals.max() + pad
    lim = (lo, hi)

    x = np.array(lim)
    ax.plot(x, x, "k--", linewidth=1, alpha=0.35, label="Perfect prediction")
    ax.fill_between(x, x - 10, x + 10, alpha=0.07, color="green", label="±10 pt band")

    ax.set_xlim(lim)
    ax.set_ylim(lim)
    ax.set_xlabel("Predicted Close  (from TRACE at 9:00 AM CT)", fontsize=12)
    ax.set_ylabel("Actual SPX Close", fontsize=12)
    ax.set_title("TRACE Delta Pressure: Predicted vs Actual Close", fontsize=14)
    ax.legend(fontsize=10)
    ax.grid(alpha=0.2)
    ax.set_aspect("equal")

    fig.tight_layout()
    out = PLOTS_DIR / "trace_predicted_vs_actual.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"  Saved: {out}")


def plot_accuracy_by_confidence(df: pd.DataFrame) -> None:
    conf_col = "confidence"
    if conf_col not in df.columns or df[conf_col].nunique() < 2:
        return

    present = [c for c in ["high", "medium", "low"] if c in df[conf_col].values]
    colors = [_CONF_COLORS[c] for c in present]

    mae_vals = [df[df[conf_col] == c]["abs_error"].mean() for c in present]
    hit_vals = [df[df[conf_col] == c]["hit_10pt"].mean() * 100 for c in present]
    counts = [len(df[df[conf_col] == c]) for c in present]
    labels = [f"{c}\n(n={n})" for c, n in zip(present, counts)]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

    ax1.bar(labels, mae_vals, color=colors, edgecolor="white")
    ax1.set_ylabel("Mean Absolute Error (pts)", fontsize=11)
    ax1.set_title("MAE by Confidence Level", fontsize=12)
    ax1.grid(axis="y", alpha=0.3)

    ax2.bar(labels, hit_vals, color=colors, edgecolor="white")
    ax2.set_ylabel("Hit Rate (%)", fontsize=11)
    ax2.set_title("Hit Rate (±10 pts) by Confidence Level", fontsize=12)
    ax2.set_ylim(0, 108)
    ax2.axhline(100, color="green", linestyle="--", alpha=0.4, linewidth=1)
    ax2.grid(axis="y", alpha=0.3)

    fig.suptitle("TRACE Delta Pressure: Accuracy by Confidence", fontsize=14)
    fig.tight_layout()
    out = PLOTS_DIR / "trace_accuracy_by_confidence.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"  Saved: {out}")


def plot_accuracy_by_vix_regime(df: pd.DataFrame) -> None:
    if "vix_regime" not in df.columns:
        return
    vix_data = df.dropna(subset=["vix_regime"])
    if vix_data.empty or vix_data["vix_regime"].nunique() < 2:
        return

    present = [r for r in _VIX_REGIME_LABELS if r in vix_data["vix_regime"].values]
    colors = [_VIX_REGIME_COLORS[r] for r in present]

    mae_vals = [vix_data[vix_data["vix_regime"] == r]["abs_error"].mean() for r in present]
    hit_vals = [vix_data[vix_data["vix_regime"] == r]["hit_10pt"].mean() * 100 for r in present]
    counts = [len(vix_data[vix_data["vix_regime"] == r]) for r in present]
    labels = [f"VIX {r}\n(n={n})" for r, n in zip(present, counts)]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

    ax1.bar(labels, mae_vals, color=colors, edgecolor="white")
    ax1.set_ylabel("Mean Absolute Error (pts)", fontsize=11)
    ax1.set_title("MAE by VIX Regime", fontsize=12)
    ax1.grid(axis="y", alpha=0.3)

    ax2.bar(labels, hit_vals, color=colors, edgecolor="white")
    ax2.set_ylabel("Hit Rate (%)", fontsize=11)
    ax2.set_title("Hit Rate (±10 pts) by VIX Regime", fontsize=12)
    ax2.set_ylim(0, 108)
    ax2.axhline(100, color="green", linestyle="--", alpha=0.4, linewidth=1)
    ax2.grid(axis="y", alpha=0.3)

    fig.suptitle("TRACE Delta Pressure: Accuracy by VIX Regime", fontsize=14)
    fig.tight_layout()
    out = PLOTS_DIR / "trace_accuracy_by_vix_regime.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"  Saved: {out}")


def plot_signal_strength(df: pd.DataFrame) -> None:
    if "current_price" not in df.columns or df["current_price"].isna().all():
        return

    df = df.copy()
    df["signal_strength"] = (df["predicted_close"] - df["current_price"]).abs()

    bins = [0, 5, 10, 20, 30, float("inf")]
    bin_labels = ["0–5", "5–10", "10–20", "20–30", "30+"]
    df["ss_bin"] = pd.cut(df["signal_strength"], bins=bins, labels=bin_labels, right=False)

    rows = []
    for label in bin_labels:
        sub = df[df["ss_bin"] == label]
        if len(sub) >= 1:
            rows.append(
                {
                    "bin": label,
                    "n": len(sub),
                    "dir_acc": sub["direction_correct"].mean() * 100,
                }
            )

    if not rows:
        return

    labels = [r["bin"] for r in rows]
    dir_acc = [r["dir_acc"] for r in rows]
    counts = [r["n"] for r in rows]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
    fig.patch.set_facecolor("#1a1a2e")

    for ax in (ax1, ax2):
        ax.set_facecolor("#16213e")
        ax.tick_params(colors="#ccc")
        ax.xaxis.label.set_color("#ccc")
        ax.yaxis.label.set_color("#ccc")
        ax.title.set_color("#ccc")
        for spine in ax.spines.values():
            spine.set_edgecolor("#444")

    ax1.bar(labels, dir_acc, color="#2ecc71", edgecolor="white")
    ax1.axhline(50, color="white", linestyle="--", linewidth=1, alpha=0.6, label="Random (50%)")
    ax1.set_ylim(0, 110)
    ax1.set_xlabel("Predicted − Open  (pts, absolute)", fontsize=11)
    ax1.set_ylabel("Direction Accuracy (%)", fontsize=11)
    ax1.set_title("Direction Accuracy by Signal Strength", fontsize=12)
    ax1.legend(fontsize=10)
    ax1.grid(axis="y", alpha=0.3)

    ax2.bar(labels, counts, color="#4c9be8", edgecolor="white")
    ax2.set_xlabel("Predicted − Open  (pts, absolute)", fontsize=11)
    ax2.set_ylabel("Sample Count", fontsize=11)
    ax2.set_title("Sample Count per Bin", fontsize=12)
    ax2.grid(axis="y", alpha=0.3)

    fig.suptitle(
        "TRACE: Does a Stronger Signal Mean Better Direction?",
        fontsize=14,
        color="#ccc",
    )
    fig.tight_layout()
    out = PLOTS_DIR / "trace_signal_strength.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"  Saved: {out}")


def plot_rolling_error(df: pd.DataFrame) -> None:
    if len(df) < 8:
        return

    df = df.copy()
    rolling_mean = df["error"].rolling(5).mean()

    step = max(1, len(df) // 10)
    x_labels = df["date"].astype(str).tolist()
    x_pos = list(range(len(df)))

    colors = ["#2ecc71" if e >= 0 else "#e74c3c" for e in df["error"]]

    fig, ax = plt.subplots(figsize=(12, 5))
    fig.patch.set_facecolor("#1a1a2e")
    ax.set_facecolor("#16213e")
    ax.tick_params(colors="#ccc")
    ax.xaxis.label.set_color("#ccc")
    ax.yaxis.label.set_color("#ccc")
    ax.title.set_color("#ccc")
    for spine in ax.spines.values():
        spine.set_edgecolor("#444")

    ax.bar(x_pos, df["error"].tolist(), color=colors, alpha=0.4, width=0.8)
    ax.plot(
        x_pos,
        rolling_mean.tolist(),
        color="#f39c12",
        linewidth=2,
        label="5-day rolling mean",
    )
    ax.axhline(0, color="white", linestyle="--", linewidth=1, alpha=0.5)

    ax.set_xticks(x_pos[::step])
    ax.set_xticklabels(x_labels[::step], rotation=45, ha="right", color="#ccc")
    ax.set_ylabel("Error (Actual − Predicted, pts)", fontsize=11)
    ax.set_title("TRACE: Signed Error Over Time (Bias Check)", fontsize=13, color="#ccc")
    ax.legend(fontsize=10)
    ax.grid(axis="y", alpha=0.3)

    fig.tight_layout()
    out = PLOTS_DIR / "trace_rolling_error.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"  Saved: {out}")


def plot_error_vs_range(df: pd.DataFrame) -> None:
    if "day_range_pts" not in df.columns or df["day_range_pts"].isna().all():
        return

    valid = df.dropna(subset=["day_range_pts"]).copy()
    if len(valid) < 5:
        return

    fig, ax = plt.subplots(figsize=(9, 6))
    fig.patch.set_facecolor("#1a1a2e")
    ax.set_facecolor("#16213e")
    ax.tick_params(colors="#ccc")
    ax.xaxis.label.set_color("#ccc")
    ax.yaxis.label.set_color("#ccc")
    ax.title.set_color("#ccc")
    for spine in ax.spines.values():
        spine.set_edgecolor("#444")

    conf_col = "confidence"
    if conf_col in valid.columns:
        for conf, color in _CONF_COLORS.items():
            sub = valid[valid[conf_col] == conf]
            if sub.empty:
                continue
            ax.scatter(
                sub["day_range_pts"],
                sub["abs_error"],
                c=color,
                label=f"{conf} confidence (n={len(sub)})",
                alpha=0.75,
                s=70,
                edgecolors="white",
                linewidths=0.5,
            )
    else:
        ax.scatter(valid["day_range_pts"], valid["abs_error"], alpha=0.75, s=70)

    x_vals = valid["day_range_pts"].astype(float).values
    y_vals = valid["abs_error"].astype(float).values
    coeffs = np.polyfit(x_vals, y_vals, 1)
    x_line = np.array([x_vals.min(), x_vals.max()])
    ax.plot(
        x_line,
        np.polyval(coeffs, x_line),
        color="white",
        linewidth=1.5,
        linestyle="--",
        alpha=0.7,
        label=f"Trend (slope={coeffs[0]:.2f})",
    )

    ax.set_xlabel("Day Range (pts, High − Low)", fontsize=11)
    ax.set_ylabel("Absolute Error (pts)", fontsize=11)
    ax.set_title("TRACE: Prediction Error vs Day Range", fontsize=13, color="#ccc")
    ax.legend(fontsize=10)
    ax.grid(alpha=0.2)

    fig.tight_layout()
    out = PLOTS_DIR / "trace_error_vs_range.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"  Saved: {out}")


def build_trace_findings(df: pd.DataFrame) -> dict:
    """Build the trace section for ml/findings.json."""
    n = len(df)
    by_conf = {}
    for conf in ["high", "medium", "low"]:
        sub = df[df["confidence"] == conf]
        if sub.empty:
            continue
        by_conf[conf] = {
            "n": int(len(sub)),
            "mae": round(float(sub["abs_error"].mean()), 2),
            "median_ae": round(float(sub["abs_error"].median()), 2),
            "direction_correct": round(float(sub["direction_correct"].mean()), 4),
            "hit_10pt": round(float(sub["hit_10pt"].mean()), 4),
        }

    by_vix: dict = {}
    if "vix_regime" in df.columns:
        vix_data = df.dropna(subset=["vix_regime"])
        for regime in _VIX_REGIME_LABELS:
            sub = vix_data[vix_data["vix_regime"] == regime]
            if sub.empty:
                continue
            by_vix[regime] = {
                "n": int(len(sub)),
                "mae": round(float(sub["abs_error"].mean()), 2),
                "direction_correct": round(float(sub["direction_correct"].mean()), 4),
                "hit_10pt": round(float(sub["hit_10pt"].mean()), 4),
            }

    signal_strength: dict = {}
    if "current_price" in df.columns and not df["current_price"].isna().all():
        _ss_df = df.copy()
        _ss_df["signal_strength"] = (_ss_df["predicted_close"] - _ss_df["current_price"]).abs()
        _ss_bins = [0, 5, 10, 20, 30, float("inf")]
        _ss_labels = ["0-5", "5-10", "10-20", "20-30", "30+"]
        _ss_df["ss_bin"] = pd.cut(
            _ss_df["signal_strength"], bins=_ss_bins, labels=_ss_labels, right=False
        )
        for label in _ss_labels:
            sub = _ss_df[_ss_df["ss_bin"] == label]
            if len(sub) >= 3:
                signal_strength[label] = {
                    "n": int(len(sub)),
                    "direction_correct": round(float(sub["direction_correct"].mean()), 4),
                }

    return {
        "n_days": n,
        "mae": round(float(df["abs_error"].mean()), 2),
        "median_ae": round(float(df["abs_error"].median()), 2),
        "std_error": round(float(df["error"].std()), 2),
        "mean_signed_error": round(float(df["error"].mean()), 2),
        "direction_correct": round(float(df["direction_correct"].mean()), 4),
        "hit_rates": {
            f"within_{pts}pt": round(float(df[f"hit_{pts}pt"].mean()), 4)
            for pts in _HIT_THRESHOLDS
        },
        "by_confidence": by_conf,
        "by_vix_regime": by_vix,
        "signal_strength": signal_strength,
        "date_range": {
            "start": str(df["date"].iloc[0]),
            "end": str(df["date"].iloc[-1]),
        },
    }


def write_findings(df: pd.DataFrame) -> None:
    """Upsert the trace section into ml/findings.json."""
    findings: dict = {}
    if FINDINGS_PATH.exists():
        try:
            findings = json.loads(FINDINGS_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    findings["trace"] = build_trace_findings(df)
    FINDINGS_PATH.write_text(json.dumps(findings, indent=2))
    print(f"Updated trace section in {FINDINGS_PATH}")


def main() -> None:
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    df = load_data()

    if len(df) < 5:
        print(
            f"Only {len(df)} valid data points — need at least 5 for meaningful analysis."
        )
        print("Add more screenshots and re-run extract_predictions.py + fetch_prices.py.")
        sys.exit(0)

    print_summary(df)

    report_path = RESULTS_DIR / "accuracy_report.csv"
    df.to_csv(report_path, index=False)
    print(f"Saved accuracy report → {report_path}")

    write_findings(df)

    print_vix_breakdown(df)

    print("\nGenerating plots:")
    plot_error_distribution(df)
    plot_predicted_vs_actual(df)
    plot_accuracy_by_confidence(df)
    plot_accuracy_by_vix_regime(df)
    plot_signal_strength(df)
    plot_rolling_error(df)
    plot_error_vs_range(df)

    print(f"\nDone. {len(df)} days analyzed.")


if __name__ == "__main__":
    main()
