"""
Simplified P&L Backtesting Framework

Simulates 0DTE credit spread trading based on the system's structure
recommendations and outcomes. Compares Claude Analysis sizing against
majority-class and equal-size baselines.

Usage:
    python3 ml/backtest.py

Requires: pip install psycopg2-binary pandas numpy matplotlib seaborn
"""

import sys
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    import pandas as pd
    import seaborn as sns
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas numpy matplotlib seaborn")
    sys.exit(1)

from utils import (
    load_data,
    validate_dataframe,
    section,
    subsection,
    takeaway,
)

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
}

# ── Trade Model Constants ────────────────────────────────────

SPREAD_WIDTH = 20       # points
CREDIT_PER_CONTRACT = 200    # $2.00 * 100
MAX_LOSS_PER_CONTRACT = (SPREAD_WIDTH * 100) - CREDIT_PER_CONTRACT  # $1,800

CONFIDENCE_SIZING = {
    "HIGH": 2,
    "MODERATE": 1,
    "LOW": 1,
}


# ── Data Loading ─────────────────────────────────────────────

def load_data_backtest() -> pd.DataFrame:
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


# ── Trade Simulation ─────────────────────────────────────────

def simulate_strategy(
    df: pd.DataFrame,
    *,
    name: str,
    use_confidence_sizing: bool = True,
    override_structure: str | None = None,
    override_contracts: int | None = None,
) -> pd.DataFrame:
    """
    Simulate daily P&L for a given strategy.

    Args:
        df: DataFrame filtered to labeled days.
        name: Strategy name for labeling.
        use_confidence_sizing: If True, size by label_confidence.
        override_structure: If set, always trade this structure.
        override_contracts: If set, always use this many contracts.

    Returns:
        DataFrame with columns: date, pnl, cumulative, max_equity,
        drawdown, win, structure, contracts.
    """
    rows = []
    for date, row in df.iterrows():
        structure = override_structure or row["recommended_structure"]
        confidence = str(row.get("label_confidence", "MODERATE")).upper()

        if override_contracts is not None:
            contracts = override_contracts
        elif use_confidence_sizing:
            contracts = CONFIDENCE_SIZING.get(confidence, 1)
        else:
            contracts = 1

        won = bool(row["structure_correct"])
        if won:
            pnl = CREDIT_PER_CONTRACT * contracts
        else:
            pnl = -MAX_LOSS_PER_CONTRACT * contracts

        rows.append({
            "date": date,
            "pnl": pnl,
            "win": won,
            "structure": structure,
            "contracts": contracts,
        })

    result = pd.DataFrame(rows)
    if len(result) == 0:
        return result

    result = result.set_index("date").sort_index()
    result["cumulative"] = result["pnl"].cumsum()
    result["max_equity"] = result["cumulative"].cummax()
    result["drawdown"] = result["cumulative"] - result["max_equity"]
    result.attrs["name"] = name
    return result


# ── Metrics ──────────────────────────────────────────────────

def compute_metrics(trades: pd.DataFrame) -> dict:
    """Compute backtest metrics from a simulated trades DataFrame."""
    if len(trades) == 0:
        return {}

    wins = trades[trades["win"]]
    losses = trades[~trades["win"]]

    total_pnl = trades["pnl"].sum()
    win_rate = len(wins) / len(trades) if len(trades) > 0 else 0
    avg_win = wins["pnl"].mean() if len(wins) > 0 else 0
    avg_loss = losses["pnl"].mean() if len(losses) > 0 else 0
    gross_wins = wins["pnl"].sum() if len(wins) > 0 else 0
    gross_losses = abs(losses["pnl"].sum()) if len(losses) > 0 else 0
    profit_factor = gross_wins / gross_losses if gross_losses > 0 else float("inf")
    max_dd = trades["drawdown"].min()
    peak_equity = trades["max_equity"].max()
    max_dd_pct = (max_dd / peak_equity * 100) if peak_equity > 0 else 0

    return {
        "total_pnl": total_pnl,
        "num_trades": len(trades),
        "win_rate": win_rate,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "profit_factor": profit_factor,
        "max_drawdown": max_dd,
        "max_drawdown_pct": max_dd_pct,
        "peak_equity": peak_equity,
    }


# ── Plotting ─────────────────────────────────────────────────

def find_max_drawdown_period(trades: pd.DataFrame) -> tuple:
    """Find start and end dates of the maximum drawdown period."""
    if len(trades) == 0:
        return None, None

    cum = trades["cumulative"]
    running_max = cum.cummax()
    drawdown = cum - running_max

    trough_idx = drawdown.idxmin()
    # Peak is the last date where cumulative was at its max before the trough
    peak_series = running_max.loc[:trough_idx]
    peak_val = peak_series.iloc[-1]
    peak_candidates = cum.loc[:trough_idx][cum.loc[:trough_idx] == peak_val]
    peak_idx = peak_candidates.index[-1] if len(peak_candidates) > 0 else trough_idx

    return peak_idx, trough_idx


