"""
Bot EOD options flow — per-contract × time-bucket aggregation.

Reads the 0DTE Parquet from `eod_flow_ingest.py`
(`ml/data/eod-flow/date=YYYY-MM-DD/data.parquet`) and produces, for each
bucket size, one Parquet per trading day grouped by
(underlying_symbol, option_chain_id, bucket_start):

  ml/data/eod-flow-buckets/bucket=1min/date=YYYY-MM-DD/data.parquet
  ml/data/eod-flow-buckets/bucket=5min/date=YYYY-MM-DD/data.parquet

Each bucket row collapses the prints inside it into:
  n_prints, total_volume, total_premium,
  buy_volume / sell_volume / mid_volume (split by aggression),
  bucket_spot (median underlying_price within the bucket),
  moneyness_pct = (strike - bucket_spot) / bucket_spot,
  max_print_premium,
  plus a `composite_score` ranking column and a per-symbol-per-day rank.

Both bucket sizes are always built in one run. Only buckets with
n_prints >= min_prints (default 1) are emitted.

Usage:
  ml/.venv/bin/python src/eod_flow_buckets.py [--force] [--min-prints N]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import duckdb

from utils import ML_ROOT, section, subsection, takeaway  # noqa: E402

DATA_IN = ML_ROOT / "data" / "eod-flow"
DATA_OUT = ML_ROOT / "data" / "eod-flow-buckets"

BUCKET_SIZES: tuple[int, ...] = (1, 5)

_AGG_SQL_TEMPLATE = """
WITH src AS (
    SELECT
        underlying_symbol AS symbol,
        option_chain_id,
        strike,
        option_type,
        expiry,
        underlying_price,
        size,
        premium,
        price,
        gamma,
        delta,
        aggression_side,
        executed_at,
        -- Floor the timestamp to the nearest bucket boundary.
        -- DuckDB's time_bucket takes (interval, timestamp) and returns
        -- the start of the bucket.
        time_bucket(INTERVAL {bucket_min} MINUTE, executed_at) AS bucket_start
    FROM read_parquet({in_parquet_literal})
    WHERE executed_at IS NOT NULL
)
SELECT
    symbol,
    option_chain_id,
    -- strike/option_type/expiry are contract-level constants, any() is
    -- cheap and deterministic enough.
    any_value(strike)      AS strike,
    any_value(option_type) AS option_type,
    any_value(expiry)      AS expiry,
    bucket_start,
    bucket_start + INTERVAL {bucket_min} MINUTE AS bucket_end,
    COUNT(*)::INTEGER       AS n_prints,
    SUM(size)::INTEGER      AS total_volume,
    CAST(SUM(premium) AS DOUBLE) AS total_premium,
    CAST(MAX(premium) AS DOUBLE) AS max_print_premium,
    -- Aggression splits — in contract-count (volume) terms.
    SUM(CASE WHEN aggression_side = 'buy_aggressive'
             THEN size ELSE 0 END)::INTEGER AS buy_volume,
    SUM(CASE WHEN aggression_side = 'sell_aggressive'
             THEN size ELSE 0 END)::INTEGER AS sell_volume,
    SUM(CASE WHEN aggression_side = 'mid'
             THEN size ELSE 0 END)::INTEGER AS mid_volume,
    -- Buy-side premium share (weighted by $, not contract count).
    CAST(
        SUM(CASE WHEN aggression_side = 'buy_aggressive'
                 THEN premium ELSE 0 END)
        / NULLIF(SUM(premium), 0)
        AS DOUBLE
    ) AS buy_premium_pct,
    -- Bucket spot: median of underlying_price across prints. Median
    -- beats mean if one late print happens at a stale quote.
    CAST(MEDIAN(underlying_price) AS DOUBLE) AS bucket_spot,
    CAST(MIN(underlying_price) AS DOUBLE)    AS spot_min,
    CAST(MAX(underlying_price) AS DOUBLE)    AS spot_max,
    MIN(executed_at) AS first_print_ts,
    MAX(executed_at) AS last_print_ts,
    -- Gamma exposure in shares per $1 spot move (dealer hedging unit).
    -- Each contract = 100 shares, gamma is per share per $1, so the
    -- total shares dealers would have to hedge on a $1 move is
    -- SUM(gamma × size × 100). Signed by aggression: buy-dominant
    -- bursts leave the dealer SHORT gamma (price-chasing, magnet
    -- dynamics); sell-dominant bursts leave dealer LONG gamma (fading,
    -- anti-magnet).
    CAST(SUM(gamma * size * 100) AS DOUBLE) AS bucket_gamma_shares,
    CAST(
        SUM(CASE WHEN aggression_side = 'buy_aggressive'
                 THEN gamma * size * 100 ELSE 0 END)
        AS DOUBLE
    ) AS buy_gamma_shares,
    CAST(
        SUM(CASE WHEN aggression_side = 'sell_aggressive'
                 THEN gamma * size * 100 ELSE 0 END)
        AS DOUBLE
    ) AS sell_gamma_shares,
    -- Average delta (signed), size-weighted. Helps debug unusual
    -- prints that carry larger-than-expected directional bias.
    CAST(
        SUM(delta * size) / NULLIF(SUM(size), 0)
        AS DOUBLE
    ) AS avg_delta_size_weighted
