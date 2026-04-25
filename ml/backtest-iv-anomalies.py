"""
Phase B of the IV-anomaly signal-vs-price study.

Three exit playbooks, evaluated per-ticker and per-DTE-bucket:

  1. Sell-on-ITM-touch — exit at first minute spot crosses strike.
  2. Sell-at-peak — oracle (cheating) ceiling, observed peak only.
  3. Hold-to-EOD — for 0DTE: intrinsic at expiration; for longer-DTE:
     last available mid_price at session close.

Inputs:
    ml/data/iv-anomaly-outcomes.parquet (Phase A output)

Outputs:
    ml/data/iv-anomaly-backtest-2026-04-25.parquet  (per-alert PnL per strategy)
    ml/reports/iv-anomaly-backtest-2026-04-25.md     (human-readable tables)
    ml/plots/iv-anomaly-backtest/*.png               (per-ticker comparisons)

Caveats (documented in the report too):
  - No slippage or commission modeling; PnL assumes mid-price execution.
    Real-world fills are worse — relative ranking between strategies is
    meaningful, absolute returns are optimistic.
  - PREMIUM trajectory is sparse post-ITM (production cron only ingests
    OTM strikes). For sell-on-ITM, premium at crossing is approximated
    by the last available OTM snapshot before strike fell off the
    snapshot table. For hold-to-EOD on non-0DTE strikes that went deep
    ITM, the realized PnL is UNDER-stated.
  - peak_premium is from observed OTM snapshots only — true peak (post-
    ITM) may be higher. Sell-at-peak is therefore a LOWER bound on the
    oracle's upside.
  - 0DTE intrinsic-at-close is exact (computed from spot trajectory at
    settlement) regardless of premium-trajectory sparsity.
  - Sample: 10 trading days (4/13-4/24), 15,886 alerts. Treat as
    directional, not statistically conclusive.

Usage:
    ml/.venv/bin/python ml/backtest-iv-anomalies.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
INPUT_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-outcomes.parquet"
OUTPUT_PARQUET = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
REPORT_PATH = REPO_ROOT / "ml" / "reports" / "iv-anomaly-backtest-2026-04-25.md"
PLOTS_DIR = REPO_ROOT / "ml" / "plots" / "iv-anomaly-backtest"


def load_outcomes() -> pd.DataFrame:
    if not INPUT_PATH.exists():
        raise RuntimeError(
            f"Phase A output not found at {INPUT_PATH}. Run extract-iv-anomaly-outcomes.py first."
        )
    df = pd.read_parquet(INPUT_PATH)
    print(f"[load] {len(df)} alerts from {INPUT_PATH}", file=sys.stderr)
    return df


def compute_strategy_pnl(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute per-alert PnL for the three strategies. Adds columns:
      pnl_itm_touch, pnl_peak (oracle), pnl_eod.
    Each is a fractional return (e.g. 0.30 = +30%, -1.0 = total loss).
    """
    out = df.copy()

    entry = out["entry_premium"].astype(float)
    peak = out["peak_premium"].astype(float)
    last_otm = out["last_strike_premium"].astype(float)
    intrinsic_close = out["intrinsic_at_close"].astype(float)
    is_0dte = out["dte_bucket"].astype(str) == "0DTE"
    touched = out["touched_itm"].fillna(0).astype(int) == 1
    finished = out["finished_itm"].fillna(0).astype(int) == 1

    # === Strategy 1: Sell-on-ITM-touch ===
    #
    # If the strike never touched ITM, this strategy held to EOD (same as
    # strategy 3). If touched, sell when spot crossed strike. Premium at
    # crossing ≈ last_strike_premium (OTM premium just before snapshot
    # pipeline dropped the strike). For never-touched alerts, fall
    # through to hold-to-EOD's PnL — assigned in pass 3 below.
    #
    # Edge case: an alert where touched_itm is true but last_otm is NaN
    # (no premium snapshots collected for that strike — happens when the
    # alert fired at the very end of the snapshot data). We can't
    # estimate a sell price; mark as NaN.
    out["pnl_itm_touch"] = np.where(
        touched & last_otm.notna() & (entry > 0),
        last_otm / entry - 1,
        np.nan,
    )

    # === Strategy 2: Sell-at-peak (oracle) ===
    out["pnl_peak"] = np.where(
        peak.notna() & (entry > 0),
        peak / entry - 1,
        np.nan,
    )

    # === Strategy 3: Hold-to-EOD ===
    #
    # 0DTE: PnL = intrinsic_at_close / entry - 1. If finished OTM, intrinsic
    #            is 0 → PnL = -1 (-100%, full premium loss).
    # Non-0DTE: PnL = last_strike_premium / entry - 1 if available,
    #               else NaN (incomplete snapshot data).
    pnl_eod_0dte = np.where(
        is_0dte & (entry > 0),
        intrinsic_close / entry - 1,
        np.nan,
    )
    pnl_eod_other = np.where(
        ~is_0dte & last_otm.notna() & (entry > 0),
        last_otm / entry - 1,
        np.nan,
    )
    out["pnl_eod"] = np.where(is_0dte, pnl_eod_0dte, pnl_eod_other)

    # Strategy 1 fallback: when never touched ITM, sell-on-ITM is the
    # same as hold-to-EOD (you hold all day looking for an exit signal
    # that never comes).
    out.loc[~touched, "pnl_itm_touch"] = out.loc[~touched, "pnl_eod"]

    # Worth-trading flag — the alert produced a complete-enough record
    # that backtest stats are valid.
    out["valid_backtest"] = (
        out["pnl_eod"].notna() | out["pnl_itm_touch"].notna() | out["pnl_peak"].notna()
    )
    return out


