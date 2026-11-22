#!/usr/bin/env python
"""Rewrite docs/tmp/lottery-tracking.csv: one row of headline lottery metrics per date.

Designed to run after `make refit` + `make enrich` complete. Every run
writes a row for every enriched fire date, oldest first, each computed as
of its own date (the window is cut at that date) on today's data and the
active weights, and shares one timestamp (`run_at`). A date with no
enriched fires gets no row. The rows already in the file are not kept, so
a revision of past data (outcomes re-enriched, fires added or corrected,
a weights promotion that moves the tier cutoffs) never leaves a jump
between old and new rows. The file is rewritten whole, so run it on a copy
when its old rows matter.

What a run prints of the file it replaces, from its rows whose `date` is
YYYY-MM-DD (any other row is dropped and counted nowhere):
- `rebuilt M dates (first .. last), replacing K rows`: K counts every row;
- `J earlier dates have no enriched fires now and were dropped`, when J > 0:
  dates the old file had that have no row now;
- `R of M earlier rows changed`: of the M dates in both the old file and the
  new rows, how many differ in any column but `run_at` (compared as the CSV
  holds it; a column the old file lacks reads as blank). Not printed when the
  old file has no such row. A revision of history shows here.
An old file that cannot be read as CSV (a field past the csv module's size
limit) is replaced all the same, with one line saying so and no comparison;
a BOM and bytes that are not UTF-8 are read (the bad ones as U+FFFD).

Read-only against the DB except for its own CSV rewrite.

The T1/T2 split is the ACTIVE weights version's bare `cutoffs` (t1, t2) on the
stored score, read from the store (phase 3 D8). A weights read that fails ends
the run before any fire is read or the CSV is touched; there is no fallback.

Usage:
    ml/.venv/Scripts/python scripts/daily_tracker.py [--csv PATH]

--csv is the tracking file to rewrite (default: the one under docs/tmp).
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


def _read_rows(path: Path) -> list[dict[str, str]]:
    # The way the nightly step reads the state (utf-8-sig, bad bytes replaced), so a
    # file it takes for healthy is one this reads; newline='' is what csv asks for.
    with path.open(newline='', encoding='utf-8-sig', errors='replace') as f:
        return list(csv.DictReader(f))


def _differs(old: dict[str, str], new: dict[str, str]) -> bool:
    """Whether two rows differ in a column other than `run_at`.

    A column the old row lacks (a shorter header) reads as blank, and a column of
    the old row that is no longer in COLUMNS is not looked at.
    """
    return any(
        (old.get(c) or '') != (new.get(c) or '') for c in COLUMNS if c != 'run_at'
    )


def build_rows(
    df: pd.DataFrame, t1_cutoff: int, t2_cutoff: int, run_at: str
) -> list[dict]:
    """One CSV row per enriched fire date, ascending, each as of that date.

    A row's window is the fires dated on or before its date; its `*_today` fields
    are the fires dated on it. The frame is ordered by date once and every window
    is a prefix of that order, so the 1.2M fires are read a few times in all, not
    once per date.
    """
    codes, uniques = pd.factorize(df['date'], sort=True)
    days = [_as_date(u) for u in uniques]

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
    for k, day in enumerate(days):
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
        help='The tracking CSV to rewrite (default: docs/tmp under the repo root).',
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

    # The rows already there, read only to report what this run changes. The file is
    # written whole from the fires, so none of them is kept.
    existing: list[dict[str, str]] = []
    if args.csv.exists():
        try:
            existing = _read_rows(args.csv)
        except csv.Error:
            # Nothing in it feeds the new file, and failing here would leave the
            # step red every night; the previous night's snapshot and git keep it.
            print('[track] the earlier file could not be read as CSV: '
                  'nothing to compare')

    run_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
    new_rows = build_rows(df, t1_cutoff, t2_cutoff, run_at)

    args.csv.parent.mkdir(parents=True, exist_ok=True)
    with args.csv.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction='ignore')
        w.writeheader()
        for r in new_rows:
            w.writerow(r)

    row = new_rows[-1]
    print(f'[track] rebuilt {len(new_rows)} dates '
          f'({new_rows[0]["date"]} .. {row["date"]}), replacing {len(existing)} rows')
    # Only a row whose date is YYYY-MM-DD is a date of the old file. If two rows hold
    # the same date, the later one is the old file's row for it.
    old_by_date = {
        r['date']: r for r in existing if _csv_date(r.get('date')) is not None
    }
    written = {r['date'] for r in new_rows}
    dropped = old_by_date.keys() - written
    if dropped:
        print(f'[track] {len(dropped)} earlier dates have no enriched fires now '
              'and were dropped')
    if old_by_date:
        # Compared as the file holds them, so read back what was just written.
        held = {r['date']: r for r in _read_rows(args.csv)}
        both = old_by_date.keys() & held.keys()
        changed = sum(1 for d in both if _differs(old_by_date[d], held[d]))
        print(f'[track] {changed} of {len(both)} earlier rows changed')
    print(f'[track] {row["date"]}: '
          f'{row["n_fires_today"]:,} new fires '
          f'(T1={row["t1_today"]} T2={row["t2_today"]} T3={row["t3_today"]})')
    print(f'[track] window: {row["days_in_window"]} days, '
          f'{row["n_fires_total_window"]:,} fires, '
          f'flow_inv Sharpe={row["flow_inv_sharpe"]} '
          f'(T2+={row["t2plus_sharpe"]}, ModeB={row["modeB_sharpe"]})')
    print(f'[track] CSV → {args.csv}  ({len(new_rows)} rows)')


if __name__ == '__main__':
    main()
