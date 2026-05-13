#!/usr/bin/env python
"""Backfill interval_ba_alerts from the historical Full Tape parquet archive.

Replays the SPXWIntervalBAHandler detection logic (see
uw-stream/src/handlers/interval_ba.py) against historical per-trade
ticks from ~/Desktop/Eod-Full-Tape-parquet/. Writes synthetic alerts
into Neon with ON CONFLICT (option_chain, bucket_start) DO NOTHING
so re-runs are safe and won't collide with live alerts the daemon
writes later for the same bucket.

Mirrors the handler's invariants exactly so backtest results are
faithful to what live alerts will look like:

  - 0DTE only:           expiry == executed_at::date(CT)
  - Wall-clock buckets:  floor(executed_at) to 5-minute boundary (UTC)
  - Side parsing:        'ask_side' / 'bid_side' / 'mid_side' tag
  - Sweep / floor:       'sweep' / 'floor' in tags OR report_flags
  - Premium:             price × size × 100 (SPXW multiplier)
  - Severity:            extreme >= $1M / critical >= $500K / warning

Filters before grouping:
  - underlying_symbol == 'SPXW'
  - canceled == False
  - price > 0, size > 0

Threshold:
  - ratio_pct >= 70.00
  - total_premium >= $250,000

Usage:
    ml/.venv/bin/python scripts/backfill_interval_ba_alerts.py \\
        [--from-date 2026-01-02] [--to-date 2026-05-11] [--dry-run]
        [--limit-days N]

Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md
(post-shipping backfill — Phase B2).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pyarrow.parquet as pq

# psycopg2 is imported lazily inside insert_alerts() so a dry-run on a
# machine without it still works.

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'

# Match the SPXWIntervalBAHandler defaults.
TICKER = 'SPXW'
RATIO_THRESHOLD = Decimal('0.70')
PREMIUM_FLOOR = Decimal(250_000)
BUCKET_SEC = 300
MULTIPLIER = Decimal(100)

# Severity cuts match api/interval-ba-alerts.ts deriveSeverity().
EXTREME_THRESHOLD = Decimal(1_000_000)
CRITICAL_THRESHOLD = Decimal(500_000)

# Chicago zone for 0DTE detection — SPX/SPXW expire by CT calendar date.
_CT = ZoneInfo('America/Chicago')

# Columns to project at parquet read time. Everything else is wasted IO
# at this volume (11M rows × 40 cols × ~1KB row = 1GB/day; projecting
# to 11 cols drops it to ~200MB).
_READ_COLUMNS = [
    'executed_at',
    'underlying_symbol',
    'option_chain_id',
    'option_type',
    'strike',
    'expiry',
    'price',
    'size',
    'premium',
    'underlying_price',
    'tags',
    'report_flags',
    'canceled',
]

# Columns in interval_ba_alerts the INSERT touches (id / fired_at /
# acknowledged auto-populate from defaults).
_INSERT_COLUMNS = [
    'option_chain',
    'ticker',
    'option_type',
    'strike',
    'expiry',
    'bucket_start',
    'bucket_end',
    'ratio_pct',
    'ask_premium',
    'total_premium',
    'trade_count',
    'top_trade_premium',
    'top_trade_size',
    'top_trade_executed_at',
    'top_trade_is_sweep',
    'top_trade_is_floor',
    'underlying_price',
]


def load_env() -> None:
    """Read .env.local into os.environ (idempotent)."""
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def list_parquet_dates(
    from_date: str | None, to_date: str | None, limit: int | None,
) -> list[tuple[str, Path]]:
    """Return [(date, path), ...] for each fulltape parquet in range."""
    out: list[tuple[str, Path]] = []
    for p in sorted(PARQUET_DIR.glob('*-fulltape.parquet')):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-fulltape\.parquet', p.name)
        if not m:
            continue
        d = m.group(1)
        if from_date and d < from_date:
            continue
        if to_date and d > to_date:
            continue
        out.append((d, p))
    if limit is not None:
        out = out[:limit]
    return out


def parse_tags(raw: Any) -> set[str]:
    """Parse a tags string into a set, tolerating both wire formats.

    The Full Tape parquet schema changed mid-2026-05:
      - Pre-May 11:  `'bid_side,bullish,index'`  (no braces)
      - May 11+:     `'{bid_side,bullish,index}'` (Postgres array)
    Empty / null variants: ``''``, ``'{}'``, ``'{NULL}'``, None, NaN.
    Returns an empty set on any unparseable input — same fail-open
    semantics as the SPXWIntervalBAHandler.
    """
    if raw is None:
        return set()
    if isinstance(raw, float) and pd.isna(raw):
        return set()
    s = str(raw).strip()
    if not s or s in ('{}', '{NULL}'):
        return set()
    # Strip Postgres-array braces if present; otherwise treat the whole
    # string as a comma list.
    if s.startswith('{') and s.endswith('}'):
        s = s[1:-1]
    return {t.strip() for t in s.split(',') if t.strip()}


def derive_side(tag_set: set[str]) -> str:
    if 'ask_side' in tag_set:
        return 'ask'
    if 'bid_side' in tag_set:
        return 'bid'
    if 'mid_side' in tag_set:
        return 'mid'
    return 'no_side'


def derive_severity(total_premium: Decimal) -> str:
    if total_premium >= EXTREME_THRESHOLD:
        return 'extreme'
    if total_premium >= CRITICAL_THRESHOLD:
        return 'critical'
    return 'warning'


def bucket_floor_epoch(ts: pd.Timestamp) -> int:
    """Floor a UTC timestamp to a 5-minute boundary (epoch seconds)."""
    epoch = int(ts.timestamp())
    return (epoch // BUCKET_SEC) * BUCKET_SEC


def ct_date(ts: pd.Timestamp) -> str:
    """Map a UTC timestamp to its CT calendar date ISO string."""
    return ts.tz_convert(_CT).date().isoformat()


def load_spxw_day(parquet_path: Path) -> pd.DataFrame:
    """Read the parquet, filter to SPXW + 0DTE + valid trades.

    Predicate pushdown via pyarrow keeps us from materialising the full
    11M-row table — only SPXW rows reach pandas.
    """
    table = pq.read_table(
        parquet_path,
        columns=_READ_COLUMNS,
        filters=[('underlying_symbol', '=', TICKER)],
    )
    if table.num_rows == 0:
        return pd.DataFrame()
    df = table.to_pandas()
    # canceled may be stored as bool or string depending on parquet era.
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[
            df['canceled']
            .astype(str)
            .str.lower()
            .isin(['f', 'false', '0', ''])
        ]
    df = df[(df['price'] > 0) & (df['size'] > 0)].copy()
    if df.empty:
        return df
    # Timestamps must be tz-aware UTC for the bucket floor + CT
    # conversions below.
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    # Expiry → ISO string for cheap equality test against CT date.
    df['expiry_iso'] = df['expiry'].astype(str).str[:10]
    df['executed_ct_date'] = df['executed_at'].apply(ct_date)
    # 0DTE filter — expiry == CT calendar date of the trade.
    df = df[df['expiry_iso'] == df['executed_ct_date']].copy()
    return df


def detect_alerts_for_day(df: pd.DataFrame) -> list[tuple]:
    """Group day's SPXW 0DTE trades into 5-min buckets per contract;
    return alert rows for buckets meeting the ratio + floor thresholds.

    Returns rows in the order of _INSERT_COLUMNS.
    """
    if df.empty:
        return []

    # Per-row enrichment vectorised where possible.
    df['premium_d'] = (
        df['price'].astype(str).map(Decimal)
        * df['size'].astype(int).map(Decimal)
        * MULTIPLIER
    )
    # Tag set per row (Python objects, can't vectorize the str-array
    # parse cleanly but the alternative regex-based extraction is
    # marginally faster and harder to read; tags column is ~30 chars).
    df['tag_set'] = df['tags'].map(parse_tags)
    df['report_set'] = df['report_flags'].map(parse_tags)
    df['side'] = df['tag_set'].map(derive_side)
    df['is_sweep'] = df['tag_set'].map(lambda s: 'sweep' in s) | df[
        'report_set'
    ].map(lambda s: 'intermarket_sweep' in s)
    df['is_floor'] = df['tag_set'].map(lambda s: 'floor' in s) | df[
        'report_set'
    ].map(lambda s: 'floor' in s)
    df['bucket_epoch'] = df['executed_at'].map(bucket_floor_epoch)

    # Option type may be 'call'/'put' or 'C'/'P' depending on era.
    df['option_type_norm'] = df['option_type'].map(
        lambda v: 'C' if v in ('C', 'call') else ('P' if v in ('P', 'put') else None),
    )
    df = df[df['option_type_norm'].notna()].copy()
    if df.empty:
        return []

    # Pre-compute the per-trade ask flag.
    df['is_ask'] = df['side'] == 'ask'
    df['ask_premium_d'] = df['premium_d'].where(df['is_ask'], Decimal(0))

    out_rows: list[tuple] = []
    # Group by (option_chain, bucket_epoch). At single-day scale (5-min
    # x ~100 active strikes = 100*78 = ~7800 groups) the apply overhead
    # is acceptable.
    for (chain, bucket_epoch), sub in df.groupby(
        ['option_chain_id', 'bucket_epoch'], sort=False,
    ):
        total_premium = sum(sub['premium_d'])
        ask_premium = sum(sub['ask_premium_d'])
        if total_premium < PREMIUM_FLOOR:
            continue
        ratio = ask_premium / total_premium
        if ratio < RATIO_THRESHOLD:
            continue

        # Top ask print — argmax over ask-side rows by premium.
        ask_rows = sub[sub['is_ask']]
        if ask_rows.empty:
            continue
        top_idx = ask_rows['premium_d'].idxmax()
        top = ask_rows.loc[top_idx]

        bucket_start = datetime.fromtimestamp(bucket_epoch, tz=UTC)
        bucket_end = bucket_start + timedelta(seconds=BUCKET_SEC)

        out_rows.append(
            (
                chain,                                       # option_chain
                TICKER,                                      # ticker
                top['option_type_norm'],                     # option_type
                Decimal(str(top['strike'])),                 # strike
                top['expiry_iso'],                           # expiry
                bucket_start,                                # bucket_start
                bucket_end,                                  # bucket_end
                (ratio * Decimal(100)).quantize(Decimal('0.01')),  # ratio_pct
                ask_premium.quantize(Decimal('0.01')),       # ask_premium
                total_premium.quantize(Decimal('0.01')),     # total_premium
                int(len(sub)),                               # trade_count
                Decimal(str(top['premium_d'])).quantize(Decimal('0.01')),
                int(top['size']),                            # top_trade_size
                top['executed_at'].to_pydatetime(),          # top_trade_executed_at
                bool(top['is_sweep']),                       # top_trade_is_sweep
                bool(top['is_floor']),                       # top_trade_is_floor
                Decimal(str(top['underlying_price']))
                if pd.notna(top['underlying_price'])
                else None,                                   # underlying_price
            ),
        )
    return out_rows


def insert_alerts(conn, rows: list[tuple]) -> int:
    """Bulk INSERT with ON CONFLICT DO NOTHING. Returns rows actually
    inserted (excludes conflict rejects)."""
    if not rows:
        return 0
    from psycopg2.extras import execute_values

    cols = ', '.join(_INSERT_COLUMNS)
    conflict_cols = '(option_chain, bucket_start)'
    sql = (
        f'INSERT INTO interval_ba_alerts ({cols}) VALUES %s '
        f'ON CONFLICT {conflict_cols} DO NOTHING RETURNING id'
    )
    with conn.cursor() as cur:
        execute_values(cur, sql, rows, page_size=500)
        inserted = cur.rowcount  # RETURNING id makes rowcount honest
    conn.commit()
    return inserted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-date', type=str, default=None)
    parser.add_argument('--to-date', type=str, default=None)
    parser.add_argument('--limit-days', type=int, default=None)
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Read parquets and detect alerts but skip DB writes.',
    )
    args = parser.parse_args()

    load_env()
    if not PARQUET_DIR.exists():
        sys.exit(f'Missing parquet dir: {PARQUET_DIR}')
    dates = list_parquet_dates(args.from_date, args.to_date, args.limit_days)
    if not dates:
        sys.exit('No parquet files matched the date range')

    print(f'Backfilling {len(dates)} day(s): {dates[0][0]} → {dates[-1][0]}')
    if args.dry_run:
        print('DRY RUN — DB writes skipped')

    conn = None
    if not args.dry_run:
        import psycopg2

        database_url = os.environ.get('DATABASE_URL')
        if not database_url:
            sys.exit('DATABASE_URL not set in env')
        conn = psycopg2.connect(database_url)

    total_alerts = 0
    total_inserted = 0
    try:
        for date_str, parquet_path in dates:
            t0 = time.monotonic()
            df = load_spxw_day(parquet_path)
            t_load = time.monotonic() - t0
            if df.empty:
                print(
                    f'  {date_str}  rows=0      no SPXW 0DTE flow '
                    f'(load {t_load:.1f}s)',
                )
                continue
            t1 = time.monotonic()
            rows = detect_alerts_for_day(df)
            t_detect = time.monotonic() - t1
            total_alerts += len(rows)

            inserted = 0
            if rows and not args.dry_run:
                assert conn is not None
                inserted = insert_alerts(conn, rows)
                total_inserted += inserted

            print(
                f'  {date_str}  rows={len(df):>7}  alerts={len(rows):>3}  '
                f'inserted={inserted:>3}  '
                f'(load {t_load:.1f}s detect {t_detect:.1f}s)',
            )
    finally:
        if conn is not None:
            conn.close()

    print(
        f'\nDone. detected={total_alerts} inserted={total_inserted} '
        f'(skipped={total_alerts - total_inserted} as duplicates / dry-run)',
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
