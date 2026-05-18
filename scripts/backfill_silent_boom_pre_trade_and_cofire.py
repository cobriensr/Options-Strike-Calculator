#!/usr/bin/env python
"""One-shot backfill of silent_boom_alerts.pre_trade_count +
adj_cofire for the 64k existing alerts.

Phase A (migration #169) added pre_trade_count and Phase B (#170)
added adj_cofire, but neither shipped with a backfill — only the
detect-silent-boom cron populates them going forward. The 63,846
existing alerts have NULL on both columns, which blocks the ML
training set from using these features and makes the Phase D-2
recalibration analysis blind to them.

This script reads the Eod-Full-Tape parquet day-by-day and computes
both features from the trade stream + per-day cofire keyset. Updates
silent_boom_alerts in place.

  pre_trade_count = count of non-canceled trades on the same chain
                    from session_open (08:30 CT, aligned to the cron's
                    Postgres `AT TIME ZONE 'America/Chicago'` boundary)
                    to bucket_ct.
  adj_cofire      = TRUE when another SB alert exists at the same
                    (ticker, option_type, bucket_ct) on strike ± step
                    ($1 default, $5 for SPX/NDX/RUT roots).

Idempotent — only touches rows where pre_trade_count IS NULL OR
adj_cofire IS NULL. Re-runs are safe.

Run:
    ml/.venv/bin/python scripts/backfill_silent_boom_pre_trade_and_cofire.py
    ml/.venv/bin/python scripts/backfill_silent_boom_pre_trade_and_cofire.py \
        --date 2026-05-15
    ml/.venv/bin/python scripts/backfill_silent_boom_pre_trade_and_cofire.py \
        --dry-run
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
FULLTAPE_DIR = Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'
_CT = ZoneInfo('America/Chicago')

# Match the canonical TS detector logic.
_INDEX_COFIRE_ROOTS = frozenset(
    {'SPXW', 'SPX', 'NDXP', 'NDX', 'RUTW', 'RUT'}
)


def _adj_cofire_strike_step(ticker: str) -> float:
    return 5.0 if ticker in _INDEX_COFIRE_ROOTS else 1.0


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def list_fulltape_dates() -> list[str]:
    out: list[str] = []
    for p in FULLTAPE_DIR.glob('*-fulltape.parquet'):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-fulltape\.parquet', p.name)
        if m:
            out.append(m.group(1))
    return sorted(out)


def fetch_alerts_for_day(
    conn: psycopg2.extensions.connection, date_str: str,
) -> list[tuple]:
    """Return alerts on `date_str` whose pre_trade_count OR adj_cofire
    is NULL. Each row: (id, option_chain_id, bucket_ct,
    underlying_symbol, option_type, strike)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, option_chain_id, bucket_ct,
                   underlying_symbol, option_type, strike
              FROM silent_boom_alerts
             WHERE date = %s::date
               AND (pre_trade_count IS NULL OR adj_cofire IS NULL)
             ORDER BY id
            """,
            (date_str,),
        )
        return cur.fetchall()


def _session_open_utc(date_str: str) -> pd.Timestamp:
    """08:30 America/Chicago on `date_str`, converted to UTC. Postgres
    handles DST via AT TIME ZONE in the cron; we mirror that here."""
    naive = datetime.strptime(date_str, '%Y-%m-%d').replace(
        hour=8, minute=30
    )
    ct_aware = naive.replace(tzinfo=_CT)
    return pd.Timestamp(ct_aware.astimezone(timezone.utc))


def compute_pre_trade_counts(
    date_str: str, alerts: list[tuple],
) -> dict[int, int]:
    """Returns {alert_id: pre_trade_count} for alerts on this day.
    Reads the day's fulltape parquet once, filtered to alert chains."""
    if not alerts:
        return {}
    path = FULLTAPE_DIR / f'{date_str}-fulltape.parquet'
    if not path.exists():
        print(
            f'  [{date_str}] WARN parquet missing — skipping '
            f'{len(alerts)} alerts',
            file=sys.stderr,
        )
        return {}
    chain_ids = list({a[1] for a in alerts})
    df = pd.read_parquet(
        path,
        columns=['executed_at', 'option_chain_id', 'price', 'canceled'],
        filters=[('option_chain_id', 'in', chain_ids)],
    )
    if df.empty:
        return {alert_id: 0 for alert_id, *_ in alerts}
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(
            ['f', 'false', '0', '']
        )]
    df['price'] = pd.to_numeric(df['price'], errors='coerce')
    df = df.dropna(subset=['price'])
    df = df[df['price'] > 0]
    if df.empty:
        return {alert_id: 0 for alert_id, *_ in alerts}
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')

    session_open = _session_open_utc(date_str)
    df = df[df['executed_at'] >= session_open]

    # Group sorted timestamps per chain so we can binary-search the
    # count for each alert's bucket_ct in O(log n) per alert.
    chain_ts: dict[str, list[pd.Timestamp]] = {}
    for chain, sub in df.groupby('option_chain_id', sort=False):
        chain_ts[chain] = sub['executed_at'].sort_values().tolist()

    out: dict[int, int] = {}
    for alert_id, chain_id, bucket_ct, *_rest in alerts:
        # bucket_ct from Postgres comes in tz-aware.
        bucket_ts = pd.Timestamp(bucket_ct)
        if bucket_ts.tz is None:
            bucket_ts = bucket_ts.tz_localize('UTC')
        ts_list = chain_ts.get(chain_id)
        if ts_list is None:
            out[alert_id] = 0
            continue
        # Count trades strictly before bucket_ct.
        from bisect import bisect_left
        out[alert_id] = bisect_left(ts_list, bucket_ts)
    return out


