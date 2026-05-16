"""Round-trip suppression EDA notebook.

Phase 1 driver — see docs/superpowers/specs/lottery-silent-boom-round-trip-suppression-2026-05-15.md

Pulls historical Lottery + Silent Boom alerts from Postgres, computes A/B/C cohort
masks, joins each alert against its day's fulltape parquet, computes per-alert
suppression features, and writes an alert_features.parquet for downstream
distribution analysis + threshold sweeps.

Usage:
    # Smoke test (50 alerts from one date)
    ml/.venv/bin/python ml/experiments/round-trip-suppression-eda/notebook.py \
        --date-from 2026-05-13 --date-to 2026-05-13 --limit 50

    # Full run (all enriched alerts across all available fulltape days)
    ml/.venv/bin/python ml/experiments/round-trip-suppression-eda/notebook.py

Output:
    ml/experiments/round-trip-suppression-eda/alert_features.parquet

Cohort definitions:
    A — production-current rules (direction_gated == FALSE AND multi-leg filter)
    B — all enriched alerts (no rule filtering)
    C — synthetic: apply current rules retroactively (uses macro cols on the row)

Production gate predicates verified from source 2026-05-15:
    Lottery: put gated iff mkt_tide_otm_diff > 150_000_000
             call gated iff mkt_tide_otm_diff < -150_000_000
    SilentBoom: put gated iff mkt_tide_diff > 100_000_000
                call gated iff mkt_tide_diff < -100_000_000
                multi-leg rejected iff multi_leg_share >= 0.50
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import polars as pl
import psycopg2
from psycopg2.extras import RealDictCursor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_helper import database_url, fulltape_exists, fulltape_path  # noqa: E402
from features import features_for_alert  # noqa: E402

EXPERIMENT_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT = EXPERIMENT_DIR / 'alert_features.parquet'

# Production direction-gate thresholds (verified from source 2026-05-15)
LOTTERY_GATE_T = 150_000_000
SILENT_BOOM_GATE_T = 100_000_000
SILENT_BOOM_MULTI_LEG_MAX = 0.50

# Fulltape coverage starts here — alerts before this date have no per-print backing
FULLTAPE_MIN_DATE = '2026-01-02'


# ─────────────────────────────────────────────────────────────────
# Alert loading
# ─────────────────────────────────────────────────────────────────

def load_alerts(date_from: str | None = None, date_to: str | None = None) -> pl.DataFrame:
    """Pull Lottery + Silent Boom enriched alerts as one unified frame.

    Returns a frame with columns:
      source ('lottery'|'silent_boom'), alert_id, date, fire_time_utc,
      option_chain_id, underlying_symbol, option_type ('C'|'P'),
      strike, expiry, dte, alert_size,
      direction_gated, multi_leg_share (null for lottery),
      mkt_tide_diff, mkt_tide_otm_diff,
      score, score_tier (null for lottery),
      realized_trail30_10_pct, realized_eod_pct, peak_ceiling_pct, minutes_to_peak,
      enriched_at
    """
    conn = psycopg2.connect(database_url())
    try:
        date_filter = ''
        if date_from:
            date_filter += f" AND date >= '{date_from}'"
        if date_to:
            date_filter += f" AND date <= '{date_to}'"

        # All NUMERIC cols cast to float8 so Polars sees consistent dtypes
        # (mixed Decimal/None across rows breaks pl.from_dicts inference).
        lottery_sql = f"""
            SELECT
                'lottery'::text                  AS source,
                id::text                         AS alert_id,
                date,
                trigger_time_ct                  AS fire_time_utc,
                option_chain_id,
                underlying_symbol,
                option_type,
                strike::float8                   AS strike,
                expiry,
                dte::int4                        AS dte,
                trigger_window_size::float8      AS alert_size,
                COALESCE(direction_gated, FALSE) AS direction_gated,
                NULL::float8                     AS multi_leg_share,
                mkt_tide_diff::float8            AS mkt_tide_diff,
                mkt_tide_otm_diff::float8        AS mkt_tide_otm_diff,
                score::int4                      AS score,
                NULL::text                       AS score_tier,
                realized_trail30_10_pct::float8  AS realized_trail30_10_pct,
                realized_eod_pct::float8         AS realized_eod_pct,
                peak_ceiling_pct::float8         AS peak_ceiling_pct,
                minutes_to_peak::float8          AS minutes_to_peak,
                enriched_at
            FROM lottery_finder_fires
            WHERE enriched_at IS NOT NULL
            {date_filter}
        """

        silent_sql = f"""
            SELECT
                'silent_boom'::text              AS source,
                id::text                         AS alert_id,
                date,
                bucket_ct                        AS fire_time_utc,
                option_chain_id,
                underlying_symbol,
                option_type,
                strike::float8                   AS strike,
                expiry,
                dte::int4                        AS dte,
                spike_volume::float8             AS alert_size,
                COALESCE(direction_gated, FALSE) AS direction_gated,
                multi_leg_share::float8          AS multi_leg_share,
                mkt_tide_diff::float8            AS mkt_tide_diff,
                mkt_tide_otm_diff::float8        AS mkt_tide_otm_diff,
                score::int4                      AS score,
                score_tier,
                realized_trail30_10_pct::float8  AS realized_trail30_10_pct,
                realized_eod_pct::float8         AS realized_eod_pct,
                peak_ceiling_pct::float8         AS peak_ceiling_pct,
                minutes_to_peak::float8          AS minutes_to_peak,
                enriched_at
            FROM silent_boom_alerts
            WHERE enriched_at IS NOT NULL
            {date_filter}
        """

        # Drop the score column on lottery if it doesn't exist — defensive
        # (lottery has `score` per migration #131 but it's worth a safety net)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'lottery_finder_fires' AND column_name = 'score'"
            )
            lottery_has_score = cur.fetchone() is not None
        if not lottery_has_score:
            lottery_sql = lottery_sql.replace('score::int4', 'NULL::int4')

        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(lottery_sql)
            lottery_rows = list(cur.fetchall())
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(silent_sql)
            silent_rows = list(cur.fetchall())
    finally:
        conn.close()

    all_rows = lottery_rows + silent_rows
    if not all_rows:
        return pl.DataFrame()

    # Scan all rows for inference — lottery rows have NULL multi_leg_share /
    # mkt_tide_otm_diff etc.; silent_boom rows have float values. Default 100-row
    # window may infer Null/Int and choke on later float rows.
    df = pl.from_dicts([dict(r) for r in all_rows], infer_schema_length=None)
    # Normalize: date as Date, fire_time_utc as UTC datetime, numerics cast
    df = df.with_columns([
        pl.col('date').cast(pl.Date),
        pl.col('fire_time_utc').cast(pl.Datetime('us', 'UTC')),
        pl.col('expiry').cast(pl.Date),
    ])
    return df


# ─────────────────────────────────────────────────────────────────
# Cohort masks
# ─────────────────────────────────────────────────────────────────

def add_cohort_masks(df: pl.DataFrame) -> pl.DataFrame:
    """Add boolean cohort columns: cohort_a, cohort_b, cohort_c.

    A = production-current — direction_gated==FALSE AND (silent_boom multi_leg < 0.5)
    B = everything (audit baseline)
    C = synthetic — apply current gate predicates retroactively from macro cols
        AND silent_boom multi-leg where data exists
    """
    # Cohort A — what the production rules let through TODAY
    cohort_a = (~pl.col('direction_gated')) & (
        (pl.col('source') == 'lottery')
        | (pl.col('multi_leg_share').is_null())
        | (pl.col('multi_leg_share') < SILENT_BOOM_MULTI_LEG_MAX)
    )

    # Cohort C — synthetic counterfactual: reconstruct gate from macro cols
    #   Lottery: gate via mkt_tide_otm_diff at ±150M (strict)
    #   SilentBoom: gate via mkt_tide_diff at ±100M (strict), plus multi-leg
    lottery_gated_synthetic = (pl.col('source') == 'lottery') & (
        ((pl.col('option_type') == 'P') & (pl.col('mkt_tide_otm_diff') > LOTTERY_GATE_T))
        | ((pl.col('option_type') == 'C') & (pl.col('mkt_tide_otm_diff') < -LOTTERY_GATE_T))
    )
    silent_gated_synthetic = (pl.col('source') == 'silent_boom') & (
        ((pl.col('option_type') == 'P') & (pl.col('mkt_tide_diff') > SILENT_BOOM_GATE_T))
        | ((pl.col('option_type') == 'C') & (pl.col('mkt_tide_diff') < -SILENT_BOOM_GATE_T))
    )
    silent_multi_leg_synthetic = (pl.col('source') == 'silent_boom') & (
        pl.col('multi_leg_share').is_not_null() & (pl.col('multi_leg_share') >= SILENT_BOOM_MULTI_LEG_MAX)
    )
    synthetic_excluded = lottery_gated_synthetic | silent_gated_synthetic | silent_multi_leg_synthetic
    cohort_c = ~synthetic_excluded

    return df.with_columns([
        cohort_a.alias('cohort_a'),
        pl.lit(True).alias('cohort_b'),
        cohort_c.alias('cohort_c'),
    ])


# ─────────────────────────────────────────────────────────────────
# Feature loop
# ─────────────────────────────────────────────────────────────────

# Only these fulltape columns are needed for feature computation — pruning
# at scan time cuts memory ~4× and disk read time.
FULLTAPE_COLS = [
    'option_chain_id', 'executed_at', 'size', 'price', 'premium',
    'nbbo_bid', 'nbbo_ask', 'open_interest', 'tags', 'multi_vol', 'canceled',
]


def features_for_alerts(alerts: pl.DataFrame, window_minutes: float = 60.0) -> pl.DataFrame:
    """For each alert, load its day's fulltape ONCE and compute features.

    Optimization vs naive per-alert scan:
      - Load each day's parquet exactly once with column pruning
      - Filter to ONLY the option_chain_ids that have alerts that day
      - Drop cancelled rows at scan time
      - Materialize to in-memory DataFrame
      - Pre-bucket by option_chain_id (Python dict) for O(1) per-alert lookup

    For a day with 14K alerts on ~5K unique contracts, this drops the load
    from ~14K parquet scans to 1 + ~14K dict lookups → ~100× faster.

    Empty input → empty output.
    """
    if len(alerts) == 0:
        return alerts

    out_rows: list[dict] = []
    skipped_no_fulltape = 0
    skipped_join_empty = 0
    t_start = time.time()

    # Group by date so we load each parquet once.
    dates = sorted(alerts['date'].unique().to_list())
    print(f'Processing alerts across {len(dates)} dates...', file=sys.stderr)

    for date in dates:
        date_str = date.isoformat()
        day_alerts = alerts.filter(pl.col('date') == date)
        if not fulltape_exists(date_str):
            skipped_no_fulltape += len(day_alerts)
            continue

        day_chains = day_alerts['option_chain_id'].unique().to_list()
        t_load = time.time()
        # Load → prune cols → filter to chain set → drop cancelled → materialize.
        # Wrapped in try/except — UW writes fulltape mid-night, so a day's file
        # can be truncated if we race it. Skip + report rather than kill the run.
        try:
            ft_day = (
                pl.scan_parquet(fulltape_path(date_str))
                .select(FULLTAPE_COLS)
                .filter(pl.col('option_chain_id').is_in(day_chains))
                .filter(~pl.col('canceled'))
                .collect()
            )
        except pl.exceptions.ComputeError as exc:
            print(f'  {date_str}: SKIP — parquet read failed: {exc}', file=sys.stderr)
            skipped_no_fulltape += len(day_alerts)
            continue
        # Older fulltape files (early-Jan 2026) have naive `executed_at`; newer
        # files are UTC-tagged. Coerce to UTC consistently or `==` against
        # UTC-aware literals raises SchemaError on the older files.
        if ft_day.schema['executed_at'].time_zone is None:
            ft_day = ft_day.with_columns(
                pl.col('executed_at').dt.replace_time_zone('UTC')
            )
        # Bucket by chain for fast per-alert lookup.
        # Polars group_by yields (key_tuple, sub_df) — unpack the scalar.
        chain_groups: dict[str, pl.DataFrame] = {
            key[0]: sub_df
            for key, sub_df in ft_day.group_by('option_chain_id', maintain_order=False)
        }
        empty_df = ft_day.head(0)
        load_elapsed = time.time() - t_load
        print(
            f'  {date_str}: {len(day_alerts):,} alerts | '
            f'{len(day_chains):,} unique chains | '
            f'{len(ft_day):,} fulltape rows | load {load_elapsed:.1f}s',
            file=sys.stderr,
        )

        for row in day_alerts.iter_rows(named=True):
            fire_time = row['fire_time_utc']
            if fire_time.tzinfo is None:
                fire_time = fire_time.replace(tzinfo=timezone.utc)
            contract_df = chain_groups.get(row['option_chain_id'], empty_df)
            feats = features_for_alert(
                contract_df, row['option_chain_id'], fire_time, window_minutes=window_minutes,
            )
            if feats.post_fire_print_count == 0 and feats.oi_at_fire == 0:
                skipped_join_empty += 1
            merged = {**row, **{k: getattr(feats, k) for k in feats.__dataclass_fields__ if k not in ('option_chain_id', 'fire_time_utc')}}
            out_rows.append(merged)

    elapsed = time.time() - t_start
    rate = len(out_rows) / max(0.001, elapsed)
    print(
        f'\nFeatures done: {len(out_rows):,} alerts in {elapsed:.1f}s '
        f'({rate:.1f} alerts/sec, skipped {skipped_no_fulltape} no-fulltape, '
        f'{skipped_join_empty} empty-join)',
        file=sys.stderr,
    )

    return pl.from_dicts(out_rows, infer_schema_length=None) if out_rows else pl.DataFrame()


# ─────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Round-trip suppression EDA')
    p.add_argument('--date-from', default=FULLTAPE_MIN_DATE, help='Inclusive earliest alert date (YYYY-MM-DD)')
    p.add_argument('--date-to', default=None, help='Inclusive latest alert date (YYYY-MM-DD)')
    p.add_argument('--limit', type=int, default=None, help='Cap to N alerts (smoke testing)')
    p.add_argument('--cohort', choices=['A', 'B', 'C'], default=None, help='Restrict to one cohort')
    p.add_argument('--window-min', type=float, default=60.0, help='Look-forward window in minutes')
    p.add_argument('--output', type=Path, default=DEFAULT_OUTPUT, help='Output parquet path')
    return p.parse_args()


def main() -> int:
    args = parse_args()

    print('=== Loading alerts ===', file=sys.stderr)
    alerts = load_alerts(date_from=args.date_from, date_to=args.date_to)
    print(f'Loaded {len(alerts):,} enriched alerts ({args.date_from} .. {args.date_to or "now"})', file=sys.stderr)
    if len(alerts) == 0:
        print('No alerts to process; exiting.', file=sys.stderr)
        return 0

    print('\n=== Cohort breakdown ===', file=sys.stderr)
    alerts = add_cohort_masks(alerts)
    by_source = (
        alerts.group_by('source').agg([
            pl.len().alias('n_total'),
            pl.col('cohort_a').sum().alias('n_cohort_a'),
            pl.col('cohort_c').sum().alias('n_cohort_c'),
        ]).sort('source')
    )
    print(by_source, file=sys.stderr)

    if args.cohort:
        mask_col = {'A': 'cohort_a', 'B': 'cohort_b', 'C': 'cohort_c'}[args.cohort]
        before = len(alerts)
        alerts = alerts.filter(pl.col(mask_col))
        print(f'\nCohort {args.cohort} filter: {before:,} → {len(alerts):,}', file=sys.stderr)

    if args.limit:
        alerts = alerts.head(args.limit)
        print(f'Limited to {len(alerts):,} alerts (smoke test)', file=sys.stderr)

    print(f'\n=== Computing features (window={args.window_min}min) ===', file=sys.stderr)
    feats_df = features_for_alerts(alerts, window_minutes=args.window_min)

    if len(feats_df) == 0:
        print('No features computed (all alerts missing fulltape?); exiting.', file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    feats_df.write_parquet(args.output)
    print(f'\n✓ Wrote {len(feats_df):,} rows × {feats_df.width} cols → {args.output}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
