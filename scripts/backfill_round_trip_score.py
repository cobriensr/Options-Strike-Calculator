"""Backfill round_trip_net_pct + round_trip_score_deduct on existing alerts.

Reads ml/experiments/round-trip-suppression-eda/alert_features.parquet (produced
by Phase 1 EDA) and updates lottery_finder_fires + silent_boom_alerts with the
computed feature + stepped-bracket deduct.

Idempotent: only touches rows where round_trip_score_deduct = 0 AND
round_trip_net_pct IS NULL. Re-running is safe.

Spec: docs/superpowers/specs/round-trip-score-deduct-production-2026-05-16.md

Usage:
    ml/.venv/bin/python scripts/backfill_round_trip_score.py
    ml/.venv/bin/python scripts/backfill_round_trip_score.py --dry-run

Decisions encoded:
  - DTE ≤ 7 only (per 2026-05-16 per-DTE AUC slice — signal collapses above 7DTE)
  - Stepped bracket: < -0.50 → -3, [-0.50, -0.30) → -2, [-0.30, -0.10) → -1
  - Skip rows where post_fire_print_count == 0 (no flow to evaluate)
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import polars as pl
import psycopg2
from psycopg2.extras import execute_batch

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
FEATURES_PATH = ROOT / 'ml' / 'experiments' / 'round-trip-suppression-eda' / 'alert_features.parquet'

DTE_MAX = 7
BRACKETS = [
    (-0.50, -3),   # net_pct < -0.50
    (-0.30, -2),   # -0.50 <= net_pct < -0.30
    (-0.10, -1),   # -0.30 <= net_pct < -0.10
]


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing {ENV_FILE}')
    with ENV_FILE.open() as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def compute_deduct(net_pct: float | None) -> int:
    """Map net_pct → stepped deduct. None / NaN → 0."""
    if net_pct is None or net_pct != net_pct:  # NaN check
        return 0
    for cutoff, deduct in BRACKETS:
        if net_pct < cutoff:
            return deduct
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--dry-run', action='store_true', help='Print stats but do not UPDATE')
    p.add_argument('--batch-size', type=int, default=500)
    args = p.parse_args()

    if not FEATURES_PATH.exists():
        sys.exit(f'Missing features parquet: {FEATURES_PATH}')

    load_env()
    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        sys.exit('DATABASE_URL not set in .env.local')

    print(f'Loading features from {FEATURES_PATH}...', file=sys.stderr)
    df = pl.read_parquet(FEATURES_PATH)
    print(f'  Loaded {len(df):,} rows', file=sys.stderr)

    # Filter to DTE ≤ 7 with non-null net pct + post-fire flow
    eligible = df.filter(
        (pl.col('dte') <= DTE_MAX)
        & pl.col('post_fire_net_pct_of_volume').is_not_null()
        & (pl.col('post_fire_print_count') > 0)
    )
    print(f'  Eligible (DTE ≤ {DTE_MAX}, has flow): {len(eligible):,}', file=sys.stderr)

    # Compute deduct per row
    deducts = [compute_deduct(v) for v in eligible['post_fire_net_pct_of_volume'].to_list()]
    eligible = eligible.with_columns(pl.Series('deduct', deducts))

    # Stats
    by_deduct = (
        eligible.group_by('deduct').agg(pl.len().alias('n')).sort('deduct')
    )
    print('\nDeduct distribution:', file=sys.stderr)
    print(by_deduct, file=sys.stderr)

    # Split by source and prepare update payloads
    for source, table in [('lottery', 'lottery_finder_fires'), ('silent_boom', 'silent_boom_alerts')]:
        sub = eligible.filter(pl.col('source') == source)
        sub_nonzero = sub.filter(pl.col('deduct') != 0)
        print(f'\n{table}: total eligible={len(sub):,}, getting non-zero deduct={len(sub_nonzero):,}', file=sys.stderr)
        if len(sub_nonzero) == 0:
            continue

        payload = [
            (
                float(r['post_fire_net_pct_of_volume']),
                int(r['deduct']),
                int(r['alert_id']),
            )
            for r in sub_nonzero.iter_rows(named=True)
        ]
        # Also write net_pct for zero-deduct rows (informational, not penalty)
        payload_zero = [
            (
                float(r['post_fire_net_pct_of_volume']),
                int(r['alert_id']),
            )
            for r in sub.filter(pl.col('deduct') == 0).iter_rows(named=True)
        ]

        if args.dry_run:
            print(f'  [DRY-RUN] would update {len(payload):,} with deduct, {len(payload_zero):,} with net_pct only', file=sys.stderr)
            continue

        conn = psycopg2.connect(db_url)
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                # Update rows getting a deduct (idempotent guard: only touch where deduct still 0 AND net_pct still NULL)
                execute_batch(
                    cur,
                    f'UPDATE {table} '
                    f'SET round_trip_net_pct = %s, round_trip_score_deduct = %s '
                    f'WHERE id = %s AND round_trip_net_pct IS NULL AND round_trip_score_deduct = 0',
                    payload,
                    page_size=args.batch_size,
                )
                # Update zero-deduct rows with the net_pct value only (no deduct change)
                execute_batch(
                    cur,
                    f'UPDATE {table} '
                    f'SET round_trip_net_pct = %s '
                    f'WHERE id = %s AND round_trip_net_pct IS NULL',
                    payload_zero,
                    page_size=args.batch_size,
                )
            conn.commit()
            print(f'  ✓ Committed {len(payload):,} deduct updates + {len(payload_zero):,} net_pct-only updates', file=sys.stderr)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    print('\n✓ Backfill complete.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
