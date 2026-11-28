#!/usr/bin/env python
"""Compute forward spot paths for Interval B/A alerts, from the Full Tape in R2.

For each alert this walks 5-min steps from the alert's own ``fired_at`` to the session's close
(15:00 CT, or 12:00 CT on an early-close day) and records the underlying's spot at each step,
plus the percent change from the alert's entry anchor.

METHODOLOGY CHANGE (2026-11-26, interval-ba-rebuild spec 6.8). Paths from this version do not
compare with CSVs written by the one before it. The two analysis reports built on them open with
a banner naming each change, (a) to (e), and the three scripts' headers say the same:

  - (a) t=0 is the last print of the root with a valid spot at or before ``fired_at``, compared
    in epoch microseconds. It used to be the last print of the minute containing ``fired_at``,
    which can sit up to 59 s after the alert.
  - (b) Every later step sits exactly 5*k minutes after ``fired_at`` and takes the root's last
    print with a valid spot at or before that instant. They used to sit 5*k minutes after the
    alert's minute and take that minute's last print, so a path could start up to 59 s late and
    measure up to 59 s more than its horizon. t=0 and the steps share one basis, the root's
    prints (any contract of the root carries the underlying's spot).
  - (c) The default source is the replay day files (below), not the table.
  - (d) Confluence looks backward only, and a partner at the same instant counts. That is
    analyze_confluence_vs_solo.py's.
  - (e) A half day's path ends at its early close, 13:00 ET (12:00 CT), on the days of
    EARLY_CLOSE_DATES, loaded by path from uw-stream/src/market_calendar.py (standard library
    only; its parity test pins it to src/data/marketHours.ts). It ran to 15:00 CT before, three
    hours of a flat spot after the last print.

Also changed:
  - Prints are picked by their OCC root (``option_chain_id`` less its last 15 characters), not
    by ``underlying_symbol``: the websocket labels SPXW prints SPX.
  - The entry is the row's own ``underlying_price`` when it is finite and above zero, else the
    t=0 spot. A row with no usable ``underlying_price`` (a live SPXW row before the nightly
    heal) is skipped only when it has neither. The query used to drop every NULL one.
  - An alert fired after the close has no path: it is counted apart from the rows skipped for
    want of a spot, in the per-day lines and the summary.

Sources (``--source``; _interval_ba_days.py holds what the three readers share):
  days    the replay day files in R2, research/interval-ba/replay/<date>.parquet, one per session,
          which the nightly interval-ba-tape step writes each morning: one rule all year and no
          gaps. This is the default. A run checks the days it needs, the NYSE trading days of
          ``--from-date`` to ``--to-date`` (by default 2026-01-02 through the newest landed
          tape), and repairs a missing or stale one before it refuses, by the tool's per-day
          writer. ``--dry-run`` writes nothing and lists the days a repair would write, exiting
          non-zero when there are any. The files are named interval-ba-outcomes-days-*.
  export  the one-time snapshot in R2, research/interval-ba/replay-<end>.parquet, written by
          scripts/interval_ba_tape.py. ``--export-end`` names one (given alone it means this
          source); without it the newest in R2 is taken (a wildcard list of the prefix) and its
          key is printed. Neither source has table ids, so ``alert_id`` is
          "<option_chain>@<bucket_start in epoch seconds>", the table's unique key, and the
          snapshot's files are named interval-ba-outcomes-export-*.
  table   interval_ba_alerts in Neon, read only: the live record, plus what the nightly tape
          step added to it. It has the live feed's gaps (live rows stay the record, and missed
          alerts are added only from 2026-10-29), so a study of the whole year reads the days.
analyze_interval_ba_cuts.py and analyze_confluence_vs_solo.py read the same three sources,
through the module they share with this one, and take the outcomes CSV that matches their
source.

Data source for the tape: fulltape/{date}-fulltape.parquet in R2 (the R2_* variables, from
.env.local), through ml/src/utils/r2.py. DuckDB reads only the columns it needs. Each print
carries the underlying's ``underlying_price``, so the last one per instant gives a spot series
for the whole day, with no dependence on the ``index_candles_1m`` table.

Outputs (under docs/tmp/, per project memory feedback_scratch_files_in_docs_tmp):
  - interval-ba-outcomes[-days|-export][-<ticker>]-{stamp}.csv: one row per (alert, t_minutes)
  - interval-ba-outcomes-summary[-days|-export][-<ticker>]-{stamp}.md: aggregate tables
Each is written under a ``.partial`` name and renamed when the run finishes, so a run that
dies leaves nothing the analyze_* scripts' ``*.csv`` discovery can pick up. So does a run that
reads no day's tape at all (every day missing from R2 or without prints of the root, as a wrong
bucket or endpoint gives): it exits non-zero. Some days read and some skipped exits 0.

Prints a final summary to stdout: median forward % returns at T+5/15/30/60
+ EOD, split by severity and option_type.

Usage:
    ml/.venv/Scripts/python scripts/enrich_interval_ba_outcomes.py \\
        [--source days|export|table] [--export-end 2026-11-25] \\
        [--from-date 2026-01-02] [--to-date 2026-05-11] \\
        [--limit-alerts N] [--dry-run]
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import math
import os
import re
import sys
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# The day files, the --source flags and the CSV names live in the module the three readers
# share. Run as a script, scripts/ is on sys.path.
import _interval_ba_days as days
import duckdb
import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
OUT_DIR = ROOT / 'docs' / 'tmp'
# The early-close days live in uw-stream's calendar, which is standard library only and is held
# to src/data/marketHours.ts by a parity test. Loaded by path, and nothing else is taken from
# uw-stream. A change to it reruns the scripts tests (the ml job's paths filter in ci.yml).
MARKET_CALENDAR_PATH = ROOT / 'uw-stream' / 'src' / 'market_calendar.py'

# ml/src holds utils.r2, the tape over httpfs.
_ML_SRC = str(ROOT / 'ml' / 'src')
if _ML_SRC not in sys.path:
    sys.path.insert(0, _ML_SRC)

from utils.r2 import fulltape_connection, r2_url  # noqa: E402


def _load_early_closes() -> Mapping[str, int]:
    """EARLY_CLOSE_DATES from uw-stream's market calendar: ISO date to the close hour in ET."""
    spec = importlib.util.spec_from_file_location('uw_stream_market_calendar', MARKET_CALENDAR_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load {MARKET_CALENDAR_PATH}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.EARLY_CLOSE_DATES


EARLY_CLOSE_DATES = _load_early_closes()

INTERVAL_MIN = 5  # 5-min cadence
SESSION_END_CT = time(15, 0)  # 15:00 CT regular-session close
_CT = ZoneInfo('America/Chicago')
_ET = ZoneInfo('America/New_York')
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_US = timedelta(microseconds=1)
_MINUTE_US = 60 * 1_000_000

# Severity cuts must match api/interval-ba-feed.ts deriveSeverity().
EXTREME_THRESHOLD = 1_000_000
CRITICAL_THRESHOLD = 500_000

# An OCC symbol is its root, then yymmdd, C or P, and eight strike digits.
OCC_SUFFIX_LEN = 15

# The tool's snapshot export (scripts/interval_ba_tape.py, spec 6.5): one object per --end date,
# in the tape's bucket. test_export_columns_match_the_replay_module holds the key prefix to the
# tool's, and the columns the scripts read (days.ALERT_COLUMNS) to the replay module's.
EXPORT_PREFIX = 'research/interval-ba/'

SKIPPED_NOTE = 'no spot in the row or on the tape'
AFTER_CLOSE_NOTE = 'fired after the close, no path'


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
    """The session's close as a tz-aware UTC datetime: 15:00 CT, or on an early-close day (the
    day before Independence Day, the Friday after Thanksgiving, Christmas Eve) 13:00 ET, which
    is 12:00 CT."""
    y, m, d = (int(x) for x in date_iso.split('-'))
    early_hour_et = EARLY_CLOSE_DATES.get(date_iso)
    if early_hour_et is not None:
        return datetime(y, m, d, early_hour_et, tzinfo=_ET).astimezone(UTC)
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

# Prints of one OCC root, whatever their underlying_symbol label, in time order. The LIKE term
# is a prefix pre-filter that DuckDB turns into a range filter on the scan (it shows as
# `option_chain_id>='SPXW'` in EXPLAIN); the exact `left()` match after it is what picks the
# root, because the prefix alone would also take SPXWS or SPYG.
_ROOT_SERIES_SQL = f"""
SELECT us, spot FROM (
    SELECT
        epoch_us(executed_at) AS us,
        file_row_number AS frn,
        CAST(underlying_price AS DOUBLE) AS spot
    FROM read_parquet($tape, file_row_number = true)
    WHERE option_chain_id LIKE $like AND {_ROOT_SQL} = $root AND {_NOT_CANCELED}
)
WHERE isfinite(spot) AND spot > 0
ORDER BY us, frn
"""


def object_exists(con, url: str) -> bool:
    """True when the parquet is there, probed with a read of its footer.

    Only a 404 means missing: DuckDB raises HTTPException ("HTTP 404 Not Found") for an absent
    s3:// key and IOException ("No files found") for an absent local path. Anything else
    raises, so a 403 stays a loud credentials failure and a corrupt file a loud read failure,
    never a skipped day. glob() cannot do this job: DuckDB answers 1 for any single s3:// key
    without asking the bucket.
    """
    try:
        con.execute('SELECT 1 FROM read_parquet($url) LIMIT 0', {'url': url})
    except duckdb.HTTPException as exc:
        if 'HTTP 404' in str(exc):
            return False
        raise
    except duckdb.IOException as exc:
        if 'No files found' in str(exc):
            return False
        raise
    return True


def load_root_spot_series(con, tape: str, root: str) -> SpotSeries:
    """Every print of one OCC root on the tape, canceled ones and prints with no usable
    underlying price left out."""
    params = {'tape': tape, 'root': root, 'like': f'{root}%'}
    cols = con.execute(_ROOT_SERIES_SQL, params).fetchnumpy()
    return SpotSeries(np.asarray(cols['us']), np.asarray(cols['spot']))


def build_forward_path(
    series: SpotSeries,
    fired_at: datetime,
    entry_price: float,
    eod_utc: datetime,
) -> list[tuple[int, datetime, float, float]]:
    """Return [(t_minutes, ts_utc, spot, pct_change), ...].

    `fired_at` is aware UTC. Step k sits exactly k*INTERVAL_MIN minutes after it, up to and
    including the close; t=0 is `fired_at` itself. Each step's spot is the root's last print
    with a valid spot at or before its instant, so t=0 is the last print at or before the
    alert. A step with no print is left out.
    """
    fired_us = epoch_us(fired_at)
    eod_us = epoch_us(eod_utc)
    out: list[tuple[int, datetime, float, float]] = []
    t_min = 0
    while fired_us + t_min * _MINUTE_US <= eod_us:
        spot = series.at_or_before(fired_us + t_min * _MINUTE_US)
        if spot is not None:
            pct = (spot - entry_price) / entry_price * 100.0
            out.append((t_min, fired_at + timedelta(minutes=t_min), spot, pct))
        t_min += INTERVAL_MIN
    return out


def alert_entry(alert: dict, series: SpotSeries, fired_us: int) -> float | None:
    """The row's own spot when it is finite and above zero, else the tape's t=0 spot.

    A NULL, NaN, zero or negative `underlying_price` counts as missing. None when the tape has
    no print at or before the alert either.
    """
    own = alert['underlying_price']
    if own is not None:
        entry = float(own)
        if math.isfinite(entry) and entry > 0:
            return entry
    return series.at_or_before(fired_us)


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
        'top_trade_is_sweep, top_trade_is_floor '
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


_EXPORT_NAME = re.compile(r'replay-(\d{4}-\d{2}-\d{2})\.parquet$')


def newest_export_end(con) -> str:
    """The end date of the newest replay object in R2, by a wildcard list of the prefix.

    glob() of one s3:// key never asks the bucket, but a pattern with a `*` issues a LIST, so
    `replay-*.parquet` finds every export. Names that do not end in a date are left out. Exits
    when the prefix holds no replay object. Needs list permission on the R2 token.
    """
    pattern = export_url('*')
    rows = con.execute('SELECT file FROM glob($pattern)', {'pattern': pattern}).fetchall()
    ends = [m[1] for (name,) in rows if (m := _EXPORT_NAME.search(name))]
    if not ends:
        sys.exit(f'No replay object under {EXPORT_PREFIX} in R2 (replay-<date>.parquet)')
    return max(ends)


def resolve_export_end(con, export_end: str | None) -> str:
    """`--export-end` as given, else the newest replay object's date. Prints the chosen key."""
    end = export_end or newest_export_end(con)
    print(f'Export: {export_key(end)}' + ('' if export_end else ' (the newest)'))
    return end


def read_export_alerts(
    con,
    end: str,
    ticker: str | None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit_alerts: int | None = None,
) -> list[dict]:
    """The one reader of the replay snapshot, for this script and the two analyze_* scripts.

    Exits, naming the key, when the object is not in R2, and names any column the scripts read
    that it lacks. `ticker` None takes every ticker.
    """
    key = export_key(end)
    url = export_url(end)
    if not object_exists(con, url):
        sys.exit(f'No export object at {key} in R2')
    days.check_columns(con, url, key)
    return days.fetch_alerts(con, url, ticker, from_date, to_date, limit_alerts)


def open_connection():
    """DuckDB over the R2 tape, at the limits the nightly tool uses (a shared box)."""
    return fulltape_connection(threads=4, memory_limit='3000MiB')


def load_alerts(
    con, args: argparse.Namespace, ticker: str, files: days.DayFiles | None
) -> list[dict]:
    if files is not None:
        return days.read_day_alerts(
            con, files, ticker, args.from_date, args.to_date, args.limit_alerts,
        )
    if args.source == days.EXPORT:
        return read_export_alerts(
            con, args.export_end, ticker, args.from_date, args.to_date, args.limit_alerts,
        )
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        return fetch_alerts(
            conn, ticker, args.from_date, args.to_date, args.limit_alerts,
        )
    finally:
        conn.close()


def require_joined(joined: int, alerts: int, paths: int, csv_name: str, source: str) -> None:
    """Exit when no alert joined a path, with no exceptions.

    The two analyze_* scripts join the alerts of `source` to the paths of an outcomes CSV by
    alert_id. An empty join (a CSV of another run, one with no rows, no alert of the ticker)
    would give empty tables and exit 0, and an analysis of zero alerts is never what a run
    meant."""
    if not joined:
        sys.exit(
            f'No alert joined a path: {alerts} alerts from the {source} source and {paths} paths '
            f'in {csv_name}. Check --csv against --source ({source}), and --ticker.',
        )


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    days.add_source_arguments(parser)
    parser.add_argument(
        '--ticker',
        type=str,
        default='SPXW',
        help='Alert ticker to enrich (SPXW, SPY, QQQ). Default: SPXW.',
    )
    parser.add_argument(
        '--from-date',
        type=days.iso_date,
        default=None,
        help='First session date. With the day files: default 2026-01-02.',
    )
    parser.add_argument(
        '--to-date',
        type=days.iso_date,
        default=None,
        help='Last session date. With the day files: default the newest landed tape.',
    )
    parser.add_argument('--limit-alerts', type=int, default=None)
    args = parser.parse_args(argv)
    days.check_source_arguments(parser, args)
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

    con = open_connection()
    try:
        files = None
        if args.source == days.DAYS:
            # The days of the range are checked, and a missing or stale one repaired, first.
            files = days.ensure_day_files(
                con,
                date.fromisoformat(args.from_date) if args.from_date else None,
                date.fromisoformat(args.to_date) if args.to_date else None,
                dry_run=args.dry_run,
            )
        elif args.source == days.EXPORT:
            args.export_end = resolve_export_end(con, args.export_end)
        alerts = load_alerts(con, args, ticker, files)
        if not alerts:
            sys.exit('No alerts matched the filter')
        return enrich(con, args, ticker, alerts, files)
    finally:
        con.close()


def enrich(
    con,
    args: argparse.Namespace,
    ticker: str,
    alerts: list[dict],
    files: days.DayFiles | None,
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
    # The names are days.outcomes_prefix's: the analyze_* scripts find the CSV by them. The
    # summary's carry `-days` or `-export` and the ticker slug the same way.
    kind = days.kind_of(args.source)
    slug = '' if ticker == 'SPXW' else f'-{ticker.lower()}'
    csv_path = OUT_DIR / f'{days.outcomes_prefix(ticker, args.source)}{stamp}.csv'
    md_path = OUT_DIR / f'interval-ba-outcomes-summary{kind}{slug}-{stamp}.md'
    # Both are written under a .partial name and renamed once the run is through, so a run
    # that dies leaves no file the analyze_* scripts' `*.csv` discovery could take for the
    # newest.
    csv_partial = csv_path.with_name(csv_path.name + '.partial')
    md_partial = md_path.with_name(md_path.name + '.partial')
    if files is not None:
        source_header = files.describe()
        source_text = 'day files'
    elif args.source == days.EXPORT:
        source_header = source_text = f'export ({export_key(args.export_end)})'
    else:
        source_header = source_text = 'table'
    print(
        f'Enriching {len(alerts)} alerts across {len(by_date)} day(s) '
        f'from the {source_text} → {csv_path.name}',
    )

    # Stream CSV rows day-by-day so memory stays bounded.
    csv_rows_written = 0
    skipped_total = 0
    after_close_total = 0
    # In-memory rollup for the summary tables — keyed by (severity, option_type).
    forward_pcts: dict[tuple[str, str, int], list[float]] = defaultdict(list)
    eod_pcts: dict[tuple[str, str], list[float]] = defaultdict(list)
    horizons_min = (5, 15, 30, 60)

    csv_file = (
        None
        if args.dry_run
        else csv_partial.open('w', newline='', encoding='utf-8')
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

    days_read = 0
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
            days_read += 1
            eod_utc = session_close_utc(date_iso)
            eod_us = epoch_us(eod_utc)
            skipped_day = 0
            after_close_day = 0

            for a in day_alerts:
                sev = severity_of(float(a['total_premium']))
                fired_at = as_utc(a['fired_at'])
                fired_us = epoch_us(fired_at)
                if fired_us > eod_us:
                    # SPY and QQQ options trade to 15:15 CT: nothing to walk forward.
                    after_close_day += 1
                    continue
                entry = alert_entry(a, series, fired_us)
                path = (
                    []
                    if entry is None
                    else build_forward_path(series, fired_at, entry, eod_utc)
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
            after_close_total += after_close_day
            print(
                f'  {date_iso}  alerts={len(day_alerts):>4}  '
                f'series_prints={len(series):>8}  skipped={skipped_day}  '
                f'after_close={after_close_day}',
            )
    finally:
        if csv_file is not None:
            csv_file.close()

    if not days_read:
        # A 404 also answers a wrong bucket or endpoint, so a run whose every day was skipped
        # would otherwise exit 0 with an empty CSV that looks valid. The .partial files stay.
        sys.exit(
            f'No day read: all {len(by_date)} day(s) were skipped (tape not in R2, or no '
            f'{ticker} prints on it). Check R2_BUCKET_FULLTAPE and R2_ENDPOINT_URL.',
        )

    # Aggregate summary tables.
    md_lines = ['# Interval B/A — forward-return experiment\n']
    md_lines.append(f'_Generated {stamp} UTC. Source: {source_header}_\n')
    md_lines.append(
        f'\nReplays the {ticker} spot path in 5-min increments from each alert\'s '
        f'``fired_at`` to the close (15:00 CT, 12:00 CT on an early-close day). Each step is '
        f'the last {ticker}-root print at or before '
        f'that many minutes after ``fired_at`` (t=0: at or before ``fired_at``). Entry '
        f'anchor is the alert\'s own ``underlying_price`` when it is finite and above zero, '
        f'else the t=0 print. Median % change across {len(alerts)} alerts.\n',
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
        f'{skipped_total} skipped ({SKIPPED_NOTE}); '
        f'{after_close_total} {AFTER_CLOSE_NOTE}._\n',
    )

    md_text = '\n'.join(md_lines)
    if not args.dry_run:
        # Both files are complete: take the .partial off both.
        md_partial.write_text(md_text, encoding='utf-8')
        csv_partial.replace(csv_path)
        md_partial.replace(md_path)
        print(f'wrote {csv_rows_written} rows → {csv_path}')
        print(f'wrote summary → {md_path}')

    print('\n' + md_text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
