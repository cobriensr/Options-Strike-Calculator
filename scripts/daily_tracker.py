#!/usr/bin/env python
"""Append one row of headline lottery metrics to docs/tmp/lottery-tracking.csv.

Designed to run after `make refit` + `make enrich` complete. Produces a
short row per (most-recent fire date) so day-over-day drift in the
edge can be charted without re-running every analysis. Idempotent —
re-running on the same date overwrites that date's row rather than
duplicating.

Read-only against the DB except for its own CSV append.

Usage:
    ml/.venv/bin/python scripts/daily_tracker.py
"""

from __future__ import annotations

import csv
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
CSV_PATH = ROOT / 'docs' / 'tmp' / 'lottery-tracking.csv'

# Order of CSV columns. Adding a new column at the end is safe (existing
# rows just get a blank trailing field on read). Don't reorder.
COLUMNS = [
    'date',                  # latest enriched fire date
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


def load_env() -> None:
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def stats(s):
    s = pd.to_numeric(s, errors='coerce').dropna()
    n = len(s)
    if n < 30:
        return n, np.nan, np.nan
    mean = float(s.mean())
    std = float(s.std(ddof=1)) if n > 1 else 0.0
    sharpe = mean / std if std > 0 else 0.0
    return n, mean, sharpe


def main() -> None:
    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)

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

    latest = df['date'].max()
    latest_iso = (
        latest.isoformat() if hasattr(latest, 'isoformat') else str(latest)[:10]
    )
    today_df = df[df['date'] == latest]

    # Load V2 tier cutoffs from the weights JSON instead of hardcoding the
    # legacy V1 thresholds (18/12). The V2 score distribution maxes out
    # around 17, so V1 cutoffs would report ~0 tier1/tier2 every night and
    # the tracker would be useless (caught by manual review 2026-05-22).
    weights_path = ROOT / 'ml' / 'output' / 'lottery_score_weights.json'
    if not weights_path.exists():
        sys.exit(
            f'[track] weights JSON not found at {weights_path} — '
            f'run `make refit` first (or set LOTTERY_REFIT=1)'
        )
    import json as _json  # local: keep top-of-file imports stable
    weights = _json.loads(weights_path.read_text())
    t1_cutoff = int(weights['cutoffs']['t1'])
    t2_cutoff = int(weights['cutoffs']['t2'])

    def _classify(s):
        if not pd.notna(s):
            return 'T3'
        if s >= t1_cutoff:
            return 'T1'
        if s >= t2_cutoff:
            return 'T2'
        return 'T3'

    df['tier'] = df['score'].apply(_classify)
    today_df = today_df.copy()
    today_df['tier'] = today_df['score'].apply(_classify)

    n_total, fi_mean, fi_sharpe = stats(df['flow_inv'])
    t2plus = df[df['tier'].isin(['T1', 'T2'])]
    t2_n, t2_mean, t2_sharpe = stats(t2plus['flow_inv'])
    modeB = df[df['mode'] == 'B_multi_day_DTE1_3']
    mB_n, mB_mean, mB_sharpe = stats(modeB['flow_inv'])

    # Top tickers by high-peak rate (n ≥ 100 to keep CIs meaningful).
    grouped = df.groupby('ticker').agg(
        n=('peak', 'count'),
        rate=('peak', lambda s: (s >= 50).mean() * 100),
    )
    eligible = grouped[grouped['n'] >= 100].sort_values('rate', ascending=False)
    top3 = list(eligible.head(3).itertuples())
    while len(top3) < 3:
        top3.append(None)

    row = {
        'date': latest_iso,
        'run_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'n_fires_today': int(len(today_df)),
        'n_fires_total_window': int(len(df)),
        'days_in_window': int(df['date'].nunique()),
        't1_today': int((today_df['tier'] == 'T1').sum()),
        't2_today': int((today_df['tier'] == 'T2').sum()),
        't3_today': int((today_df['tier'] == 'T3').sum()),
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

    # Idempotent append: if a row already exists for this date, replace
    # it (so re-running after a partial enrichment doesn't duplicate).
    existing = []
    if CSV_PATH.exists():
        with CSV_PATH.open() as f:
            existing = list(csv.DictReader(f))
    existing = [r for r in existing if r.get('date') != latest_iso]
    existing.append(row)

    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CSV_PATH.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction='ignore')
        w.writeheader()
        for r in existing:
            w.writerow(r)

    print(f'[track] {latest_iso}: '
          f'{row["n_fires_today"]:,} new fires '
          f'(T1={row["t1_today"]} T2={row["t2_today"]} T3={row["t3_today"]})')
    print(f'[track] window: {row["days_in_window"]} days, '
          f'{row["n_fires_total_window"]:,} fires, '
          f'flow_inv Sharpe={row["flow_inv_sharpe"]} '
          f'(T2+={row["t2plus_sharpe"]}, ModeB={row["modeB_sharpe"]})')
    print(f'[track] CSV → {CSV_PATH}  ({len(existing)} rows)')


if __name__ == '__main__':
    main()
