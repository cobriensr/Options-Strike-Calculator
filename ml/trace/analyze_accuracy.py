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
"""

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

RESULTS_DIR = Path(__file__).parent / "results"
PLOTS_DIR = Path(__file__).parent.parent / "plots"

_CONF_COLORS = {"high": "#2ecc71", "medium": "#f39c12", "low": "#e74c3c"}
_HIT_THRESHOLDS = [5, 10, 15, 20]


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
    ax.set_xlabel("Predicted Close  (from TRACE at 8:30 AM CT)", fontsize=12)
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

    print("\nGenerating plots:")
    plot_error_distribution(df)
    plot_predicted_vs_actual(df)
    plot_accuracy_by_confidence(df)

    print(f"\nDone. {len(df)} days analyzed.")


if __name__ == "__main__":
    main()