def aggregate_by_strategy(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    """Group by `group_cols` and compute strategy stats."""
    rows = []
    for keys, sub in df.groupby(group_cols, observed=True):
        if not isinstance(keys, tuple):
            keys = (keys,)
        n_total = len(sub)
        for strat in ["pnl_itm_touch", "pnl_peak", "pnl_eod"]:
            valid = sub[strat].dropna()
            if len(valid) == 0:
                continue
            rows.append(
                {
                    **dict(zip(group_cols, keys)),
                    "strategy": strat.replace("pnl_", ""),
                    "n_alerts": n_total,
                    "n_valid": len(valid),
                    "win_rate_pos": (valid > 0).mean(),
                    "win_rate_30pct": (valid >= 0.30).mean(),
                    "win_rate_100pct": (valid >= 1.0).mean(),
                    "mean_pnl": valid.mean(),
                    "median_pnl": valid.median(),
                    "p25_pnl": valid.quantile(0.25),
                    "p75_pnl": valid.quantile(0.75),
                    "max_loss": valid.min(),
                    "max_gain": valid.max(),
                    # Sharpe-like (mean / stddev) — undefined when stddev=0
                    "sharpe_like": valid.mean() / valid.std() if valid.std() > 0 else np.nan,
                }
            )
    return pd.DataFrame(rows)


def fmt_pct(x: float) -> str:
    if pd.isna(x):
        return "—"
    return f"{x * 100:+.1f}%"


def fmt_pct_unsigned(x: float) -> str:
    if pd.isna(x):
        return "—"
    return f"{x * 100:.1f}%"


def fmt_int(x: float) -> str:
    if pd.isna(x):
        return "—"
    return f"{int(x):,}"


def render_strategy_table(stats: pd.DataFrame, title: str) -> str:
    if stats.empty:
        return f"### {title}\n\n_No data._\n"
    lines = [f"### {title}\n"]
    grouping_cols = [
        c
        for c in stats.columns
        if c
        not in {
            "strategy",
            "n_alerts",
            "n_valid",
            "win_rate_pos",
            "win_rate_30pct",
            "win_rate_100pct",
            "mean_pnl",
            "median_pnl",
            "p25_pnl",
            "p75_pnl",
            "max_loss",
            "max_gain",
            "sharpe_like",
        }
    ]
    header = (
        "| "
        + " | ".join(grouping_cols)
        + " | strategy | n | win% | 30%+ win | mean | median | p25 | p75 | max loss | max gain | Sharpe-ish |"
    )
    sep = "| " + " | ".join(["---"] * (len(grouping_cols) + 11)) + " |"
    lines.append(header)
    lines.append(sep)
    for _, r in stats.iterrows():
        row = (
            "| "
            + " | ".join(str(r[c]) for c in grouping_cols)
            + f" | {r['strategy']}"
            + f" | {fmt_int(r['n_valid'])}"
            + f" | {fmt_pct_unsigned(r['win_rate_pos'])}"
            + f" | {fmt_pct_unsigned(r['win_rate_30pct'])}"
            + f" | {fmt_pct(r['mean_pnl'])}"
            + f" | {fmt_pct(r['median_pnl'])}"
            + f" | {fmt_pct(r['p25_pnl'])}"
            + f" | {fmt_pct(r['p75_pnl'])}"
            + f" | {fmt_pct(r['max_loss'])}"
            + f" | {fmt_pct(r['max_gain'])}"
            + (
                " | —"
                if pd.isna(r["sharpe_like"])
                else f" | {r['sharpe_like']:.2f}"
            )
            + " |"
        )
        lines.append(row)
    return "\n".join(lines) + "\n"


def best_strategy_per_ticker(stats: pd.DataFrame) -> pd.DataFrame:
    """Return one row per ticker recommending the best non-oracle strategy."""
    excluded = {"peak"}
    pivoted = stats[~stats["strategy"].isin(excluded)].copy()
    rows = []
    for ticker, sub in pivoted.groupby("ticker", observed=True):
        # Rank by Sharpe-ish, fall back to mean_pnl if Sharpe undefined
        sub = sub.sort_values(
            by=["sharpe_like", "mean_pnl"], ascending=[False, False], na_position="last"
        )
        top = sub.iloc[0]
        rows.append(
            {
                "ticker": ticker,
                "n_alerts": top["n_alerts"],
                "best_strategy": top["strategy"],
                "best_win_rate": top["win_rate_pos"],
                "best_mean_pnl": top["mean_pnl"],
                "best_median_pnl": top["median_pnl"],
                "best_max_loss": top["max_loss"],
            }
        )
    return pd.DataFrame(rows)


def write_plots(df: pd.DataFrame, by_ticker: pd.DataFrame) -> None:
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Win-rate-by-strategy bar chart per ticker
    pivot = (
        by_ticker.pivot_table(
            index="ticker", columns="strategy", values="win_rate_pos", aggfunc="first"
        )
        * 100
    )
    pivot = pivot.reindex(columns=["itm_touch", "peak", "eod"], fill_value=0)
    fig, ax = plt.subplots(figsize=(11, 6))
    pivot.plot(kind="bar", ax=ax, color=["#3b82f6", "#94a3b8", "#ef4444"])
    ax.set_ylabel("Win rate %")
    ax.set_xlabel("Ticker")
    ax.set_title(
        "Win rate (% PnL > 0) by strategy and ticker — IV anomaly backfill 2026-04-13/04-24",
        fontsize=11,
    )
    ax.legend(title="Strategy")
    ax.grid(axis="y", alpha=0.3)
    plt.xticks(rotation=0)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "win-rate-by-strategy.png", dpi=120)
    plt.close()

    # 2. Mean-PnL bar chart
    pivot_mean = (
        by_ticker.pivot_table(
            index="ticker", columns="strategy", values="mean_pnl", aggfunc="first"
        )
        * 100
    )
    pivot_mean = pivot_mean.reindex(columns=["itm_touch", "peak", "eod"], fill_value=0)
    fig, ax = plt.subplots(figsize=(11, 6))
    pivot_mean.plot(kind="bar", ax=ax, color=["#3b82f6", "#94a3b8", "#ef4444"])
    ax.set_ylabel("Mean PnL %")
    ax.set_xlabel("Ticker")
    ax.set_title("Mean PnL % by strategy and ticker", fontsize=11)
    ax.axhline(0, color="black", linewidth=0.8)
    ax.legend(title="Strategy")
    ax.grid(axis="y", alpha=0.3)
    plt.xticks(rotation=0)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "mean-pnl-by-strategy.png", dpi=120)
    plt.close()

    # 3. Time-to-ITM histogram for alerts that touched
    touched = df[df["touched_itm"] == 1].copy()
    if not touched.empty:
        fig, ax = plt.subplots(figsize=(11, 6))
        for ticker, sub in touched.groupby("ticker"):
            t = sub["minutes_to_first_itm"].dropna()
            if len(t) >= 10:
                ax.hist(t, bins=30, alpha=0.4, label=f"{ticker} (n={len(t)})")
        ax.set_xlabel("Minutes from alert to first ITM touch")
        ax.set_ylabel("Count")
        ax.set_title(
            "Time from alert to first ITM crossing — by ticker (n≥10)", fontsize=11
        )
        ax.legend(fontsize=8)
        ax.set_xlim(0, 400)
        plt.tight_layout()
        plt.savefig(PLOTS_DIR / "time-to-itm-by-ticker.png", dpi=120)
        plt.close()

    # 4. PnL distribution box plot per strategy (overall)
    fig, ax = plt.subplots(figsize=(10, 6))
    box_data = []
    box_labels = []
    for strat_col, label in [
        ("pnl_itm_touch", "ITM-touch"),
        ("pnl_peak", "Peak (oracle)"),
        ("pnl_eod", "Hold-to-EOD"),
    ]:
        d = df[strat_col].dropna()
        # Clip to [-1, 5] so the boxplot is readable (oracle peak can hit
        # +20× / +50×; full distribution is reported in the table).
        d = d.clip(-1, 5)
        box_data.append(d)
        box_labels.append(f"{label}\n(n={len(d)})")
    ax.boxplot(box_data, tick_labels=box_labels, showfliers=False)
    ax.set_ylabel("PnL (clipped to [-100%, +500%] for readability)")
    ax.set_title("PnL distribution by strategy (all tickers, all DTE)", fontsize=11)
    ax.axhline(0, color="black", linewidth=0.8)
    ax.grid(axis="y", alpha=0.3)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "pnl-boxplot.png", dpi=120)
    plt.close()

    # 5. 0DTE-specific: % touched ITM but finished OTM (the trap)
    zero = df[df["dte_bucket"].astype(str) == "0DTE"].copy()
    zero["touched_then_otm"] = (
        (zero["touched_itm"] == 1) & (zero["finished_itm"] == 0)
    ).astype(int)
    by_ticker_trap = (
        zero.groupby("ticker")
        .agg(
            n_touched=("touched_itm", "sum"),
            n_touched_then_otm=("touched_then_otm", "sum"),
        )
        .reset_index()
    )
    by_ticker_trap["pct_retraced"] = (
        by_ticker_trap["n_touched_then_otm"]
        / by_ticker_trap["n_touched"].replace(0, np.nan)
        * 100
    )
    by_ticker_trap = by_ticker_trap.sort_values("pct_retraced", ascending=False)
    fig, ax = plt.subplots(figsize=(11, 6))
    ax.bar(by_ticker_trap["ticker"], by_ticker_trap["pct_retraced"], color="#dc2626")
    ax.set_ylabel("% of touched-ITM 0DTEs that finished OTM")
    ax.set_xlabel("Ticker")
    ax.set_title(
        "0DTE retrace rate — touched ITM but expired OTM (the trap)\nHigh % = sell-on-ITM-touch is critical",
        fontsize=11,
    )
    ax.grid(axis="y", alpha=0.3)
    for i, v in enumerate(by_ticker_trap["pct_retraced"]):
        if not pd.isna(v):
            ax.text(i, v + 1, f"{v:.0f}%", ha="center", fontsize=9)
    plt.xticks(rotation=0)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / "0dte-retrace-rate.png", dpi=120)
    plt.close()

    print(f"[plots] wrote 5 plots to {PLOTS_DIR}", file=sys.stderr)