def compute_adj_cofires(alerts: list[tuple]) -> dict[int, bool]:
    """For each alert on the day, check whether another alert exists
    at the same (ticker, option_type, bucket_ct) on strike ± step.

    Per-day intra-cohort lookup. Mirrors the live cron's intra-cron
    cofire keyset — within a single backfill day, all of that day's
    SB alerts ARE the cofire universe."""
    # Build keyset from all alerts on the day (not just the subset
    # needing backfill — co-fires might pair with already-populated
    # alerts).
    keyset: set[str] = set()
    for _id, _chain, bucket_ct, ticker, option_type, strike in alerts:
        bucket_ts = pd.Timestamp(bucket_ct)
        if bucket_ts.tz is None:
            bucket_ts = bucket_ts.tz_localize('UTC')
        key = f'{ticker}|{option_type}|{bucket_ts.isoformat()}|{float(strike)}'
        keyset.add(key)

    out: dict[int, bool] = {}
    for alert_id, _chain, bucket_ct, ticker, option_type, strike in alerts:
        bucket_ts = pd.Timestamp(bucket_ct)
        if bucket_ts.tz is None:
            bucket_ts = bucket_ts.tz_localize('UTC')
        step = _adj_cofire_strike_step(ticker)
        ts_iso = bucket_ts.isoformat()
        s_up = float(strike) + step
        s_dn = float(strike) - step
        out[alert_id] = (
            f'{ticker}|{option_type}|{ts_iso}|{s_up}' in keyset
            or f'{ticker}|{option_type}|{ts_iso}|{s_dn}' in keyset
        )
    return out


def fetch_all_alerts_for_keyset(
    conn: psycopg2.extensions.connection, date_str: str,
) -> list[tuple]:
    """Pull EVERY alert on the day (regardless of NULL-status) so the
    cofire keyset sees the whole cohort. Without this, an alert whose
    twin already has adj_cofire populated would incorrectly come back
    as adj_cofire=False during backfill."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, option_chain_id, bucket_ct,
                   underlying_symbol, option_type, strike
              FROM silent_boom_alerts
             WHERE date = %s::date
             ORDER BY id
            """,
            (date_str,),
        )
        return cur.fetchall()


def apply_updates(
    conn: psycopg2.extensions.connection,
    ptc_by_id: dict[int, int],
    cof_by_id: dict[int, bool],
    dry_run: bool,
) -> int:
    """Batched UPDATE both columns. Returns rowcount actually written."""
    ids = set(ptc_by_id) | set(cof_by_id)
    rows = [
        (alert_id, ptc_by_id.get(alert_id), cof_by_id.get(alert_id))
        for alert_id in ids
    ]
    if not rows:
        return 0
    if dry_run:
        return len(rows)
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            UPDATE silent_boom_alerts AS s
               SET pre_trade_count = v.ptc::integer,
                   adj_cofire = v.cof::boolean
              FROM (VALUES %s) AS v(id, ptc, cof)
             WHERE s.id = v.id
            """,
            rows,
            template='(%s, %s, %s)',
            page_size=10000,
        )
        conn.commit()
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', help='YYYY-MM-DD; single-day mode')
    parser.add_argument('--from-date', help='YYYY-MM-DD inclusive lower')
    parser.add_argument('--to-date', help='YYYY-MM-DD inclusive upper')
    parser.add_argument(
        '--dry-run', action='store_true',
        help='Compute updates but do not commit.',
    )
    args = parser.parse_args()
    if args.date and (args.from_date or args.to_date):
        parser.error('--date is mutually exclusive with --from-date / --to-date')

    load_env()
    db_url = (
        os.environ.get('DATABASE_URL_UNPOOLED')
        or os.environ['DATABASE_URL']
    )
    conn = psycopg2.connect(db_url)

    if args.date:
        dates = [args.date]
    else:
        all_dates = list_fulltape_dates()
        dates = [
            d for d in all_dates
            if (not args.from_date or d >= args.from_date)
            and (not args.to_date or d <= args.to_date)
        ]
    print(
        f'[sb-ptc-cofire-backfill] {len(dates)} days; '
        f'dry_run={args.dry_run}'
    )

    grand_updated = 0
    grand_alerts = 0
    t0 = time.time()
    try:
        for date_str in dates:
            td = time.time()
            null_alerts = fetch_alerts_for_day(conn, date_str)
            if not null_alerts:
                continue
            grand_alerts += len(null_alerts)
            # Pre-trade-count from parquet (only for NULL-row alerts).
            ptc_by_id = compute_pre_trade_counts(date_str, null_alerts)
            # Cofire keyset from ALL alerts on the day, but only emit
            # updates for the NULL-row alerts.
            all_alerts = fetch_all_alerts_for_keyset(conn, date_str)
            cof_all = compute_adj_cofires(all_alerts)
            null_ids = {a[0] for a in null_alerts}
            cof_by_id = {
                aid: v for aid, v in cof_all.items() if aid in null_ids
            }
            updated = apply_updates(conn, ptc_by_id, cof_by_id, args.dry_run)
            grand_updated += updated
            print(
                f'  [{date_str}] alerts={len(null_alerts):>4,} '
                f'updated={updated:>4,} in {time.time() - td:.1f}s'
            )
    finally:
        conn.close()

    print(
        f'[sb-ptc-cofire-backfill] DONE — '
        f'alerts_seen={grand_alerts:,} updated={grand_updated:,} '
        f'dry_run={args.dry_run} elapsed={time.time() - t0:.1f}s'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