def plot_equity_curves(
    strategies: dict[str, pd.DataFrame],
    metrics: dict[str, dict],
) -> None:
    """Generate equity curve plot with metrics annotation."""
    fig, ax = plt.subplots(figsize=(14, 7))

    strategy_colors = {
        "Claude Analysis": COLORS["green"],
        "Majority Class (CCS)": COLORS["orange"],
        "Equal Size": COLORS["blue"],
    }

    for name, trades in strategies.items():
        if len(trades) == 0:
            continue
        color = strategy_colors.get(name, COLORS["red"])
        ax.plot(
            trades.index, trades["cumulative"],
            label=name, color=color, linewidth=2, alpha=0.9,
        )

    # Annotate max drawdown for Claude Analysis
    claude_trades = strategies.get("Claude Analysis")
    if claude_trades is not None and len(claude_trades) > 0:
        peak_date, trough_date = find_max_drawdown_period(claude_trades)
        if peak_date is not None and peak_date != trough_date:
            ax.axvspan(
                peak_date, trough_date,
                alpha=0.15, color=COLORS["red"],
                label="Max Drawdown Period",
            )

    # Metrics text box
    claude_m = metrics.get("Claude Analysis", {})
    if claude_m:
        text_lines = [
            "Claude Analysis Metrics",
            f"Total P&L: ${claude_m['total_pnl']:,.0f}",
            f"Win Rate: {claude_m['win_rate']:.1%}",
            f"Profit Factor: {claude_m['profit_factor']:.2f}",
            f"Max DD: ${claude_m['max_drawdown']:,.0f}"
            f" ({claude_m['max_drawdown_pct']:.1f}%)",
            f"Avg Win: ${claude_m['avg_win']:,.0f}"
            f" / Avg Loss: ${claude_m['avg_loss']:,.0f}",
            f"Trades: {claude_m['num_trades']}",
        ]
        text = "\n".join(text_lines)
        props = {
            "boxstyle": "round,pad=0.5",
            "facecolor": "#16213e",
            "edgecolor": "#555",
            "alpha": 0.9,
        }
        ax.text(
            0.02, 0.98, text,
            transform=ax.transAxes,
            fontsize=9, verticalalignment="top",
            bbox=props, family="monospace",
        )

    ax.set_title(
        "0DTE Credit Spread Backtest: Equity Curves",
        fontsize=14, fontweight="bold",
    )
    ax.set_xlabel("Date")
    ax.set_ylabel("Cumulative P&L ($)")
    ax.axhline(y=0, color="#555", linestyle="--", linewidth=0.8, alpha=0.6)
    ax.legend(loc="lower right", fontsize=10)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=1))
    fig.autofmt_xdate(rotation=45)

    path = PLOT_DIR / "backtest_equity.png"
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  Saved: ml/plots/backtest_equity.png")


# ── Summary Report ───────────────────────────────────────────

def print_metrics_table(metrics: dict[str, dict]) -> None:
    """Print a comparison table of all strategy metrics."""
    subsection("Strategy Comparison")

    header = f"  {'Strategy':<25s} {'P&L':>10s} {'Win%':>7s} {'PF':>7s} {'MaxDD':>10s} {'Trades':>7s}"
    print(header)
    print(f"  {'-'*66}")

    for name, m in metrics.items():
        if not m:
            continue
        print(
            f"  {name:<25s} "
            f"${m['total_pnl']:>9,.0f} "
            f"{m['win_rate']:>6.1%} "
            f"{m['profit_factor']:>6.2f} "
            f"${m['max_drawdown']:>9,.0f} "
            f"{m['num_trades']:>6d}"
        )


