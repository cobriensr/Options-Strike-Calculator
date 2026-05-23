"""
One-shot backfill: compute cluster_bonus for historical lottery_finder_fires.

V2.2 Phase C.4 (docs/tmp/v22-co-fire-analysis-2026-05-22.md).
Migration #178 added cluster_bonus SMALLINT DEFAULT 0 to lottery_finder_fires.
This script fills in the non-zero values for rows that pre-date the deploy.

Algorithm:
  For each tier1 fire (score >= 9), count how many other distinct tickers
  also scored tier1 within ±5 minutes of that fire's trigger_time_ct.
  Map the count to the tiered bonus:
    isolated (cluster_size=1) -> 0
    pair     (cluster_size=2) -> 1
    small    (cluster_size 3-4) -> 2
    large    (cluster_size 5+) -> 1

Done in a single SQL window query — no Python row-by-row loop:

  WITH tier1 AS (
    SELECT id, underlying_symbol, score, trigger_time_ct,
           cluster_bonus
    FROM lottery_finder_fires
    WHERE score >= 9
  ),
  cluster_peers AS (
    SELECT
      f.id,
      COUNT(DISTINCT p.underlying_symbol) FILTER (
        WHERE p.underlying_symbol <> f.underlying_symbol
          AND ABS(EXTRACT(EPOCH FROM (p.trigger_time_ct - f.trigger_time_ct))) <= 300
      ) AS other_tier1_count
    FROM tier1 f
    LEFT JOIN tier1 p ON TRUE
    GROUP BY f.id
  ),
  bonus AS (
    SELECT
      cp.id,
      CASE
        WHEN cp.other_tier1_count + 1 >= 5 THEN 1  -- large cluster
        WHEN cp.other_tier1_count + 1 >= 3 THEN 2  -- small cluster (3-4, peak lift)
        WHEN cp.other_tier1_count + 1 = 2 THEN 1   -- pair
        ELSE 0                                      -- isolated
      END AS cluster_bonus
    FROM cluster_peers cp
  )
  UPDATE lottery_finder_fires lff
  SET cluster_bonus = bonus.cluster_bonus
  FROM bonus
  WHERE lff.id = bonus.id
    AND bonus.cluster_bonus <> 0;

Usage:
    ml/.venv/bin/python scripts/backfill-lottery-cluster-bonus.py
    ml/.venv/bin/python scripts/backfill-lottery-cluster-bonus.py --dry-run

Args:
    --dry-run   Print the UPDATE plan (count + sample) without executing.
    --batch-days N  Process N calendar days at a time (default: all at once).
                    Use when the DB self-join is too expensive for the full history.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta

import psycopg2
import psycopg2.extras


TIER1_MIN_SCORE = 9
CLUSTER_WINDOW_SEC = 300  # 5 minutes

BONUS_TIERS = [
    # (min_cluster_size_inclusive, bonus)
    (5, 1),  # large: 5+ tickers
    (3, 2),  # small: 3-4 tickers (peak empirical lift)
    (2, 1),  # pair: exactly 2 tickers
    (1, 0),  # isolated
]


def get_bonus(cluster_size: int) -> int:
    for min_size, bonus in BONUS_TIERS:
        if cluster_size >= min_size:
            return bonus
    return 0


BACKFILL_SQL = """
WITH tier1 AS (
    SELECT id, underlying_symbol, score, trigger_time_ct
    FROM lottery_finder_fires
    WHERE score >= %(tier1_min)s
      AND date >= %(start_date)s
      AND date <= %(end_date)s
),
cluster_peers AS (
    SELECT
        f.id,
        COUNT(DISTINCT p.underlying_symbol) FILTER (
            WHERE p.underlying_symbol <> f.underlying_symbol
              AND ABS(EXTRACT(EPOCH FROM (p.trigger_time_ct - f.trigger_time_ct))) <= %(window_sec)s
        ) AS other_tier1_count
    FROM tier1 f
    LEFT JOIN tier1 p ON TRUE
    GROUP BY f.id
),
bonus_map AS (
    SELECT
        cp.id,
        CASE
            WHEN cp.other_tier1_count + 1 >= 5 THEN 1
            WHEN cp.other_tier1_count + 1 >= 3 THEN 2
            WHEN cp.other_tier1_count + 1 = 2 THEN 1
            ELSE 0
        END AS cluster_bonus
    FROM cluster_peers cp
)
UPDATE lottery_finder_fires lff
SET cluster_bonus = bonus_map.cluster_bonus
FROM bonus_map
WHERE lff.id = bonus_map.id
  AND bonus_map.cluster_bonus <> 0
RETURNING lff.id, lff.underlying_symbol, lff.trigger_time_ct::text,
          lff.score, lff.cluster_bonus;
