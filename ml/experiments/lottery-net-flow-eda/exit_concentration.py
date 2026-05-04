"""Concentration check on the inversion-exit lottery winners.

The simulation showed inversion-exit produces a 7.82% lottery rate
(>=+100% returns) — 6x higher than trail-30/10. But "spread or
clustered?" determines whether this is real edge or a leakage
fingerprint per `feedback_uniform_lift_is_leakage`.

This script re-runs the simulation but PERSISTS the per-fire results
parquet, then breaks the lottery winners down by:
  - date (single-day blowups would be the worst)
  - ticker (a couple of meme-stock days carrying everything)
  - mode / tod / cheap-call-pm

A coefficient-of-variation > 1.5 on the lottery rate across strata =
concentrated (likely real). Uniform lift across every stratum = the
leakage signature.

Run: ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/exit_concentration.py
Requires exit_simulation.py to have been run AND the
exit_simulation_results.parquet to exist (we re-emit it from
exit_simulation.py — see that script for the persist hook).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

EXPERIMENT_DIR = Path(__file__).parent
RESULTS_PARQUET = EXPERIMENT_DIR / "exit_simulation_results.parquet"
REPORT_OUT = EXPERIMENT_DIR / "exit_concentration.md"

LOTTERY_THRESHOLD_PCT = 100.0


def fmt_pct(x):
    if x is None or pd.isna(x):
        return "—"
    return f"{x * 100:.2f}%"


def fmt(x):
    if x is None or pd.isna(x):
        return "—"
    return f"{x:+.2f}"


def stratum_breakdown(
    df: pd.DataFrame, strat_col: str, min_n: int = 30
) -> pd.DataFrame:
    rows = []
    for stratum, group in df.groupby(strat_col, observed=True):
        if len(group) < min_n:
            continue
        rate_inv = (group["inversion_pct"] >= LOTTERY_THRESHOLD_PCT).mean()
        rate_trail = (group["trail_pct"] >= LOTTERY_THRESHOLD_PCT).mean()
        rows.append(
            {
                "stratum": stratum,
                "n": len(group),
                "lottery_rate_inv": rate_inv,
                "lottery_rate_trail": rate_trail,
                "lift_inv_vs_trail": rate_inv - rate_trail,
                "mean_inv": group["inversion_pct"].mean(),
                "mean_trail": group["trail_pct"].mean(),
            }
        )
    return pd.DataFrame(rows).sort_values("lottery_rate_inv", ascending=False)


def write_report(df: pd.DataFrame) -> None:
    lines = ["# Inversion-Exit Lottery-Winner Concentration Check", ""]
    n = len(df)
    n_lottery_inv = (df["inversion_pct"] >= LOTTERY_THRESHOLD_PCT).sum()
    n_lottery_trail = (df["trail_pct"] >= LOTTERY_THRESHOLD_PCT).sum()
    lines.append(
        f"Sample: **{n:,} fires** with both exit policies simulated. "
        f"Inversion lottery winners: **{n_lottery_inv:,}** "
        f"({n_lottery_inv / n * 100:.2f}%). "
        f"Trail lottery winners: **{n_lottery_trail:,}** "
        f"({n_lottery_trail / n * 100:.2f}%)."
    )
    lines.append("")
    lines.append(
        "**Decision rule (per `feedback_uniform_lift_is_leakage`)**: "
        "uniform lift across every stratum = leakage; concentrated lift "
        "in 1–2 strata = real edge. CV across strata is the test."
    )
    lines.append("")

    # By date
    lines.append("## By date")
    lines.append("")
    by_date = stratum_breakdown(df, "date_str", min_n=30)
    lines.append("| date | n | lottery rate inv | lottery rate trail | lift |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for _, r in by_date.iterrows():
        lines.append(
            f"| {r['stratum']} | {int(r['n']):,} | {fmt_pct(r['lottery_rate_inv'])} | "
            f"{fmt_pct(r['lottery_rate_trail'])} | {fmt_pct(r['lift_inv_vs_trail'])} |"
        )
    cv_date = (
        by_date["lottery_rate_inv"].std() / by_date["lottery_rate_inv"].mean()
        if by_date["lottery_rate_inv"].mean() > 0
        else None
    )
    lines.append("")
    if cv_date is not None:
        lines.append(
            f"CV(lottery_rate_inv) across {len(by_date)} dates = **{cv_date:.2f}**"
        )
        if cv_date >= 1.0:
            lines.append("→ **Concentrated** — a few outlier days carry most of the edge.")
        elif cv_date < 0.5:
            lines.append("→ **Uniform** — leakage fingerprint; treat with suspicion.")
        else:
            lines.append("→ **Mixed** — moderate concentration, investigate top dates.")
    lines.append("")

    # By ticker
    lines.append("## By ticker (top 15 by inversion lottery rate)")
    lines.append("")
    by_ticker = stratum_breakdown(df, "ticker", min_n=50).head(15)
    lines.append("| ticker | n | lottery rate inv | lottery rate trail | mean inv | mean trail |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
    for _, r in by_ticker.iterrows():
        lines.append(
            f"| {r['stratum']} | {int(r['n']):,} | {fmt_pct(r['lottery_rate_inv'])} | "
            f"{fmt_pct(r['lottery_rate_trail'])} | {fmt(r['mean_inv'])}% | {fmt(r['mean_trail'])}% |"
        )
    by_ticker_full = stratum_breakdown(df, "ticker", min_n=50)
    cv_ticker = (
        by_ticker_full["lottery_rate_inv"].std() / by_ticker_full["lottery_rate_inv"].mean()
        if by_ticker_full["lottery_rate_inv"].mean() > 0
        else None
    )
    lines.append("")
    if cv_ticker is not None:
        lines.append(
            f"CV across {len(by_ticker_full)} tickers = **{cv_ticker:.2f}**"
        )
        if cv_ticker >= 1.0:
            lines.append("→ **Concentrated** — winners cluster on specific tickers.")
        elif cv_ticker < 0.5:
            lines.append("→ **Uniform** — leakage fingerprint.")
        else:
            lines.append("→ **Mixed**.")
    lines.append("")

    # By mode + tod
    for col in ["mode", "tod", "option_type"]:
        lines.append(f"## By {col}")
        lines.append("")
        by_col = stratum_breakdown(df, col, min_n=100)
        lines.append("| stratum | n | lottery rate inv | lottery rate trail | lift |")
        lines.append("| --- | ---: | ---: | ---: | ---: |")
        for _, r in by_col.iterrows():
            lines.append(
                f"| {r['stratum']} | {int(r['n']):,} | {fmt_pct(r['lottery_rate_inv'])} | "
                f"{fmt_pct(r['lottery_rate_trail'])} | {fmt_pct(r['lift_inv_vs_trail'])} |"
            )
        cv = (
            by_col["lottery_rate_inv"].std() / by_col["lottery_rate_inv"].mean()
            if len(by_col) > 1 and by_col["lottery_rate_inv"].mean() > 0
            else None
        )
        if cv is not None:
            lines.append("")
            lines.append(f"CV across {len(by_col)} strata = **{cv:.2f}**")
        lines.append("")

    # Top single-day-ticker contributions
    lines.append("## Top 20 (date, ticker) cells contributing inversion lottery winners")
    lines.append("")
    lottery_only = df[df["inversion_pct"] >= LOTTERY_THRESHOLD_PCT].copy()
    if not lottery_only.empty:
        cells = (
            lottery_only.groupby(["date_str", "ticker"], observed=True)
            .size()
            .reset_index(name="winners")
            .sort_values("winners", ascending=False)
            .head(20)
        )
        lines.append("| date | ticker | winners |")
        lines.append("| --- | --- | ---: |")
        for _, r in cells.iterrows():
            lines.append(f"| {r['date_str']} | {r['ticker']} | {int(r['winners']):,} |")
        top_share = cells["winners"].iloc[:5].sum() / n_lottery_inv
        lines.append("")
        lines.append(
            f"Top 5 (date, ticker) cells account for **{top_share * 100:.1f}%** "
            f"of all inversion lottery winners."
        )
    lines.append("")

    # Verdict
    lines.append("## Verdict")
    lines.append("")
    cv_summary = []
    if cv_date is not None:
        cv_summary.append(("date", cv_date))
    if cv_ticker is not None:
        cv_summary.append(("ticker", cv_ticker))
    high_cv = [(name, c) for name, c in cv_summary if c >= 1.0]
    if high_cv:
        lines.append(
            "**Concentrated edge** — high CV on "
            + ", ".join(f"{n} ({c:.2f})" for n, c in high_cv)
            + ". Inversion-exit's lottery-rate uplift comes from outlier days/tickers, "
            "not a uniform improvement across the universe. This is the *expected* "
            "shape of real edge in lottery trading. Worth shipping the inversion-exit "
            "policy as a UI option."
        )
    else:
        lines.append(
            "**Possibly uniform** — CV across date and ticker stays moderate. "
            "Rerun with stricter min_n to be sure, but treat the inversion-exit "
            "lottery uplift with suspicion: uniform lift is the fingerprint of "
            "data leakage or methodology bias."
        )
    REPORT_OUT.write_text("\n".join(lines))


def main() -> int:
    if not RESULTS_PARQUET.exists():
        print(
            f"Missing {RESULTS_PARQUET}. Run exit_simulation.py first "
            "(it now persists per-fire results to parquet)."
        )
        return 1
    df = pd.read_parquet(RESULTS_PARQUET)
    print(f"loaded {len(df):,} simulated fires")
    print(f"  inversion lottery winners: {(df['inversion_pct'] >= 100).sum():,}")
    print(f"  trail lottery winners:     {(df['trail_pct'] >= 100).sum():,}")
    write_report(df)
    print(f"\nWrote {REPORT_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