FROM src
GROUP BY symbol, option_chain_id, bucket_start
HAVING COUNT(*) >= {min_prints}
"""


def _sql_string(value: str) -> str:
    """Escape a string for safe embedding in a DuckDB SQL literal."""
    return "'" + value.replace("'", "''") + "'"


def _build_bucket_parquet(
    conn: duckdb.DuckDBPyConnection,
    in_parquet: Path,
    out_parquet: Path,
    bucket_min: int,
    min_prints: int,
) -> tuple[int, int]:
    """Build one (date, bucket_size) Parquet. Returns (rows, bytes)."""
    out_parquet.parent.mkdir(parents=True, exist_ok=True)

    agg_sql = _AGG_SQL_TEMPLATE.format(
        bucket_min=bucket_min,
        in_parquet_literal=_sql_string(str(in_parquet)),
        min_prints=min_prints,
    )
    # Add derived columns in a second pass — cleaner than cramming into
    # the aggregation. Composite scoring lives in the bursts script
    # (see `eod_flow_bursts.py`) so the formula can be iterated without
    # rebuilding buckets.
    select_sql = f"""
    WITH bucket_agg AS ({agg_sql})
    SELECT
        *,
        CAST(total_volume AS DOUBLE) / NULLIF(n_prints, 0) AS avg_size_per_print,
        CAST(buy_volume AS DOUBLE) / NULLIF(total_volume, 0) AS buy_vol_pct,
        CAST(sell_volume AS DOUBLE) / NULLIF(total_volume, 0) AS sell_vol_pct,
        CAST(
            (strike - bucket_spot) / NULLIF(bucket_spot, 0)
            AS DOUBLE
        ) AS moneyness_pct,
        -- is_otm: true when the contract is OTM at the bucket's spot.
        -- Puts are OTM when strike < spot; calls are OTM when strike > spot.
        -- ITM contracts behave like stock proxies and rarely carry
        -- directional signal, so downstream scoring deprioritizes them.
        CASE
            WHEN option_type = 'put'  AND strike < bucket_spot THEN TRUE
            WHEN option_type = 'call' AND strike > bucket_spot THEN TRUE
            ELSE FALSE
        END AS is_otm,
        -- Net dealer gamma exposure: buy-dominant flow leaves dealer
        -- SHORT gamma (positive value = magnet expected). Sell-dominant
        -- flow leaves dealer LONG gamma (negative = anti-magnet).
        CAST(
            buy_gamma_shares - sell_gamma_shares AS DOUBLE
        ) AS dealer_short_gamma_shares,
        -- Gamma notional per 1% spot move, in dollars. bucket_spot² × 0.01
        -- converts "shares per $1 move" → "$ per 1% move".
        CAST(
            bucket_gamma_shares * bucket_spot * bucket_spot * 0.01
            AS DOUBLE
        ) AS gamma_notional_per_pct
    FROM bucket_agg
    """

    copy_sql = (
        f"COPY ({select_sql}) TO {_sql_string(str(out_parquet))} "
        "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000)"
    )
    conn.execute(copy_sql)

    n = conn.execute(
        f"SELECT COUNT(*) FROM read_parquet({_sql_string(str(out_parquet))})"
    ).fetchone()[0]
    size = out_parquet.stat().st_size
    return int(n), int(size)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Aggregate 0DTE prints into per-(contract, bucket) rows."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rewrite existing bucket Parquet files",
    )
    parser.add_argument(
        "--min-prints",
        type=int,
        default=1,
        help="Only emit bucket rows with at least this many prints (default 1)",
    )
    args = parser.parse_args()

    day_dirs = sorted(DATA_IN.glob("date=*"))
    if not day_dirs:
        print(f"No input Parquet under {DATA_IN}. Run eod_flow_ingest.py first.")
        return 1

    section(
        f"EOD Flow Bucket Aggregation — {len(day_dirs)} day(s), "
        f"sizes={','.join(f'{b}min' for b in BUCKET_SIZES)}, "
        f"min_prints={args.min_prints}"
    )

    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    conn.execute("PRAGMA memory_limit='6GB'")

    total_rows = 0
    total_bytes = 0
    skipped = 0
    wrote = 0
    t0 = time.monotonic()

    for day_dir in day_dirs:
        date_str = day_dir.name.removeprefix("date=")
        in_parquet = day_dir / "data.parquet"
        if not in_parquet.exists():
            print(f"  {date_str}: no data.parquet, skipping")
            continue

        subsection(date_str)
        for bucket_min in BUCKET_SIZES:
            out_parquet = (
                DATA_OUT
                / f"bucket={bucket_min}min"
                / f"date={date_str}"
                / "data.parquet"
            )
            if out_parquet.exists() and not args.force:
                print(f"    {bucket_min}min: exists, skipping (--force to overwrite)")
                skipped += 1
                continue

            t_file = time.monotonic()
            n, size = _build_bucket_parquet(
                conn, in_parquet, out_parquet, bucket_min, args.min_prints
            )
            elapsed = time.monotonic() - t_file
            total_rows += n
            total_bytes += size
            wrote += 1
            print(
                f"    {bucket_min}min: rows={n:>8,}  parquet={size / 1e6:>5.1f} MB  "
                f"took={elapsed:>4.1f}s  → "
                f"{out_parquet.relative_to(ML_ROOT)}"
            )

    conn.close()
    elapsed_total = time.monotonic() - t0

    takeaway(
        f"Wrote {wrote} bucket file(s), skipped {skipped}. "
        f"Total: {total_rows:,} rows, {total_bytes / 1e6:.1f} MB, "
        f"{elapsed_total:.1f}s."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
