#!/usr/bin/env python3
"""Segment down-wick gamma-node rejection events by day-level vol regime.

Uses `vol_realized.iv_30d` from the DB (30-day ATM implied vol, VIX-
equivalent, sourced from UW). Full coverage Feb 23 → May 20 over the
event sample window.

For each event, attach the EVENT-DAY's iv_30d. Bucket events into IV
quartiles. Test if the Q1+Q2 (small gamma wall) pocket edge is
conditional on elevated vol — that would explain the H1/H2 regime
split (Feb-Mar may have been higher-vol than Apr-May).

Output: docs/tmp/forensic-multi-day/segment_vol_regime_findings.md
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
CSV_PATH = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'segment_vol_regime_findings.md'


def query_df(conn, sql):
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def load_day_vol(conn):
    """Day-level vol regime: iv_30d (VIX-equivalent) + rv_30d + iv_rank."""
    q = """
        SELECT date, iv_30d, rv_30d, iv_rv_spread, iv_rank
        FROM vol_realized
        ORDER BY date
    """
    df = query_df(conn, q)
    for c in ('iv_30d', 'rv_30d', 'iv_rv_spread', 'iv_rank'):
        df[c] = df[c].astype(float)
    return df.set_index('date')


def report(label, sub):
    paired = sub[['ret_30m', 'control_ret_30m']].dropna()
    n = len(paired)
    if n < 5:
        return {'label': label, 'n': n, 'event': np.nan, 'control': np.nan,
                'delta': np.nan, 't': np.nan, 'p': np.nan}
    ev = paired['ret_30m'].mean()
    ct = paired['control_ret_30m'].mean()
    diffs = paired['ret_30m'] - paired['control_ret_30m']
    t, p = stats.ttest_1samp(diffs, 0)
    return {'label': label, 'n': n, 'event': ev, 'control': ct,
            'delta': ev - ct, 't': t, 'p': p}


def main():
    df = pd.read_csv(CSV_PATH, parse_dates=['event_ts', 'control_ts'])
    df['event_date'] = df['event_ts'].dt.date

    down = df[df['direction'] == 'down'].copy()
    down['abs_gex'] = down['node_gex'].abs()
    down['gex_q'] = pd.qcut(down['abs_gex'], q=4,
                            labels=['Q1', 'Q2', 'Q3', 'Q4'],
                            duplicates='drop')
    pocket = down[down['gex_q'].isin(['Q1', 'Q2'])].copy()

    # Day-level vol from vol_realized table (iv_30d ≈ VIX)
    conn = psycopg2.connect(DB_URL)
    try:
        vol_df = load_day_vol(conn)
    finally:
        conn.close()

    iv_30d = vol_df['iv_30d']
    print(f'Day-level iv_30d loaded for {len(iv_30d)} days, '
          f'range {iv_30d.index.min()} → {iv_30d.index.max()}')
    print(f'iv_30d percentiles: '
          f'p25={np.percentile(iv_30d, 25):.3f}, '
          f'p50={np.percentile(iv_30d, 50):.3f}, '
          f'p75={np.percentile(iv_30d, 75):.3f}, '
          f'max={iv_30d.max():.3f}')

    # Attach iv_30d to events (rename for downstream code reuse)
    pocket['rv_day'] = pocket['event_date'].map(iv_30d.to_dict())
    # Print H1 vs H2 RV distribution
    sorted_pocket = pocket.sort_values('event_ts').reset_index(drop=True)
    split_idx = len(sorted_pocket) // 2
    h1 = sorted_pocket.iloc[:split_idx].copy()
    h2 = sorted_pocket.iloc[split_idx:].copy()

    lines = []
    lines.append('# Vol-Regime Segmentation — Down-Wick Q1+Q2 Pocket\n\n')
    lines.append(f'Day-level iv_30d (UW 30-day ATM IV, VIX-equivalent) '
                 f'from vol_realized. {len(iv_30d)} days covered.\n\n')
    lines.append('## H1 vs H2 iv_30d distribution\n\n')
    for label, sub in (('H1', h1), ('H2', h2)):
        rv_sub = sub['rv_day'].dropna()
        lines.append(f'### {label} (n={len(rv_sub)})\n')
        lines.append(f'- Mean iv_30d: {rv_sub.mean():.3f}\n')
        lines.append(f'- Median iv_30d: {rv_sub.median():.3f}\n')
        lines.append(f'- p25/p75: {rv_sub.quantile(0.25):.3f} / '
                     f'{rv_sub.quantile(0.75):.3f}\n\n')

    # RV-quartile segmentation (using FULL pocket sample for consistent cuts)
    pocket_v = pocket.dropna(subset=['rv_day']).copy()
    pocket_v['rv_q'] = pd.qcut(pocket_v['rv_day'], q=4,
                               labels=['RV_Q1', 'RV_Q2', 'RV_Q3', 'RV_Q4'],
                               duplicates='drop')
    print('\n=== Pocket edge by realized-vol quartile ===')
    print(f"{'RV bucket':<10} {'med RV':>8} {'n':>5} {'event':>8} "
          f"{'ctrl':>8} {'Δ':>8} {'p':>8}")
    print('-' * 70)
    lines.append('## Pocket edge by realized-vol quartile\n\n')
    lines.append('| RV bucket | Median RV | n | Event +30m | Control +30m '
                 '| Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|---:|\n')
    for q in ['RV_Q1', 'RV_Q2', 'RV_Q3', 'RV_Q4']:
        sub = pocket_v[pocket_v['rv_q'] == q]
        if sub.empty:
            continue
        r = report(q, sub)
        med_rv = sub['rv_day'].median()
        print(f'{q:<10} {med_rv:>8.3f} {r["n"]:>5} '
              f'{r["event"]:>+8.2f} {r["control"]:>+8.2f} '
              f'{r["delta"]:>+8.2f} {r["p"]:>8.4f}')
        lines.append(f'| {q} | {med_rv:.3f} | {r["n"]} | {r["event"]:+.2f} '
                     f'| {r["control"]:+.2f} | {r["delta"]:+.2f} '
                     f'| {r["t"]:+.2f} | {r["p"]:.4f} |\n')

    # Cross-test: RV quartile × half
    print('\n=== Pocket edge by RV quartile × half ===')
    lines.append('\n## Pocket edge by RV quartile × half\n\n')
    lines.append('| RV bucket | Half | n | Event | Control | Δ | p |\n')
    lines.append('|---|---|---:|---:|---:|---:|---:|\n')
    pocket_v_sorted = pocket_v.sort_values('event_ts').reset_index(drop=True)
    split_idx_v = len(pocket_v_sorted) // 2
    h1_v = pocket_v_sorted.iloc[:split_idx_v]
    h2_v = pocket_v_sorted.iloc[split_idx_v:]
    for q in ['RV_Q1', 'RV_Q2', 'RV_Q3', 'RV_Q4']:
        h1_q = h1_v[h1_v['rv_q'] == q]
        h2_q = h2_v[h2_v['rv_q'] == q]
        for label, sub in (('H1', h1_q), ('H2', h2_q)):
            r = report(label, sub)
            if np.isnan(r['delta']):
                row = (f'| {q} | {label} | {r["n"]} | n/a | n/a | n/a | '
                       'n/a |')
                print(f'{q} {label}: n={r["n"]} sparse')
            else:
                row = (f'| {q} | {label} | {r["n"]} | {r["event"]:+.2f} '
                       f'| {r["control"]:+.2f} | {r["delta"]:+.2f} '
                       f'| {r["p"]:.4f} |')
                print(f'{q} {label}: n={r["n"]:3d} Δ={r["delta"]:+.2f} '
                      f'p={r["p"]:.4f}')
            lines.append(row + '\n')

    MD_PATH.write_text(''.join(lines))
    print(f'\nWrote findings → {MD_PATH}')


if __name__ == '__main__':
    main()
