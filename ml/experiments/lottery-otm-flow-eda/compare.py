"""Side-by-side comparison: trail-30/10 vs all-NCP inversion vs OTM-NCP inversion.

Reads exit_simulation_otm_results.parquet and produces compare.md with:
  - Head-to-head P&L distributions
  - Lottery rate per policy (gross + net of costs)
  - Stratified breakdown (mode, tod, option_type, by date)
  - Concentration check on OTM-NCP winners (per leakage rule)
  - Pre-committed verdict per spec decision rule

Run: ml/.venv/bin/python ml/experiments/lottery-otm-flow-eda/compare.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

EXPERIMENT_DIR = Path(__file__).parent
RESULTS = EXPERIMENT_DIR / "exit_simulation_otm_results.parquet"
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


def stat_table(df: pd.DataFrame) -> list[str]:
    lines = ["| metric | trail | inv_all | inv_otm | inv_otm − inv_all |"]
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
        o = fn(df["inversion_pct_otm"])
        lines.append(f"| {stat} | {fmt(t)} | {fmt(a)} | {fmt(o)} | {fmt(o - a)} |")
    return lines


def stratified(df: pd.DataFrame, col: str, min_n: int = 50) -> list[str]:
    lines = [f"| {col} | n | rate trail | rate inv_all | rate inv_otm | otm − all |"]
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
    for stratum, group in df.groupby(col, observed=True):
        if len(group) < min_n:
            continue
        rt = (group["trail_pct"] >= LOTTERY_PCT).mean()
        ra = (group["inversion_pct_all"] >= LOTTERY_PCT).mean()
        ro = (group["inversion_pct_otm"] >= LOTTERY_PCT).mean()
        lines.append(
            f"| {stratum} | {len(group):,} | {fmt_pct(rt)} | {fmt_pct(ra)} | {fmt_pct(ro)} | {fmt_pct(ro - ra)} |"
        )
    return lines


def concentration_cv(df: pd.DataFrame, col: str, target: str = "inversion_pct_otm", min_n: int = 50) -> float | None:
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
        print(f"Missing {RESULTS} — run exit_simulation_otm.py first")
        return 1
    df = pd.read_parquet(RESULTS).dropna(subset=["inversion_pct_all", "inversion_pct_otm"])
    n = len(df)

    # Headline
    rate_trail = (df["trail_pct"] >= LOTTERY_PCT).mean()
    rate_all = (df["inversion_pct_all"] >= LOTTERY_PCT).mean()
    rate_otm = (df["inversion_pct_otm"] >= LOTTERY_PCT).mean()
    delta = rate_otm - rate_all

    lines = ["# OTM-NCP vs All-NCP Inversion — Head-to-Head", ""]
    lines.append(
        f"Sample: **{n:,} fires** with both inversion variants computable on the 15-day "
        "parquet window (2026-04-13 → 2026-05-01)."
    )
    lines.append("")
    lines.append("## Headline lottery rate")
    lines.append("")
    lines.append(f"- **trail-30/10**:        {fmt_pct(rate_trail)}")
    lines.append(f"- **inversion (all-NCP)**: {fmt_pct(rate_all)}")
    lines.append(f"- **inversion (OTM-NCP)**: {fmt_pct(rate_otm)}")
    lines.append(f"- **OTM − all-NCP**:       {fmt_pct(delta)}")
    lines.append("")

    lines.append("## P&L distribution (mid-based, no costs)")
    lines.append("")
    lines.extend(stat_table(df))
    lines.append("")

    # Cost-net headline
    rate_all_net = (df["inversion_net_pct_all"] >= LOTTERY_PCT).mean()
    rate_otm_net = (df["inversion_net_pct_otm"] >= LOTTERY_PCT).mean()
    lines.append("## Lottery rate after costs ($0.65 RT + 25% spread / leg)")
    lines.append("")
    lines.append(f"- inv_all net: {fmt_pct(rate_all_net)}")
    lines.append(f"- inv_otm net: {fmt_pct(rate_otm_net)}")
    lines.append(f"- delta:       {fmt_pct(rate_otm_net - rate_all_net)}")
    lines.append("")

    # Stratified
    for col in ["mode", "tod", "option_type"]:
        lines.append(f"## Stratified by {col}")
        lines.append("")
        lines.extend(stratified(df, col))
        lines.append("")

    # By date
    lines.append("## By date")
    lines.append("")
    lines.extend(stratified(df, "date_str", min_n=200))
    lines.append("")

    # Concentration CVs on OTM
    lines.append("## Concentration check on OTM-NCP winners")
    lines.append("")
    for col in ["date_str", "ticker", "mode", "tod"]:
        cv = concentration_cv(df, col)
        lines.append(f"- CV(lottery_rate_otm) across `{col}`: {cv:.2f}" if cv else f"- CV across `{col}`: insufficient data")
    lines.append("")
    lines.append(
        "Per `feedback_uniform_lift_is_leakage`: high CV (≥1.0) = concentrated edge; "
        "low CV (<0.5) = uniform = leakage. CVs near or above the all-NCP CVs imply "
        "OTM didn't change the concentration shape."
    )
    lines.append("")

    # Verdict per spec
    lines.append("## Verdict (per spec decision rule)")
    lines.append("")
    delta_pp = delta * 100
    if delta_pp >= 3:
        lines.append(
            f"**OTM WINS** — OTM-NCP inversion lottery rate is +{delta_pp:.2f}pp better than "
            "all-NCP. Open follow-up spec to ship OTM-NCP as a parquet-pipeline column + new "
            "5th exit policy."
        )
    elif delta_pp <= -3:
        lines.append(
            f"**OTM LOSES** — OTM-NCP inversion lottery rate is {delta_pp:.2f}pp worse than "
            "all-NCP. The OTM filter loses information; all-strikes NCP captures the relevant "
            "directional signal. Move to next feature (Dir Delta)."
        )
    else:
        lines.append(
            f"**TIE** — OTM-NCP inversion lottery rate is {delta_pp:+.2f}pp vs all-NCP, "
            "within the ±2pp practical-significance tie band. The OTM filter neither "
            "meaningfully helps nor hurts. Keep all-NCP as the default — simpler is better — "
            "and move on to the next feature (Dir Delta) for genuine signal exploration."
        )

    REPORT_OUT.write_text("\n".join(lines))
    print(f"wrote {REPORT_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
