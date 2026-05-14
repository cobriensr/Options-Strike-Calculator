"""Periscope EDA 05 — Gamma-level edge experiment.

Tests three pre-registered claims against periscope_analyses.key_levels
joined to spx_candles_1m:

  1. Walls hold (touch-then-reverse vs sham at same distance)
  2. Magnet predicts SPX close better than naive spot
  3. Charm-zero crosses more (or less) frequently than sham

Outputs:
    ml/plots/periscope-eda/gamma_wall_reversal.png
    ml/plots/periscope-eda/gamma_wall_distance_dist.png
    ml/plots/periscope-eda/magnet_predictor_quality.png
    ml/plots/periscope-eda/charm_zero_cross_rates.png
    ml/exports/gamma_wall_events.csv
    ml/findings.json   (appends three blocks)

CLI::

    ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py

Spec: docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# sys.path mutation must precede the `periscope_gamma_wall_lib` import below;
# ml/conftest.py handles this for pytest, but scripts run directly need to add
# ml/src/ themselves.
_HERE = Path(__file__).resolve().parent
_ML_SRC = _HERE.parent
sys.path.insert(0, str(_ML_SRC))

import pandas as pd  # noqa: E402
import psycopg2  # noqa: E402

from periscope_gamma_wall_lib import (  # noqa: E402, F401
    compute_charm_zero_event,
    compute_magnet_event,
    compute_wall_event,
    distance_bucket,
    mirror_strike,
)

PLOT_DIR = Path("ml/plots/periscope-eda")
CSV_PATH = Path("ml/exports/gamma_wall_events.csv")
FINDINGS_PATH = Path("ml/findings.json")


def fetch_reads(database_url: str) -> pd.DataFrame:
    """Fetch periscope_analyses rows with key_levels, before 15:00 CT same day."""
    sql = """
        SELECT
          id                          AS read_id,
          trading_date,
          read_time                   AS read_time_utc,
          spot_at_read_time::float    AS spot_at_read,
          mode,
          calibration_quality,
          (key_levels->>'gamma_ceiling')::float AS wall_ceiling,
          (key_levels->>'gamma_floor')::float   AS wall_floor,
          (key_levels->>'magnet')::float        AS magnet,
          (key_levels->>'charm_zero')::float    AS charm_zero
        FROM periscope_analyses
        WHERE mode IN ('pre_trade', 'intraday')
          AND read_time < ((trading_date + INTERVAL '15 hours')
                           AT TIME ZONE 'America/Chicago')
          AND key_levels IS NOT NULL
        ORDER BY trading_date, read_time
    """
    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn)


def fetch_bars_for_read(conn, trading_date, read_time_utc) -> pd.DataFrame:
    """Fetch regular-hours SPX 1-min bars from read_time to 15:00 CT same day.

    NOTE: queries index_candles_1m directly (the compat view spx_candles_1m
    does not exist in this DB). symbol='SPX' filter is required.
    """
    sql = """
        SELECT timestamp, close::float AS close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND date = %s
          AND timestamp >= %s
          AND timestamp <= ((%s::date + INTERVAL '15 hours')
                            AT TIME ZONE 'America/Chicago')
          AND market_time = 'r'
        ORDER BY timestamp
    """
    return pd.read_sql_query(
        sql, conn, params=(trading_date, read_time_utc, trading_date)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="Postgres URL (default: $DATABASE_URL)",
    )
    args = parser.parse_args()
    if not args.database_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 1

    print("Fetching periscope reads with key_levels…")
    reads = fetch_reads(args.database_url)
    print(f"  N reads = {len(reads)}")
    print(
        f"  with both walls = "
        f"{reads.dropna(subset=['wall_ceiling', 'wall_floor']).shape[0]}"
    )
    print(f"  with magnet     = {reads['magnet'].notna().sum()}")
    print(f"  with charm_zero = {reads['charm_zero'].notna().sum()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
