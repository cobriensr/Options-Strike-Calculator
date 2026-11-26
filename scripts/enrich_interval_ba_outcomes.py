#!/usr/bin/env python
"""Compute forward spot paths for Interval B/A alerts, from the Full Tape in R2.

For each alert this walks 5-min steps from the alert's own ``fired_at`` to 15:00 CT
(regular-session close) and records the underlying's spot at each step, plus the percent
change from the alert's entry anchor.

METHODOLOGY CHANGE (2026-11-26, interval-ba-rebuild spec 6.8). Paths from this version do not
compare with CSVs written by the one before it:

  - t=0 is the last print of the alert's own contract at or before ``fired_at``, compared in
    epoch microseconds. It used to be the last print of the minute containing ``fired_at``,
    which can sit up to 59 s after the alert.
  - Every later step sits exactly 5*k minutes after ``fired_at`` and takes the last print of
    the whole root at or before that instant. They used to sit 5*k minutes after the alert's
    minute and take that minute's last print, so a path could start up to 59 s late and
    measure up to 59 s more than its horizon.
  - Prints are picked by their OCC root (``option_chain_id`` less its last 15 characters), not
    by ``underlying_symbol``: the websocket labels SPXW prints SPX.
  - A row with no ``underlying_price`` (a live SPXW row before the nightly heal) takes the
    t=0 print as its entry, and is skipped only when the tape has none. The query used to
    drop every such row.

Sources (``--source``):
  table   interval_ba_alerts in Neon, read only: the live record, plus what the nightly tape
          step added to it. This is the default.
  export  the full-year replay in R2, research/interval-ba/replay-<--export-end>.parquet,
          written by scripts/interval_ba_tape.py: one rule all year. It has no table ids, so
          ``alert_id`` is "<option_chain>@<bucket_start in epoch seconds>", the table's
          unique key, and the files are named interval-ba-outcomes-export-*. The analyze_*
          scripts join ``alert_id`` to table ids: give them the table's CSV only.

Data source for the tape: fulltape/{date}-fulltape.parquet in R2 (the R2_* variables, from
.env.local), through ml/src/utils/r2.py. DuckDB reads only the columns it needs. Each print
carries the underlying's ``underlying_price``, so the last one per instant gives a spot series
for the whole day, with no dependence on the ``index_candles_1m`` table.

Outputs (under docs/tmp/, per project memory feedback_scratch_files_in_docs_tmp):
  - interval-ba-outcomes[-export][-<ticker>]-{stamp}.csv: one row per (alert, t_minutes)
  - interval-ba-outcomes-summary[-export][-<ticker>]-{stamp}.md: aggregate tables

Prints a final summary to stdout: median forward % returns at T+5/15/30/60
+ EOD, split by severity and option_type.

Usage:
    ml/.venv/Scripts/python scripts/enrich_interval_ba_outcomes.py \\
        [--source table|export] [--export-end 2026-11-25] \\
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
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
OUT_DIR = ROOT / 'docs' / 'tmp'

# ml/src holds utils.r2, the tape over httpfs.
_ML_SRC = str(ROOT / 'ml' / 'src')
if _ML_SRC not in sys.path:
    sys.path.insert(0, _ML_SRC)

from utils.r2 import fulltape_connection, r2_url  # noqa: E402

INTERVAL_MIN = 5  # 5-min cadence
SESSION_END_CT = time(15, 0)  # 15:00 CT regular-session close
_CT = ZoneInfo('America/Chicago')
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_US = timedelta(microseconds=1)
_MINUTE_US = 60 * 1_000_000

# Severity cuts must match api/interval-ba-feed.ts deriveSeverity().
EXTREME_THRESHOLD = 1_000_000
CRITICAL_THRESHOLD = 500_000

# An OCC symbol is its root, then yymmdd, C or P, and eight strike digits.
OCC_SUFFIX_LEN = 15

# The tool's export (scripts/interval_ba_tape.py, spec 6.5): one object per --end date, in the
# tape's bucket. These are the columns this script reads, in the tool's order, with the types
# the tool writes. This file imports nothing from the tool: a production run hashes its files.
# test_export_columns_match_the_tool holds this copy to the tool's own.
#   option_chain string, ticker string, option_type string, strike decimal(10,3), expiry date,
#   bucket_start timestamp(us, UTC), fired_at timestamp(us, UTC), ratio_pct decimal(5,2),
#   total_premium decimal(14,2), trade_count int32, underlying_price decimal(10,2) NULLABLE,
#   top_trade_is_sweep bool
EXPORT_PREFIX = 'research/interval-ba/'
EXPORT_COLUMNS = (
    'option_chain',
    'ticker',
    'option_type',
    'strike',
    'expiry',
    'bucket_start',
    'fired_at',
    'ratio_pct',
    'total_premium',
    'trade_count',
    'underlying_price',
    'top_trade_is_sweep',
)

SKIPPED_NOTE = 'no spot in the row or on the tape'


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


def epoch_us(at: datetime) -> int:
    """Epoch microseconds of an aware datetime, in exact integer arithmetic."""
    return (at - _EPOCH) // _US


def as_utc(at: datetime) -> datetime:
    return at.replace(tzinfo=UTC) if at.tzinfo is None else at.astimezone(UTC)


@dataclass(frozen=True)
class SpotSeries:
    """The underlying's spot at each print, in time order.

    `us` is epoch microseconds, ascending; prints that share a microsecond keep the file's
    order, so the later row is the one at_or_before returns.
    """

    us: np.ndarray
    spot: np.ndarray

    def __len__(self) -> int:
        return len(self.us)

    def at_or_before(self, at_us: int) -> float | None:
        """The spot of the last print at or before `at_us`, or None when none is."""
        i = int(np.searchsorted(self.us, at_us, side='right'))
        return float(self.spot[i - 1]) if i else None


# The tape has had two layouts (before 2026-05-04 `executed_at` is a naive TIMESTAMP holding
# UTC, after it a TIMESTAMPTZ). epoch_us gives the true instant of either, whatever the
# session's time zone; a cast through AT TIME ZONE would misdate the naive one. Prices are
# DECIMAL in the old layout and DOUBLE in the new one, so they are cast. `canceled` may be a
# Boolean or 't' / 'f' text (the loader this replaces read both), and an empty or NULL one
# counts as not canceled.
_ROOT_SQL = f'left(option_chain_id, length(option_chain_id) - {OCC_SUFFIX_LEN})'
_NOT_CANCELED = 'NOT coalesce(try_cast(canceled AS BOOLEAN), false)'

# Prints of one OCC root, whatever their underlying_symbol label, in time order.
_ROOT_SERIES_SQL = f"""
SELECT us, spot FROM (
    SELECT
        epoch_us(executed_at) AS us,
        file_row_number AS frn,
        CAST(underlying_price AS DOUBLE) AS spot
    FROM read_parquet($tape, file_row_number = true)
    WHERE {_ROOT_SQL} = $root AND {_NOT_CANCELED}
)
WHERE isfinite(spot) AND spot > 0
ORDER BY us, frn
"""

# For each (chain, instant), the spot of that chain's last print at or before the instant.
_T0_SQL = f"""
WITH wanted AS (
    SELECT unnest($chains) AS chain, unnest($fired) AS fired_us
),
prints AS (
    SELECT
        option_chain_id AS chain,
        epoch_us(executed_at) AS us,
        file_row_number AS frn,
        CAST(underlying_price AS DOUBLE) AS spot
    FROM read_parquet($tape, file_row_number = true)
    WHERE option_chain_id IN (SELECT chain FROM wanted) AND {_NOT_CANCELED}
)
SELECT w.chain, w.fired_us, first(p.spot ORDER BY p.us DESC, p.frn DESC) AS spot
FROM wanted w
JOIN prints p ON p.chain = w.chain AND p.us <= w.fired_us
WHERE isfinite(p.spot) AND p.spot > 0
GROUP BY w.chain, w.fired_us
"""


def object_exists(con, url: str) -> bool:
    """True when the parquet is there. A missing day is told apart from a failed read this
    way: a read that fails for any other reason (credentials, a corrupt file) raises."""
    return con.execute('SELECT count(*) FROM glob($url)', {'url': url}).fetchone()[0] > 0


def load_root_spot_series(con, tape: str, root: str) -> SpotSeries:
    """Every print of one OCC root on the tape, canceled ones and prints with no usable
    underlying price left out."""
    cols = con.execute(_ROOT_SERIES_SQL, {'tape': tape, 'root': root}).fetchnumpy()
    return SpotSeries(np.asarray(cols['us']), np.asarray(cols['spot']))


def load_t0_spots(
    con,
    tape: str,
    wanted: Sequence[tuple[str, int]],
) -> dict[tuple[str, int], float]:
    """{(chain, epoch_us): spot} for each wanted pair that has a print of that chain at or
    before the instant. A pair with none is absent."""
    if not wanted:
        return {}
    params = {
        'tape': tape,
        'chains': [chain for chain, _ in wanted],
        'fired': [fired_us for _, fired_us in wanted],
    }
    rows = con.execute(_T0_SQL, params).fetchall()
    return {(chain, fired_us): float(spot) for chain, fired_us, spot in rows}


def build_forward_path(
    root_series: SpotSeries,
    t0_spot: float | None,
    fired_at: datetime,
    entry_price: float,
    eod_utc: datetime,
) -> list[tuple[int, datetime, float, float]]:
    """Return [(t_minutes, ts_utc, spot, pct_change), ...].

    `fired_at` is aware UTC. Step k sits exactly k*INTERVAL_MIN minutes after it, up to and
    including the close. t=0 is `t0_spot`, the alert's own contract's last print at or before
    `fired_at`; every later step is the root's last print at or before its instant. A step
    with no print is left out.
    """
    fired_us = epoch_us(fired_at)
    eod_us = epoch_us(eod_utc)
    out: list[tuple[int, datetime, float, float]] = []
    t_min = 0
    while fired_us + t_min * _MINUTE_US <= eod_us:
        if t_min == 0:
            spot = t0_spot
        else:
            spot = root_series.at_or_before(fired_us + t_min * _MINUTE_US)
        if spot is not None:
            pct = (spot - entry_price) / entry_price * 100.0
            out.append((t_min, fired_at + timedelta(minutes=t_min), spot, pct))
        t_min += INTERVAL_MIN
    return out


def alert_entry(alert: dict, t0_spot: float | None) -> float | None:
    """The alert's own spot, else the tape's t=0 spot; None when neither exists."""
    if alert['underlying_price'] is not None:
        return float(alert['underlying_price'])
    return t0_spot


def fetch_alerts(
    conn,
    ticker: str,
    from_date: str | None,
    to_date: str | None,
    limit_alerts: int | None,
) -> list[dict]:
    where: list[str] = ['ticker = %s']
    params: list[object] = [ticker]
    if from_date:
        where.append('expiry >= %s')
        params.append(from_date)
    if to_date:
        where.append('expiry <= %s')
        params.append(to_date)
    # A NULL underlying_price stays in: the tape gives such a row its entry (alert_entry).
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


def export_key(end: str) -> str:
    return f'{EXPORT_PREFIX}replay-{end}.parquet'


def export_url(end: str) -> str:
    bucket = os.environ.get('R2_BUCKET_FULLTAPE', '').strip()
    if not bucket:
        sys.exit('Missing env var R2_BUCKET_FULLTAPE (set it in .env.local)')
    return f's3://{bucket}/{export_key(end)}'


def fetch_export_alerts(
    con,
    url: str,
    ticker: str,
    from_date: str | None,
    to_date: str | None,
    limit_alerts: int | None,
) -> list[dict]:
    """The export's alerts, shaped like fetch_alerts' rows: the same keys and Python types.

    The export has no ids, so `id` is the table's unique key, the contract and its bucket.
    Times leave DuckDB as epoch microseconds (a TIMESTAMPTZ needs pytz to come out as a
    datetime) and become aware UTC datetimes here.
    """
    where = ['ticker = $ticker']
    params: dict[str, object] = {'url': url, 'ticker': ticker}
    if from_date:
        where.append('expiry >= CAST($from_date AS DATE)')
        params['from_date'] = from_date
    if to_date:
        where.append('expiry <= CAST($to_date AS DATE)')
        params['to_date'] = to_date
    sql = (
        'SELECT option_chain, ticker, option_type, strike, expiry, '
        'epoch_us(fired_at) AS fired_us, ratio_pct, total_premium, trade_count, '
        'underlying_price, top_trade_is_sweep, epoch_us(bucket_start) AS bucket_us '
        'FROM read_parquet($url) WHERE ' + ' AND '.join(where) +
        ' ORDER BY fired_at ASC, option_chain ASC'
    )
    if limit_alerts is not None:
        sql += f' LIMIT {int(limit_alerts)}'
    cur = con.execute(sql, params)
    cols = [c[0] for c in cur.description]
    alerts = []
    for row in cur.fetchall():
        r = dict(zip(cols, row, strict=True))
        fired_us = r.pop('fired_us')
        bucket_us = r.pop('bucket_us')
        alerts.append(
            {
                'id': f'{r["option_chain"]}@{bucket_us // 1_000_000}',
                **r,
                'fired_at': _EPOCH + timedelta(microseconds=fired_us),
            },
        )
    return alerts


def check_export_columns(con, url: str, key: str) -> None:
    have = {
        c[0]
        for c in con.execute(
            'SELECT * FROM read_parquet($url) LIMIT 0', {'url': url},
        ).description
    }
    missing = [c for c in EXPORT_COLUMNS if c not in have]
    if missing:
        sys.exit(f'{key} lacks column(s) this script reads: {", ".join(missing)}')


def load_alerts(con, args: argparse.Namespace, ticker: str) -> list[dict]:
    if args.source == 'export':
        key = export_key(args.export_end)
        url = export_url(args.export_end)
        if not object_exists(con, url):
            sys.exit(f'No export object at {key} in R2')
        check_export_columns(con, url, key)
        return fetch_export_alerts(
            con, url, ticker, args.from_date, args.to_date, args.limit_alerts,
        )
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        return fetch_alerts(
            conn, ticker, args.from_date, args.to_date, args.limit_alerts,
        )
    finally:
        conn.close()


def _iso_date(text: str) -> str:
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(f'{text!r} is not a YYYY-MM-DD date') from None


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--source',
        choices=('table', 'export'),
        default='table',
        help=(
            'Where the alerts come from: the interval_ba_alerts table (default) or the '
            "tool's full-year export in R2 (needs --export-end)."
        ),
    )
    parser.add_argument(
        '--export-end',
        type=_iso_date,
        default=None,
        help='With --source export: the --end date of the export object to read.',
    )
    parser.add_argument(
        '--ticker',
        type=str,
        default='SPXW',
        help='Alert ticker to enrich (SPXW, SPY, QQQ). Default: SPXW.',
    )
    parser.add_argument('--from-date', type=str, default=None)
    parser.add_argument('--to-date', type=str, default=None)
    parser.add_argument('--limit-alerts', type=int, default=None)
    parser.add_argument(
        '--dry-run', action='store_true', help='Skip CSV/MD writes.',
    )
    args = parser.parse_args(argv)
    if args.source == 'export' and args.export_end is None:
        parser.error('--source export needs --export-end')
    if args.source == 'table' and args.export_end is not None:
        parser.error('--export-end goes with --source export')
    return args


def median(xs: list[float]) -> float:
    if not xs:
        return float('nan')
    s = sorted(xs)
    n = len(s)
    m = n // 2
    return s[m] if n % 2 else (s[m - 1] + s[m]) / 2.0


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    ticker = args.ticker.upper()

    load_env()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    con = fulltape_connection(threads=4, memory_limit='3000MiB')
    try:
        alerts = load_alerts(con, args, ticker)
        if not alerts:
            sys.exit('No alerts matched the filter')
        return enrich(con, args, ticker, alerts)
    finally:
        con.close()


def enrich(
    con,
    args: argparse.Namespace,
    ticker: str,
    alerts: list[dict],
) -> int:
    # Group alerts by expiry date so each tape is read once.
    by_date: dict[str, list[dict]] = defaultdict(list)
    for a in alerts:
        date_iso = (
            a['expiry'].isoformat()
            if hasattr(a['expiry'], 'isoformat')
            else str(a['expiry'])[:10]
        )
        by_date[date_iso].append(a)

    stamp = datetime.now(tz=UTC).strftime('%Y%m%d-%H%M%S')
    # Back-compat: SPXW from the table writes to the original (no-ticker) filename so the
    # existing CSV history and downstream consumers (analyze_*) don't need path migration.
    # Non-SPXW tickers get a ticker slug in the filename so the auto-discovery in
    # analyze_interval_ba_cuts.py still picks up the SPXW file by default. The export's files
    # carry `-export` before the ticker slug, which both of those discoveries skip.
    slug = '' if ticker == 'SPXW' else f'-{ticker.lower()}'
    kind = '-export' if args.source == 'export' else ''
    csv_path = OUT_DIR / f'interval-ba-outcomes{kind}{slug}-{stamp}.csv'
    md_path = OUT_DIR / f'interval-ba-outcomes-summary{kind}{slug}-{stamp}.md'
    source_text = (
        f'export ({export_key(args.export_end)})'
        if args.source == 'export'
        else 'table'
    )
    print(
        f'Enriching {len(alerts)} alerts across {len(by_date)} day(s) '
        f'from the {source_text} → {csv_path.name}',
    )

    # Stream CSV rows day-by-day so memory stays bounded.
    csv_rows_written = 0
    skipped_total = 0
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

    try:
        for date_iso, day_alerts in sorted(by_date.items()):
            tape = r2_url(date_iso)
            if not object_exists(con, tape):
                print(f'  {date_iso}  SKIP: tape not in R2')
                continue
            series = load_root_spot_series(con, tape, ticker)
            if not len(series):
                print(f'  {date_iso}  SKIP: no {ticker} prints on the tape')
                continue
            eod_utc = session_close_utc(date_iso)
            fired = [as_utc(a['fired_at']) for a in day_alerts]
            t0_spots = load_t0_spots(
                con,
                tape,
                sorted(
                    {
                        (a['option_chain'], epoch_us(f))
                        for a, f in zip(day_alerts, fired, strict=True)
                    },
                ),
            )
            skipped_day = 0

            for a, fired_at in zip(day_alerts, fired, strict=True):
                sev = severity_of(float(a['total_premium']))
                t0_spot = t0_spots.get((a['option_chain'], epoch_us(fired_at)))
                entry = alert_entry(a, t0_spot)
                path = (
                    []
                    if entry is None
                    else build_forward_path(
                        series, t0_spot, fired_at, entry, eod_utc,
                    )
                )
                if not path:
                    skipped_day += 1
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
            skipped_total += skipped_day
            print(
                f'  {date_iso}  alerts={len(day_alerts):>4}  '
                f'series_prints={len(series):>8}  skipped={skipped_day}',
            )
    finally:
        if csv_file is not None:
            csv_file.close()

    if csv_file is not None:
        print(f'wrote {csv_rows_written} rows → {csv_path}')

    # Aggregate summary tables.
    md_lines = ['# Interval B/A — forward-return experiment\n']
    md_lines.append(f'_Generated {stamp} UTC. Source: {source_text}_\n')
    md_lines.append(
        f'\nReplays the {ticker} spot path in 5-min increments from each alert\'s '
        f'``fired_at`` to 15:00 CT. t=0 is the last print of the alert\'s own contract at or '
        f'before ``fired_at``; each later step is the last {ticker}-root print at or before '
        f'that many minutes after it. Entry anchor is the alert\'s own ``underlying_price``, '
        f'or the t=0 print when the row has none. Median % change across {len(alerts)} '
        f'alerts.\n',
    )
    md_lines.append('\n## Median % change by severity × option_type\n')
    md_lines.append(
        '| severity | type | n | T+5min | T+15min | T+30min | T+60min | EOD |',
    )
    md_lines.append(
        '|---|---|--:|--:|--:|--:|--:|--:|',
    )

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
    md_lines.append(
        f'\n_grand total: {grand_total} alerts with forward path; '
        f'{skipped_total} skipped ({SKIPPED_NOTE})._\n',
    )

    md_text = '\n'.join(md_lines)
    if not args.dry_run:
        md_path.write_text(md_text, encoding='utf-8')
        print(f'wrote summary → {md_path}')

    print('\n' + md_text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
