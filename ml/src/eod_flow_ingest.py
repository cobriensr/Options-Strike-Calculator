"""
Bot EOD options flow CSV → partitioned Parquet ingest.

Reads daily `bot-eod-report-YYYY-MM-DD.csv` files from a source
directory, filters to the configured underlying symbols (default:
SPY/QQQ/SPXW/NDXP), drops cancelled rows, derives a few convenience
columns, casts to narrow dtypes, and writes:

  ml/data/eod-flow/date=YYYY-MM-DD/data.parquet

DuckDB does the whole pass in one SQL statement per file (filter +
cast + derive + write). That's ~10× faster than a pandas chunked read
and stays entirely out-of-core, so full-file memory usage is modest
even on 3 GB inputs.

Usage:
  ml/.venv/bin/python src/eod_flow_ingest.py \
      [--source /path/to/EOD-OptionFlow] \
      [--symbols SPY,QQQ,SPXW,NDXP] \
      [--force]
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import duckdb

from utils import ML_ROOT, section, subsection, takeaway  # noqa: E402

DEFAULT_SOURCE = Path("/Users/charlesobrien/Downloads/EOD-OptionFlow")
DEFAULT_SYMBOLS: tuple[str, ...] = ("SPY", "QQQ", "SPXW", "NDXP")
DATA_ROOT = ML_ROOT / "data" / "eod-flow"
FILENAME_DATE_RE = re.compile(r"bot-eod-report-(\d{4}-\d{2}-\d{2})\.csv$")

# Single-pass SELECT that does filter + dtype cast + derived columns.
# Narrow dtypes (float32, int32) are safe: sizes never exceed int32,
# Greeks/prices are emitted by the bot with ≤4 decimals of precision.
_SELECT_TEMPLATE = """
SELECT
    CAST(executed_at AS TIMESTAMP)         AS executed_at,
    underlying_symbol                      AS underlying_symbol,
    option_chain_id                        AS option_chain_id,
    side                                   AS side,
    CAST(strike            AS FLOAT)       AS strike,
    option_type                            AS option_type,
    CAST(expiry            AS DATE)        AS expiry,
    CAST(underlying_price  AS FLOAT)       AS underlying_price,
    CAST(nbbo_bid          AS FLOAT)       AS nbbo_bid,
    CAST(nbbo_ask          AS FLOAT)       AS nbbo_ask,
    CAST(ewma_nbbo_bid     AS FLOAT)       AS ewma_nbbo_bid,
    CAST(ewma_nbbo_ask     AS FLOAT)       AS ewma_nbbo_ask,
    CAST(price             AS FLOAT)       AS price,
    CAST(size              AS INTEGER)     AS size,
    CAST(premium           AS FLOAT)       AS premium,
    CAST(volume            AS INTEGER)     AS volume,
    CAST(open_interest     AS INTEGER)     AS open_interest,
    CAST(implied_volatility AS FLOAT)      AS implied_volatility,
    CAST(delta             AS FLOAT)       AS delta,
    CAST(theta             AS FLOAT)       AS theta,
    CAST(gamma             AS FLOAT)       AS gamma,
    CAST(vega              AS FLOAT)       AS vega,
    CAST(rho               AS FLOAT)       AS rho,
    CAST(theo              AS FLOAT)       AS theo,
    sector                                 AS sector,
    exchange                               AS exchange,
    report_flags                           AS report_flags,
    CAST(canceled AS BOOLEAN)              AS canceled,
    upstream_condition_detail              AS upstream_condition_detail,
    equity_type                            AS equity_type,
    -- Derived: DTE in calendar days, computed per row.
    CAST(
        date_diff('day',
            CAST(executed_at AS DATE),
            CAST(expiry AS DATE))
        AS INTEGER
    )                                      AS dte,
    -- Moneyness: strike / spot. <1 = put-side ITM / call-side OTM etc.
    CAST(
        CASE WHEN underlying_price > 0
             THEN strike / underlying_price
             ELSE NULL
        END AS FLOAT
    )                                      AS moneyness,
    -- Aggression: buy_aggressive = crossed the ask, sell_aggressive
    -- = hit the bid, mid = filled between.
    CASE
        WHEN side = 'ask' THEN 'buy_aggressive'
        WHEN side = 'bid' THEN 'sell_aggressive'
        ELSE 'mid'
    END                                    AS aggression_side,
    -- Volume / OI ratio: new-position indicator. >1 = trade size
    -- exceeds current OI (opening flow). NULL when OI is 0.
    CAST(
        CASE WHEN open_interest > 0
             THEN CAST(volume AS DOUBLE) / open_interest
             ELSE NULL
        END AS FLOAT
    )                                      AS vol_oi_ratio
