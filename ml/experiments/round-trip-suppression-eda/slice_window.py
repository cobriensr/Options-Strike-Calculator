"""Phase 3 EDA: window-length sweep + per-ticker + per-DTE stratification.

Walks the fulltape for the past 30 days at multiple window lengths
{30, 60, 90, 120 min} per alert and emits a long-format parquet
(`alert_features_windows.parquet`) with one row per (alert, window).

Multi-window-in-one-pass: for each alert we filter the day's fulltape
to the contract ONCE, then compute net_pct at each of the four windows
from the same in-memory subset. Cost is dominated by the per-day
parquet load, not the per-alert math.

Spec direction: validates whether the 60-min window we shipped in
Phase 2B is optimal, or whether a different window per DTE bucket
gives sharper discrimination. Drives Phase 3 cron-tuning decisions.

Usage:
    ml/.venv/bin/python ml/experiments/round-trip-suppression-eda/slice_window.py

Output:
    ml/experiments/round-trip-suppression-eda/alert_features_windows.parquet
    (long-format: alert_id × source × window_minutes × features × outcome)
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_helper import fulltape_exists, fulltape_path  # noqa: E402
from features import annotate_per_print_sides  # noqa: E402
from notebook import (  # noqa: E402
    FULLTAPE_COLS,
    add_cohort_masks,
    load_alerts,
)

EXPERIMENT_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT = EXPERIMENT_DIR / 'alert_features_windows.parquet'

# Past 30 trading days — matches the user's scope decision.
DATE_FROM = '2026-04-14'
DATE_TO = '2026-05-15'

# Sweep these four windows per alert. 30 gives the short-DTE answer;
# 120 catches anything that develops over 2 hours.
WINDOWS = [30, 60, 90, 120]


def features_multi_window(
    contract_df: pl.DataFrame,
    fire_time_utc: datetime,
    windows: list[int],
) -> dict[int, dict[str, object]]:
    """Compute (net_pct, ask_size, bid_size, total_size, print_count) per window.

    Single-pass design: the contract subset is already filtered by
    option_chain_id + canceled=false. We tag sides once, then slice by
    timestamp for each window.
    """
    base = {
        w: {
            'post_fire_print_count': 0,
            'post_fire_total_size': 0,
            'post_fire_ask_size': 0,
            'post_fire_bid_size': 0,
            'post_fire_net_ask_minus_bid': 0,
            'post_fire_net_pct_of_volume': 0.0,
        }
        for w in windows
    }
    if len(contract_df) == 0:
        return base
    tagged = annotate_per_print_sides(contract_df.sort('executed_at'))
    for w in windows:
        window_end = fire_time_utc + timedelta(minutes=w)
        post = tagged.filter(
            (pl.col('executed_at') > fire_time_utc)
            & (pl.col('executed_at') <= window_end)
        )
        if len(post) == 0:
            continue
        ask = int(post.filter(pl.col('tag_side') == 'ask')['size'].sum())
        bid = int(post.filter(pl.col('tag_side') == 'bid')['size'].sum())
        total = int(post['size'].sum())
        net = ask - bid
        base[w] = {
            'post_fire_print_count': len(post),
            'post_fire_total_size': total,
            'post_fire_ask_size': ask,
            'post_fire_bid_size': bid,
            'post_fire_net_ask_minus_bid': net,
            'post_fire_net_pct_of_volume': net / max(1, total),
        }
    return base


def main() -> int:
    print(f'Loading alerts {DATE_FROM} → {DATE_TO}...', file=sys.stderr)
    alerts = load_alerts(date_from=DATE_FROM, date_to=DATE_TO)
    if len(alerts) == 0:
        print('No alerts in range; exiting.', file=sys.stderr)
        return 1
    alerts = add_cohort_masks(alerts)
    print(f'Loaded {len(alerts):,} alerts in window', file=sys.stderr)

    out_rows: list[dict] = []
    skipped_no_fulltape = 0
    t_start = time.time()
    dates = sorted(alerts['date'].unique().to_list())
    print(f'Processing {len(dates)} days × {len(WINDOWS)} windows...', file=sys.stderr)

    for date in dates:
        date_str = date.isoformat()
        day_alerts = alerts.filter(pl.col('date') == date)
        if not fulltape_exists(date_str):
            skipped_no_fulltape += len(day_alerts)
            continue

        day_chains = day_alerts['option_chain_id'].unique().to_list()
        t_load = time.time()
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
        if ft_day.schema['executed_at'].time_zone is None:
            ft_day = ft_day.with_columns(
                pl.col('executed_at').dt.replace_time_zone('UTC')
            )
        chain_groups: dict[str, pl.DataFrame] = {
            key[0]: sub_df
            for key, sub_df in ft_day.group_by('option_chain_id', maintain_order=False)
        }
        empty = ft_day.head(0)
        print(
            f'  {date_str}: {len(day_alerts):,} alerts | {len(day_chains):,} chains | '
            f'{len(ft_day):,} prints | load {time.time() - t_load:.1f}s',
            file=sys.stderr,
        )

        for row in day_alerts.iter_rows(named=True):
            fire_time = row['fire_time_utc']
            if fire_time.tzinfo is None:
                fire_time = fire_time.replace(tzinfo=timezone.utc)
            contract_df = chain_groups.get(row['option_chain_id'], empty)
            feats = features_multi_window(contract_df, fire_time, WINDOWS)
            for w, f in feats.items():
                out_rows.append({
                    'alert_id': row['alert_id'],
                    'source': row['source'],
                    'date': row['date'],
                    'fire_time_utc': fire_time,
                    'option_chain_id': row['option_chain_id'],
                    'underlying_symbol': row['underlying_symbol'],
                    'option_type': row['option_type'],
                    'dte': row['dte'],
                    'window_minutes': w,
                    **f,
                    'realized_trail30_10_pct': row['realized_trail30_10_pct'],
                    'realized_eod_pct': row['realized_eod_pct'],
                    'peak_ceiling_pct': row['peak_ceiling_pct'],
                    'cohort_a': row['cohort_a'],
                    'cohort_c': row['cohort_c'],
                })

    elapsed = time.time() - t_start
    rate = len(out_rows) / max(0.001, elapsed)
    print(
        f'\nDone: {len(out_rows):,} (alert × window) rows in {elapsed:.1f}s '
        f'({rate:.0f}/sec, skipped {skipped_no_fulltape} no-fulltape).',
        file=sys.stderr,
    )

    if not out_rows:
        return 1
    out_df = pl.from_dicts(out_rows, infer_schema_length=None)
    DEFAULT_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    out_df.write_parquet(DEFAULT_OUTPUT)
    print(f'✓ Wrote {DEFAULT_OUTPUT}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