def print_report(
    df: pd.DataFrame,
    strategies: dict[str, pd.DataFrame],
    metrics: dict[str, dict],
) -> None:
    """Print the full backtest summary report."""
    section("BACKTEST SUMMARY")

    subsection("Data Overview")
    labeled = df[df["structure_correct"].notna()]
    print(f"  Total days loaded: {len(df)}")
    print(f"  Labeled days (tradeable): {len(labeled)}")
    print(f"  Date range: {labeled.index.min():%Y-%m-%d} to {labeled.index.max():%Y-%m-%d}")

    structures = labeled["recommended_structure"].value_counts()
    print("\n  Structure distribution:")
    for struct, count in structures.items():
        pct = count / len(labeled)
        print(f"    {struct}: {count} ({pct:.0%})")

    win_rate = labeled["structure_correct"].mean()
    print(f"\n  Overall label win rate: {win_rate:.1%}")

    print_metrics_table(metrics)

    # Per-structure breakdown for Claude Analysis
    claude_trades = strategies.get("Claude Analysis")
    if claude_trades is not None and len(claude_trades) > 0:
        subsection("Claude Analysis by Structure")
        for struct in sorted(claude_trades["structure"].unique()):
            subset = claude_trades[claude_trades["structure"] == struct]
            wins = subset["win"].sum()
            total = len(subset)
            wr = wins / total if total > 0 else 0
            pnl = subset["pnl"].sum()
            print(f"  {struct:<25s}  {wins}/{total} wins ({wr:.0%})  P&L: ${pnl:,.0f}")

        # Confidence breakdown
        subsection("Claude Analysis by Confidence")
        for conf in ["HIGH", "MODERATE", "LOW"]:
            conf_rows = labeled[
                labeled["label_confidence"].str.upper() == conf
            ]
            if len(conf_rows) == 0:
                continue
            conf_trades = claude_trades.loc[
                claude_trades.index.isin(conf_rows.index)
            ]
            if len(conf_trades) == 0:
                continue
            wins = conf_trades["win"].sum()
            total = len(conf_trades)
            wr = wins / total if total > 0 else 0
            pnl = conf_trades["pnl"].sum()
            contracts = conf_trades["contracts"].iloc[0]
            print(
                f"  {conf:<12s} ({contracts}x)  "
                f"{wins}/{total} wins ({wr:.0%})  P&L: ${pnl:,.0f}"
            )

    # Key takeaways
    section("KEY TAKEAWAYS")

    claude_m = metrics.get("Claude Analysis", {})
    majority_m = metrics.get("Majority Class (CCS)", {})

    if claude_m and majority_m:
        pnl_diff = claude_m["total_pnl"] - majority_m["total_pnl"]
        if pnl_diff > 0:
            takeaway(
                f"Claude Analysis outperforms majority-class baseline "
                f"by ${pnl_diff:,.0f}"
            )
        else:
            takeaway(
                f"Majority-class baseline outperforms Claude Analysis "
                f"by ${abs(pnl_diff):,.0f} -- structure selection not yet adding value"
            )

    if claude_m:
        if claude_m["win_rate"] >= 0.90:
            takeaway(
                f"Win rate {claude_m['win_rate']:.1%} is excellent. "
                f"The 9:1 risk/reward ratio requires >90% to be profitable."
            )
        elif claude_m["win_rate"] >= 0.85:
            takeaway(
                f"Win rate {claude_m['win_rate']:.1%} is promising but "
                f"below the ~90% threshold needed for consistent profitability "
                f"at 9:1 risk/reward."
            )
        else:
            takeaway(
                f"Win rate {claude_m['win_rate']:.1%} is below the ~90% "
                f"threshold. At 9:1 risk/reward, each loss wipes 9 wins. "
                f"Focus on loss avoidance."
            )

        if claude_m["profit_factor"] > 1.0:
            takeaway(
                f"Profit factor {claude_m['profit_factor']:.2f} -- "
                f"system is net profitable."
            )
        else:
            takeaway(
                f"Profit factor {claude_m['profit_factor']:.2f} -- "
                f"system is not yet profitable. "
                f"Need better loss filtering or tighter entry criteria."
            )

    equal_m = metrics.get("Equal Size", {})
    if claude_m and equal_m:
        sizing_diff = claude_m["total_pnl"] - equal_m["total_pnl"]
        if sizing_diff > 0:
            takeaway(
                f"Confidence-based sizing adds ${sizing_diff:,.0f} "
                f"vs equal sizing -- confidence calibration is working."
            )
        else:
            takeaway(
                f"Confidence-based sizing loses ${abs(sizing_diff):,.0f} "
                f"vs equal sizing -- confidence calibration needs work."
            )


# ── Main ─────────────────────────────────────────────────────

def main() -> None:
    print("Loading data ...")
    df = load_data_backtest()
    print(f"  {len(df)} days loaded ({df.index.min():%Y-%m-%d} to {df.index.max():%Y-%m-%d})")

    validate_dataframe(
        df,
        min_rows=5,
        required_columns=["structure_correct", "recommended_structure"],
    )

    # Filter to labeled days
    labeled = df[
        df["structure_correct"].notna() & df["recommended_structure"].notna()
    ].copy()
    print(f"  {len(labeled)} labeled days for backtesting")

    if len(labeled) < 3:
        print("Error: Not enough labeled days for a meaningful backtest.")
        print("  Label more days via the curation pipeline first.")
        sys.exit(1)

    # Determine majority structure for baseline
    majority_structure = labeled["recommended_structure"].value_counts().index[0]
    print(f"  Majority structure: {majority_structure}")

    # Simulate strategies
    strategies = {}
    strategies["Claude Analysis"] = simulate_strategy(
        labeled, name="Claude Analysis",
        use_confidence_sizing=True,
    )
    strategies["Majority Class (CCS)"] = simulate_strategy(
        labeled, name="Majority Class (CCS)",
        override_structure=majority_structure,
        override_contracts=2,
    )
    strategies["Equal Size"] = simulate_strategy(
        labeled, name="Equal Size",
        use_confidence_sizing=False,
        override_contracts=1,
    )

    # Compute metrics
    metrics = {}
    for name, trades in strategies.items():
        metrics[name] = compute_metrics(trades)

    # Generate plot
    section("GENERATING EQUITY CURVE")
    plot_equity_curves(strategies, metrics)

    # Print report
    print_report(df, strategies, metrics)


if __name__ == "__main__":
    main()
