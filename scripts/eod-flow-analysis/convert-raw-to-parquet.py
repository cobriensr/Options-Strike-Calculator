"""
Lossless CSV → parquet converter for raw UW-bot EOD options-flow files.

Sibling to analyze.py — but where analyze.py aggregates per-chain (98% of
trades dropped), this script preserves every row and every column with
proper dtypes. Output is ~85-90% smaller than CSV with zero information
loss, and orders-of-magnitude faster to scan column-projected.

Source:  /Users/charlesobrien/Desktop/Bot-Eod/bot-eod-report-YYYY-MM-DD.csv
Output:  ~/Desktop/Bot-Eod-parquet/YYYY-MM-DD-trades.parquet  (zstd)

Usage:
    # Convert all CSVs not yet converted
    ml/.venv/bin/python scripts/eod-flow-analysis/convert-raw-to-parquet.py

    # Convert one specific date
    ml/.venv/bin/python scripts/eod-flow-analysis/convert-raw-to-parquet.py --day 2026-04-23

    # Re-convert (overwrite existing parquet)
    ml/.venv/bin/python scripts/eod-flow-analysis/convert-raw-to-parquet.py --day 2026-04-23 --force

Files are NOT checked into git — set INPUT_DIR / OUTPUT_DIR via env or
CLI flags to point elsewhere.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import duckdb

INPUT_DIR = Path(os.environ.get("BOT_EOD_RAW_DIR", "/Users/charlesobrien/Desktop/Bot-Eod"))
OUTPUT_DIR = Path(os.environ.get("BOT_EOD_PARQUET_DIR", str(Path.home() / "Desktop/Bot-Eod-parquet")))

CSV_PATTERN = re.compile(r"^bot-eod-report-(\d{4}-\d{2}-\d{2})\.csv$")


def find_csvs(input_dir: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for csv in input_dir.glob("bot-eod-report-*.csv"):
        m = CSV_PATTERN.match(csv.name)
        if m:
            out[m.group(1)] = csv
    return dict(sorted(out.items()))


def convert(date_str: str, csv_path: Path, out_dir: Path, *, force: bool) -> Path | None:
    out_path = out_dir / f"{date_str}-trades.parquet"
    if out_path.exists() and not force:
        print(f"[skip]    {date_str} already converted ({out_path.stat().st_size/1e6:.0f} MB)", file=sys.stderr)
        return None

    in_size_gb = csv_path.stat().st_size / 1e9
    print(f"[convert] {date_str}  ({in_size_gb:.2f} GB CSV) → parquet …", file=sys.stderr)

    con = duckdb.connect()
    # Lossless dump: keep every column, every row. DuckDB infers types from
    # the header sample; sample_size is generous to avoid mis-typing sparse
    # columns. ROW_GROUP_SIZE keeps groups small enough for fast filtered
    # scans (vs the default 122,880 which is too coarse for time-bucketed
    # queries on this dataset).
    con.execute(
        f"""
        COPY (
            SELECT * FROM read_csv_auto('{csv_path}', header=true, sample_size=200000)
        )
        TO '{out_path}'
        (FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE 100000)
        """
    )

    out_size_gb = out_path.stat().st_size / 1e9
    ratio = in_size_gb / out_size_gb if out_size_gb > 0 else 0
    print(
        f"[done]    {date_str}  {in_size_gb:.2f} GB → {out_size_gb:.2f} GB  ({ratio:.1f}× smaller)",
        file=sys.stderr,
    )
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--day", help="Process single date (YYYY-MM-DD)")
    parser.add_argument("--force", action="store_true", help="Re-convert existing parquet")
    parser.add_argument("--input", help="Override input dir", default=None)
    parser.add_argument("--output", help="Override output dir", default=None)
    args = parser.parse_args()

    input_dir = Path(args.input) if args.input else INPUT_DIR
    output_dir = Path(args.output) if args.output else OUTPUT_DIR

    if not input_dir.is_dir():
        print(f"[error]   Input dir does not exist: {input_dir}", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    csvs = find_csvs(input_dir)
    if not csvs:
        print(f"[error]   No bot-eod-report-*.csv files in {input_dir}", file=sys.stderr)
        sys.exit(1)

    targets = [args.day] if args.day else list(csvs.keys())
    for date_str in targets:
        if date_str not in csvs:
            print(f"[error]   No CSV for date {date_str}", file=sys.stderr)
            continue
        convert(date_str, csvs[date_str], output_dir, force=args.force)

    print(f"\nOutput dir: {output_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
