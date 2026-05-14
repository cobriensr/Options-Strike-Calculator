"""Phase 2 — forward NQ log-returns at 5/15/30/60 min horizons.

Reads ml/data/nq-flow-leadership/nq_1m_bars.parquet, computes forward
log-returns at each horizon for every minute, RESETTING at session
boundaries so we never compute a return that spans an overnight gap.
Writes to ml/data/nq-flow-leadership/nq_forward_returns.parquet.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[3] / "ml" / "data" / "nq-flow-leadership"
INPUT_PATH = DATA_DIR / "nq_1m_bars.parquet"
OUTPUT_PATH = DATA_DIR / "nq_forward_returns.parquet"

HORIZONS_MIN = (5, 15, 30, 60)


def main() -> int:
    if not INPUT_PATH.exists():
        print(
            f"ERROR: {INPUT_PATH} not found (run load_nq_bars first)", file=sys.stderr
        )
        return 1

    df = pd.read_parquet(INPUT_PATH)
    df = df.sort_values("ts").reset_index(drop=True)
    df["date_ct"] = df["ts"].dt.tz_convert("America/Chicago").dt.date
    df["minute_ts"] = df["ts"]
    df["log_close"] = np.log(df["close"])

    # For each horizon, compute fwd log return WITHIN-DAY only.
    # Use shift(-H) within each date_ct group so cross-day shifts return NaN.
    for h in HORIZONS_MIN:
        col = f"fwd_ret_{h}m"
        df[col] = df.groupby("date_ct")["log_close"].shift(-h) - df["log_close"]

    # Sanity counts: how many non-NaN at each horizon? (Last H minutes of each day = NaN.)
    for h in HORIZONS_MIN:
        col = f"fwd_ret_{h}m"
        nn = int(df[col].notna().sum())
        nan = int(df[col].isna().sum())
        rng = df[col].dropna()
        if len(rng) > 0:
            print(
                f"  {col}: {nn:,} valid / {nan:,} NaN | mean={rng.mean():+.5f} "
                f"std={rng.std():.5f} p01={rng.quantile(0.01):+.5f} p99={rng.quantile(0.99):+.5f}"
            )

    out = df[["minute_ts", "close"] + [f"fwd_ret_{h}m" for h in HORIZONS_MIN]]
    out.to_parquet(OUTPUT_PATH, compression="zstd")
    print(f"\nWrote {OUTPUT_PATH} ({len(out):,} rows, {len(out.columns)} cols)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
