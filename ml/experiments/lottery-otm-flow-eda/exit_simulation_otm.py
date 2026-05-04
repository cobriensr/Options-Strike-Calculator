"""Re-run inversion-exit simulation against OTM-only NCP/NPP from
otm_flow.parquet (Phase 1 output). Same exit logic as the all-NCP
exit_simulation.py — only the flow source differs.

Output: exit_simulation_otm_results.parquet with per-fire columns
  fire_id, trail_pct, inversion_pct_all (from prior sim), inversion_pct_otm,
  trail_net_pct, inversion_net_pct_all, inversion_net_pct_otm,
  inversion_status_otm, plus stratification cols.

Run: ml/.venv/bin/python ml/experiments/lottery-otm-flow-eda/exit_simulation_otm.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from scipy.signal import find_peaks

# Reuse layout primitives from the all-NCP sim
ALL_NCP_RESULTS = Path(__file__).parents[1] / "lottery-net-flow-eda" / "exit_simulation_results.parquet"
PARQUET_DIR = Path("/Users/charlesobrien/Desktop/Bot-Eod-parquet")
OTM_FLOW = Path(__file__).parent / "otm_flow.parquet"
OUT_PARQUET = Path(__file__).parent / "exit_simulation_otm_results.parquet"

PEAK_PROMINENCE_RATIO = 0.05
TRAIL_ACTIVATE_PCT = 30.0
TRAIL_GIVEBACK_PCT = 10.0
INVERSION_SLOPE_WINDOW_MIN = 5
INVERSION_NEG_PERSIST_MIN = 3
EOD_CT_HOUR = 15
COMMISSION_USD_PER_CONTRACT_RT = 0.65
SLIPPAGE_PCT_OF_SPREAD = 0.5


def load_fires(conn) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT id, date, trigger_time_ct, entry_price,
               underlying_symbol AS ticker, option_chain_id, option_type,
               peak_ceiling_pct, mode, tod, cheap_call_pm_tagged
        FROM lottery_finder_fires
        WHERE date >= '2026-04-13' AND date <= '2026-05-01'
          AND realized_trail30_10_pct IS NOT NULL
        ORDER BY date, trigger_time_ct
        """,
        conn,
    )


def build_minute_prices(trades: pd.DataFrame) -> pd.DataFrame:
    if trades.empty:
        return pd.DataFrame()
    df = trades.copy()
    df = df[~df["canceled"].isin([True, "t", "true", "True"])].copy()
    df["minute"] = df["executed_at"].dt.floor("min")
    df["mid"] = (df["nbbo_bid"] + df["nbbo_ask"]) / 2.0
    df["spread"] = df["nbbo_ask"] - df["nbbo_bid"]
    grouped = df.groupby("minute", observed=True).agg(
        mid=("mid", "last"),
        spread=("spread", "last"),
    )
    return grouped.reset_index()


def simulate_trail(minutes, entry_price, trigger_ts):
    post = minutes[minutes["minute"] > trigger_ts]
    if post.empty:
        return None
    activated = False
    running_max_pct = -np.inf
    eod_ts = (
        trigger_ts.tz_convert("America/Chicago")
        .replace(hour=EOD_CT_HOUR, minute=0, second=0, microsecond=0)
        .tz_convert("UTC")
    )
    for _, row in post.iterrows():
        if row["minute"] >= eod_ts:
            return float((row["mid"] - entry_price) / entry_price * 100)
        ret_pct = (row["mid"] - entry_price) / entry_price * 100
        if ret_pct > running_max_pct:
            running_max_pct = ret_pct
        if not activated and ret_pct >= TRAIL_ACTIVATE_PCT:
            activated = True
        if activated and (running_max_pct - ret_pct) >= TRAIL_GIVEBACK_PCT:
            return float(ret_pct)
    last = post.iloc[-1]
    return float((last["mid"] - entry_price) / entry_price * 100)


