#!/usr/bin/env python3
"""
Recompute per-ticker whale-detection thresholds (p95 of premium) from the
EOD parquet archive.

The thresholds in api/_lib/whale-detector.ts are calibrated to a fixed
window of historical data. As the archive grows, the empirical p95
shifts. Run this script every ~30 trading days (or after a regime
change) to surface drift; the printed values can be pasted directly into
WHALE_THRESHOLDS.

Usage:
    ml/.venv/bin/python scripts/recompute-whale-thresholds.py [--last-n-days N]

Optional --last-n-days narrows the recompute to a trailing window so a
single regime-changing day doesn't permanently shift the long-run number.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import polars as pl
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Run with ml/.venv/bin/python", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
PARQUET_DIR = REPO_ROOT / "scripts" / "eod-flow-analysis" / "output" / "by-day"
WHALE_TICKERS = ["SPX", "SPXW", "NDX", "NDXP", "QQQ", "SPY", "IWM"]


def load_archive(last_n_days: int | None = None) -> pl.DataFrame:
    files = sorted(PARQUET_DIR.glob("*-chains.parquet"))
    if not files:
        raise FileNotFoundError(f"No parquet files in {PARQUET_DIR}")
    if last_n_days is not None:
        files = files[-last_n_days:]
    return pl.concat([pl.read_parquet(f) for f in files])


def compute_per_ticker(df: pl.DataFrame) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for tkr in WHALE_TICKERS:
        sub = df.filter(pl.col("ticker") == tkr)
        if sub.height == 0:
            continue
        stats = sub.select(
            [
                pl.col("total_premium").quantile(0.50).alias("p50"),
                pl.col("total_premium").quantile(0.75).alias("p75"),
                pl.col("total_premium").quantile(0.90).alias("p90"),
                pl.col("total_premium").quantile(0.95).alias("p95"),
                pl.col("total_premium").quantile(0.99).alias("p99"),
                pl.col("total_premium").max().alias("max"),
            ]
        ).row(0, named=True)
        out[tkr] = {**stats, "n": float(sub.height)}
    return out


def print_table(stats: dict[str, dict[str, float]]) -> None:
    print(
        f"\n{'Ticker':6} {'N':>7} {'p50':>14} {'p75':>14} {'p90':>14} "
        f"{'p95':>14} {'p99':>14} {'Max':>14}"
    )
    for tkr in WHALE_TICKERS:
        s = stats.get(tkr)
        if s is None:
            print(f"{tkr:6} (no data)")
            continue
        print(
            f"{tkr:6} {int(s['n']):>7} ${s['p50']:>12,.0f} ${s['p75']:>12,.0f} "
            f"${s['p90']:>12,.0f} ${s['p95']:>12,.0f} ${s['p99']:>12,.0f} "
            f"${s['max']:>12,.0f}"
        )


def print_typescript_block(stats: dict[str, dict[str, float]]) -> None:
    print(
        "\n# Paste the following into api/_lib/whale-detector.ts "
        "(WHALE_THRESHOLDS):\n"
    )
    print("export const WHALE_THRESHOLDS: Record<WhaleTicker, number> = {")
    for tkr in WHALE_TICKERS:
        s = stats.get(tkr)
        if s is None:
            continue
        # Underscore every 3 digits — matches the existing TS style.
        n = int(s["p95"])
        formatted = f"{n:,}".replace(",", "_")
        print(f"  {tkr}: {formatted},")
    print("};")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--last-n-days",
        type=int,
        default=None,
        help="Trailing window in days (default: all available)",
    )
    args = parser.parse_args(argv)

    df = load_archive(args.last_n_days)
    print(
        f"Loaded {df.height:,} chains from "
        f"{df['trade_date'].min()} to {df['trade_date'].max()}"
        f"{' (last ' + str(args.last_n_days) + ' days)' if args.last_n_days else ''}"
    )

    stats = compute_per_ticker(df)
    print_table(stats)
    print_typescript_block(stats)

    return 0


if __name__ == "__main__":
    sys.exit(main())
