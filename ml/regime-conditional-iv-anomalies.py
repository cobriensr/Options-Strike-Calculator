"""IV-anomaly Phase D0 — regime-conditional headline.

Re-cuts Phase B/C numbers conditioned on each ticker's own daily
regime label (chop / mild_trend / strong_trend / extreme × up/down).

Per-(ticker, regime) BEST_STRATEGY is re-picked from the three
candidates — NOT inherited from Phase B's blind pick — because the
right exit on NVDA-trending-up is not the right exit on NVDA-chop.

Outputs:
- ml/findings/iv-anomaly-regime-conditional-2026-04-25.json
- ml/reports/iv-anomaly-regime-conditional-2026-04-25.md
- ml/plots/iv-anomaly-regime-conditional/*.png
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKTEST_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
OUT_FINDINGS = REPO_ROOT / "ml" / "findings" / "iv-anomaly-regime-conditional-2026-04-25.json"
OUT_REPORT = REPO_ROOT / "ml" / "reports" / "iv-anomaly-regime-conditional-2026-04-25.md"
OUT_PLOTS = REPO_ROOT / "ml" / "plots" / "iv-anomaly-regime-conditional"

STRATEGIES = ["pnl_itm_touch", "pnl_eod", "pnl_peak"]
NON_ORACLE = ["pnl_itm_touch", "pnl_eod"]

# Regime thresholds (absolute % change of the underlying)
def regime_label(pct: float) -> str:
    if pd.isna(pct):
        return "unknown"
    a = abs(pct)
    if a < 0.25:
        return "chop"
    direction = "up" if pct > 0 else "down"
    if a < 1.0:
        return f"mild_trend_{direction}"
    if a < 2.0:
        return f"strong_trend_{direction}"
    return f"extreme_{direction}"


def load_and_label() -> pd.DataFrame:
    df = pd.read_parquet(BACKTEST_PATH)
    df["alert_ct"] = pd.to_datetime(df["alert_ts"], utc=True).dt.tz_convert("US/Central")
    df["date"] = df["alert_ct"].dt.date

    # Per (ticker, date) regime: first observed spot vs last observed spot of the day.
    # spot_at_detect of earliest alert ≈ open; close_spot of latest alert ≈ close.
    day = (
        df.sort_values("alert_ct")
        .groupby(["ticker", "date"])
        .agg(
            first_spot=("spot_at_detect", "first"),
            last_spot=("close_spot", "last"),
        )
        .reset_index()
    )
    day["pct_change"] = (day["last_spot"] - day["first_spot"]) / day["first_spot"] * 100.0
    day["regime"] = day["pct_change"].apply(regime_label)

    df = df.merge(day[["ticker", "date", "regime", "pct_change"]], on=["ticker", "date"], how="left")
    df["entry_dollars"] = df["entry_premium"].astype(float) * 100.0
    return df


def pick_best_strategy(group: pd.DataFrame) -> str:
    """Sharpe-ish (mean/std) over non-oracle strategies."""
    best, best_score = None, -np.inf
    for strat in NON_ORACLE:
        col = group[strat].dropna()
        if len(col) < 5 or col.std() == 0 or pd.isna(col.std()):
            continue
        score = col.mean() / col.std()
        if score > best_score:
            best, best_score = strat, score
    return best or "pnl_eod"


def aggregate(df: pd.DataFrame, group_cols: list[str], strategy_col: str) -> pd.DataFrame:
    pnl = df[strategy_col]
    out = (
        df.assign(_pnl=pnl, _dollars=df["entry_dollars"] * pnl)
        .dropna(subset=["_pnl"])
        .groupby(group_cols, dropna=False)
        .agg(
            n=("anomaly_id", "count"),
            win_pct=("_pnl", lambda x: float((x > 0).mean() * 100.0)),
            mean_pct=("_pnl", "mean"),
            median_pct=("_pnl", "median"),
            mean_dollar=("_dollars", "mean"),
            median_dollar=("_dollars", "median"),
            max_loss_dollar=("_dollars", "min"),
            max_gain_dollar=("_dollars", "max"),
        )
    )
    return out.round(2)


def per_ticker_regime_best(df: pd.DataFrame) -> dict[tuple[str, str], str]:
    """Pick best non-oracle strategy per (ticker, regime). Falls back to ticker-level pick if regime sample <30."""
    best = {}
    ticker_level: dict[str, str] = {}
    for ticker, sub in df.groupby("ticker"):
        ticker_level[ticker] = pick_best_strategy(sub)
    for (ticker, regime), sub in df.groupby(["ticker", "regime"]):
        if len(sub) >= 30:
            best[(ticker, regime)] = pick_best_strategy(sub)
        else:
            best[(ticker, regime)] = ticker_level[ticker]
    return best, ticker_level


def apply_best(df: pd.DataFrame, best_map: dict[tuple[str, str], str]) -> pd.DataFrame:
    df = df.copy()
    df["best_strategy"] = df.apply(lambda r: best_map.get((r["ticker"], r["regime"]), "pnl_eod"), axis=1)
    df["best_pnl_pct"] = df.apply(lambda r: r[r["best_strategy"]] if pd.notna(r[r["best_strategy"]]) else np.nan, axis=1)
    df["best_dollar"] = df["entry_dollars"] * df["best_pnl_pct"]
    return df


# ──────── Plotting ────────

def plot_regime_winrate_by_ticker(df: pd.DataFrame, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    base_regimes = ["chop", "mild_trend_up", "strong_trend_up", "extreme_up", "mild_trend_down", "strong_trend_down", "extreme_down"]
    for ticker in sorted(df["ticker"].unique()):
        sub = df[df["ticker"] == ticker].dropna(subset=["best_pnl_pct"])
        if len(sub) < 30:
            continue
        agg = (
            sub.groupby(["regime", "side"])
            .agg(
                n=("anomaly_id", "count"),
                win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100.0)),
            )
            .reset_index()
        )
        if len(agg) == 0:
            continue
        fig, ax = plt.subplots(figsize=(10, 4.5))
        regimes = [r for r in base_regimes if r in agg["regime"].unique()]
        sides = ["call", "put"]
        x = np.arange(len(regimes))
        width = 0.35
        for i, side in enumerate(sides):
            vals = [
                agg[(agg["regime"] == r) & (agg["side"] == side)]["win_pct"].iloc[0]
                if not agg[(agg["regime"] == r) & (agg["side"] == side)].empty
                else 0.0
                for r in regimes
            ]
            ns = [
                int(agg[(agg["regime"] == r) & (agg["side"] == side)]["n"].iloc[0])
                if not agg[(agg["regime"] == r) & (agg["side"] == side)].empty
                else 0
                for r in regimes
            ]
            bars = ax.bar(x + (i - 0.5) * width, vals, width, label=side, color="#1f77b4" if side == "call" else "#d62728")
            for bar, n in zip(bars, ns):
                if n > 0:
                    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1, f"n={n}", ha="center", fontsize=7)
        ax.set_xticks(x)
        ax.set_xticklabels([r.replace("_", "\n") for r in regimes], fontsize=8)
        ax.set_ylabel("win rate %")
        ax.set_title(f"{ticker} — win rate by regime × side (best strategy per (ticker, regime))")
        ax.legend()
        ax.grid(axis="y", alpha=0.3)
        plt.tight_layout()
        fig.savefig(out_dir / f"{ticker}-winrate-by-regime.png", dpi=120)
        plt.close(fig)


def plot_aggregate_regime(df: pd.DataFrame, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    base_regimes = ["chop", "mild_trend_up", "strong_trend_up", "extreme_up", "mild_trend_down", "strong_trend_down", "extreme_down"]
    sub = df.dropna(subset=["best_pnl_pct"])
    agg = (
        sub.groupby(["regime", "side"])
        .agg(
            n=("anomaly_id", "count"),
            win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100.0)),
            mean_dollar=("best_dollar", "mean"),
        )
        .reset_index()
    )
    fig, axes = plt.subplots(1, 2, figsize=(14, 4.5))
    regimes = [r for r in base_regimes if r in agg["regime"].unique()]
    sides = ["call", "put"]
    x = np.arange(len(regimes))
    width = 0.35
    for i, side in enumerate(sides):
        vals_w = [
            agg[(agg["regime"] == r) & (agg["side"] == side)]["win_pct"].iloc[0]
            if not agg[(agg["regime"] == r) & (agg["side"] == side)].empty
            else 0.0
            for r in regimes
        ]
        vals_d = [
            agg[(agg["regime"] == r) & (agg["side"] == side)]["mean_dollar"].iloc[0]
            if not agg[(agg["regime"] == r) & (agg["side"] == side)].empty
            else 0.0
            for r in regimes
        ]
        axes[0].bar(x + (i - 0.5) * width, vals_w, width, label=side, color="#1f77b4" if side == "call" else "#d62728")
        axes[1].bar(x + (i - 0.5) * width, vals_d, width, label=side, color="#1f77b4" if side == "call" else "#d62728")
    for ax in axes:
        ax.set_xticks(x)
        ax.set_xticklabels([r.replace("_", "\n") for r in regimes], fontsize=8)
        ax.legend()
        ax.grid(axis="y", alpha=0.3)
    axes[0].set_ylabel("win rate %")
    axes[0].set_title("All tickers — win rate by regime × side")
    axes[1].set_ylabel("mean $/contract")
    axes[1].set_title("All tickers — mean dollar PnL/contract by regime × side")
    plt.tight_layout()
    fig.savefig(out_dir / "aggregate-regime-side.png", dpi=120)
    plt.close(fig)


# ──────── Main ────────

def main() -> None:
    df = load_and_label()
    print(f"Loaded {len(df):,} alerts across {df['ticker'].nunique()} tickers and "
          f"{df['date'].nunique()} trading days.")

    best_map, ticker_level = per_ticker_regime_best(df)
    df = apply_best(df, best_map)

    # Per-ticker × regime × side
    pts = aggregate(df, ["ticker", "regime", "side"], "best_pnl_pct")
    # Aggregate × regime × side
    agg = aggregate(df, ["regime", "side"], "best_pnl_pct")
    # Aggregate × regime (both sides combined)
    agg_no_side = aggregate(df, ["regime"], "best_pnl_pct")

    # Per-(ticker, regime) headline including pct_change of those days
    day_summary = (
        df.groupby(["ticker", "regime"])
        .agg(
            n_alerts=("anomaly_id", "count"),
            n_days=("date", "nunique"),
            mean_pct_change=("pct_change", "mean"),
        )
        .round(2)
    )

    # ──────── JSON findings ────────
    findings = {
        "thresholds": {
            "chop": "|Δ| < 0.25%",
            "mild_trend": "0.25–1.0%",
            "strong_trend": "1.0–2.0%",
            "extreme": ">2.0%",
        },
        "lookahead_caveat": (
            "Regime label uses the underlying's same-day close. At alert_ts you "
            "do not yet know how the day will close. Read these numbers as "
            "'given you correctly identify the regime, this is the available edge.'"
        ),
        "per_ticker_regime_best_strategy": {f"{k[0]}__{k[1]}": v for k, v in best_map.items()},
        "ticker_level_best_strategy": ticker_level,
        "per_ticker_regime_side": pts.reset_index().to_dict(orient="records"),
        "aggregate_regime_side": agg.reset_index().to_dict(orient="records"),
        "aggregate_regime": agg_no_side.reset_index().to_dict(orient="records"),
        "ticker_regime_day_summary": day_summary.reset_index().to_dict(orient="records"),
    }
    OUT_FINDINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FINDINGS.write_text(json.dumps(findings, indent=2, default=str))
    print(f"Wrote {OUT_FINDINGS}")

    # ──────── Markdown report ────────
    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# IV-Anomaly Regime-Conditional (Phase D0) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts, {df['date'].nunique()} trading days, "
                 f"{df['ticker'].nunique()} tickers.")
    lines.append("**Regime label:** the **underlying ticker's own** daily % change "
                 "(open ≈ first observed spot of day; close ≈ last observed spot).")
    lines.append("")
    lines.append("**Thresholds:**")
    lines.append("")
    lines.append("- chop: `|Δ| < 0.25%`")
    lines.append("- mild_trend_(up|down): `0.25–1.0%`")
    lines.append("- strong_trend_(up|down): `1.0–2.0%`")
    lines.append("- extreme_(up|down): `>2.0%`")
    lines.append("")
    lines.append("**Lookahead caveat:** uses the day's actual close to label regime. "
                 "These numbers tell you 'given you correctly identify the regime at "
                 "alert_ts, this is the available edge' — not 'this is what the alert "
                 "predicts going forward.'")
    lines.append("")

    # Aggregate × regime × side
    lines.append("## Aggregate (all tickers)")
    lines.append("")
    lines.append("### Regime × side")
    lines.append("")
    lines.append("| regime | side | n | win% | mean% | mean $ | median $ | max gain $ | max loss $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for (regime, side), row in agg.iterrows():
        lines.append(
            f"| {regime} | {side} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} | "
            f"${row['median_dollar']:,.0f} | ${row['max_gain_dollar']:,.0f} | "
            f"${row['max_loss_dollar']:,.0f} |"
        )
    lines.append("")

    # Per-ticker breakdown
    lines.append("## Per-ticker × regime × side")
    lines.append("")
    lines.append("Best strategy is re-picked per `(ticker, regime)` when n ≥ 30, else "
                 "falls back to ticker-level Sharpe-ish pick.")
    lines.append("")
    lines.append("| ticker | regime | side | best strat | n | win% | mean% | mean $ | median $ | max loss $ |")
    lines.append("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for (ticker, regime, side), row in pts.iterrows():
        strat = best_map.get((ticker, regime), "pnl_eod").replace("pnl_", "")
        lines.append(
            f"| {ticker} | {regime} | {side} | {strat} | {int(row['n']):,} | "
            f"{row['win_pct']:.1f}% | {row['mean_pct']*100:.1f}% | "
            f"${row['mean_dollar']:,.0f} | ${row['median_dollar']:,.0f} | "
            f"${row['max_loss_dollar']:,.0f} |"
        )
    lines.append("")

    # Days × regime calibration table
    lines.append("## Sanity check — days per ticker × regime")
    lines.append("")
    lines.append("| ticker | regime | n alerts | n days | mean Δ% |")
    lines.append("| --- | --- | ---: | ---: | ---: |")
    for (ticker, regime), row in day_summary.iterrows():
        lines.append(
            f"| {ticker} | {regime} | {int(row['n_alerts']):,} | {int(row['n_days'])} | "
            f"{row['mean_pct_change']:+.2f}% |"
        )
    lines.append("")

    # Per-(ticker, regime) BEST_STRATEGY decisions
    lines.append("## Per-(ticker, regime) BEST_STRATEGY picks")
    lines.append("")
    lines.append("| ticker | regime | strategy |")
    lines.append("| --- | --- | --- |")
    for (ticker, regime), strat in sorted(best_map.items()):
        lines.append(f"| {ticker} | {regime} | {strat.replace('pnl_', '')} |")
    lines.append("")

    OUT_REPORT.write_text("\n".join(lines))
    print(f"Wrote {OUT_REPORT}")

    # ──────── Plots ────────
    plot_aggregate_regime(df, OUT_PLOTS)
    plot_regime_winrate_by_ticker(df, OUT_PLOTS)
    print(f"Wrote plots to {OUT_PLOTS}")


if __name__ == "__main__":
    main()