def write_report(
    df: pd.DataFrame,
    by_ticker: pd.DataFrame,
    by_dte: pd.DataFrame,
    by_ticker_dte: pd.DataFrame,
    best: pd.DataFrame,
) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# IV-Anomaly Backtest — 2026-04-25\n")
    lines.append(
        "**Sample:** 15,886 backfill alerts from `iv_anomalies` (4/13-4/24, 13 tickers).\n"
    )
    lines.append(
        "**Strategies compared:** sell-on-ITM-touch, sell-at-peak (oracle), hold-to-EOD.\n"
    )
    lines.append("**Caveats:**\n")
    lines.append(
        "- No slippage / commission. Real fills are worse than mid. Relative ranking is meaningful; absolute returns are optimistic.\n"
    )
    lines.append(
        "- Premium trajectory is sparse post-ITM (snapshot table only stores OTM strikes). Sell-on-ITM-touch premium ≈ last OTM snapshot before crossing. Peak underestimates ITM upside. Hold-to-EOD on non-0DTE deep-ITM strikes understated.\n"
    )
    lines.append(
        "- 0DTE intrinsic-at-close is exact (computed from spot trajectory at settlement).\n"
    )

    # Overall
    lines.append("## Overall (all tickers, all DTE)\n")
    overall = aggregate_by_strategy(df, ["dte_bucket"]).query(
        "dte_bucket == dte_bucket"
    )  # drop NaN
    lines.append(render_strategy_table(overall, "By DTE bucket"))

    # Per-ticker recommendations
    lines.append("\n## Best non-oracle strategy per ticker\n")
    lines.append(
        "Ranked by Sharpe-like (mean / stddev). Excludes the cheating oracle 'peak'. **Higher win rate + smaller max loss = better trade.**\n"
    )
    lines.append(
        "| Ticker | n | Best strategy | Win rate | Mean PnL | Median PnL | Max loss |\n"
    )
    lines.append("| --- | --- | --- | --- | --- | --- | --- |\n")
    for _, r in best.iterrows():
        lines.append(
            f"| {r['ticker']} | {fmt_int(r['n_alerts'])} | {r['best_strategy']} | "
            f"{fmt_pct_unsigned(r['best_win_rate'])} | {fmt_pct(r['best_mean_pnl'])} | "
            f"{fmt_pct(r['best_median_pnl'])} | {fmt_pct(r['best_max_loss'])} |\n"
        )

    # Per-ticker full breakdown
    lines.append("\n## Per-ticker, all 3 strategies\n")
    lines.append(render_strategy_table(by_ticker, "All tickers × all strategies"))

    # Per-ticker × DTE
    lines.append("\n## Per-ticker × DTE bucket\n")
    lines.append(render_strategy_table(by_ticker_dte, "Ticker × DTE × strategy"))

    # 0DTE retrace trap
    lines.append("\n## 0DTE retrace trap\n")
    lines.append(
        "Touched ITM but finished OTM = full premium loss on hold-to-EOD. High retrace % = sell-on-ITM-touch is structurally necessary.\n"
    )
    zero = df[df["dte_bucket"].astype(str) == "0DTE"].copy()
    zero["touched_then_otm"] = (
        (zero["touched_itm"] == 1) & (zero["finished_itm"] == 0)
    ).astype(int)
    trap = zero.groupby("ticker").agg(
        n_alerts=("touched_itm", "count"),
        n_touched=("touched_itm", "sum"),
        n_touched_finished_otm=("touched_then_otm", "sum"),
    )
    trap["touched_pct"] = trap["n_touched"] / trap["n_alerts"] * 100
    trap["retrace_pct"] = (
        trap["n_touched_finished_otm"] / trap["n_touched"].replace(0, np.nan) * 100
    )
    trap = trap.sort_values("retrace_pct", ascending=False)
    lines.append(
        "| Ticker | n alerts | touched ITM | touched% | touched-then-OTM | retrace% |\n"
    )
    lines.append("| --- | --- | --- | --- | --- | --- |\n")
    for ticker, r in trap.iterrows():
        lines.append(
            f"| {ticker} | {fmt_int(r['n_alerts'])} | {fmt_int(r['n_touched'])} | "
            f"{fmt_pct_unsigned(r['touched_pct'] / 100)} | {fmt_int(r['n_touched_finished_otm'])} | "
            f"{fmt_pct_unsigned(r['retrace_pct'] / 100) if not pd.isna(r['retrace_pct']) else '—'} |\n"
        )

    # Time-to-ITM
    lines.append("\n## Time from alert to first ITM (minutes, alerts that touched)\n")
    touched = df[df["touched_itm"] == 1].copy()
    tti = (
        touched.groupby("ticker")["minutes_to_first_itm"]
        .agg(["count", "median", "mean", "min", "max"])
        .rename(columns={"count": "n_touched"})
    )
    tti = tti.sort_values("median")
    lines.append(
        "| Ticker | n touched | median min | mean min | min | max |\n"
    )
    lines.append("| --- | --- | --- | --- | --- | --- |\n")
    for ticker, r in tti.iterrows():
        lines.append(
            f"| {ticker} | {fmt_int(r['n_touched'])} | "
            f"{int(r['median']) if not pd.isna(r['median']) else '—'} | "
            f"{int(r['mean']) if not pd.isna(r['mean']) else '—'} | "
            f"{int(r['min']) if not pd.isna(r['min']) else '—'} | "
            f"{int(r['max']) if not pd.isna(r['max']) else '—'} |\n"
        )

    REPORT_PATH.write_text("".join(lines))
    print(f"[report] wrote {REPORT_PATH}", file=sys.stderr)


def main() -> None:
    df = load_outcomes()
    df = compute_strategy_pnl(df)

    print(f"[backtest] valid alerts: {df['valid_backtest'].sum()}", file=sys.stderr)
    print("[backtest] aggregating per ticker / DTE / strategy...", file=sys.stderr)

    by_ticker = aggregate_by_strategy(df, ["ticker"])
    by_dte = aggregate_by_strategy(df, ["dte_bucket"])
    by_ticker_dte = aggregate_by_strategy(df, ["ticker", "dte_bucket"])

    best = best_strategy_per_ticker(by_ticker)
    print("\n=== Best strategy per ticker (excluding oracle) ===", file=sys.stderr)
    print(best.to_string(index=False), file=sys.stderr)

    OUTPUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUTPUT_PARQUET, index=False)
    print(f"\n[done] backtest parquet: {OUTPUT_PARQUET}", file=sys.stderr)

    write_plots(df, by_ticker)
    write_report(df, by_ticker, by_dte, by_ticker_dte, best)


if __name__ == "__main__":
    main()