def simulate_inversion(minutes, flow_day, matched_side, entry_price, trigger_ts):
    """Same inversion logic as exit_simulation.py — just parameterized
    on the matched-side column name (otm_ncp vs otm_npp here)."""
    post = minutes[minutes["minute"] > trigger_ts]
    if post.empty:
        return None, "no_post_trigger_prices"
    eod_ts = (
        trigger_ts.tz_convert("America/Chicago")
        .replace(hour=EOD_CT_HOUR, minute=0, second=0, microsecond=0)
        .tz_convert("UTC")
    )
    flow_post = flow_day[
        (flow_day["ts"] > trigger_ts) & (flow_day["ts"] <= eod_ts)
    ]
    if len(flow_post) < 5:
        return None, "insufficient_flow_data"
    cum = flow_post[matched_side].cumsum().to_numpy()
    rng = float(cum.max() - cum.min())
    if rng <= 0:
        return None, "flat_flow_no_peak"
    peaks, props = find_peaks(cum, prominence=rng * PEAK_PROMINENCE_RATIO)
    if len(peaks) == 0:
        return _exit_at_or_after(post, eod_ts, entry_price, "no_flow_peak")
    peak_idx = int(peaks[np.argmax(props["prominences"])])
    flow_after_peak = flow_post.iloc[peak_idx:]
    if len(flow_after_peak) < INVERSION_SLOPE_WINDOW_MIN + INVERSION_NEG_PERSIST_MIN:
        return _exit_at_or_after(post, eod_ts, entry_price, "eod_no_inversion_window")
    cum_after = flow_after_peak[matched_side].cumsum().to_numpy()
    slopes = np.full(len(cum_after), np.nan)
    for i in range(INVERSION_SLOPE_WINDOW_MIN, len(cum_after)):
        slopes[i] = (cum_after[i] - cum_after[i - INVERSION_SLOPE_WINDOW_MIN]) / INVERSION_SLOPE_WINDOW_MIN
    neg_streak = 0
    inversion_idx = None
    for i, s in enumerate(slopes):
        if np.isnan(s):
            continue
        if s < 0:
            neg_streak += 1
            if neg_streak >= INVERSION_NEG_PERSIST_MIN:
                inversion_idx = i
                break
        else:
            neg_streak = 0
    if inversion_idx is None:
        return _exit_at_or_after(post, eod_ts, entry_price, "eod_no_inversion_found")
    inversion_ts = flow_after_peak["ts"].iloc[inversion_idx]
    return _exit_at_or_after(post, inversion_ts, entry_price, "inversion")


def _exit_at_or_after(minute_prices, target_ts, entry_price, status):
    at_or_after = minute_prices[minute_prices["minute"] >= target_ts]
    if at_or_after.empty:
        last = minute_prices.iloc[-1]
        return float((last["mid"] - entry_price) / entry_price * 100), f"{status}_eod_fallback"
    row = at_or_after.iloc[0]
    return float((row["mid"] - entry_price) / entry_price * 100), status


def apply_costs(pct, entry_price, spread_pct_of_price):
    if pd.isna(pct) or entry_price <= 0:
        return pct
    comm_pct = (COMMISSION_USD_PER_CONTRACT_RT / (entry_price * 100)) * 100
    slip_pct = 2 * SLIPPAGE_PCT_OF_SPREAD * spread_pct_of_price
    return pct - comm_pct - slip_pct


