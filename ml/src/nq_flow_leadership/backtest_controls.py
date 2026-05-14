"""Control variants for the QQQ sweep_dir_imbalance backtest.

The headline run produced a 100% win rate on 10 trades clustered in 4 days.
That's a red flag — likely the entry filters (PM bucket + NQ>VWAP + no-flush)
are themselves selecting for trending PM rallies, and the signal is just
along for the ride. These controls disentangle signal vs filter:

  A. INVERTED signal (top 20% — bull sweeps) with same filters.
     If A also wins ~80%+, signal isn't doing work.
  B. Pure signal, NO time/VWAP/flush filters.
     Reveals raw signal performance unfiltered.
  C. Filters only, NO signal threshold (every filter-eligible minute).
     Establishes filter-baseline win rate.
  D. Random control: random entries matching filter conditions.
     Sanity check on baseline.

Reuses simulate() and summarize() from backtest.py for apples-to-apples.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Reuse the original module's helpers
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backtest import (  # type: ignore
    ENTRY_PERCENTILE,
    FLUSH_THRESHOLD,
    HOLD_MAX_MIN,
    RT_COST_PCT,
    SIGNAL_COL,
    SL_PCT,
    TP_PCT,
    TRAILING_DAYS,
    WARMUP_DAYS,
    Trade,
    compute_nq_session_features,
    compute_signal_thresholds,
    load_data,
    summarize,
    time_bucket,
)

EXP = Path(__file__).resolve().parents[3] / "ml" / "experiments" / "nq-flow-leadership"


def simulate_variant(
    signals: pd.DataFrame,
    nq: pd.DataFrame,
    *,
    use_signal: bool = True,
    invert_signal: bool = False,
    use_time_filter: bool = True,
    use_vwap_filter: bool = True,
    use_flush_filter: bool = True,
    random_n: int | None = None,
    seed: int = 42,
) -> list[Trade]:
    """Generic simulator with toggleable filters."""
    # Drop date_ct from signals to avoid collision with nq's date_ct on merge
    sig = signals.drop(columns=["date_ct"], errors="ignore")
    merged = sig.merge(nq, left_on="minute_ts", right_on="ts", how="inner")
    merged = merged.sort_values("minute_ts").reset_index(drop=True)
    ts_ct = merged["minute_ts"].dt.tz_convert("America/Chicago")
    merged["bucket"] = (ts_ct.dt.hour * 60 + ts_ct.dt.minute).map(time_bucket)
    # For bookkeeping when bucket is None
    merged["bucket"] = merged["bucket"].fillna("off-hours")

    # Build mask piece by piece based on toggles
    mask = pd.Series(True, index=merged.index)
    if use_signal:
        if invert_signal:
            # Top 20%: invert percentile by computing trailing 80th rather than 20th.
            # Cheapest way: re-call with inverted ENTRY_PERCENTILE in the source thresholds
            # function. Here we instead rebuild on the fly per the merged df.
            mask &= (
                merged[SIGNAL_COL].notna()
                & merged["threshold_top20"].notna()
                & (merged[SIGNAL_COL] >= merged["threshold_top20"])
            )
        else:
            mask &= (
                merged[SIGNAL_COL].notna()
                & merged["threshold"].notna()
                & (merged[SIGNAL_COL] <= merged["threshold"])
            )
    if use_time_filter:
        mask &= merged["bucket"].isin(["open", "pm"])
    if use_vwap_filter:
        mask &= merged["close"] >= merged["vwap"]
    if use_flush_filter:
        mask &= merged["ret_30m_back"].fillna(0) > FLUSH_THRESHOLD

    eligible_idx = list(merged.index[mask])

    # Random subsample if requested (control D)
    if random_n is not None:
        rng = random.Random(seed)
        if len(eligible_idx) > random_n:
            eligible_idx = sorted(rng.sample(eligible_idx, random_n))

    trades: list[Trade] = []
    busy_until_idx = -1
    for entry_idx in eligible_idx:
        if entry_idx <= busy_until_idx:
            continue
        entry_row = merged.loc[entry_idx]
        entry_price = float(entry_row["close"])
        tp_level = entry_price * (1 + TP_PCT)
        sl_level = entry_price * (1 - SL_PCT)
        end_idx = min(entry_idx + HOLD_MAX_MIN, len(merged) - 1)
        entry_date = entry_row["date_ct"]

        exit_idx = None
        exit_price = float("nan")
        exit_reason = "time"
        for j in range(entry_idx + 1, end_idx + 1):
            bar = merged.loc[j]
            if bar["date_ct"] != entry_date:
                exit_idx = j - 1
                exit_price = float(merged.loc[exit_idx, "close"])
                break
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
            exit_idx = end_idx
            exit_price = float(merged.loc[end_idx, "close"])

        gross = (exit_price / entry_price) - 1
        net = gross - RT_COST_PCT
        sig_val = (
            float(entry_row[SIGNAL_COL])
            if pd.notna(entry_row[SIGNAL_COL])
            else float("nan")
        )
        trades.append(
            Trade(
                entry_ts=str(entry_row["minute_ts"]),
                entry_price=entry_price,
                exit_ts=str(merged.loc[exit_idx, "minute_ts"]),
                exit_price=exit_price,
                exit_reason=exit_reason,
                hold_minutes=int(exit_idx - entry_idx),
                gross_return_pct=float(gross * 100),
                net_return_pct=float(net * 100),
                bucket=str(entry_row["bucket"]),
                signal_value=sig_val,
            )
        )
        busy_until_idx = exit_idx

    return trades


def add_top20_threshold(signals: pd.DataFrame) -> pd.DataFrame:
    """Compute the top-20% (i.e., 80th percentile) threshold the same way."""
    df = signals.copy()
    df["date_ct"] = df["minute_ts"].dt.tz_convert("America/Chicago").dt.date
    unique_dates = sorted(df["date_ct"].unique())
    threshold_by_date = {}
    for i, d in enumerate(unique_dates):
        if i < WARMUP_DAYS:
            threshold_by_date[d] = float("nan")
            continue
        trailing = unique_dates[i - TRAILING_DAYS : i]
        vals = df[df["date_ct"].isin(trailing)][SIGNAL_COL].dropna()
        threshold_by_date[d] = (
            float(np.percentile(vals, 100 - ENTRY_PERCENTILE))
            if len(vals) >= 100
            else float("nan")
        )
    df["threshold_top20"] = df["date_ct"].map(threshold_by_date)
    return df


def main() -> int:
    EXP.mkdir(parents=True, exist_ok=True)
    feats, nq = load_data()
    nq_aug = compute_nq_session_features(nq)
    signals = compute_signal_thresholds(feats)
    signals = add_top20_threshold(signals)

    variants = {
        "ORIGINAL: bottom-20% + filters": {
            "use_signal": True,
            "invert_signal": False,
            "use_time_filter": True,
            "use_vwap_filter": True,
            "use_flush_filter": True,
        },
        "A: INVERTED top-20% + filters": {
            "use_signal": True,
            "invert_signal": True,
            "use_time_filter": True,
            "use_vwap_filter": True,
            "use_flush_filter": True,
        },
        "B: Pure signal, NO filters": {
            "use_signal": True,
            "invert_signal": False,
            "use_time_filter": False,
            "use_vwap_filter": False,
            "use_flush_filter": False,
        },
        "C: Filters only, NO signal": {
            "use_signal": False,
            "use_time_filter": True,
            "use_vwap_filter": True,
            "use_flush_filter": True,
        },
    }

    results = {}
    for name, kwargs in variants.items():
        trades = simulate_variant(signals, nq_aug, **kwargs)
        summary = summarize(trades)
        results[name] = summary
        print("=" * 70)
        print(name)
        print("=" * 70)
        for k in (
            "n_trades",
            "win_rate_pct",
            "avg_win_pct",
            "avg_loss_pct",
            "expectancy_pct",
            "net_total_return_pct",
            "max_drawdown_pct",
            "profit_factor",
            "exit_reason_breakdown",
            "bucket_breakdown",
            "avg_hold_minutes",
        ):
            v = summary.get(k)
            if v is None:
                continue
            print(f"  {k}: {v}")
        print()

    # Run D last with random_n matching ORIGINAL trade count
    n_orig = results["ORIGINAL: bottom-20% + filters"]["n_trades"]
    print("=" * 70)
    print(f"D: RANDOM matched-count (n={n_orig}) within filter-eligible minutes")
    print("=" * 70)
    rand_trades = simulate_variant(
        signals,
        nq_aug,
        use_signal=False,
        use_time_filter=True,
        use_vwap_filter=True,
        use_flush_filter=True,
        random_n=n_orig,
    )
    rand_summary = summarize(rand_trades)
    results["D: RANDOM matched-count"] = rand_summary
    for k in (
        "n_trades",
        "win_rate_pct",
        "avg_win_pct",
        "avg_loss_pct",
        "expectancy_pct",
        "net_total_return_pct",
        "avg_hold_minutes",
        "exit_reason_breakdown",
    ):
        v = rand_summary.get(k)
        if v is None:
            continue
        print(f"  {k}: {v}")

    with open(EXP / "backtest_controls.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nWrote {EXP / 'backtest_controls.json'}")

    # Side-by-side summary
    print("\n" + "=" * 70)
    print("SIDE-BY-SIDE COMPARISON")
    print("=" * 70)
    print(f"{'Variant':<40} {'n':>4} {'win%':>6} {'EV%':>7} {'net%':>7}")
    for name, s in results.items():
        n = s.get("n_trades", 0)
        wr = s.get("win_rate_pct", 0)
        ev = s.get("expectancy_pct", 0)
        nt = s.get("net_total_return_pct", 0)
        print(f"  {name:<40} {n:>4} {wr:>6} {ev:>7} {nt:>7}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
