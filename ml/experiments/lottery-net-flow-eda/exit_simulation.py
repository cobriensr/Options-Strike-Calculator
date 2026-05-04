"""Exit-rule P&L simulation: trail-30/10 vs flow-inversion.

For each fire in the 15-day parquet window (2026-04-13 → 2026-05-01),
re-simulate two exit rules against the per-minute NBBO mid price of
the fire's option contract:

  1. Trail-30/10 (baseline) — return >= +30% activates trail; exit
     when return drops 10pp from running peak. If never activated,
     hold to 15:00 CT.
  2. Flow-inversion — exit at the first minute AFTER matched-side
     cumulative-flow peak where the 5-min flow slope is negative for
     3 consecutive minutes.

Compare per-fire P&L (% return on entry premium). Cost-net the result
with $0.65 round-trip commission + 25% bid-ask slippage on entry/exit.

Run: ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/exit_simulation.py
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

PARQUET_DIR = Path("/Users/charlesobrien/Desktop/Bot-Eod-parquet")
EXPERIMENT_DIR = Path(__file__).parent
PLOTS_DIR = Path(__file__).parents[2] / "plots" / "lottery-net-flow-eda"
REPORT_OUT = EXPERIMENT_DIR / "exit_simulation.md"
RESULTS_PARQUET = EXPERIMENT_DIR / "exit_simulation_results.parquet"

PEAK_PROMINENCE_RATIO = 0.05
TRAIL_ACTIVATE_PCT = 30.0
TRAIL_GIVEBACK_PCT = 10.0
INVERSION_SLOPE_WINDOW_MIN = 5
INVERSION_NEG_PERSIST_MIN = 3
EOD_CT_HOUR = 15
EOD_CT_MINUTE = 0
COMMISSION_USD_PER_CONTRACT_RT = 0.65  # round-trip
SLIPPAGE_PCT_OF_SPREAD = 0.5  # cross half the bid-ask each leg


def load_fires(conn) -> pd.DataFrame:
    """Pull fires inside the parquet window."""
    fires = pd.read_sql(
        """
        SELECT id, date, trigger_time_ct, entry_time_ct, entry_price,
               underlying_symbol AS ticker, option_chain_id, option_type,
               peak_ceiling_pct, minutes_to_peak,
               realized_trail30_10_pct, realized_eod_pct,
               mode, tod, cheap_call_pm_tagged
        FROM lottery_finder_fires
        WHERE date >= '2026-04-13' AND date <= '2026-05-01'
          AND realized_trail30_10_pct IS NOT NULL
        ORDER BY date, trigger_time_ct
        """,
        conn,
    )
    return fires


def load_flow_for_dates(conn, tickers: list[str], date_lo: str, date_hi: str) -> pd.DataFrame:
    flow = pd.read_sql(
        """
        SELECT ticker, ts, net_call_prem, net_put_prem
        FROM net_flow_per_ticker_history
        WHERE ticker = ANY(%(tickers)s)
          AND ts >= %(lo)s::date
          AND ts <  (%(hi)s::date + INTERVAL '1 day')
        ORDER BY ticker, ts
        """,
        conn,
        params={"tickers": tickers, "lo": date_lo, "hi": date_hi},
    )
    for col in ("net_call_prem", "net_put_prem"):
        flow[col] = pd.to_numeric(flow[col], errors="coerce").astype("float64")
    return flow


def build_minute_prices(trades: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per-trade tape into per-minute NBBO-mid + last spread."""
    if trades.empty:
        return pd.DataFrame()
    df = trades.copy()
    # canceled column varies across daily parquets — bool False vs str 'f'.
    # Drop both encodings of "canceled" alongside any other truthy value.
    df = df[~df["canceled"].isin([True, "t", "true", "True"])].copy()
    df["minute"] = df["executed_at"].dt.floor("min")
    df["mid"] = (df["nbbo_bid"] + df["nbbo_ask"]) / 2.0
    df["spread"] = df["nbbo_ask"] - df["nbbo_bid"]
    grouped = df.groupby("minute", observed=True).agg(
        mid=("mid", "last"),
        spread=("spread", "last"),
        bid=("nbbo_bid", "last"),
        ask=("nbbo_ask", "last"),
        last_price=("price", "last"),
    )
    return grouped.reset_index()


