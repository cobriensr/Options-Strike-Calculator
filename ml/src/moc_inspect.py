"""
MOC Imbalance — Phase 0: Data Inspection

Loads the raw Databento imbalance DBN file for SPY + QQQ (XNAS.ITCH), converts
it to a pandas DataFrame, and prints a gut-feel inspection of what's actually
in the data before we build features.

This is the "do I trust the data" step. It validates:
  - Message counts per symbol per year (should be ~252 trading days x a handful
    of imbalance prints per day)
  - Distribution of publication times (closing auction prints should cluster
    in the last 10 min, opening cross earlier in the day)
  - Headline imbalance field ranges (total_imbalance_qty, paired_qty, side)
  - Presence of `auction_type` codes so we know how to filter for CLOSING
    auction only

Reminder on data provenance:
  - QQQ (NASDAQ-listed) -> XNAS.ITCH is authoritative. Full signal.
  - SPY (Arca-listed)   -> XNAS.ITCH shows only NASDAQ's portion of SPY flow,
    not the canonical Arca closing cross. Use as a proxy only, or pull
    ARCX.PILLAR separately for the authoritative SPY imbalance.

Usage:
    ml/.venv/bin/python ml/src/moc_inspect.py \\
        --input ~/Downloads/XNAS-20260414-C6YN774XG5/xnas-itch-20180501-20260413.imbalance.dbn.zst

Requires: pip install databento pandas
"""

import argparse
import sys
from pathlib import Path

try:
    import databento as db
    import pandas as pd
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install databento pandas")
    sys.exit(1)

from utils import ML_ROOT, section, subsection, takeaway


# ── Args ─────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="Path to the .dbn.zst imbalance file from Databento",
    )
    parser.add_argument(
        "--parquet-out",
        type=Path,
        default=ML_ROOT / "data" / "moc_imbalance_raw.parquet",
        help="Where to write the decoded parquet cache (default: ml/data/)",
    )
    return parser.parse_args()


# ── Load ─────────────────────────────────────────────────────


def load_dbn(path: Path) -> pd.DataFrame:
    """
    Decode a Databento DBN file into a pandas DataFrame, resolving
    instrument_id -> raw ticker via the embedded symbology so we can
    filter on 'SPY' / 'QQQ' directly.
    """
    if not path.exists():
        print(f"ERROR: file not found: {path}")
        sys.exit(1)
    print(f"  Loading {path.name} ({path.stat().st_size / 1e6:.1f} MB) ...")
    store = db.DBNStore.from_file(str(path))
    # map_symbols=True uses the DBN's embedded symbology metadata to add a
    # 'symbol' column (raw ticker) alongside the numeric instrument_id.
    frame = store.to_df(map_symbols=True)
    print(f"  Decoded {len(frame):,} imbalance messages")
    return frame


# ── Inspect ──────────────────────────────────────────────────


def inspect_schema(frame: pd.DataFrame) -> None:
    subsection("Schema & dtypes")
    print(frame.dtypes.to_string())
    print(f"\n  Index type: {type(frame.index).__name__}")
    print(f"  Date range: {frame.index.min()}  ->  {frame.index.max()}")


def inspect_counts_by_symbol(frame: pd.DataFrame) -> None:
    subsection("Message counts by symbol")
    counts = frame["symbol"].value_counts()
    print(counts.to_string())


def inspect_yearly_cadence(frame: pd.DataFrame) -> None:
    subsection("Messages per year per symbol")
    yearly = (
        frame.groupby([frame.index.year, "symbol"]).size().unstack(fill_value=0)
    )
    print(yearly.to_string())


def inspect_auction_types(frame: pd.DataFrame) -> None:
    subsection("auction_type distribution")
    # auction_type is a single char — 'C' closing, 'O' opening, 'H' halt,
    # 'P' IPO, etc. Counts tell us what we'll need to filter on.
    print(frame["auction_type"].value_counts(dropna=False).to_string())


def inspect_publication_times(frame: pd.DataFrame) -> None:
    subsection("Publication time-of-day (ET) — counts by hour:minute bucket")
    # Convert UTC to US/Eastern to see the 9:25 open-cross and 15:50-16:00
    # close-cross clusters.
    ts_et = frame.index.tz_convert("US/Eastern")
    buckets = ts_et.strftime("%H:%M")
    top = pd.Series(buckets).value_counts().sort_index()
    # Print only the non-zero minutes so it stays readable
    print(top.to_string())


def inspect_imbalance_distribution(frame: pd.DataFrame) -> None:
    subsection("total_imbalance_qty distribution (closing auction only)")
    close_mask = frame["auction_type"] == "C"
    close = frame.loc[close_mask]
    if close.empty:
        print("  (no auction_type == 'C' rows — check venue encoding)")
        return
    for symbol, grp in close.groupby("symbol"):
        print(f"\n  {symbol}:  n={len(grp):,}")
        print(grp["total_imbalance_qty"].describe().to_string())
        print("\n  side breakdown:")
        print(grp["side"].value_counts().to_string())


def inspect_nulls(frame: pd.DataFrame) -> None:
    subsection("Null counts (top 10 fields with nulls)")
    null_counts = frame.isnull().sum()
    null_counts = null_counts[null_counts > 0].sort_values(ascending=False)
    if null_counts.empty:
        print("  No null values anywhere.")
    else:
        print(null_counts.head(10).to_string())


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    args = parse_args()
    section("MOC Imbalance — Phase 0: Data Inspection")

    frame = load_dbn(args.input)

    inspect_schema(frame)
    inspect_counts_by_symbol(frame)
    inspect_yearly_cadence(frame)
    inspect_auction_types(frame)
    inspect_publication_times(frame)
    inspect_imbalance_distribution(frame)
    inspect_nulls(frame)

    # Cache a parquet copy so the real EDA/feature scripts don't re-parse the
    # DBN every run. Parquet loads ~20x faster than DBN on repeat.
    args.parquet_out.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(args.parquet_out)
    takeaway(
        f"Cached {len(frame):,} rows -> {args.parquet_out.relative_to(ML_ROOT)}. "
        "Next phase: filter auction_type=='C', compute signed imbalance, "
        "join with SPY/QQQ minute bars to build (imbalance -> MAE) targets."
    )


if __name__ == "__main__":
    main()
