"""Phase 6 — Backtest the validated QQQ sweep_dir_imbalance trigger.

Implements the rule from docs/tmp/nq-flow-signal-usage-guide-2026-05-02.md:

  Long entry — all four must be true:
    1. Open or PM time-of-day bucket
    2. QQQ sweep_dir_imbalance_30m_0dte in bottom 20% of trailing 5-day distribution
       (walk-forward, no look-ahead)
    3. NQ at or above session VWAP
    4. NQ trailing 30-min return > -0.4% (no active flush)
  Exit:
    - TP +0.20% NQ
    - SL -0.10% NQ
    - Time stop 30 min
  Costs:
    - 1 NQ tick slippage per side + ~$5 round-trip commission
    - Total round-trip ~0.0033% of notional (3 bps)

Output:
  ml/experiments/nq-flow-leadership/backtest_trades.parquet  (per-trade log)
  ml/experiments/nq-flow-leadership/backtest_summary.json    (summary stats)

Methodology notes (per backtesting-frameworks skill):
  - Point-in-time: percentile threshold uses TRAILING 5-day window only,
    never future data. 5-day warmup so trades start day 6.
  - Conservative same-bar hit: if TP and SL both hit within a single bar's
    high/low, assume SL hit first.
  - One position at a time: no overlapping entries.
  - Long-only per user preference.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).resolve().parents[3] / "ml" / "data" / "nq-flow-leadership"
EXP = Path(__file__).resolve().parents[3] / "ml" / "experiments" / "nq-flow-leadership"

# --- Strategy parameters (mirror usage doc)
SIGNAL_COL = "QQQ_sweep_dir_imbalance_30m_0dte"
ENTRY_PERCENTILE = 20.0  # bottom 20% of trailing distribution
TP_PCT = 0.0020  # +0.20% NQ
SL_PCT = 0.0010  # -0.10% NQ
HOLD_MAX_MIN = 30  # time stop in minutes
TRAILING_DAYS = 5  # walk-forward percentile window
WARMUP_DAYS = 5  # require N days of history before trading
RT_COST_PCT = 0.000033  # 1 tick slippage each side + commission ~3 bps
FLUSH_THRESHOLD = -0.004  # NQ trailing 30-min return below this = "active flush"

# Time-of-day buckets (CT minute-of-day)
OPEN_MIN, OPEN_END = 8 * 60 + 30, 9 * 60 + 30
PM_MIN, PM_END = 13 * 60, 14 * 60 + 30


@dataclass
class Trade:
    entry_ts: str
    entry_price: float
    exit_ts: str
    exit_price: float
    exit_reason: str  # 'tp' | 'sl' | 'time'
    hold_minutes: int
    gross_return_pct: float
    net_return_pct: float
    bucket: str  # 'open' | 'pm'
    signal_value: float


def load_data() -> tuple[pd.DataFrame, pd.DataFrame]:
    feats = pd.read_parquet(DATA / "features_minute.parquet")
    nq = pd.read_parquet(DATA / "nq_1m_bars.parquet")
    return feats, nq


def compute_nq_session_features(nq: pd.DataFrame) -> pd.DataFrame:
    """Add per-minute VWAP and trailing-30m return per session-day."""
    nq = nq.sort_values("ts").reset_index(drop=True).copy()
    nq["date_ct"] = nq["ts"].dt.tz_convert("America/Chicago").dt.date
    typical = (nq["high"] + nq["low"] + nq["close"]) / 3.0

    # Per-day cumulative VWAP
    grouped = nq.groupby("date_ct", group_keys=False)
    nq["cum_pv"] = grouped.apply(
        lambda g: (typical.loc[g.index] * g["volume"]).cumsum()
    )
    nq["cum_v"] = grouped["volume"].cumsum()
    nq["vwap"] = nq["cum_pv"] / nq["cum_v"].replace(0, np.nan)

    # Trailing 30-min return WITHIN day (NaN at session boundaries)
    log_close = np.log(nq["close"])
    nq["ret_30m_back"] = log_close - grouped["close"].apply(
        lambda s: np.log(s).shift(30)
    )

    return nq[["ts", "date_ct", "open", "high", "low", "close", "vwap", "ret_30m_back"]]


def compute_signal_thresholds(feats: pd.DataFrame) -> pd.DataFrame:
    """Walk-forward percentile threshold per minute, using trailing N-day distribution.

    Returns a DataFrame indexed by minute_ts with the trailing percentile threshold
    for that minute. NaN during warmup.
    """
    df = feats[["minute_ts", SIGNAL_COL]].copy()
    df["date_ct"] = df["minute_ts"].dt.tz_convert("America/Chicago").dt.date

    # For each unique date, compute the percentile of the trailing TRAILING_DAYS
    # of values (excluding the current day to keep it strictly point-in-time).
    unique_dates = sorted(df["date_ct"].unique())
    threshold_by_date = {}
    for i, d in enumerate(unique_dates):
        if i < WARMUP_DAYS:
            threshold_by_date[d] = float("nan")
            continue
        trailing_dates = unique_dates[
            i - TRAILING_DAYS : i
        ]  # last N days, excluding today
        trailing_values = df[df["date_ct"].isin(trailing_dates)][SIGNAL_COL].dropna()
        if len(trailing_values) < 100:
            threshold_by_date[d] = float("nan")
            continue
        threshold_by_date[d] = float(np.percentile(trailing_values, ENTRY_PERCENTILE))

    df["threshold"] = df["date_ct"].map(threshold_by_date)
    return df[["minute_ts", SIGNAL_COL, "threshold"]]


def time_bucket(ts_ct_min: int) -> str | None:
    if OPEN_MIN <= ts_ct_min < OPEN_END:
        return "open"
    if PM_MIN <= ts_ct_min < PM_END:
        return "pm"
    return None


def simulate(
    signals: pd.DataFrame,
    nq: pd.DataFrame,
) -> list[Trade]:
    """Walk through signals chronologically, simulate TP/SL/time exits."""
    # Merge signals with NQ on minute_ts.
    merged = signals.merge(nq, left_on="minute_ts", right_on="ts", how="inner")
    merged = merged.sort_values("minute_ts").reset_index(drop=True)
    ts_ct = merged["minute_ts"].dt.tz_convert("America/Chicago")
    merged["bucket"] = (ts_ct.dt.hour * 60 + ts_ct.dt.minute).map(time_bucket)

    # Entry mask: bucket valid AND signal below trailing threshold AND NQ above VWAP
    # AND not in active flush.
    entry_mask = (
        merged["bucket"].notna()
        & merged["threshold"].notna()
        & merged[SIGNAL_COL].notna()
        & (merged[SIGNAL_COL] <= merged["threshold"])
        & (merged["close"] >= merged["vwap"])
        & (merged["ret_30m_back"].fillna(0) > FLUSH_THRESHOLD)
    )

    # Walk through entries; simulate each trade against subsequent NQ bars
    trades: list[Trade] = []
    busy_until_idx = -1  # don't enter while a position is open
    for entry_idx in merged.index[entry_mask]:
        if entry_idx <= busy_until_idx:
            continue

        entry_row = merged.loc[entry_idx]
        entry_price = float(entry_row["close"])
        tp_level = entry_price * (1 + TP_PCT)
        sl_level = entry_price * (1 - SL_PCT)

        # Walk forward up to HOLD_MAX_MIN bars, but stop at session boundary
        # (no cross-day fills — NQ bars in dataset already filtered to RTH).
        end_idx = min(entry_idx + HOLD_MAX_MIN, len(merged) - 1)
        # Also enforce same-day exit
        entry_date = entry_row["date_ct"]

        exit_idx = None
        exit_price = float("nan")
        exit_reason = "time"
        for j in range(entry_idx + 1, end_idx + 1):
            bar = merged.loc[j]
            if bar["date_ct"] != entry_date:
                # crossed into next day - exit at last same-day close
                exit_idx = j - 1
                exit_price = float(merged.loc[exit_idx, "close"])
                exit_reason = "time"
                break
            # Conservative same-bar resolution: if SL touched, take SL.
            if bar["low"] <= sl_level:
                exit_idx = j
                exit_price = sl_level
                exit_reason = "sl"
                break
            if bar["high"] >= tp_level:
                exit_idx = j
                exit_price = tp_level
                exit_reason = "tp"
                break

        if exit_idx is None:
            # Time stop reached without TP/SL
            exit_idx = end_idx
            exit_price = float(merged.loc[end_idx, "close"])
            exit_reason = "time"

        gross_return = (exit_price / entry_price) - 1
        net_return = gross_return - RT_COST_PCT
        hold_minutes = int(exit_idx - entry_idx)
        trades.append(
            Trade(
                entry_ts=str(entry_row["minute_ts"]),
                entry_price=entry_price,
                exit_ts=str(merged.loc[exit_idx, "minute_ts"]),
                exit_price=exit_price,
                exit_reason=exit_reason,
                hold_minutes=hold_minutes,
                gross_return_pct=float(gross_return * 100),
                net_return_pct=float(net_return * 100),
                bucket=str(entry_row["bucket"]),
                signal_value=float(entry_row[SIGNAL_COL]),
            )
        )
        busy_until_idx = exit_idx

    return trades


def summarize(trades: list[Trade]) -> dict:
    if not trades:
        return {"n_trades": 0, "note": "no signals fired"}

    df = pd.DataFrame([asdict(t) for t in trades])
    n = len(df)
    wins = df[df["net_return_pct"] > 0]
    losses = df[df["net_return_pct"] <= 0]
    cum = df["net_return_pct"].cumsum()
    max_dd = float((cum.cummax() - cum).max())

    return {
        "n_trades": n,
        "win_rate_pct": round(100 * len(wins) / n, 2),
        "avg_win_pct": round(float(wins["net_return_pct"].mean()), 4)
        if len(wins)
        else None,
        "avg_loss_pct": round(float(losses["net_return_pct"].mean()), 4)
        if len(losses)
        else None,
        "expectancy_pct": round(float(df["net_return_pct"].mean()), 4),
        "gross_total_return_pct": round(float(df["gross_return_pct"].sum()), 4),
        "net_total_return_pct": round(float(df["net_return_pct"].sum()), 4),
        "max_drawdown_pct": round(max_dd, 4),
        "profit_factor": round(
            float(wins["net_return_pct"].sum() / -losses["net_return_pct"].sum())
            if len(losses) and losses["net_return_pct"].sum() != 0
            else float("nan"),
            3,
        ),
        "exit_reason_breakdown": df["exit_reason"].value_counts().to_dict(),
        "bucket_breakdown": df["bucket"].value_counts().to_dict(),
        "avg_hold_minutes": round(float(df["hold_minutes"].mean()), 1),
        "trade_dates": sorted(df["entry_ts"].str[:10].unique().tolist()),
    }


def main() -> int:
    EXP.mkdir(parents=True, exist_ok=True)
    feats, nq = load_data()
    nq_aug = compute_nq_session_features(nq)
    signals = compute_signal_thresholds(feats)
    trades = simulate(signals, nq_aug)
    summary = summarize(trades)

    # Save artifacts
    trades_df = pd.DataFrame([asdict(t) for t in trades])
    if not trades_df.empty:
        trades_df.to_parquet(EXP / "backtest_trades.parquet", compression="zstd")
    with open(EXP / "backtest_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    # Console report
    print("=" * 70)
    print(f"BACKTEST: QQQ {SIGNAL_COL} → NQ long, 30m hold")
    print("=" * 70)
    print(f"Period: {feats['minute_ts'].min()} → {feats['minute_ts'].max()}")
    print(
        f"Walk-forward: {WARMUP_DAYS}-day warmup, trailing-{TRAILING_DAYS}-day percentile"
    )
    print(
        f"Entry: signal in bottom {ENTRY_PERCENTILE}%, time in open|pm, NQ>VWAP, no flush"
    )
    print(
        f"Exit: TP +{TP_PCT * 100:.2f}% / SL -{SL_PCT * 100:.2f}% / time {HOLD_MAX_MIN}m"
    )
    print(f"Costs: {RT_COST_PCT * 100:.4f}% per round-trip")
    print()
    print("--- RESULTS ---")
    for k, v in summary.items():
        if isinstance(v, list) and len(v) > 5:
            print(f"  {k}: ({len(v)} items)")
        else:
            print(f"  {k}: {v}")

    if summary.get("n_trades", 0) > 0:
        # Per-trade log preview
        print()
        print("--- TRADE LOG ---")
        print(
            trades_df[
                [
                    "entry_ts",
                    "bucket",
                    "signal_value",
                    "entry_price",
                    "exit_price",
                    "exit_reason",
                    "hold_minutes",
                    "net_return_pct",
                ]
            ].to_string(index=False)
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
