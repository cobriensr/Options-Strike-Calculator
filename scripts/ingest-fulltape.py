#!/usr/bin/env python3
"""Ingest a UW Full Tape CSV: validate header (soft-fail), shape to schema, write Parquet.

Usage:
    ml/.venv/bin/python scripts/ingest-fulltape.py <YYYY-MM-DD>
    ml/.venv/bin/python scripts/ingest-fulltape.py 2026-05-06 --keep-csv

Spec: docs/superpowers/specs/fulltape-archive-2026-05-07.md

Auxiliary, parallel pipeline to scripts/ingest-flow.py. Captures the raw UW
Full Tape into a local parquet archive (~/Desktop/Eod-Full-Tape-parquet/).
No filtering, no Blob upload — this is a row-faithful insurance copy of a
feed that UW retains for only 3 trading days. Schema is frozen against the
spec; soft-fails on drift so we don't lose days of capture if UW renames a
column underneath us.
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import UTC, date as dt_date, datetime
from pathlib import Path

import polars as pl

# --- Schema (frozen — pinned to docs/superpowers/specs/fulltape-archive-2026-05-07.md) ---

FULLTAPE_SCHEMA: dict[str, pl.DataType] = {
    "id": pl.Utf8,                          # UUID
    "underlying_symbol": pl.Utf8,
    "executed_at": pl.Datetime("us", "UTC"),
    "nbbo_bid": pl.Float64,
    "nbbo_ask": pl.Float64,
    "size": pl.Int32,
    "price": pl.Float64,
    "option_chain_id": pl.Utf8,
    "alert_score": pl.Utf8,                 # 0/11M populated — placeholder
    "created_at": pl.Datetime("us", "UTC"),
    "report_flags": pl.Utf8,                # Postgres array literal: '{}', '{intermarket_sweep}', etc.
    "tags": pl.Utf8,                        # Postgres array literal: '{ask_side,bullish,etf}'
    "expiry": pl.Date,
    "option_type": pl.Utf8,                 # 'call' | 'put'
    "open_interest": pl.Int32,
    "strike": pl.Float64,
    "premium": pl.Float64,
    "aggregated_trade_id": pl.Utf8,         # 0/11M populated — placeholder
    "volume": pl.Int32,
    "underlying_price": pl.Float64,
    "ewma_nbbo_ask": pl.Float64,
    "ewma_nbbo_bid": pl.Float64,
    "implied_volatility": pl.Float64,
    "delta": pl.Float64,
    "theta": pl.Float64,
    "gamma": pl.Float64,
    "vega": pl.Float64,
    "rho": pl.Float64,
    "theo": pl.Float64,
    "upstream_condition_detail": pl.Utf8,   # 4-char codes: 'auto', 'slan', 'mlet', 'mlat', 'isoi', etc.
    "market_center_locate": pl.Int32,       # small ints, 1-16 in samples
    "canceled": pl.Utf8,                    # 'f' | 't' literals — cast to bool in transform
    "trade_id": pl.Int64,                   # 11M/11M = 0 — placeholder
    "exchange": pl.Utf8,                    # 4-char codes: 'XCBO', 'ARCO', 'XPHO', etc.
    "ask_vol": pl.Int32,
    "bid_vol": pl.Int32,
    "no_side_vol": pl.Int32,
    "mid_vol": pl.Int32,
    "multi_vol": pl.Int32,
    "stock_multi_vol": pl.Int32,
}

SANITY_FLOOR_ROWS = 1_000_000

DEFAULT_INPUT_DIR = Path.home() / "Downloads" / "EOD-FullTape"
ARCHIVE_PARQUET_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"


def expected_csv_path(date: str, input_dir: Path) -> Path:
    return input_dir / f"fulltape-{date}.csv"


def archive_parquet_path(date: str) -> Path:
    return ARCHIVE_PARQUET_DIR / f"{date}-fulltape.parquet"


def validate_header(csv_path: Path) -> tuple[list[str], list[str]]:
    """Read CSV header and report drift against FULLTAPE_SCHEMA.

    Soft-fail policy (intentionally diverges from ingest-flow.py): we keep
    a stable, schema-uniform parquet view even if UW renames or drops a
    column. Missing CSV cols become null; extra CSV cols are dropped at
    scan time. The only hard failure is an empty / unreadable CSV.

    Returns (missing_in_csv, extra_in_csv) for the caller to log/track.
    """
    expected = list(FULLTAPE_SCHEMA.keys())
    with csv_path.open("r") as f:
        header_line = f.readline().strip()
    if not header_line:
        raise ValueError(f"CSV is empty or has no header: {csv_path}")
    header = header_line.split(",")
    expected_set = set(expected)
    header_set = set(header)
    missing = sorted(expected_set - header_set)
    extra = sorted(header_set - expected_set)
    if missing:
        print(
            f"WARN: {len(missing)} schema col(s) not in CSV (will null-fill): {missing}",
            file=sys.stderr,
        )
    if extra:
        print(
            f"WARN: {len(extra)} CSV col(s) not in schema (will drop): {extra}",
            file=sys.stderr,
        )
    return missing, extra


def shape_to_schema(
    csv_path: Path, missing: list[str], extra: list[str]
) -> pl.LazyFrame:
    """Scan the CSV and project to exactly FULLTAPE_SCHEMA's columns/order.

    Strategy:
      - scan_csv with `infer_schema_length=0` so polars doesn't peek; we
        type only the columns we know about.
      - schema_overrides covers the cols actually present in the CSV.
      - Drop `extra` cols by selecting only the schema cols that are
        present; add `missing` cols as typed null literals.
      - Final select restores FULLTAPE_SCHEMA's column order.
    """
    present_overrides = {
        col: dtype
        for col, dtype in FULLTAPE_SCHEMA.items()
        if col not in missing
    }
    lf = pl.scan_csv(
        csv_path,
        schema_overrides=present_overrides,
        infer_schema_length=0,
        missing_utf8_is_empty_string=True,
    )
    # Drop extras by selecting only present schema cols first.
    present_cols = [c for c in FULLTAPE_SCHEMA if c not in missing]
    lf = lf.select(present_cols)
    # Add typed nulls for missing schema cols.
    if missing:
        lf = lf.with_columns(
            [
                pl.lit(None, dtype=FULLTAPE_SCHEMA[c]).alias(c)
                for c in missing
            ]
        )
    # Note: `extra` is implicitly dropped by the select above. The arg is
    # kept on the signature so callers can log it from one place.
    _ = extra
    # Restore canonical column order.
    return lf.select(list(FULLTAPE_SCHEMA.keys()))


def transform(lf: pl.LazyFrame, date: str) -> pl.LazyFrame:
    """Cast `canceled` to bool and add `date` partition + `ingested_at` traceability cols.

    Deliberately minimal — no row filtering, no sorting. Raw archive only.
    """
    date_obj = dt_date.fromisoformat(date)
    ingested_at = datetime.now(UTC)
    return lf.with_columns(
        (pl.col("canceled") == "t").alias("canceled"),
        pl.lit(date_obj).alias("date"),
        pl.lit(ingested_at).alias("ingested_at"),
    )


def write_archive(lf: pl.LazyFrame, archive_path: Path) -> None:
    """Stream the LazyFrame to disk as Parquet.

    `sink_parquet` keeps the 11M-row, ~4 GB CSV from being fully
    materialized in memory. zstd-3 + 1M-row groups + statistics matches
    the bot-eod archive's compression profile for consistency.
    """
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    lf.sink_parquet(
        archive_path,
        compression="zstd",
        compression_level=3,
        row_group_size=1_048_576,
        statistics=True,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("date", help="Trading date in YYYY-MM-DD format")
    p.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    p.add_argument("--keep-csv", action="store_true", help="Don't delete source CSV")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        print(f"ERROR: date must be YYYY-MM-DD, got {args.date!r}", file=sys.stderr)
        return 2

    csv_path = expected_csv_path(args.date, args.input_dir)
    if not csv_path.is_file():
        print(f"ERROR: CSV not found: {csv_path}", file=sys.stderr)
        return 2

    print(f"→ Validating header: {csv_path.name}")
    missing, extra = validate_header(csv_path)

    print("→ Counting raw rows (streaming)")
    count_lf = shape_to_schema(csv_path, missing, extra)
    raw_count = count_lf.select(pl.len()).collect(engine="streaming").item()
    print(f"  raw rows: {raw_count:,}")

    if raw_count == 0:
        print("ERROR: empty CSV", file=sys.stderr)
        return 2
    if raw_count < SANITY_FLOOR_ROWS:
        print(
            f"WARN: row count below sanity floor ({SANITY_FLOOR_ROWS:,}); continuing"
        )

    archive_path = archive_parquet_path(args.date)
    if archive_path.exists():
        print(
            f"→ Parquet already exists, skipping write: {archive_path} "
            f"({archive_path.stat().st_size / 1024**2:.1f} MB)"
        )
    else:
        print(f"→ Writing Full Tape Parquet: {archive_path}")
        lf = shape_to_schema(csv_path, missing, extra)
        lf = transform(lf, args.date)
        write_archive(lf, archive_path)

    csv_size = csv_path.stat().st_size
    parquet_size = archive_path.stat().st_size
    print(f"  CSV     {csv_size / 1024**3:.2f} GB")
    print(f"  Parquet {parquet_size / 1024**2:.1f} MB")
    print(f"  Ratio   {csv_size / parquet_size:.1f}×")

    if not args.keep_csv:
        print(f"→ Deleting source CSV: {csv_path}")
        csv_path.unlink()
    else:
        print(f"→ --keep-csv: leaving source CSV in place: {csv_path}")

    tops = (
        pl.scan_parquet(archive_path)
        .group_by("underlying_symbol")
        .len()
        .sort("len", descending=True)
        .head(10)
        .collect(engine="streaming")
    )
    print("\nTop 10 underlyings:")
    for sym, n in tops.iter_rows():
        print(f"  {sym:<10} {n:>10,}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
