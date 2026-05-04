"""Exit-quality analysis: does matched-side NCP/NPP peak BEFORE the
option price peak? If yes consistently, a flow-based early exit could
beat the existing trail-30/10.

For each fire that has a peak_ceiling_pct outcome, we:
  1. Find the option price peak time = trigger_time_ct + minutes_to_peak
  2. Pull the matched-side flow series for the post-trigger window
  3. Find the matched-side cumulative-flow peak time using
     scipy.signal.find_peaks (same algorithm as extract_features.py)
  4. Compute lead = option_peak_time - flow_peak_time (minutes)
     - Positive lead = flow peaked BEFORE option (leading indicator)
     - Negative = flow peaked AFTER option (lagging — useless for exit)

Output: lead distribution + stratified breakdown + plot.

Run: `ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/exit_analysis.py`
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2
from scipy.signal import find_peaks

EXPERIMENT_DIR = Path(__file__).parent
PLOTS_DIR = Path(__file__).parents[2] / "plots" / "lottery-net-flow-eda"
REPORT_OUT = EXPERIMENT_DIR / "exit_analysis.md"

PEAK_PROMINENCE_RATIO = 0.05  # same as extract_features.py
LEAD_MIN_THRESHOLD_PCT = 50.0  # only analyze fires that hit >=+50% peak (room to need an exit)


def load_data(conn) -> tuple[pd.DataFrame, pd.DataFrame]:
    fires = pd.read_sql(
        f"""
        SELECT id, trigger_time_ct, underlying_symbol AS ticker,
               option_type, peak_ceiling_pct, minutes_to_peak,
               realized_trail30_10_pct, mode, tod, cheap_call_pm_tagged
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct >= {LEAD_MIN_THRESHOLD_PCT}
          AND minutes_to_peak IS NOT NULL
          AND minutes_to_peak > 0
        ORDER BY trigger_time_ct
        """,
        conn,
    )
    if fires.empty:
        return fires, pd.DataFrame()
    tickers = list(sorted(fires["ticker"].unique()))
    flow = pd.read_sql(
        """
        SELECT ticker, ts, net_call_prem, net_put_prem
        FROM net_flow_per_ticker_history
        WHERE ticker = ANY(%(tickers)s)
        ORDER BY ticker, ts
        """,
        conn,
        params={"tickers": tickers},
    )
    for col in ("net_call_prem", "net_put_prem"):
        flow[col] = pd.to_numeric(flow[col], errors="coerce").astype("float64")
    return fires, flow


def find_post_trigger_flow_peak(
    flow_day: pd.DataFrame,
    matched_side: str,
    trigger_ts: pd.Timestamp,
    horizon_min: float,
) -> pd.Timestamp | None:
    """Return the timestamp of the most prominent matched-side
    cumulative peak strictly AFTER trigger_ts within horizon_min."""
    horizon_end = trigger_ts + pd.Timedelta(minutes=horizon_min)
    window = flow_day[(flow_day["ts"] > trigger_ts) & (flow_day["ts"] <= horizon_end)]
    if len(window) < 5:
        return None
    cum = window[matched_side].cumsum().to_numpy()
    rng = float(cum.max() - cum.min())
    if rng <= 0:
        return None
    peaks, props = find_peaks(cum, prominence=rng * PEAK_PROMINENCE_RATIO)
    if len(peaks) == 0:
        return None
    # Pick the most prominent peak within the horizon.
    best_idx = peaks[np.argmax(props["prominences"])]
    return window["ts"].iloc[int(best_idx)]


def fmt_pct(x):
    if pd.isna(x):
        return "—"
    return f"{x * 100:.1f}%"


def write_report(leads_df: pd.DataFrame) -> None:
    lines = ["# Exit-Quality Analysis — does flow peak before price?", ""]
    lines.append(
        f"Sample: {len(leads_df):,} fires that hit ≥ {LEAD_MIN_THRESHOLD_PCT:.0f}% "
        "peak_ceiling AND have a matched-side flow peak in the same window."
    )
    lines.append("")
    leads = leads_df["lead_min"]
    lines.append("## Lead distribution (minutes flow peak preceded option peak)")
    lines.append("")
    lines.append(
        f"- Median lead: **{leads.median():+.1f} min**\n"
        f"- Mean lead:   **{leads.mean():+.1f} min**\n"
        f"- 25th–75th:   {leads.quantile(0.25):+.1f} min .. {leads.quantile(0.75):+.1f} min\n"
        f"- 10th–90th:   {leads.quantile(0.10):+.1f} min .. {leads.quantile(0.90):+.1f} min\n"
        f"- Pct of fires with lead > 0 (flow led):  {(leads > 0).mean() * 100:.1f}%\n"
        f"- Pct with lead >= 3 min (actionable):    {(leads >= 3).mean() * 100:.1f}%\n"
        f"- Pct with lead <= 0 (flow lagged):       {(leads <= 0).mean() * 100:.1f}%"
    )
    lines.append("")
    lines.append("## Stratified by mode")
    lines.append("")
    lines.append("| stratum | n | median lead | mean lead | % lead>=3min |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for mode, group in leads_df.groupby("mode", observed=True):
        if len(group) < 20:
            continue
        lines.append(
            f"| {mode} | {len(group):,} | {group['lead_min'].median():+.1f} | "
            f"{group['lead_min'].mean():+.1f} | {fmt_pct((group['lead_min'] >= 3).mean())} |"
        )
    lines.append("")
    lines.append("## Stratified by option type")
    lines.append("")
    lines.append("| stratum | n | median lead | mean lead | % lead>=3min |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for ot, group in leads_df.groupby("option_type", observed=True):
        lines.append(
            f"| {ot} | {len(group):,} | {group['lead_min'].median():+.1f} | "
            f"{group['lead_min'].mean():+.1f} | {fmt_pct((group['lead_min'] >= 3).mean())} |"
        )
    lines.append("")
    lines.append("## Stratified by tod")
    lines.append("")
    lines.append("| stratum | n | median lead | mean lead | % lead>=3min |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for tod, group in leads_df.groupby("tod", observed=True):
        if len(group) < 20:
            continue
        lines.append(
            f"| {tod} | {len(group):,} | {group['lead_min'].median():+.1f} | "
            f"{group['lead_min'].mean():+.1f} | {fmt_pct((group['lead_min'] >= 3).mean())} |"
        )
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    pct_actionable = (leads >= 3).mean()
    median_lead = leads.median()
    if median_lead >= 3 and pct_actionable >= 0.55:
        lines.append(
            f"**SIGNAL** — flow peaks {median_lead:+.1f} min before price on the median fire, "
            f"and {pct_actionable * 100:.0f}% of fires have an actionable lead (>=3 min). "
            "Worth investing in a P&L simulation: 'exit at flow-peak + offset' vs trail-30/10. "
            "Need parquet option-price data to quantify the captured-pct improvement."
        )
    elif abs(median_lead) < 1 and pct_actionable < 0.55:
        lines.append(
            f"**NO SIGNAL** — median lead {median_lead:+.1f} min and only "
            f"{pct_actionable * 100:.0f}% of fires show actionable lead. Flow peak is "
            "essentially coincident with or trailing the option peak. Trail-30/10 "
            "captures roughly the same exit point as a flow-based rule would."
        )
    else:
        lines.append(
            f"**MARGINAL** — median lead {median_lead:+.1f} min, "
            f"{pct_actionable * 100:.0f}% actionable. Mixed signal — too narrow to "
            "justify a production exit rule but possibly useful as a confirmation "
            "alongside trail-30/10."
        )
    REPORT_OUT.write_text("\n".join(lines))


def plot_lead_histogram(leads_df: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(10, 5))
    leads = leads_df["lead_min"].clip(-30, 60)  # tail clip for readability
    ax.hist(leads, bins=45, color="steelblue", edgecolor="white", alpha=0.85)
    ax.axvline(0, color="red", linestyle="--", label="coincident")
    ax.axvline(leads.median(), color="darkorange", linestyle="-", label=f"median {leads.median():+.1f} min")
    ax.set_xlabel("Lead (min) — flow peak BEFORE option peak →")
    ax.set_ylabel("Fires")
    ax.set_title(
        f"Matched-side flow peak vs option peak ({len(leads_df):,} fires, ≥+{LEAD_MIN_THRESHOLD_PCT:.0f}% peak)"
    )
    ax.legend()
    fig.tight_layout()
    out = PLOTS_DIR / "exit_lead_histogram.png"
    fig.savefig(out, dpi=120, bbox_inches="tight")
    plt.close(fig)


def main() -> int:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Missing DATABASE_URL", file=sys.stderr)
        return 1
    print("connecting...")
    with psycopg2.connect(db_url) as conn:
        fires, flow = load_data(conn)
    if fires.empty:
        print("No fires meet the peak_ceiling threshold.")
        return 0
    print(f"  fires meeting >=+{LEAD_MIN_THRESHOLD_PCT:.0f}% peak threshold: {len(fires):,}")
    print(f"  flow rows: {len(flow):,}")

    flow["ts"] = pd.to_datetime(flow["ts"], utc=True)
    flow["session_date"] = flow["ts"].dt.tz_convert("America/Chicago").dt.date
    fires["trigger_time_ct"] = pd.to_datetime(fires["trigger_time_ct"], utc=True)
    fires["fire_session_date"] = (
        fires["trigger_time_ct"].dt.tz_convert("America/Chicago").dt.date
    )
    flow_groups = flow.groupby(["ticker", "session_date"], observed=True)

    rows: list[dict] = []
    no_flow_day = 0
    no_peak_found = 0
    for fire in fires.itertuples(index=False):
        key = (fire.ticker, fire.fire_session_date)
        if key not in flow_groups.groups:
            no_flow_day += 1
            continue
        flow_day = flow_groups.get_group(key)
        matched_side = "net_call_prem" if fire.option_type == "C" else "net_put_prem"
        # Horizon: minutes_to_peak + small buffer so we can find peaks
        # right at or just before the option peak.
        horizon = float(fire.minutes_to_peak) + 5.0
        flow_peak_ts = find_post_trigger_flow_peak(
            flow_day, matched_side, fire.trigger_time_ct, horizon
        )
        if flow_peak_ts is None:
            no_peak_found += 1
            continue
        option_peak_ts = fire.trigger_time_ct + pd.Timedelta(minutes=float(fire.minutes_to_peak))
        lead_min = (option_peak_ts - flow_peak_ts).total_seconds() / 60.0
        rows.append(
            {
                "fire_id": fire.id,
                "lead_min": lead_min,
                "minutes_to_peak": float(fire.minutes_to_peak),
                "peak_ceiling_pct": float(fire.peak_ceiling_pct),
                "realized_trail30_10_pct": float(fire.realized_trail30_10_pct or 0),
                "option_type": fire.option_type,
                "mode": fire.mode,
                "tod": fire.tod,
                "cheap_call_pm_tagged": fire.cheap_call_pm_tagged,
            }
        )

    print(f"  fires without flow data for the day: {no_flow_day:,}")
    print(f"  fires with no detectable matched-side flow peak: {no_peak_found:,}")
    print(f"  fires analyzed: {len(rows):,}")

    leads_df = pd.DataFrame(rows)
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    plot_lead_histogram(leads_df)
    write_report(leads_df)
    print(f"\nWrote {REPORT_OUT}")
    print(f"  median lead: {leads_df['lead_min'].median():+.1f} min")
    print(f"  pct lead>=3min: {(leads_df['lead_min'] >= 3).mean() * 100:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