def simulate_trail(
    minutes: pd.DataFrame,
    entry_price: float,
    trigger_ts: pd.Timestamp,
) -> tuple[float | None, pd.Timestamp | None]:
    """Return (exit_pct, exit_ts). exit_pct is on midpoint."""
    post = minutes[minutes["minute"] > trigger_ts]
    if post.empty:
        return None, None
    activated = False
    running_max_pct = -np.inf
    eod_ts = (
        trigger_ts.tz_convert("America/Chicago")
        .replace(hour=EOD_CT_HOUR, minute=EOD_CT_MINUTE, second=0, microsecond=0)
        .tz_convert("UTC")
    )
    for _, row in post.iterrows():
        if row["minute"] >= eod_ts:
            return float((row["mid"] - entry_price) / entry_price * 100), row["minute"]
        ret_pct = (row["mid"] - entry_price) / entry_price * 100
        if ret_pct > running_max_pct:
            running_max_pct = ret_pct
        if not activated and ret_pct >= TRAIL_ACTIVATE_PCT:
            activated = True
        if activated and (running_max_pct - ret_pct) >= TRAIL_GIVEBACK_PCT:
            return float(ret_pct), row["minute"]
    last = post.iloc[-1]
    return float((last["mid"] - entry_price) / entry_price * 100), last["minute"]


def simulate_flow_inversion(
    minutes: pd.DataFrame,
    flow_day: pd.DataFrame,
    matched_side: str,
    entry_price: float,
    trigger_ts: pd.Timestamp,
) -> tuple[float | None, pd.Timestamp | None, str]:
    """Return (exit_pct, exit_ts, status). Status describes which
    branch fired so the report can break down what happened."""
    post = minutes[minutes["minute"] > trigger_ts].copy()
    if post.empty:
        return None, None, "no_post_trigger_prices"
    eod_ts = (
        trigger_ts.tz_convert("America/Chicago")
        .replace(hour=EOD_CT_HOUR, minute=EOD_CT_MINUTE, second=0, microsecond=0)
        .tz_convert("UTC")
    )
    flow_post = flow_day[
        (flow_day["ts"] > trigger_ts) & (flow_day["ts"] <= eod_ts)
    ].copy()
    if len(flow_post) < 5:
        return None, None, "insufficient_flow_data"
    cum = flow_post[matched_side].cumsum().to_numpy()
    rng = float(cum.max() - cum.min())
    if rng <= 0:
        return None, None, "flat_flow_no_peak"
    peaks, props = find_peaks(cum, prominence=rng * PEAK_PROMINENCE_RATIO)
    if len(peaks) == 0:
        return None, None, "no_flow_peak_detected"
    peak_idx = int(peaks[np.argmax(props["prominences"])])
    # After peak, find first INVERSION_NEG_PERSIST_MIN consecutive
    # minutes where 5-min cumulative-flow slope is negative.
    flow_after_peak = flow_post.iloc[peak_idx:].copy()
    if len(flow_after_peak) < INVERSION_SLOPE_WINDOW_MIN + INVERSION_NEG_PERSIST_MIN:
        # Use EOD as the inversion fallback when there's not enough
        # post-peak data to detect inversion — flow peaked too late.
        return _exit_at_or_after(post, eod_ts, entry_price, status="eod_no_inversion_window")
    cum_after_peak = flow_after_peak[matched_side].cumsum().to_numpy()
    slopes = np.full(len(cum_after_peak), np.nan)
    for i in range(INVERSION_SLOPE_WINDOW_MIN, len(cum_after_peak)):
        slopes[i] = (cum_after_peak[i] - cum_after_peak[i - INVERSION_SLOPE_WINDOW_MIN]) / INVERSION_SLOPE_WINDOW_MIN
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
        return _exit_at_or_after(post, eod_ts, entry_price, status="eod_no_inversion_found")
    inversion_ts = flow_after_peak["ts"].iloc[inversion_idx]
    return _exit_at_or_after(post, inversion_ts, entry_price, status="inversion")


def _exit_at_or_after(
    minute_prices: pd.DataFrame,
    target_ts: pd.Timestamp,
    entry_price: float,
    status: str,
) -> tuple[float | None, pd.Timestamp | None, str]:
    """Find first minute >= target_ts and return its mid-based pct."""
    at_or_after = minute_prices[minute_prices["minute"] >= target_ts]
    if at_or_after.empty:
        last = minute_prices.iloc[-1]
        return float((last["mid"] - entry_price) / entry_price * 100), last["minute"], f"{status}_eod_fallback"
    row = at_or_after.iloc[0]
    return float((row["mid"] - entry_price) / entry_price * 100), row["minute"], status


