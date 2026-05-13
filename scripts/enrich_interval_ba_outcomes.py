#!/usr/bin/env python
"""Compute forward SPX price paths for every interval_ba_alerts row.

For each backfilled alert this walks 5-min intervals from the alert's
``fired_at`` minute to 15:00 CT (regular-session close) and records the
SPX spot price at each step, plus the percent change from the alert's
``underlying_price`` entry anchor.

Data source: the Full Tape parquets at ~/Desktop/Eod-Full-Tape-parquet/.
Each SPXW option print carries ``underlying_price``, so taking the last
underlying_price per minute across all SPXW ticks yields a 1-minute
SPX spot series for the full backfill window (Jan-May). This avoids
the ``index_candles_1m`` table gap (only covers post-Feb-25).

Outputs (under docs/tmp/, per project memory feedback_scratch_files_in_docs_tmp):
  - interval-ba-outcomes-{stamp}.csv — one row per (alert, t_minutes)
  - interval-ba-outcomes-summary-{stamp}.md — aggregate tables

Prints a final summary to stdout: median forward % returns at T+5/15/30/60
+ EOD, split by severity and option_type.

Usage:
    python3 scripts/enrich_interval_ba_outcomes.py \\
        [--from-date 2026-01-02] [--to-date 2026-05-11] \\
        [--limit-alerts N] [--dry-run]
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import re
import sys
from collections import defaultdict
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import psycopg2
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'
OUT_DIR = ROOT / 'docs' / 'tmp'

TICKER = 'SPXW'
INTERVAL_MIN = 5  # 5-min cadence
SESSION_END_CT = time(15, 0)  # 15:00 CT regular-session close
_CT = ZoneInfo('America/Chicago')

# Severity cuts must match api/interval-ba-feed.ts deriveSeverity().
EXTREME_THRESHOLD = 1_000_000
CRITICAL_THRESHOLD = 500_000


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def severity_of(total_premium: float) -> str:
    if total_premium >= EXTREME_THRESHOLD:
        return 'extreme'
    if total_premium >= CRITICAL_THRESHOLD:
        return 'critical'
    return 'warning'


def session_close_utc(date_iso: str) -> datetime:
    """Return the 15:00 CT instant as a tz-aware UTC datetime."""
    y, m, d = (int(x) for x in date_iso.split('-'))
    naive = datetime.combine(datetime(y, m, d).date(), SESSION_END_CT)
    return naive.replace(tzinfo=_CT).astimezone(UTC)


def load_spx_minute_series(parquet_path: Path) -> dict[datetime, float]:
    """Return {minute_utc: spx_close} for one day from the parquet.

    Takes the last ``underlying_price`` per minute across all SPXW ticks.
    Filters out canceled rows and obviously bad prices (<=0).
    """
    t = pq.read_table(
        parquet_path,
        columns=['underlying_symbol', 'executed_at', 'underlying_price', 'canceled'],
        filters=[('underlying_symbol', '=', TICKER)],
    )
    if t.num_rows == 0:
        return {}
    df = t.to_pandas()
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[
            df['canceled']
            .astype(str)
            .str.lower()
            .isin(['f', 'false', '0', ''])
        ]
    df = df[df['underlying_price'] > 0]
    if df.empty:
        return {}
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    # Floor to the minute boundary (UTC) and pick the last underlying
    # price per minute. Sort first so .last() is deterministic.
    df = df.sort_values('executed_at')
    df['minute'] = df['executed_at'].dt.floor('1min')
    series = df.groupby('minute')['underlying_price'].last()
    return {idx.to_pydatetime(): float(v) for idx, v in series.items()}


def nearest_le(series_keys: list[datetime], target: datetime) -> datetime | None:
    """Return the largest minute_utc <= target, or None if none exists."""
    lo, hi = 0, len(series_keys) - 1
    out = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series_keys[mid] <= target:
            out = series_keys[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return out


def build_forward_path(
    series: dict[datetime, float],
    series_keys: list[datetime],
    fired_at: datetime,
    entry_price: float,
    eod_utc: datetime,
) -> list[tuple[int, datetime, float, float]]:
    """Return [(t_minutes, ts_utc, spx_price, pct_change), ...]."""
    # Anchor at fired_at's minute. t=0 spot uses the last close <= fired_at
    # to mirror what the user would have seen "right when the alert fired".
    anchor_minute = fired_at.replace(second=0, microsecond=0)
    out: list[tuple[int, datetime, float, float]] = []
    step = timedelta(minutes=INTERVAL_MIN)
    t_min = 0
    cur = anchor_minute
    while cur <= eod_utc:
        key = nearest_le(series_keys, cur)
        if key is not None:
            spx = series[key]
            pct = (spx - entry_price) / entry_price * 100.0
            out.append((t_min, cur, spx, pct))
        cur += step
        t_min += INTERVAL_MIN
    return out


def fetch_alerts(
    conn,
    from_date: str | None,
    to_date: str | None,
    limit_alerts: int | None,
) -> list[dict]:
    where: list[str] = []
    params: list[object] = []
    if from_date:
        where.append('expiry >= %s')
        params.append(from_date)
    if to_date:
        where.append('expiry <= %s')
        params.append(to_date)
    # Only alerts whose underlying_price is non-null can be normalized.
    where.append('underlying_price IS NOT NULL')
    sql = (
        'SELECT id, option_chain, ticker, option_type, strike, expiry, '
        'fired_at, ratio_pct, total_premium, trade_count, underlying_price, '
        'top_trade_is_sweep '
        'FROM interval_ba_alerts'
    )
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY fired_at ASC'
    if limit_alerts is not None:
        sql += f' LIMIT {int(limit_alerts)}'
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-date', type=str, default=None)
    parser.add_argument('--to-date', type=str, default=None)
    parser.add_argument('--limit-alerts', type=int, default=None)
    parser.add_argument(
        '--dry-run', action='store_true', help='Skip CSV/MD writes.',
    )
    args = parser.parse_args()

    load_env()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        alerts = fetch_alerts(
            conn, args.from_date, args.to_date, args.limit_alerts,
        )
    finally:
        conn.close()
    if not alerts:
        sys.exit('No alerts matched the filter')

    # Group alerts by expiry date so each parquet is read once.
    by_date: dict[str, list[dict]] = defaultdict(list)
    for a in alerts:
        date_iso = (
            a['expiry'].isoformat()
            if hasattr(a['expiry'], 'isoformat')
            else str(a['expiry'])[:10]
        )
        by_date[date_iso].append(a)

    stamp = datetime.now(tz=UTC).strftime('%Y%m%d-%H%M%S')
    csv_path = OUT_DIR / f'interval-ba-outcomes-{stamp}.csv'
    md_path = OUT_DIR / f'interval-ba-outcomes-summary-{stamp}.md'
    print(
        f'Enriching {len(alerts)} alerts across {len(by_date)} day(s) '
        f'→ {csv_path.name}',
    )

    # Stream CSV rows day-by-day so memory stays bounded.
    csv_rows_written = 0
    # In-memory rollup for the summary tables — keyed by (severity, option_type).
    forward_pcts: dict[tuple[str, str, int], list[float]] = defaultdict(list)
    eod_pcts: dict[tuple[str, str], list[float]] = defaultdict(list)
    horizons_min = (5, 15, 30, 60)

    csv_file = (
        None
        if args.dry_run
        else csv_path.open('w', newline='', encoding='utf-8')
    )
    writer = (
        csv.writer(csv_file)
        if csv_file is not None
        else None
    )
    if writer is not None:
        writer.writerow(
            [
                'alert_id',
                'option_chain',
                'option_type',
                'severity',
                'fired_at',
                't_minutes',
                'ts_utc',
                'spx_price',
                'pct_change',
            ],
        )

    for date_iso, day_alerts in sorted(by_date.items()):
        parquet_path = PARQUET_DIR / f'{date_iso}-fulltape.parquet'
        if not parquet_path.exists():
            print(f'  {date_iso}  SKIP: parquet missing')
            continue
        series = load_spx_minute_series(parquet_path)
        if not series:
            print(f'  {date_iso}  SKIP: no SPXW underlying data')
            continue
        series_keys = sorted(series.keys())
        eod_utc = session_close_utc(date_iso)

        for a in day_alerts:
            sev = severity_of(float(a['total_premium']))
            entry = float(a['underlying_price'])
            fired_at = a['fired_at']
            if fired_at.tzinfo is None:
                fired_at = fired_at.replace(tzinfo=UTC)
            path = build_forward_path(
                series, series_keys, fired_at, entry, eod_utc,
            )
            if not path:
                continue
            for t_min, ts_utc, spx_price, pct in path:
                if writer is not None:
                    writer.writerow(
                        [
                            a['id'],
                            a['option_chain'],
                            a['option_type'],
                            sev,
                            fired_at.isoformat(),
                            t_min,
                            ts_utc.isoformat(),
                            f'{spx_price:.2f}',
                            f'{pct:.4f}',
                        ],
                    )
                    csv_rows_written += 1
                if t_min in horizons_min:
                    forward_pcts[(sev, a['option_type'], t_min)].append(pct)
            # EOD = last point in the path
            last_pct = path[-1][3]
            eod_pcts[(sev, a['option_type'])].append(last_pct)
        print(
            f'  {date_iso}  alerts={len(day_alerts):>4}  '
            f'series_minutes={len(series_keys)}',
        )

    if csv_file is not None:
        csv_file.close()
        print(f'wrote {csv_rows_written} rows → {csv_path}')

    # Aggregate summary tables.
    md_lines = ['# Interval B/A — forward-return experiment\n']
    md_lines.append(f'_Generated {stamp} UTC_\n')
    md_lines.append(
        f'\nReplays the SPX spot path in 5-min increments from each alert\'s '
        f'``fired_at`` minute to 15:00 CT. Entry anchor is the alert\'s own '
        f'``underlying_price``. Median % change across {len(alerts)} alerts.\n',
    )
    md_lines.append('\n## Median % change by severity × option_type\n')
    md_lines.append(
        '| severity | type | n | T+5min | T+15min | T+30min | T+60min | EOD |',
    )
    md_lines.append(
        '|---|---|--:|--:|--:|--:|--:|--:|',
    )

    def median(xs: list[float]) -> float:
        if not xs:
            return float('nan')
        s = sorted(xs)
        n = len(s)
        m = n // 2
        return s[m] if n % 2 else (s[m - 1] + s[m]) / 2.0

    grand_total = 0
    for sev in ('extreme', 'critical', 'warning'):
        for opt_type in ('C', 'P'):
            n = len(eod_pcts.get((sev, opt_type), []))
            if n == 0:
                continue
            grand_total += n
            row = [sev, opt_type, str(n)]
            for h in horizons_min:
                xs = forward_pcts.get((sev, opt_type, h), [])
                row.append(f'{median(xs):+.3f}%' if xs else '—')
            eod_xs = eod_pcts.get((sev, opt_type), [])
            row.append(f'{median(eod_xs):+.3f}%' if eod_xs else '—')
            md_lines.append('| ' + ' | '.join(row) + ' |')
    md_lines.append(f'\n_grand total: {grand_total} alerts with forward path._\n')

    md_text = '\n'.join(md_lines)
    if not args.dry_run:
        md_path.write_text(md_text, encoding='utf-8')
        print(f'wrote summary → {md_path}')

    print('\n' + md_text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
