"""IV-anomaly Phase D3 — population / cohort × regime.

Asks: are wins concentrated on one day? Does the 1st firing of a
compound key beat the Nth? Is there a day-density relationship?

All sliced by regime per D0's classifier.

Outputs:
- ml/findings/iv-anomaly-cohort-2026-04-25.json
- ml/reports/iv-anomaly-cohort-2026-04-25.md
- ml/plots/iv-anomaly-cohort/*.png
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKTEST_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
OUT_FINDINGS = REPO_ROOT / "ml" / "findings" / "iv-anomaly-cohort-2026-04-25.json"
OUT_REPORT = REPO_ROOT / "ml" / "reports" / "iv-anomaly-cohort-2026-04-25.md"
OUT_PLOTS = REPO_ROOT / "ml" / "plots" / "iv-anomaly-cohort"

NON_ORACLE = ["pnl_itm_touch", "pnl_eod"]


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


def load_label_and_pick() -> pd.DataFrame:
    df = pd.read_parquet(BACKTEST_PATH)
    df["alert_ct"] = pd.to_datetime(df["alert_ts"], utc=True).dt.tz_convert("US/Central")
    df["date"] = df["alert_ct"].dt.date

    day = (
        df.sort_values("alert_ct")
        .groupby(["ticker", "date"])
        .agg(first_spot=("spot_at_detect", "first"), last_spot=("close_spot", "last"))
        .reset_index()
    )
    day["pct_change"] = (day["last_spot"] - day["first_spot"]) / day["first_spot"] * 100.0
    day["regime"] = day["pct_change"].apply(regime_label)
    df = df.merge(day[["ticker", "date", "regime"]], on=["ticker", "date"], how="left")

    # Per-(ticker, regime) best non-oracle strategy
    best = {}
    ticker_level = {}
    for ticker, sub in df.groupby("ticker"):
        scores = {s: sub[s].dropna().mean() / sub[s].dropna().std() for s in NON_ORACLE if sub[s].dropna().std()}
        ticker_level[ticker] = max(scores, key=scores.get) if scores else "pnl_eod"
    for (ticker, regime), sub in df.groupby(["ticker", "regime"]):
        if len(sub) >= 30:
            scores = {s: sub[s].dropna().mean() / sub[s].dropna().std() for s in NON_ORACLE if sub[s].dropna().std()}
            best[(ticker, regime)] = max(scores, key=scores.get) if scores else ticker_level[ticker]
        else:
            best[(ticker, regime)] = ticker_level[ticker]

    df["best_strategy"] = df.apply(lambda r: best.get((r["ticker"], r["regime"]), "pnl_eod"), axis=1)
    df["best_pnl_pct"] = df.apply(lambda r: r[r["best_strategy"]] if pd.notna(r[r["best_strategy"]]) else np.nan, axis=1)
    df["entry_dollars"] = df["entry_premium"].astype(float) * 100.0
    df["best_dollar"] = df["entry_dollars"] * df["best_pnl_pct"]

    # Compound key per (ticker, strike, side, expiry, date)
    df = df.sort_values("alert_ct")
    df["compound_key"] = df["ticker"] + "|" + df["strike"].astype(str) + "|" + df["side"] + "|" + df["expiry"].astype(str)
    df["firing_index"] = df.groupby(["compound_key", "date"]).cumcount() + 1
    counts = df.groupby(["compound_key", "date"]).size().rename("firings_in_key_today").reset_index()
    df = df.merge(counts, on=["compound_key", "date"])
    df["is_first_of_day"] = df["firing_index"] == 1
    df["is_single_firing"] = df["firings_in_key_today"] == 1

    # Alerts per day (regime proxy for tape activity)
    daily = df.groupby("date").size().rename("alerts_on_day").reset_index()
    df = df.merge(daily, on="date")

    return df


def aggregate_by(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby(group_cols).agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_pct=("best_pnl_pct", "mean"),
        mean_dollar=("best_dollar", "mean"),
    )
    return g.round(2)


def plot_per_day_winrate(df: pd.DataFrame, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby("date").agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_dollar=("best_dollar", "mean"),
    ).reset_index()
    fig, axes = plt.subplots(2, 1, figsize=(12, 7))
    axes[0].bar(range(len(g)), g["win_pct"], color="#1f77b4")
    axes[0].set_xticks(range(len(g)))
    axes[0].set_xticklabels([d.strftime("%m-%d") for d in g["date"]], rotation=45)
    axes[0].set_ylabel("win rate %")
    axes[0].set_title("Per-day win rate (all alerts, all tickers)")
    axes[0].grid(axis="y", alpha=0.3)
    for i, n in enumerate(g["n"]):
        axes[0].text(i, g["win_pct"].iloc[i] + 0.5, f"n={n:,}", ha="center", fontsize=8)
    axes[1].bar(range(len(g)), g["mean_dollar"], color="#2ca02c")
    axes[1].set_xticks(range(len(g)))
    axes[1].set_xticklabels([d.strftime("%m-%d") for d in g["date"]], rotation=45)
    axes[1].set_ylabel("mean $/contract")
    axes[1].set_title("Per-day mean dollar PnL/contract")
    axes[1].axhline(0, color="black", linewidth=0.5)
    axes[1].grid(axis="y", alpha=0.3)
    plt.tight_layout()
    fig.savefig(out_dir / "per-day-winrate.png", dpi=120)
    plt.close(fig)


def main() -> None:
    df = load_label_and_pick()
    print(f"Loaded {len(df):,} alerts, {df['compound_key'].nunique():,} unique compound keys.")

    findings = {
        "n_total": int(len(df)),
        "n_compound_keys": int(df["compound_key"].nunique()),
        "n_single_firing": int(df["is_single_firing"].sum()),
        # Q: first vs Nth firing of same key
        "by_first_of_day": aggregate_by(df, ["is_first_of_day", "side"]).reset_index().to_dict(orient="records"),
        "by_single_firing": aggregate_by(df, ["is_single_firing", "side"]).reset_index().to_dict(orient="records"),
        # Q: per-day homogeneity
        "by_date": aggregate_by(df, ["date"]).reset_index().to_dict(orient="records"),
        "by_date_regime_side": aggregate_by(df, ["date", "regime", "side"]).reset_index().to_dict(orient="records"),
        # Q: alerts-on-day density
        "by_density_quartile": aggregate_by(
            df.assign(density_q=pd.qcut(df["alerts_on_day"], 4, labels=["q1_lowest", "q2", "q3", "q4_highest"], duplicates="drop")),
            ["density_q", "side"],
        ).reset_index().to_dict(orient="records"),
        # Q: firing index buckets
        "by_firing_index": aggregate_by(
            df.assign(fi_bucket=pd.cut(df["firing_index"], bins=[0, 1, 5, 20, np.inf], labels=["1st", "2nd-5th", "6th-20th", "21st+"])),
            ["fi_bucket", "side"],
        ).reset_index().to_dict(orient="records"),
    }
    OUT_FINDINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FINDINGS.write_text(json.dumps(findings, indent=2, default=str))
    print(f"Wrote {OUT_FINDINGS}")

    # ──────── Markdown ────────
    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# IV-Anomaly Cohort (Phase D3) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts, {df['compound_key'].nunique():,} unique compound keys, "
                 f"{int(df['is_single_firing'].sum()):,} single-firing.")
    lines.append("")

    lines.append("## Per-day win rate")
    lines.append("")
    lines.append("Reveals whether headline numbers were driven by one anomalous day.")
    lines.append("")
    by_date = aggregate_by(df, ["date"])
    lines.append("| date | n | win% | mean% | mean $ |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for date, row in by_date.iterrows():
        lines.append(
            f"| {date} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## First-of-day vs subsequent firings")
    lines.append("")
    lines.append("| is_first_of_day | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (is_first, side), row in aggregate_by(df, ["is_first_of_day", "side"]).iterrows():
        lines.append(
            f"| {is_first} | {side} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## Single-firing keys vs multi-firing")
    lines.append("")
    lines.append("Hypothesis: a key that fires once and never repeats may be noise vs a persistent setup.")
    lines.append("")
    lines.append("| is_single_firing | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (is_single, side), row in aggregate_by(df, ["is_single_firing", "side"]).iterrows():
        lines.append(
            f"| {is_single} | {side} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## Firing-index bucket (1st, 2-5th, 6-20th, 21+)")
    lines.append("")
    fi = df.assign(fi_bucket=pd.cut(df["firing_index"], bins=[0, 1, 5, 20, np.inf], labels=["1st", "2nd-5th", "6th-20th", "21st+"]))
    lines.append("| fi_bucket | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (fi_bucket, side), row in aggregate_by(fi, ["fi_bucket", "side"]).iterrows():
        lines.append(
            f"| {fi_bucket} | {side} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## Alert-density quartile (regime proxy)")
    lines.append("")
    lines.append("Days where lots of alerts fire across all tickers vs quiet days.")
    lines.append("")
    dq = df.assign(density_q=pd.qcut(df["alerts_on_day"], 4, labels=["q1_lowest", "q2", "q3", "q4_highest"], duplicates="drop"))
    lines.append("| density_q | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (q, side), row in aggregate_by(dq, ["density_q", "side"]).iterrows():
        lines.append(
            f"| {q} | {side} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    OUT_REPORT.write_text("\n".join(lines))
    print(f"Wrote {OUT_REPORT}")

    plot_per_day_winrate(df, OUT_PLOTS)
    print(f"Wrote plots to {OUT_PLOTS}")


if __name__ == "__main__":
    main()
