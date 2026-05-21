#!/usr/bin/env python3
"""Pre-day filter validation — THE REAL TRADABLE EDGE.

Apply (prior_5d_ret < -1% AND prior_iv_rank > 25) as a HARD GATE on
the composite framework. Both conditions are knowable at PRIOR DAY's
close (forward-safe).

FINDING: filter-ON subset walks forward cleanly.
  H1 (early filter-on days): Δ +12.15/trade p=0.005
  H2 (later filter-on days): Δ +7.75/trade p=0.010
  Both highly significant. Filter ON gets +9.93/trade vs +3.45 on
  filter-off days.

This validates the strategy as a CONDITIONAL system: only trade when
the pre-day filter fires. ~26% of days = ~5/month when active.
"""

import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

load_dotenv('.env.local')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']
OUT = Path('docs/tmp/forensic-multi-day')
LEDGER = OUT / 'aggregate_framework_trades_tagged.csv'
MD_PATH = OUT / 'preday_filter_validation_findings.md'

FILTER_RET_5D = -0.01    # prior_5d < -1.0%
FILTER_IV_RANK = 25.0    # prior_iv_rank > 25


def stats_for(label, df):
    d = df.dropna(subset=['ret_30m', 'control_ret_30m'])
    if len(d) < 5:
        return f'{label:<24} n={len(d)} sparse', None
    delta = d['ret_30m'] - d['control_ret_30m']
    t, p = stats.ttest_1samp(delta, 0)
    win = (delta > 0).mean()
    return (f'{label:<24} n={len(d):3d} Δ={delta.mean():+.2f} '
            f'win={win:.1%} p={p:.4f} total_Δ={delta.sum():+.1f}',
            {'n': len(d), 'mean_delta': delta.mean(), 'win': win,
             'p': p, 'total': delta.sum()})


def main():
    ledger = pd.read_csv(LEDGER, parse_dates=['anchor_ts'])
    ledger['event_date'] = pd.to_datetime(ledger['anchor_ts']).dt.date

    conn = psycopg2.connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT date, iv_30d, rv_30d, iv_rank FROM vol_realized "
            "ORDER BY date")
        cols = [d[0] for d in cur.description]
        vol = pd.DataFrame(cur.fetchall(), columns=cols)
        for c in ('iv_30d', 'rv_30d', 'iv_rank'):
            vol[c] = vol[c].astype(float)

        cur.execute("""
            SELECT date,
                   (array_agg(close ORDER BY timestamp DESC))[1] AS day_close
            FROM index_candles_1m
            WHERE symbol='SPX' AND market_time='r'
            GROUP BY date ORDER BY date
        """)
        cols = [d[0] for d in cur.description]
        day_close = pd.DataFrame(cur.fetchall(), columns=cols)
    conn.close()
    day_close['day_close'] = day_close['day_close'].astype(float)
    day_close['ret_5d'] = day_close['day_close'].pct_change(5)

    pre_day = vol.merge(day_close[['date', 'ret_5d']], on='date',
                         how='left').sort_values('date').reset_index(drop=True)
    pre_day['prior_iv_rank'] = pre_day['iv_rank'].shift(1)
    pre_day['prior_ret_5d'] = pre_day['ret_5d'].shift(1)
    pre_day['fwd_filter_fires'] = (
        (pre_day['prior_ret_5d'] < FILTER_RET_5D)
        & (pre_day['prior_iv_rank'] > FILTER_IV_RANK)
    )

    ledger_v = ledger.merge(
        pre_day[['date', 'fwd_filter_fires', 'prior_ret_5d',
                 'prior_iv_rank']],
        left_on='event_date', right_on='date', how='left')

    lines = []
    lines.append('# Pre-Day Filter Validation\n\n')
    lines.append(f'Filter: `prior_5d_return < {FILTER_RET_5D:.0%}` AND '
                 f'`prior_iv_rank > {FILTER_IV_RANK}` — both knowable at '
                 'PRIOR day\'s close, fully forward-safe.\n\n')

    on = ledger_v[ledger_v['fwd_filter_fires'] == True]
    off = ledger_v[ledger_v['fwd_filter_fires'] == False]
    days_on = on['event_date'].nunique()
    days_off = off['event_date'].nunique()
    lines.append(f'**Coverage:** {days_on}/{days_on + days_off} days '
                 f'({days_on / max(1, days_on + days_off):.1%}) fire the '
                 f'filter, capturing {len(on)} trades.\n\n')

    lines.append('## Aggregate edge\n\n')
    on_line, _ = stats_for('FILTER ON', on)
    off_line, _ = stats_for('FILTER OFF', off)
    lines.append(f'```\n{on_line}\n{off_line}\n```\n\n')
    print('=== Aggregate ===')
    print(' ', on_line)
    print(' ', off_line)

    lines.append('## By trade type (FILTER ON only)\n\n')
    print('\n=== By trade type, FILTER ON ===')
    for tt in on['trade_type'].unique():
        sub = on[on['trade_type'] == tt]
        line, _ = stats_for(tt, sub)
        lines.append(f'- {line}\n')
        print(' ', line)
    lines.append('\n')

    on_sorted = on.sort_values('anchor_ts').reset_index(drop=True)
    sp = len(on_sorted) // 2
    lines.append('## Walk-forward (FILTER ON subset)\n\n')
    print('\n=== Walk-forward FILTER ON ===')
    for label, half in (('H1', on_sorted.iloc[:sp]),
                        ('H2', on_sorted.iloc[sp:]),
                        ('FULL', on_sorted)):
        line, _ = stats_for(label, half)
        lines.append(f'- {line}\n')
        print(' ', line)
    lines.append('\n')

    # Day-by-day rollup
    on_d = on.copy()
    on_d['delta'] = on_d['ret_30m'] - on_d['control_ret_30m']
    daily = on_d.groupby('event_date').agg(
        n=('delta', 'count'),
        total_delta=('delta', 'sum'),
        mean_delta=('delta', 'mean'),
    ).round(2)
    lines.append('## Day-level rollup (FILTER ON only)\n\n')
    lines.append('```\n' + daily.to_string() + '\n```\n\n')

    # Per-DOW within filter
    on_d['dow'] = pd.to_datetime(on_d['anchor_ts']).dt.day_name()
    lines.append('## Per-DOW within FILTER ON\n\n')
    print('\n=== Per-DOW FILTER ON ===')
    for dow in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'):
        sub = on_d[on_d['dow'] == dow]
        if len(sub) < 5:
            continue
        line, _ = stats_for(dow, sub)
        lines.append(f'- {line}\n')
        print(' ', line)
    lines.append('\n')

    MD_PATH.write_text(''.join(lines))
    print(f'\nFull findings → {MD_PATH}')


if __name__ == '__main__':
    main()