FROM read_csv_auto({csv_path_literal}, header=true)
WHERE underlying_symbol IN ({symbols_list})
  AND (canceled IS NULL OR canceled = FALSE)
  {dte_filter}
"""


def _sql_string(value: str) -> str:
    """Escape a string for safe embedding in a DuckDB SQL literal."""
    return "'" + value.replace("'", "''") + "'"


def _convert_one(
    conn: duckdb.DuckDBPyConnection,
    csv_path: Path,
    out_dir: Path,
    symbols: tuple[str, ...],
    max_dte: int,
) -> tuple[int, int]:
    """Filter+cast+write one CSV → Parquet. Returns (rows, bytes).

    max_dte < 0 disables the DTE filter; otherwise only rows with
    dte BETWEEN 0 AND max_dte are retained. DTE is calendar days
    between executed_at and expiry.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "data.parquet"

    if max_dte < 0:
        dte_filter = ""
    else:
        dte_filter = (
            "AND date_diff('day', CAST(executed_at AS DATE), "
            f"CAST(expiry AS DATE)) BETWEEN 0 AND {max_dte}"
        )

    select_sql = _SELECT_TEMPLATE.format(
        csv_path_literal=_sql_string(str(csv_path)),
        symbols_list=", ".join(_sql_string(s) for s in symbols),
        dte_filter=dte_filter,
    )
    copy_sql = (
        f"COPY ({select_sql}) TO {_sql_string(str(out_path))} "
        "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)"
    )
    conn.execute(copy_sql)

    n = conn.execute(
        f"SELECT COUNT(*) FROM read_parquet({_sql_string(str(out_path))})"
    ).fetchone()[0]
    size = out_path.stat().st_size
    return int(n), int(size)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Filter bot EOD options flow CSVs into partitioned Parquet."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help="Directory containing bot-eod-report-*.csv files",
    )
    parser.add_argument(
        "--symbols",
        type=str,
        default=",".join(DEFAULT_SYMBOLS),
        help="Comma-separated underlying symbols to retain",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-ingest days that already have a Parquet file",
    )
    parser.add_argument(
        "--max-dte",
        type=int,
        default=0,
        help=(
            "Keep only rows with 0 <= dte <= max-dte (default 0 = 0DTE only). "
            "Pass a negative value to disable the DTE filter."
        ),
    )
    args = parser.parse_args()

    symbols = tuple(s.strip().upper() for s in args.symbols.split(",") if s.strip())
    if not symbols:
        print("Error: --symbols produced an empty list")
        return 1

    source: Path = args.source
    if not source.is_dir():
        print(f"Error: source directory does not exist: {source}")
        return 1

    csv_files = sorted(source.glob("bot-eod-report-*.csv"))
    if not csv_files:
        print(f"No bot-eod-report-*.csv files in {source}")
        return 1

    dte_desc = "all DTE" if args.max_dte < 0 else f"dte BETWEEN 0 AND {args.max_dte}"
    section(
        f"EOD Flow Ingest — {len(csv_files)} CSV(s) → "
        f"{DATA_ROOT.relative_to(ML_ROOT)} "
        f"(symbols={','.join(symbols)}, {dte_desc})"
    )
    DATA_ROOT.mkdir(parents=True, exist_ok=True)

    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    # Cap memory so a runaway plan doesn't swap the laptop.
    conn.execute("PRAGMA memory_limit='6GB'")

    total_rows = 0
    total_bytes = 0
    skipped = 0
    wrote = 0
    t0 = time.monotonic()

    for csv_path in csv_files:
        m = FILENAME_DATE_RE.search(csv_path.name)
        if not m:
            print(f"  Skip (no date in filename): {csv_path.name}")
            continue
        date_str = m.group(1)
        out_dir = DATA_ROOT / f"date={date_str}"
        out_path = out_dir / "data.parquet"

        if out_path.exists() and not args.force:
            print(f"  {date_str}: exists, skipping (--force to overwrite)")
            skipped += 1
            continue

        subsection(date_str)
        t_file = time.monotonic()
        n, size = _convert_one(conn, csv_path, out_dir, symbols, args.max_dte)
        elapsed = time.monotonic() - t_file
        total_rows += n
        total_bytes += size
        wrote += 1
        print(
            f"  rows={n:>12,}  parquet={size / 1e6:>7.1f} MB  "
            f"took={elapsed:>5.1f}s  → {out_path.relative_to(ML_ROOT)}"
        )

    conn.close()
    elapsed_total = time.monotonic() - t0

    takeaway(
        f"Wrote {wrote} day(s), skipped {skipped}. "
        f"Total: {total_rows:,} rows, {total_bytes / 1e9:.2f} GB, "
        f"{elapsed_total:.1f}s."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