"""

PREVIEW_SQL = """
WITH tier1 AS (
    SELECT id, underlying_symbol, score, trigger_time_ct
    FROM lottery_finder_fires
    WHERE score >= %(tier1_min)s
      AND date >= %(start_date)s
      AND date <= %(end_date)s
),
cluster_peers AS (
    SELECT
        f.id,
        COUNT(DISTINCT p.underlying_symbol) FILTER (
            WHERE p.underlying_symbol <> f.underlying_symbol
              AND ABS(EXTRACT(EPOCH FROM (p.trigger_time_ct - f.trigger_time_ct))) <= %(window_sec)s
        ) AS other_tier1_count
    FROM tier1 f
    LEFT JOIN tier1 p ON TRUE
    GROUP BY f.id
),
bonus_map AS (
    SELECT
        cp.id,
        cp.other_tier1_count,
        cp.other_tier1_count + 1 AS cluster_size,
        CASE
            WHEN cp.other_tier1_count + 1 >= 5 THEN 1
            WHEN cp.other_tier1_count + 1 >= 3 THEN 2
            WHEN cp.other_tier1_count + 1 = 2 THEN 1
            ELSE 0
        END AS cluster_bonus
    FROM cluster_peers cp
)
SELECT cluster_size, cluster_bonus, COUNT(*) AS n_fires
FROM bonus_map
WHERE cluster_bonus <> 0
GROUP BY cluster_size, cluster_bonus
ORDER BY cluster_size;
"""

SAMPLE_SQL = """
WITH tier1 AS (
    SELECT id, underlying_symbol, score, trigger_time_ct, date
    FROM lottery_finder_fires
    WHERE score >= %(tier1_min)s
      AND date >= %(start_date)s
      AND date <= %(end_date)s
),
cluster_peers AS (
    SELECT
        f.id,
        f.underlying_symbol,
        f.trigger_time_ct,
        f.date,
        f.score,
        COUNT(DISTINCT p.underlying_symbol) FILTER (
            WHERE p.underlying_symbol <> f.underlying_symbol
              AND ABS(EXTRACT(EPOCH FROM (p.trigger_time_ct - f.trigger_time_ct))) <= %(window_sec)s
        ) AS other_tier1_count,
        STRING_AGG(DISTINCT p.underlying_symbol, ', ') FILTER (
            WHERE p.underlying_symbol <> f.underlying_symbol
              AND ABS(EXTRACT(EPOCH FROM (p.trigger_time_ct - f.trigger_time_ct))) <= %(window_sec)s
        ) AS peer_tickers
    FROM tier1 f
    LEFT JOIN tier1 p ON TRUE
    GROUP BY f.id, f.underlying_symbol, f.trigger_time_ct, f.date, f.score
)
SELECT
    date::text,
    underlying_symbol,
    trigger_time_ct::text,
    score,
    other_tier1_count + 1 AS cluster_size,
    CASE
        WHEN other_tier1_count + 1 >= 5 THEN 1
        WHEN other_tier1_count + 1 >= 3 THEN 2
        WHEN other_tier1_count + 1 = 2 THEN 1
        ELSE 0
    END AS cluster_bonus,
    peer_tickers
FROM cluster_peers
WHERE other_tier1_count >= 1
ORDER BY date DESC, trigger_time_ct, underlying_symbol
LIMIT 20;
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill cluster_bonus on lottery_finder_fires (V2.2 Phase C.4)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the bonus distribution and sample cluster moments without updating.",
    )
    parser.add_argument(
        "--start-date",
        default="2024-01-01",
        help="Inclusive start date (YYYY-MM-DD). Default: 2024-01-01.",
    )
    parser.add_argument(
        "--end-date",
        default=str(date.today()),
        help="Inclusive end date (YYYY-MM-DD). Default: today.",
    )
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL environment variable not set.", file=sys.stderr)
        sys.exit(1)

    params = {
        "tier1_min": TIER1_MIN_SCORE,
        "window_sec": CLUSTER_WINDOW_SEC,
        "start_date": args.start_date,
        "end_date": args.end_date,
    }

    print(
        f"Backfilling cluster_bonus for fires from {args.start_date} to {args.end_date}"
    )
    print(f"  tier1_min={TIER1_MIN_SCORE}, window={CLUSTER_WINDOW_SEC}s (5 min)")
    print()

    conn = psycopg2.connect(database_url)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Preview distribution
        print("Cluster bonus distribution (fires that will receive non-zero bonus):")
        cur.execute(PREVIEW_SQL, params)
        rows = cur.fetchall()
        if rows:
            for row in rows:
                print(
                    f"  cluster_size={row['cluster_size']:2d}  "
                    f"bonus=+{row['cluster_bonus']}  "
                    f"n_fires={row['n_fires']:,}"
                )
        else:
            print("  (none found in date range)")
        print()

        # Show sample cluster moments
        print("Sample cluster moments (up to 20 rows):")
        cur.execute(SAMPLE_SQL, params)
        samples = cur.fetchall()
        if samples:
            for row in samples:
                print(
                    f"  {row['date']}  {row['trigger_time_ct'][11:19]}  "
                    f"{row['underlying_symbol']:6s}  score={row['score']:3.0f}  "
                    f"cluster={row['cluster_size']}  bonus=+{row['cluster_bonus']}  "
                    f"peers=[{row['peer_tickers'] or ''}]"
                )
        else:
            print("  (no cluster moments found)")
        print()

        if args.dry_run:
            print("DRY RUN — no updates executed. Re-run without --dry-run to apply.")
            return

        # Execute the UPDATE
        print("Executing UPDATE...")
        cur.execute(BACKFILL_SQL, params)
        updated = cur.fetchall()
        conn.commit()
        print(f"Updated {len(updated):,} rows with non-zero cluster_bonus.")
        if updated:
            # Show a few examples
            print("Examples:")
            for row in updated[:10]:
                print(
                    f"  id={row['id']}  {row['underlying_symbol']}  "
                    f"score={row['score']}  cluster_bonus=+{row['cluster_bonus']}  "
                    f"at {str(row['trigger_time_ct'])[:19]}"
                )

    finally:
        conn.close()


if __name__ == "__main__":
    main()