def main() -> int:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Missing DATABASE_URL", file=sys.stderr)
        return 1

    print("loading...")
    if not OTM_FLOW.exists():
        print(f"Missing {OTM_FLOW} — run compute_otm_flow.py first")
        return 1
    if not ALL_NCP_RESULTS.exists():
        print(f"Missing {ALL_NCP_RESULTS} — run all-NCP sim first")
        return 1
    otm = pd.read_parquet(OTM_FLOW)
    all_ncp = pd.read_parquet(ALL_NCP_RESULTS)
    with psycopg2.connect(db_url) as conn:
        fires = load_fires(conn)

    fires["trigger_time_ct"] = pd.to_datetime(fires["trigger_time_ct"], utc=True)
    otm["ts"] = pd.to_datetime(otm["ts"], utc=True)
    otm["session_date"] = otm["ts"].dt.tz_convert("America/Chicago").dt.date
    fires["fire_session_date"] = fires["trigger_time_ct"].dt.tz_convert("America/Chicago").dt.date
    fires["fire_date"] = fires["date"].astype(str)

    print(f"  fires:    {len(fires):,}")
    print(f"  otm rows: {len(otm):,}")
    print(f"  all_ncp rows: {len(all_ncp):,}")

    fires_by_date = fires.groupby("fire_date")
    otm_groups = otm.groupby(["ticker", "session_date"], observed=True)

    rows = []
    for date_str, day_fires in fires_by_date:
        path = PARQUET_DIR / f"{date_str}-trades.parquet"
        if not path.exists():
            continue
        chains = day_fires["option_chain_id"].unique().tolist()
        all_trades = pd.read_parquet(
            path,
            columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "canceled"],
        )
        day_trades = all_trades[all_trades["option_chain_id"].isin(chains)].copy()
        chain_groups = day_trades.groupby("option_chain_id", observed=True)
        for fire in day_fires.itertuples(index=False):
            chain_id = fire.option_chain_id
            if chain_id not in chain_groups.groups:
                continue
            minutes = build_minute_prices(chain_groups.get_group(chain_id))
            if minutes.empty:
                continue
            trigger_ts = fire.trigger_time_ct
            entry_price = float(fire.entry_price)
            trail_pct = simulate_trail(minutes, entry_price, trigger_ts)
            otm_key = (fire.ticker, fire.fire_session_date)
            if otm_key not in otm_groups.groups:
                continue
            otm_day = otm_groups.get_group(otm_key)
            matched = "otm_ncp" if fire.option_type == "C" else "otm_npp"
            inv_pct, inv_status = simulate_inversion(minutes, otm_day, matched, entry_price, trigger_ts)
            if trail_pct is None or inv_pct is None:
                continue
            entry_min = minutes.iloc[0]
            spread_pct = (
                (entry_min["spread"] / entry_min["mid"]) * 100
                if entry_min["mid"] > 0
                else 0
            )
            rows.append({
                "fire_id": fire.id,
                "trail_pct": trail_pct,
                "inversion_pct_otm": inv_pct,
                "trail_net_pct": apply_costs(trail_pct, entry_price, spread_pct),
                "inversion_net_pct_otm": apply_costs(inv_pct, entry_price, spread_pct),
                "inversion_status_otm": inv_status,
                "peak_ceiling_pct": float(fire.peak_ceiling_pct or 0),
                "mode": fire.mode,
                "tod": fire.tod,
                "option_type": fire.option_type,
                "ticker": fire.ticker,
                "date_str": date_str,
            })
        del all_trades, day_trades
        print(f"  {date_str}: cumulative {len(rows):,}")

    out = pd.DataFrame(rows)
    # Join in the all-NCP results for head-to-head comparison
    all_slim = all_ncp[["fire_id", "inversion_pct", "inversion_net_pct"]].rename(
        columns={"inversion_pct": "inversion_pct_all", "inversion_net_pct": "inversion_net_pct_all"}
    )
    merged = out.merge(all_slim, on="fire_id", how="left")
    merged.to_parquet(OUT_PARQUET, index=False)
    print(f"\nwrote {OUT_PARQUET}")
    print(f"  rows: {len(merged):,}")
    print(f"  median trail:    {merged['trail_pct'].median():+.1f}%")
    print(f"  median inv all:  {merged['inversion_pct_all'].median():+.1f}%")
    print(f"  median inv otm:  {merged['inversion_pct_otm'].median():+.1f}%")
    print(f"  lottery rate trail: {(merged['trail_pct'] >= 100).mean() * 100:.2f}%")
    print(f"  lottery rate all:   {(merged['inversion_pct_all'] >= 100).mean() * 100:.2f}%")
    print(f"  lottery rate otm:   {(merged['inversion_pct_otm'] >= 100).mean() * 100:.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