def apply_costs(pct: float, entry_price: float, spread_pct_of_price: float) -> float:
    """Strip commissions + slippage from a gross % return.

    Commission: $0.65 round-trip per contract = $0.65 / (entry_price * 100) * 100 %
    Slippage: cross half the bid-ask each leg = SLIPPAGE_PCT_OF_SPREAD * spread on each side
    """
    if pd.isna(pct) or entry_price <= 0:
        return pct
    comm_pct = (COMMISSION_USD_PER_CONTRACT_RT / (entry_price * 100)) * 100
    slip_pct = 2 * SLIPPAGE_PCT_OF_SPREAD * spread_pct_of_price
    return pct - comm_pct - slip_pct


def fmt(v):
    if v is None or pd.isna(v):
        return "—"
    return f"{v:+.1f}"


def write_report(results: pd.DataFrame) -> None:
    lines: list[str] = ["# Exit Simulation — Trail-30/10 vs Flow-Inversion", ""]
    n = len(results)
    lines.append(
        f"Sample: **{n:,} fires** in the 15-day parquet window "
        "(2026-04-13 → 2026-05-01) with trade tape available for the option chain "
        "AND post-trigger flow data for the underlying."
    )
    lines.append("")
    lines.append("## Aggregate P&L (mid-based, no costs)")
    lines.append("")
    lines.append("| metric | trail-30/10 | flow-inversion | diff (inv-trail) |")
    lines.append("| --- | ---: | ---: | ---: |")
    def _apply(series: pd.Series, op):
        return getattr(series, op)() if isinstance(op, str) else op(series)

    for stat, op in [
        ("median", "median"),
        ("mean", "mean"),
        ("std", "std"),
        ("p10", lambda s: s.quantile(0.10)),
        ("p25", lambda s: s.quantile(0.25)),
        ("p75", lambda s: s.quantile(0.75)),
        ("p90", lambda s: s.quantile(0.90)),
    ]:
        t = _apply(results["trail_pct"], op)
        i = _apply(results["inversion_pct"], op)
        lines.append(f"| {stat} | {fmt(t)} | {fmt(i)} | {fmt(i - t)} |")
    lines.append("")

    win_rate_trail = (results["trail_pct"] > 0).mean()
    win_rate_inv = (results["inversion_pct"] > 0).mean()
    lottery_trail = (results["trail_pct"] >= 100).mean()
    lottery_inv = (results["inversion_pct"] >= 100).mean()
    lines.append(f"- Win-rate trail:           {win_rate_trail * 100:.1f}%")
    lines.append(f"- Win-rate inversion:       {win_rate_inv * 100:.1f}%")
    lines.append(f"- Lottery rate trail:       {lottery_trail * 100:.2f}%")
    lines.append(f"- Lottery rate inversion:   {lottery_inv * 100:.2f}%")
    lines.append("")
    lines.append("## Cost-net P&L ($0.65 RT + 25% spread slippage / leg)")
    lines.append("")
    lines.append("| metric | trail-30/10 net | flow-inversion net | diff |")
    lines.append("| --- | ---: | ---: | ---: |")
    for stat, op in [
        ("median", "median"),
        ("mean", "mean"),
        ("p25", lambda s: s.quantile(0.25)),
        ("p75", lambda s: s.quantile(0.75)),
    ]:
        t = _apply(results["trail_net_pct"], op)
        i = _apply(results["inversion_net_pct"], op)
        lines.append(f"| {stat} | {fmt(t)} | {fmt(i)} | {fmt(i - t)} |")
    lines.append("")

    lines.append("## Inversion exit status breakdown")
    lines.append("")
    sb = results["inversion_status"].value_counts()
    for status, count in sb.items():
        lines.append(f"- `{status}`: {count:,} ({count / n * 100:.1f}%)")
    lines.append("")
    lines.append("## Stratified by mode")
    lines.append("")
    lines.append("| mode | n | median trail | median inv | diff |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for mode, group in results.groupby("mode", observed=True):
        if len(group) < 30:
            continue
        t = group["trail_pct"].median()
        i = group["inversion_pct"].median()
        lines.append(f"| {mode} | {len(group):,} | {fmt(t)} | {fmt(i)} | {fmt(i - t)} |")
    lines.append("")
    lines.append("## Stratified by tod")
    lines.append("")
    lines.append("| tod | n | median trail | median inv | diff |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for tod, group in results.groupby("tod", observed=True):
        if len(group) < 30:
            continue
        t = group["trail_pct"].median()
        i = group["inversion_pct"].median()
        lines.append(f"| {tod} | {len(group):,} | {fmt(t)} | {fmt(i)} | {fmt(i - t)} |")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    median_diff_net = (results["inversion_net_pct"] - results["trail_net_pct"]).median()
    if median_diff_net >= 5:
        lines.append(
            f"**INVERSION WINS** — median fire keeps {median_diff_net:+.1f}pp more under "
            "flow-inversion exit, after costs. Worth pursuing as an alternative exit policy."
        )
    elif median_diff_net <= -5:
        lines.append(
            f"**TRAIL WINS** — median fire loses {abs(median_diff_net):.1f}pp under "
            "flow-inversion vs trail. Trail-30/10 is the better default; flow-inversion exits too early."
        )
    else:
        lines.append(
            f"**TIE** — median diff (inversion - trail) is {median_diff_net:+.1f}pp net. "
            "Within noise; no clear winner. Pick by simplicity / preference."
        )
    REPORT_OUT.write_text("\n".join(lines))


def plot_results(results: pd.DataFrame) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    # Side-by-side return histograms (clipped for readability)
    bins = np.linspace(-100, 200, 60)
    axes[0].hist(results["trail_pct"].clip(-100, 200), bins=bins, alpha=0.55, label=f"trail-30/10 (med {results['trail_pct'].median():+.1f})", color="steelblue")
    axes[0].hist(results["inversion_pct"].clip(-100, 200), bins=bins, alpha=0.55, label=f"flow-inversion (med {results['inversion_pct'].median():+.1f})", color="darkorange")
    axes[0].axvline(0, color="gray", linestyle="--")
    axes[0].set_xlabel("Realized return % (mid, no costs)")
    axes[0].set_ylabel("Fires")
    axes[0].set_title(f"Return distributions (n={len(results):,})")
    axes[0].legend()
    # Scatter: per-fire diff vs peak_ceiling
    diff = results["inversion_pct"] - results["trail_pct"]
    axes[1].scatter(
        results["peak_ceiling_pct"].clip(0, 500),
        diff.clip(-150, 150),
        s=4,
        alpha=0.4,
        c="purple",
    )
    axes[1].axhline(0, color="gray", linestyle="--")
    axes[1].set_xlabel("Peak ceiling % (clipped at 500)")
    axes[1].set_ylabel("Inversion - Trail (pp, clipped ±150)")
    axes[1].set_title("Per-fire P&L diff vs peak size")
    fig.tight_layout()
    out = PLOTS_DIR / "exit_simulation_distribution.png"
    fig.savefig(out, dpi=120, bbox_inches="tight")
    plt.close(fig)


def main() -> int:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Missing DATABASE_URL", file=sys.stderr)
        return 1
    print("connecting...")
    with psycopg2.connect(db_url) as conn:
        fires = load_fires(conn)
        if fires.empty:
            print("No fires in parquet window.")
            return 0
        tickers = sorted(fires["ticker"].unique().tolist())
        flow = load_flow_for_dates(conn, tickers, "2026-04-13", "2026-05-01")
    print(f"  fires:     {len(fires):,}")
    print(f"  tickers:   {len(tickers)}")
    print(f"  flow rows: {len(flow):,}")

    fires["trigger_time_ct"] = pd.to_datetime(fires["trigger_time_ct"], utc=True)
    flow["ts"] = pd.to_datetime(flow["ts"], utc=True)
    flow["session_date"] = flow["ts"].dt.tz_convert("America/Chicago").dt.date

    fires["fire_date"] = fires["date"].astype(str)
    fires_by_date = fires.groupby("fire_date")
    flow_groups = flow.groupby(["ticker", "session_date"], observed=True)

    rows: list[dict] = []
    for date_str, day_fires in fires_by_date:
        path = PARQUET_DIR / f"{date_str}-trades.parquet"
        if not path.exists():
            print(f"  missing parquet for {date_str} — skipping {len(day_fires)} fires")
            continue
        chains = day_fires["option_chain_id"].unique().tolist()
        # Filter pushdown via columns so we don't load 11M rows and then filter.
        all_trades = pd.read_parquet(
            path,
            columns=[
                "executed_at", "option_chain_id",
                "nbbo_bid", "nbbo_ask", "price", "canceled",
            ],
        )
        day_trades = all_trades[all_trades["option_chain_id"].isin(chains)].copy()
        chain_groups = day_trades.groupby("option_chain_id", observed=True)
        for fire in day_fires.itertuples(index=False):
            chain_id = fire.option_chain_id
            if chain_id not in chain_groups.groups:
                continue
            chain_trades = chain_groups.get_group(chain_id)
            minutes = build_minute_prices(chain_trades)
            if minutes.empty:
                continue
            trigger_ts = fire.trigger_time_ct
            entry_price = float(fire.entry_price)
            trail_pct, _ = simulate_trail(minutes, entry_price, trigger_ts)
            session_date = trigger_ts.tz_convert("America/Chicago").date()
            flow_key = (fire.ticker, session_date)
            if flow_key not in flow_groups.groups:
                continue
            flow_day = flow_groups.get_group(flow_key)
            matched_side = "net_call_prem" if fire.option_type == "C" else "net_put_prem"
            inv_pct, _, inv_status = simulate_flow_inversion(
                minutes, flow_day, matched_side, entry_price, trigger_ts
            )
            if trail_pct is None or inv_pct is None:
                continue
            entry_min = minutes.iloc[0]
            spread_pct = (
                (entry_min["spread"] / entry_min["mid"]) * 100
                if entry_min["mid"] > 0
                else 0
            )
            trail_net = apply_costs(trail_pct, entry_price, spread_pct)
            inv_net = apply_costs(inv_pct, entry_price, spread_pct)
            rows.append(
                {
                    "fire_id": fire.id,
                    "date_str": date_str,
                    "ticker": fire.ticker,
                    "trail_pct": trail_pct,
                    "inversion_pct": inv_pct,
                    "trail_net_pct": trail_net,
                    "inversion_net_pct": inv_net,
                    "inversion_status": inv_status,
                    "peak_ceiling_pct": float(fire.peak_ceiling_pct or 0),
                    "mode": fire.mode,
                    "tod": fire.tod,
                    "option_type": fire.option_type,
                    "spread_pct": spread_pct,
                }
            )
        del all_trades, day_trades
        print(f"  {date_str}: cumulative rows so far {len(rows):,}")

    if not rows:
        print("No simulated fires — exiting.")
        return 1
    results = pd.DataFrame(rows)
    results.to_parquet(RESULTS_PARQUET, index=False)
    print(f"  persisted {len(results):,} rows to {RESULTS_PARQUET.name}")
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    plot_results(results)
    write_report(results)
    print(f"\nWrote {REPORT_OUT}")
    print(f"  median trail:     {results['trail_pct'].median():+.1f}%")
    print(f"  median inversion: {results['inversion_pct'].median():+.1f}%")
    print(f"  median diff:      {(results['inversion_pct'] - results['trail_pct']).median():+.1f}pp")
    print(f"  median diff net:  {(results['inversion_net_pct'] - results['trail_net_pct']).median():+.1f}pp")

    if os.environ.get("WRITE_DB") == "1":
        write_back_to_db(results, db_url)

    return 0


def write_back_to_db(results: pd.DataFrame, db_url: str) -> None:
    """Persist inversion_pct into lottery_finder_fires.realized_flow_inversion_pct
    via batched UPDATE-from-UNNEST. Gated by WRITE_DB=1 so analysis re-runs
    don't accidentally clobber populated values."""
    from decimal import Decimal

    BATCH = 500
    print(f"\nWRITE_DB=1 — updating realized_flow_inversion_pct for {len(results):,} rows...")
    updated = 0
    with psycopg2.connect(db_url) as conn:
        with conn.cursor() as cur:
            for start in range(0, len(results), BATCH):
                chunk = results.iloc[start : start + BATCH]
                ids = chunk["fire_id"].astype(int).tolist()
                # Convert to Decimal so psycopg2 binds as NUMERIC cleanly.
                pcts = [Decimal(str(round(float(p), 4))) for p in chunk["inversion_pct"]]
                cur.execute(
                    """
                    UPDATE lottery_finder_fires AS f
                    SET realized_flow_inversion_pct = u.pct
                    FROM (
                      SELECT unnest(%(ids)s::bigint[]) AS id,
                             unnest(%(pcts)s::numeric[]) AS pct
                    ) u
                    WHERE f.id = u.id
                    """,
                    {"ids": ids, "pcts": pcts},
                )
                updated += cur.rowcount
        conn.commit()
    print(f"  updated {updated:,} of {len(results):,} rows")


if __name__ == "__main__":
    sys.exit(main())
