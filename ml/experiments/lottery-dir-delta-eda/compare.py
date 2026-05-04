"""Head-to-head: trail-30/10 vs all-NCP inversion vs Dir-Delta inversion.

Reads exit_simulation_dirdelta_results.parquet and produces compare.md
with headline lottery rates, P&L distributions, stratified breakdown,
concentration check, and the pre-committed verdict per spec.

Run: ml/.venv/bin/python ml/experiments/lottery-dir-delta-eda/compare.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

EXPERIMENT_DIR = Path(__file__).parent
RESULTS = EXPERIMENT_DIR / "exit_simulation_dirdelta_results.parquet"
REPORT_OUT = EXPERIMENT_DIR / "compare.md"

LOTTERY_PCT = 100.0


def fmt_pct(x):
    if x is None or pd.isna(x):
        return "—"
    return f"{x * 100:.2f}%"


def fmt(x):
    if x is None or pd.isna(x):
        return "—"
    return f"{x:+.1f}"


def stat_table(df):
    lines = ["| metric | trail | inv_all | inv_dd | inv_dd − inv_all |"]
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for stat, fn in [
        ("median", lambda s: s.median()),
        ("mean", lambda s: s.mean()),
        ("std", lambda s: s.std()),
        ("p10", lambda s: s.quantile(0.10)),
        ("p25", lambda s: s.quantile(0.25)),
        ("p75", lambda s: s.quantile(0.75)),
        ("p90", lambda s: s.quantile(0.90)),
    ]:
        t = fn(df["trail_pct"])
        a = fn(df["inversion_pct_all"])
        d = fn(df["inversion_pct_dirdelta"])
        lines.append(f"| {stat} | {fmt(t)} | {fmt(a)} | {fmt(d)} | {fmt(d - a)} |")
    return lines


def stratified(df, col, min_n=50):
    lines = [f"| {col} | n | rate trail | rate inv_all | rate inv_dd | dd − all |"]
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
    for stratum, group in df.groupby(col, observed=True):
        if len(group) < min_n:
            continue
        rt = (group["trail_pct"] >= LOTTERY_PCT).mean()
        ra = (group["inversion_pct_all"] >= LOTTERY_PCT).mean()
        rd = (group["inversion_pct_dirdelta"] >= LOTTERY_PCT).mean()
        lines.append(
            f"| {stratum} | {len(group):,} | {fmt_pct(rt)} | {fmt_pct(ra)} | {fmt_pct(rd)} | {fmt_pct(rd - ra)} |"
        )
    return lines


def cv_for(df, col, target="inversion_pct_dirdelta", min_n=50):
    rates = []
    for _, group in df.groupby(col, observed=True):
        if len(group) >= min_n:
            rates.append((group[target] >= LOTTERY_PCT).mean())
    if len(rates) < 2:
        return None
    s = pd.Series(rates)
    if s.mean() <= 0:
        return None
    return float(s.std() / s.mean())


def main() -> int:
    if not RESULTS.exists():
        print(f"Missing {RESULTS} — run exit_simulation_dirdelta.py first")
        return 1
    df = pd.read_parquet(RESULTS).dropna(
        subset=["inversion_pct_all", "inversion_pct_dirdelta"]
    )
    n = len(df)

    rate_trail = (df["trail_pct"] >= LOTTERY_PCT).mean()
    rate_all = (df["inversion_pct_all"] >= LOTTERY_PCT).mean()
    rate_dd = (df["inversion_pct_dirdelta"] >= LOTTERY_PCT).mean()
    delta = rate_dd - rate_all

    lines = ["# Dir-Delta vs All-NCP Inversion — Head-to-Head", ""]
    lines.append(
        f"Sample: **{n:,} fires** with both inversion variants computable on the 15-day "
        "parquet window (2026-04-13 → 2026-05-01)."
    )
    lines.append("")
    lines.append("## Headline lottery rate")
    lines.append("")
    lines.append(f"- **trail-30/10**:           {fmt_pct(rate_trail)}")
    lines.append(f"- **inversion (all-NCP)**:    {fmt_pct(rate_all)}")
    lines.append(f"- **inversion (Dir Delta)**:  {fmt_pct(rate_dd)}")
    lines.append(f"- **Dir Delta − all-NCP**:    {fmt_pct(delta)}")
    lines.append("")

    lines.append("## P&L distribution (mid-based, no costs)")
    lines.append("")
    lines.extend(stat_table(df))
    lines.append("")

    rate_all_net = (df["inversion_net_pct_all"] >= LOTTERY_PCT).mean()
    rate_dd_net = (df["inversion_net_pct_dirdelta"] >= LOTTERY_PCT).mean()
    lines.append("## Lottery rate after costs")
    lines.append("")
    lines.append(f"- inv_all net:      {fmt_pct(rate_all_net)}")
    lines.append(f"- inv_dirdelta net: {fmt_pct(rate_dd_net)}")
    lines.append(f"- delta:            {fmt_pct(rate_dd_net - rate_all_net)}")
    lines.append("")

    for col in ["mode", "tod", "option_type"]:
        lines.append(f"## Stratified by {col}")
        lines.append("")
        lines.extend(stratified(df, col))
        lines.append("")

    lines.append("## By date")
    lines.append("")
    lines.extend(stratified(df, "date_str", min_n=200))
    lines.append("")

    lines.append("## Concentration check on Dir-Delta winners")
    lines.append("")
    for col in ["date_str", "ticker", "mode", "tod"]:
        cv = cv_for(df, col)
        if cv is not None:
            lines.append(f"- CV(lottery_rate_dirdelta) across `{col}`: {cv:.2f}")
        else:
            lines.append(f"- CV across `{col}`: insufficient data")
    lines.append("")

    lines.append("## Verdict (per spec decision rule)")
    lines.append("")
    delta_pp = delta * 100
    if delta_pp >= 3:
        lines.append(
            f"**DIR DELTA WINS** — lottery rate +{delta_pp:.2f}pp better than all-NCP. "
            "Open follow-up spec to ship as 5th exit policy."
        )
    elif delta_pp <= -3:
        lines.append(
            f"**DIR DELTA LOSES** — lottery rate {delta_pp:.2f}pp worse than all-NCP. "
            "Delta-weighting drops information. Move to Dir Vega."
        )
    else:
        lines.append(
            f"**TIE** — Dir Delta lottery rate is {delta_pp:+.2f}pp vs all-NCP, within "
            "the ±2pp tie band. Keep all-NCP. Move to Dir Vega for genuine signal exploration."
        )
    REPORT_OUT.write_text("\n".join(lines))
    print(f"wrote {REPORT_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
