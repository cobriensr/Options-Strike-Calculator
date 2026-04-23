#!/usr/bin/env python3
"""
Backfill institutional_blocks from local bot EOD CSV dumps.

Reads SPXW prints from ~/Downloads/EOD-OptionFlow/bot-eod-report-*.csv,
filters to mfsl/cbmo/slft conditions with size >= 50 and premium >= $25k,
classifies each block into program_track (ceiling / opening_atm / other),
and upserts into Neon Postgres.

Usage:
  DATABASE_URL="postgres://..." \
    ml/.venv/bin/python scripts/backfill-institutional-blocks.py \
    [--source /path/to/csv/dir] [--dry-run]

Notes:
  - Uses ml/.venv Python interpreter (duckdb + psycopg2 already installed).
  - Idempotent: relies on the trade_id PRIMARY KEY + ON CONFLICT DO NOTHING
    in the INSERT statement. Safe to re-run.
  - Only processes SPXW (for now). Extend by widening the DuckDB filter.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    import duckdb
    import psycopg2
    from psycopg2.extras import execute_batch
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Run with ml/.venv/bin/python")
    sys.exit(1)

DEFAULT_SOURCE = Path("/Users/charlesobrien/Downloads/EOD-OptionFlow")
TARGET_CONDITIONS = ("mfsl", "cbmo", "slft")
MIN_SIZE = 50
MIN_PREMIUM = 25_000
BATCH_SIZE = 500

# Classification thresholds — MUST match api/cron/fetch-spxw-blocks.ts
CEILING_DTE_MIN = 180
CEILING_DTE_MAX = 300
CEILING_MNY_MIN = 0.05
CEILING_MNY_MAX = 0.25
OPENING_DTE_MAX = 7
OPENING_MNY_MAX = 0.03
# 13:30-14:30 UTC = 08:30-09:30 CT
OPEN_START_UTC_MIN = 13 * 60 + 30
OPEN_END_UTC_MIN = 14 * 60 + 30


def classify_track(dte: int, mny: float, executed_at_iso: str) -> str:
    """Match the TypeScript classifyTrack() in fetch-spxw-blocks.ts."""
    abs_mny = abs(mny)
    if CEILING_DTE_MIN <= dte <= CEILING_DTE_MAX and CEILING_MNY_MIN <= abs_mny <= CEILING_MNY_MAX:
        return "ceiling"
    # Parse YYYY-MM-DDTHH:MM:SS± as UTC time-of-day in minutes.
    try:
        hh = int(executed_at_iso[11:13])
        mm = int(executed_at_iso[14:16])
    except (ValueError, IndexError):
        return "other"
    utc_min = hh * 60 + mm
    if (
        0 <= dte <= OPENING_DTE_MAX
        and abs_mny <= OPENING_MNY_MAX
        and OPEN_START_UTC_MIN <= utc_min <= OPEN_END_UTC_MIN
    ):
        return "opening_atm"
    return "other"


def load_blocks(csv_glob: str) -> list[dict]:
    """Load filtered SPXW institutional blocks from the EOD CSVs."""
    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    # DuckDB-side filtering: drop everything that isn't a target block
    # before we materialize into Python. Only keeps ~1k rows per day.
    rows = conn.execute(
        f"""
        SELECT
            id::TEXT                               AS trade_id,
            executed_at::TIMESTAMPTZ::TEXT         AS executed_at,
            option_chain_id,
            CAST(strike AS DOUBLE)                 AS strike,
            option_type,
            expiry::DATE                           AS expiry,
            CAST(size AS INTEGER)                  AS size,
            CAST(price AS DOUBLE)                  AS price,
            CAST(premium AS DOUBLE)                AS premium,
            side,
            LOWER(upstream_condition_detail)       AS condition,
            exchange,
            CAST(underlying_price AS DOUBLE)       AS underlying_price,
            CAST(open_interest AS INTEGER)         AS open_interest,
            CAST(delta AS DOUBLE)                  AS delta,
            CAST(gamma AS DOUBLE)                  AS gamma,
            CAST(implied_volatility AS DOUBLE)     AS iv,
            date_diff(
                'day',
                CAST(executed_at AS DATE),
                CAST(expiry AS DATE)
            )::INTEGER                             AS dte,
            ((strike - underlying_price) / underlying_price)::DOUBLE AS mny
        FROM read_csv_auto('{csv_glob}', header=true)
        WHERE underlying_symbol = 'SPXW'
          AND (canceled IS NULL OR canceled = FALSE)
          AND LOWER(upstream_condition_detail) IN {TARGET_CONDITIONS!r}
          AND CAST(size AS INTEGER) >= {MIN_SIZE}
          AND CAST(premium AS DOUBLE) >= {MIN_PREMIUM}
        """
    ).fetchall()
    cols = [d[0] for d in conn.description]
    return [dict(zip(cols, r, strict=True)) for r in rows]


def _side_to_label(side: str | None) -> str | None:
    """Raw CSV side is 'ask' / 'bid' / null — matches DB convention."""
    if side in ("ask", "bid"):
        return side
    return None


def upsert(conn: psycopg2.extensions.connection, blocks: list[dict]) -> int:
    """Batch-insert blocks with ON CONFLICT (trade_id) DO NOTHING."""
    rows = []
    for b in blocks:
        track = classify_track(b["dte"], b["mny"], b["executed_at"])
        rows.append((
            b["trade_id"],
            b["executed_at"],
            b["option_chain_id"],
            b["strike"],
            b["option_type"],
            b["expiry"],
            b["dte"],
            b["size"],
            b["price"],
            b["premium"],
            _side_to_label(b.get("side")),
            b["condition"],
            b.get("exchange"),
            b["underlying_price"],
            b["mny"],
            b.get("open_interest"),
            b.get("delta"),
            b.get("gamma"),
            b.get("iv"),
            track,
        ))

    sql = """
        INSERT INTO institutional_blocks (
            trade_id, executed_at, option_chain_id, strike, option_type,
            expiry, dte, size, price, premium, side, condition, exchange,
            underlying_price, moneyness_pct, open_interest, delta, gamma,
            iv, program_track
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (trade_id) DO NOTHING
    """
    with conn.cursor() as cur:
        execute_batch(cur, sql, rows, page_size=BATCH_SIZE)
    conn.commit()
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.source.is_dir():
        print(f"Source directory not found: {args.source}")
        return 1

    csv_glob = str(args.source / "bot-eod-report-*.csv")
    files = sorted(args.source.glob("bot-eod-report-*.csv"))
    if not files:
        print(f"No bot-eod-report-*.csv in {args.source}")
        return 1
    print(f"Reading {len(files)} CSV files: {files[0].name} .. {files[-1].name}")

    blocks = load_blocks(csv_glob)
    print(f"Captured {len(blocks):,} institutional blocks matching filters")

    if not blocks:
        print("No blocks to insert. Exiting.")
        return 0

    # Show classification breakdown
    track_counts: dict[str, int] = {}
    for b in blocks:
        t = classify_track(b["dte"], b["mny"], b["executed_at"])
        track_counts[t] = track_counts.get(t, 0) + 1
    print(f"Track breakdown: {track_counts}")

    if args.dry_run:
        print("--dry-run: skipping DB writes. Sample row:")
        print({k: v for k, v in blocks[0].items() if k != "executed_at"})
        return 0

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL not set")
        return 1

    conn = psycopg2.connect(database_url, sslmode="require")
    try:
        n = upsert(conn, blocks)
        print(f"Upserted {n:,} rows (duplicates silently skipped)")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
