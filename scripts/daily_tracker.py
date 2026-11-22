#!/usr/bin/env python
"""Append rows of headline lottery metrics to docs/tmp/lottery-tracking.csv.

Designed to run after `make refit` + `make enrich` complete. Writes a
short row for every enriched fire date after the CSV's last row, each
computed as of its own date (the window is cut at that date), so
day-over-day drift in the edge can be charted without re-running every
analysis and a run that was missed is filled by the next one. A date
with no enriched fires gets no row. With no CSV, or one with no row whose
date parses, it writes the newest date only and never the whole history.
When no date is newer than the CSV's last row it writes the newest date
again, so re-running on the same date overwrites that date's row rather
than duplicating. One timestamp (`run_at`) marks every row of a run. When the
CSV's last row is newer than the newest enriched fire date, nothing can be
filled and the run says so.

`--rebuild` writes a row for EVERY enriched fire date, each as of its date,
and discards the rows already in the file, which afterwards holds exactly
the rebuilt rows. It is for after outcomes were re-enriched, when the
stored rows no longer match the data they were computed on. It is also the
fix after a weights promotion: that moves the active cutoffs, so rows written
before it no longer compare with rows written after it, and a rebuild puts
the whole series on one set of cutoffs. It overwrites the file it is given,
so run it on a copy.

Read-only against the DB except for its own CSV rewrite.

The T1/T2 split is the ACTIVE weights version's bare `cutoffs` (t1, t2) on the
stored score, read from the store (phase 3 D8). A weights read that fails ends
the run before any fire is read or the CSV is touched; there is no fallback.

Usage:
    ml/.venv/Scripts/python scripts/daily_tracker.py [--csv PATH] [--rebuild]

--csv is the tracking file to read and rewrite (default: the one under
docs/tmp). --rebuild recomputes the whole file (see above).
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
CSV_PATH = ROOT / 'docs' / 'tmp' / 'lottery-tracking.csv'
_CSV_DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')

sys.path.insert(0, str(ROOT / 'scripts'))
from _cli_paths import load_env_file  # noqa: E402
from _report_weights import load_active_weights  # noqa: E402

# Order of CSV columns. Adding a new column at the end is safe (existing
# rows just get a blank trailing field on read). Don't reorder.
COLUMNS = [
    'date',                  # the enriched fire date this row is as of
    'run_at',                # ISO UTC timestamp of this run
    'n_fires_today',
    'n_fires_total_window',
    'days_in_window',
    # Tier distribution
    't1_today', 't2_today', 't3_today',
    # Aggregate flow_inv stats across full window
    'flow_inv_n', 'flow_inv_mean_pct', 'flow_inv_sharpe',
    # Tier 2+ slice
    't2plus_n', 't2plus_mean_pct', 't2plus_sharpe',
    # Mode B (the structurally cleaner cohort)
    'modeB_n', 'modeB_mean_pct', 'modeB_sharpe',
    # Top-3 ticker weights — early-warning for universe drift
    'top1_ticker', 'top1_n', 'top1_rate',
    'top2_ticker', 'top2_n', 'top2_rate',
    'top3_ticker', 'top3_n', 'top3_rate',
]


def stats(s):
    s = pd.to_numeric(s, errors='coerce').dropna()
    n = len(s)
    if n < 30:
        return n, np.nan, np.nan
    mean = float(s.mean())
    std = float(s.std(ddof=1)) if n > 1 else 0.0
    sharpe = mean / std if std > 0 else 0.0
    return n, mean, sharpe


def _as_date(value) -> date:
    """A fire date as a `date`: psycopg2 gives dates, a datetime64 column Timestamps."""
    return value.date() if isinstance(value, pd.Timestamp) else value


def _csv_date(raw: str | None) -> date | None:
    """A row's `date` as a date, or None when it is blank or not YYYY-MM-DD.

    The shape is checked first: `date.fromisoformat` alone also takes 2026-W45-3.
    """
    if raw is None or not _CSV_DATE.fullmatch(raw):
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def dates_to_write(
    days: list[date], last_date: date | None, rebuild: bool = False
) -> list[date]:
    """The fire dates (ascending) that get a row this run.

    Every date after the CSV's last row; the newest date alone when there is no
    such row (a new file never gets the whole history) or no date is newer. A
    rebuild is every date.
    """
    if rebuild:
        return days
    if last_date is None:
        return days[-1:]
    return [d for d in days if d > last_date] or days[-1:]


def build_rows(
    df: pd.DataFrame,
    t1_cutoff: int,
    t2_cutoff: int,
    last_date: date | None,
    run_at: str,
    rebuild: bool = False,
) -> list[dict]:
    """One CSV row per date `dates_to_write` picks, each as of that date.

    A row's window is the fires dated on or before its date; its `*_today` fields
    are the fires dated on it. The frame is ordered by date once and every window
    is a prefix of that order, so the 1.2M fires are read a few times in all, not
    once per date.
    """
    codes, uniques = pd.factorize(df['date'], sort=True)
    days = [_as_date(u) for u in uniques]
    targets = dates_to_write(days, last_date, rebuild)

    order = np.argsort(codes, kind='stable')
    codes = codes[order]
    flow_inv = pd.to_numeric(df['flow_inv'], errors='coerce').to_numpy(dtype=float)[order]
    score = pd.to_numeric(df['score'], errors='coerce').to_numpy(dtype=float)[order]
    peak = pd.to_numeric(df['peak'], errors='coerce').to_numpy(dtype=float)[order]
    is_mode_b = (df['mode'] == 'B_multi_day_DTE1_3').to_numpy(dtype=bool)[order]

    # 0 = T1, 1 = T2, 2 = T3. A null score is not >= either cutoff, so it is T3.
    tier = np.where(score >= t1_cutoff, 0, np.where(score >= t2_cutoff, 1, 2))
    n_days = len(days)
    day_ids = np.arange(n_days)
    tier_by_day = np.bincount(codes * 3 + tier, minlength=n_days * 3).reshape(n_days, 3)

    # A cohort's fires are in date order too, so its window for day k is its first
    # `ends[k]` fires.
    def window_end(mask) -> np.ndarray:
        return np.searchsorted(codes[mask], day_ids, side='right')

    in_t2plus = tier < 2
    ends_all = np.searchsorted(codes, day_ids, side='right')
    cohorts = {
        'all': (flow_inv, ends_all),
        't2plus': (flow_inv[in_t2plus], window_end(in_t2plus)),
        'modeB': (flow_inv[is_mode_b], window_end(is_mode_b)),
    }

    def window_stats(cohort: str, k: int):
        flows, ends = cohorts[cohort]
        return stats(pd.Series(flows[: ends[k]]))

    # Per ticker and date, the running count of fires, of fires with a peak and of
    # fires with peak >= 50, so a window's ticker table is one column of each.
    ticker_codes, tickers = pd.factorize(df['ticker'], sort=True)
    ticker_codes = ticker_codes[order]
    cell = ticker_codes * n_days + codes
    size = len(tickers) * n_days

    def running(cells) -> np.ndarray:
        counts = np.bincount(cells, minlength=size).reshape(len(tickers), n_days)
        return counts.cumsum(axis=1)

    fires_by = running(cell)
    peaks_by = running(cell[~np.isnan(peak)])
    high_by = running(cell[peak >= 50])

    rows = []
    for day in targets:
        k = days.index(day)
        today = tier_by_day[k]
        n_total, fi_mean, fi_sharpe = window_stats('all', k)
        t2_n, t2_mean, t2_sharpe = window_stats('t2plus', k)
        mB_n, mB_mean, mB_sharpe = window_stats('modeB', k)

        # Top tickers by high-peak rate (n ≥ 100 to keep CIs meaningful).
        seen = fires_by[:, k] > 0
        grouped = pd.DataFrame(
            {
                'n': peaks_by[seen, k],
                'rate': high_by[seen, k] / fires_by[seen, k] * 100,
            },
            index=pd.Index(tickers[seen], name='ticker'),
        )
        eligible = grouped[grouped['n'] >= 100].sort_values('rate', ascending=False)
        top3 = list(eligible.head(3).itertuples())
        while len(top3) < 3:
            top3.append(None)

        row = {
            'date': day.isoformat(),
            'run_at': run_at,
            'n_fires_today': int(today.sum()),
            'n_fires_total_window': int(ends_all[k]),
            'days_in_window': k + 1,
            't1_today': int(today[0]),
            't2_today': int(today[1]),
            't3_today': int(today[2]),
            'flow_inv_n': int(n_total),
            'flow_inv_mean_pct': round(fi_mean, 3) if not np.isnan(fi_mean) else '',
            'flow_inv_sharpe': round(fi_sharpe, 4) if not np.isnan(fi_sharpe) else '',
            't2plus_n': int(t2_n),
            't2plus_mean_pct': round(t2_mean, 3) if not np.isnan(t2_mean) else '',
            't2plus_sharpe': round(t2_sharpe, 4) if not np.isnan(t2_sharpe) else '',
            'modeB_n': int(mB_n),
            'modeB_mean_pct': round(mB_mean, 3) if not np.isnan(mB_mean) else '',
            'modeB_sharpe': round(mB_sharpe, 4) if not np.isnan(mB_sharpe) else '',
        }
        for slot, t in enumerate(top3, start=1):
            if t is None:
                row[f'top{slot}_ticker'] = ''
                row[f'top{slot}_n'] = ''
                row[f'top{slot}_rate'] = ''
            else:
                row[f'top{slot}_ticker'] = t.Index
                row[f'top{slot}_n'] = int(t.n)
                row[f'top{slot}_rate'] = round(float(t.rate), 2)
        rows.append(row)
    return rows


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--csv',
        type=Path,
        default=CSV_PATH,
        help='The tracking CSV to update (default: docs/tmp under the repo root).',
    )
    parser.add_argument(
        '--rebuild',
        action='store_true',
        help='Write a row for every enriched fire date, each as of its date. This '
        'discards the rows already in the file, so run it on a copy.',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    load_env_file(ENV_FILE)
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)

    # The active weights' bare tier cutoffs, read before any fire is read or the
    # CSV is touched. The score distribution moves with every promoted version,
    # so a stale pair would report ~0 tier1/tier2 every night and the tracker
    # would be useless (the V1 18/12 caught by manual review 2026-05-22).
    version, weights = load_active_weights(conn, 'track')
    t1_cutoff = int(weights['cutoffs']['t1'])
    t2_cutoff = int(weights['cutoffs']['t2'])
    print(f'[track] active weights {version}: T1 score >= {t1_cutoff}, T2 >= {t2_cutoff}')

    df = pd.read_sql(
        """
        SELECT date, mode, score, peak_ceiling_pct AS peak,
               realized_flow_inversion_pct AS flow_inv,
               underlying_symbol AS ticker
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct IS NOT NULL
        """,
        conn,
    )
    if df.empty:
        sys.exit('[track] no enriched fires found — nothing to record')

    # The rows already there. A row whose date does not parse stays in the file and
    # takes no part in choosing the dates.
    existing = []
    if args.csv.exists():
        with args.csv.open(encoding='utf-8') as f:
            existing = list(csv.DictReader(f))
    csv_dates = (_csv_date(r.get('date')) for r in existing)
    last_date = max((d for d in csv_dates if d is not None), default=None)

    run_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
    new_rows = build_rows(
        df, t1_cutoff, t2_cutoff, last_date, run_at, rebuild=args.rebuild
    )

    # Idempotent: a row already there for a date being written is replaced (so
    # re-running after a partial enrichment doesn't duplicate); the new rows go
    # after the others, oldest date first. A rebuild keeps none of the old rows.
    written = {r['date'] for r in new_rows}
    kept = [] if args.rebuild else [r for r in existing if r.get('date') not in written]
    merged = [*kept, *new_rows]

    args.csv.parent.mkdir(parents=True, exist_ok=True)
    with args.csv.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction='ignore')
        w.writeheader()
        for r in merged:
            w.writerow(r)

    row = new_rows[-1]
    if args.rebuild:
        print(f'[track] rebuilt {len(new_rows)} dates '
              f'({new_rows[0]["date"]} .. {row["date"]}), replacing {len(existing)} rows')
        had_a_row = {r['date'] for r in existing if _csv_date(r.get('date')) is not None}
        dropped = had_a_row - written
        if dropped:
            print(f'[track] {len(dropped)} earlier dates have no enriched fires now '
                  'and were dropped')
    else:
        if last_date is not None and row['date'] < last_date.isoformat():
            # Nothing could be filled; the step stays ok, so its log has to say why.
            print(f"[track] CSV's last row {last_date} is newer than "
                  f'the newest enriched fire date {row["date"]}')
        if len(new_rows) > 1:
            print(f'[track] filled {len(new_rows)} dates '
                  f'({new_rows[0]["date"]} .. {row["date"]})')
    print(f'[track] {row["date"]}: '
          f'{row["n_fires_today"]:,} new fires '
          f'(T1={row["t1_today"]} T2={row["t2_today"]} T3={row["t3_today"]})')
    print(f'[track] window: {row["days_in_window"]} days, '
          f'{row["n_fires_total_window"]:,} fires, '
          f'flow_inv Sharpe={row["flow_inv_sharpe"]} '
          f'(T2+={row["t2plus_sharpe"]}, ModeB={row["modeB_sharpe"]})')
    print(f'[track] CSV → {args.csv}  ({len(merged)} rows)')


if __name__ == '__main__':
    main()
