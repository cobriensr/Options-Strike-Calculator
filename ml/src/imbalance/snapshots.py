"""Aggregate per-message NOII into one row per (date, symbol, auction_type).

For each auction window we capture the FIRST and LAST NOII update inside the
window, plus derived trend fields. This is the per-day panel Phase 3 joins
against SPX 1-min candles.

Auction-window definitions (ET, inclusive of start, exclusive of end):
    'C'  (Closing Cross / Closing Auction):  15:50:00 -> 16:00:00
    'M'  (Core Opening Auction):              09:00:00 -> 09:30:00
    'O'  (Early Opening Auction, non-NYSE):   09:25:00 -> 09:30:00

Usage:
    python -m src.imbalance.snapshots \\
        data/imbalance/arcx.parquet data/imbalance/xnas.parquet \\
        data/imbalance/xnys_main.parquet data/imbalance/xnys_pghd.parquet \\
        --output data/imbalance/snapshots.parquet
"""

from __future__ import annotations

import argparse
import sys
from datetime import time
from pathlib import Path

import pandas as pd

# (auction_type, start_time, end_time_exclusive) — times are Eastern.
AUCTION_WINDOWS: dict[str, tuple[time, time]] = {
    "C": (time(15, 50), time(16, 0)),
    "M": (time(9, 0), time(9, 30)),
    "O": (time(9, 25), time(9, 30)),
}

# Snapshot fields carried from the raw row into the per-window first/last.
SNAPSHOT_FIELDS = [
    "ts_event_et",
    "side",
    "signed_imbalance",
    "total_imbalance_qty",
    "paired_qty",
    "ref_price",
    "cont_book_clr_price",
]


def _in_window(et: pd.Series, start: time, end: time) -> pd.Series:
    """Returns rows where the ET clock time is in [start, end)."""
    clk = et.dt.time
    return (clk >= start) & (clk < end)


def _first_last_in_group(group: pd.DataFrame) -> pd.Series:
    """Pick the first and last NOII message in a (date,symbol,auction_type) group
    by ts_event_et, returning a flat row of {field}_first / {field}_last columns
    plus a count of messages in the window.
    """
    group = group.sort_values("ts_event_et")
    first = group.iloc[0]
    last = group.iloc[-1]
    out: dict[str, object] = {"n_msgs": len(group)}
    for field in SNAPSHOT_FIELDS:
        out[f"{field}_first"] = first[field]
        out[f"{field}_last"] = last[field]
    return pd.Series(out)


def _aggregate_one(df: pd.DataFrame, auction_type: str) -> pd.DataFrame:
    start, end = AUCTION_WINDOWS[auction_type]
    sub = df[
        (df["auction_type"] == auction_type) & _in_window(df["ts_event_et"], start, end)
    ]
    if sub.empty:
        return pd.DataFrame()

    sub = sub.assign(date=sub["ts_event_et"].dt.date)
    keys = ["dataset", "symbol", "date"]
    snap = (
        sub.groupby(keys, observed=True)
        .apply(_first_last_in_group, include_groups=False)
        .reset_index()
    )
    snap["auction_type"] = auction_type

    # Convergence: change in absolute imbalance over the window.
    # Negative means the imbalance is SHRINKING (contra liquidity arriving →
    # final auction print likely close to current indicative). Positive means
    # pressure is BUILDING (clearing price may still move).
    snap["abs_imbalance_first"] = snap["signed_imbalance_first"].abs()
    snap["abs_imbalance_last"] = snap["signed_imbalance_last"].abs()
    snap["abs_imbalance_trend"] = (
        snap["abs_imbalance_last"] - snap["abs_imbalance_first"]
    )
    snap["signed_imbalance_trend"] = (
        snap["signed_imbalance_last"] - snap["signed_imbalance_first"]
    )
    snap["paired_qty_growth"] = snap["paired_qty_last"] - snap["paired_qty_first"]

    return snap


def build_snapshots(parquets: list[Path]) -> pd.DataFrame:
    """Concatenate per-venue Parquets, aggregate each auction window, return
    one combined panel."""
    frames: list[pd.DataFrame] = []
    for p in parquets:
        if not p.is_file():
            raise FileNotFoundError(p)
        frames.append(pd.read_parquet(p))
    df = pd.concat(frames, ignore_index=True)

    pieces = [_aggregate_one(df, auction_type) for auction_type in AUCTION_WINDOWS]
    return pd.concat([p for p in pieces if not p.empty], ignore_index=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "inputs", nargs="+", type=Path, help="Per-venue imbalance Parquets"
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output snapshots Parquet path",
    )
    args = parser.parse_args()

    inputs = [p.expanduser().resolve() for p in args.inputs]
    output = args.output.expanduser().resolve()

    print(f"Loading {len(inputs)} venue Parquets...")
    panel = build_snapshots(inputs)
    output.parent.mkdir(parents=True, exist_ok=True)
    panel.to_parquet(output, compression="zstd", index=False)
    print(f"Wrote {len(panel):,} snapshot rows to {output}")
    print()
    print("Per-auction-type counts:")
    print(panel["auction_type"].value_counts().to_string())
    print()
    print("Per-venue counts:")
    print(panel["dataset"].value_counts().to_string())
    return 0


if __name__ == "__main__":
    sys.exit(main())
