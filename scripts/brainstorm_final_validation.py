#!/usr/bin/env python3
"""Final validation of the two strongest leads from brainstorm_followups.

LEAD 1: Multi-bar consolidation. Brainstorm found down-wick + 3-bar
consolidation at ±7pt around the wicked strike → +7.48 pts forward (n=175,
p<0.0001 vs zero). Need control comparison + walk-forward.

LEAD 2: Monday-only filter on chop pocket. DOW counts showed Monday
heavily overrepresented in H1 (29) vs H2 (9). If Monday is a real
driver, MONDAY-ONLY chop pocket should clear walk-forward.

If either survives BOTH control comparison AND walk-forward, we have
a real signal to spec into a detector. If both fail, the gamma-node
rejection idea has been exhaustively tested and is shelved.
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
V4_CSV = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'brainstorm_final_validation.md'

CONSOL_BAND_PTS = 7
CONSOL_BARS = 3
FORWARD_MIN = 30


def query_df(conn, sql):
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def report_paired(label, sub, ev_col, ct_col):
    paired = sub[[ev_col, ct_col]].dropna()
    n = len(paired)
    if n < 5:
        return {'label': label, 'n': n, 'event': np.nan,
                'control': np.nan, 'delta': np.nan, 't': np.nan, 'p': np.nan}
    ev = paired[ev_col].mean()
    ct = paired[ct_col].mean()
    diffs = paired[ev_col] - paired[ct_col]
    t, p = stats.ttest_1samp(diffs, 0)
    return {'label': label, 'n': n, 'event': ev, 'control': ct,
            'delta': ev - ct, 't': t, 'p': p}


def fmt_row(r):
    if np.isnan(r['delta']):
        return f"| {r['label']} | {r['n']} | n/a | n/a | n/a | n/a | n/a |"
    return (f"| {r['label']} | {r['n']} | {r['event']:+.2f} "
            f"| {r['control']:+.2f} | {r['delta']:+.2f} "
            f"| {r['t']:+.2f} | {r['p']:.4f} |")


def load_candles(conn):
    q = """
        SELECT timestamp, open, high, low, close, date
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND market_time = 'r'
        ORDER BY timestamp
    """
    df = query_df(conn, q)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    return df


def attach_control_close(v4_df, candles):
    candles_slim = candles[['timestamp', 'close']].rename(
        columns={'timestamp': 'control_ts', 'close': 'control_close'})
    return v4_df.merge(candles_slim, on='control_ts', how='left')


def is_consolidating(candles, ts, target_strike, n=CONSOL_BARS,
                     band=CONSOL_BAND_PTS):
    if pd.isna(ts) or pd.isna(target_strike):
        return False
    end = ts + pd.Timedelta(minutes=n)
    day = ts.tz_convert('America/Chicago').date()
    fwd = candles[(candles['timestamp'] > ts)
                  & (candles['timestamp'] <= end)
                  & (candles['date'] == day)]
    if len(fwd) < n:
        return False
    return ((fwd['close'] - target_strike).abs() <= band).all()


def fwd_return_from_offset(candles, ts, ref_close, direction,
                           offset_min, horizon_min=FORWARD_MIN):
    """Direction-adjusted return from ts+offset_min over the next
    horizon_min, anchored to ref_close measured at ts (the bar's close)."""
    if pd.isna(ts):
        return np.nan
    start = ts + pd.Timedelta(minutes=offset_min)
    end = start + pd.Timedelta(minutes=horizon_min)
    day = ts.tz_convert('America/Chicago').date()
    fwd = candles[(candles['timestamp'] > start)
                  & (candles['timestamp'] <= end)
                  & (candles['date'] == day)]
    if fwd.empty:
        return np.nan
    end_close = float(fwd.iloc[-1]['close'])
    return (ref_close - end_close) if direction == 'up' \
        else (end_close - ref_close)


def fwd_anchor_at_offset(candles, ts, direction, offset_min,
                         horizon_min=FORWARD_MIN):
    """Like fwd_return_from_offset but anchored to the candle at ts+offset
    (the consolidation END), not the original bar's close."""
    if pd.isna(ts):
        return np.nan
    anchor_ts = ts + pd.Timedelta(minutes=offset_min)
    end = anchor_ts + pd.Timedelta(minutes=horizon_min)
    day = ts.tz_convert('America/Chicago').date()
    anchor = candles[(candles['timestamp'] >= anchor_ts)
                     & (candles['date'] == day)]
    if anchor.empty:
        return np.nan
    anchor_close = float(anchor.iloc[0]['close'])
    fwd = candles[(candles['timestamp'] > anchor_ts)
                  & (candles['timestamp'] <= end)
                  & (candles['date'] == day)]
    if fwd.empty:
        return np.nan
    end_close = float(fwd.iloc[-1]['close'])
    return (anchor_close - end_close) if direction == 'up' \
        else (end_close - anchor_close)


# === LEAD 1: Multi-bar consolidation with control ===

def lead1_multibar_with_control(df, candles, lines):
    print(f'\n=== LEAD 1: Multi-bar consolidation (N={CONSOL_BARS}, '
          f'±{CONSOL_BAND_PTS}pt) with control + walk-forward ===')
    lines.append(f'## LEAD 1: Multi-bar consolidation with control\n\n')
    lines.append(f'Filter events to those with {CONSOL_BARS}-bar '
                 f'consolidation within ±{CONSOL_BAND_PTS}pt of wicked '
                 f'strike. Anchor forward return at consolidation END '
                 f'(event_ts + {CONSOL_BARS}min). Control uses same +{CONSOL_BARS}min '
                 f'offset from control_ts (whether or not control had its own '
                 f'consolidation).\n\n')

    # Filter to consolidating events
    df['is_consol'] = df.apply(
        lambda r: is_consolidating(candles, r['event_ts'], r['node_strike']),
        axis=1)
    consol = df[df['is_consol']].copy()
    print(f'  Total events: {len(df):,}')
    print(f'  Consolidating events: {len(consol):,} '
          f'({len(consol)/len(df):.1%})')

    # Forward returns: event from consol end, control from +N offset
    consol['ret_post_consol'] = consol.apply(
        lambda r: fwd_anchor_at_offset(candles, r['event_ts'],
                                        r['direction'], CONSOL_BARS),
        axis=1)
    consol['ctrl_ret_post_offset'] = consol.apply(
        lambda r: fwd_anchor_at_offset(candles, r['control_ts'],
                                        r['direction'], CONSOL_BARS)
        if pd.notna(r['control_ts']) else np.nan,
        axis=1)

    for direction in ('down', 'up'):
        sub = consol[consol['direction'] == direction].copy()
        if len(sub) < 10:
            continue
        lines.append(f'### {direction}-wick + {CONSOL_BARS}-bar consol\n\n')
        lines.append('| Cell | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        print(f'\n  {direction}-wick + consol:')
        sub_sorted = sub.sort_values('event_ts').reset_index(drop=True)
        split = len(sub_sorted) // 2
        h1 = sub_sorted.iloc[:split]
        h2 = sub_sorted.iloc[split:]
        for label, half in (('H1', h1), ('H2', h2), ('FULL', sub_sorted)):
            r = report_paired(label, half,
                              'ret_post_consol', 'ctrl_ret_post_offset')
            lines.append(fmt_row(r) + '\n')
            if not np.isnan(r['delta']):
                print(f'    {label:<6} n={r["n"]:3d}  '
                      f'event={r["event"]:+.2f} ctrl={r["control"]:+.2f}  '
                      f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
        lines.append('\n')

    # Also test by GEX quartile on the down-wick + consol subset
    down_consol = consol[consol['direction'] == 'down'].copy()
    if len(down_consol) >= 16:
        down_consol['abs_gex'] = down_consol['node_gex'].abs()
        down_consol['gex_q'] = pd.qcut(
            down_consol['abs_gex'], q=4,
            labels=['Q1', 'Q2', 'Q3', 'Q4'], duplicates='drop')
        lines.append('### Down-wick + consol × GEX quartile (FULL)\n\n')
        lines.append('| GEX Q | n | Event | Control | Δ | t | p '
                     '| med |gex| |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|---:|\n')
        print('\n  Down-wick + consol × GEX-Q:')
        for q in ['Q1', 'Q2', 'Q3', 'Q4']:
            sub_q = down_consol[down_consol['gex_q'] == q]
            r = report_paired(q, sub_q,
                              'ret_post_consol', 'ctrl_ret_post_offset')
            med = sub_q['abs_gex'].median() if not sub_q.empty else np.nan
            line = fmt_row(r).rstrip('|\n') + f' | {med:.0f} |\n'
            lines.append(line)
            if not np.isnan(r['delta']):
                print(f'    {q:<6} n={r["n"]:3d}  Δ={r["delta"]:+.2f}  '
                      f'p={r["p"]:.4f}  med|gex|={med:.0f}')
        lines.append('\n')


# === LEAD 2: Monday-only chop pocket ===

def compute_day_classification(candles):
    candles_ct = candles.copy()
    candles_ct['ct_ts'] = candles_ct['timestamp'].dt.tz_convert('America/Chicago')
    candles_ct['ct_minute'] = (candles_ct['ct_ts'].dt.hour * 60
                               + candles_ct['ct_ts'].dt.minute)
    morning = candles_ct[(candles_ct['ct_minute'] >= 8 * 60 + 30)
                         & (candles_ct['ct_minute'] < 10 * 60)]
    by_day = morning.groupby('date').agg(
        morning_open=('open', 'first'),
        morning_close=('close', 'last'),
        morning_high=('high', 'max'),
        morning_low=('low', 'min'),
    )
    by_day['morning_oc'] = by_day['morning_close'] - by_day['morning_open']
    by_day['morning_range'] = by_day['morning_high'] - by_day['morning_low']
    by_day['trend_strength'] = (by_day['morning_oc'].abs()
                                / by_day['morning_range'].replace(0, np.nan))
    return by_day


def lead2_dow_monday(df, candles, lines):
    print('\n=== LEAD 2: Day-of-week filtering on chop pocket ===')
    lines.append('## LEAD 2: Day-of-week filtering on chop pocket\n\n')
    lines.append('Chop pocket = down-wick + GEX-Q1+Q2 + morning trend_strength '
                 'in Q1-Q2 (chop). Filter by DOW and walk-forward.\n\n')

    day_class = compute_day_classification(candles)
    df['event_date'] = df['event_ts'].dt.date
    df = df.merge(day_class[['trend_strength']],
                  left_on='event_date', right_index=True, how='left')
    df['trend_q'] = pd.qcut(df['trend_strength'].dropna(), q=4,
                            labels=['Q1_chop', 'Q2', 'Q3', 'Q4_trend'],
                            duplicates='drop')

    down = df[df['direction'] == 'down'].copy()
    down['abs_gex'] = down['node_gex'].abs()
    down['gex_q'] = pd.qcut(down['abs_gex'], q=4,
                            labels=['GEX_Q1', 'GEX_Q2', 'GEX_Q3', 'GEX_Q4'],
                            duplicates='drop')
    pocket = down[
        down['gex_q'].isin(['GEX_Q1', 'GEX_Q2'])
        & down['trend_q'].isin(['Q1_chop', 'Q2'])
    ].copy()
    pocket['dow'] = pd.to_datetime(pocket['event_ts']).dt.day_name()

    # Per-DOW: full + walk-forward
    lines.append('### Pocket edge by day-of-week (+30m)\n\n')
    lines.append('| DOW | Cell | n | Event | Control | Δ | t | p |\n')
    lines.append('|---|---|---:|---:|---:|---:|---:|---:|\n')
    print('\n  Pocket by DOW (+30m):')
    for d in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'):
        sub = pocket[pocket['dow'] == d].sort_values('event_ts')
        if len(sub) < 8:
            row = (f'| {d} | (too few) | {len(sub)} | n/a | n/a | n/a '
                   '| n/a | n/a |')
            lines.append(row + '\n')
            print(f'    {d:<10} n={len(sub)} too few')
            continue
        split = len(sub) // 2
        h1 = sub.iloc[:split]
        h2 = sub.iloc[split:]
        for label, half in (('H1', h1), ('H2', h2), ('FULL', sub)):
            r = report_paired(label, half, 'ret_30m', 'control_ret_30m')
            row = (f'| {d} | {label} | {r["n"]} | '
                   f'{r["event"]:+.2f} | {r["control"]:+.2f} | '
                   f'{r["delta"]:+.2f} | {r["t"]:+.2f} | '
                   f'{r["p"]:.4f} |')
            lines.append(row + '\n')
            print(f'    {d:<10} {label:<6} n={r["n"]:3d}  '
                  f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
        lines.append('| | | | | | | | |\n')
    lines.append('\n')

    # Bonus: Monday-only walk-forward INSIDE the broader down-wick + GEX pocket
    # (without the trend filter — maybe the chop filter is over-restrictive
    # for Mondays)
    broader = down[down['gex_q'].isin(['GEX_Q1', 'GEX_Q2'])].copy()
    broader['dow'] = pd.to_datetime(broader['event_ts']).dt.day_name()
    monday_broad = broader[broader['dow'] == 'Monday'].sort_values('event_ts')
    if len(monday_broad) >= 10:
        lines.append('### Bonus: Monday-only within full GEX Q1+Q2 pocket '
                     '(NO trend filter)\n\n')
        lines.append('| Cell | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        print('\n  Monday-only (full GEX pocket, no trend filter):')
        split = len(monday_broad) // 2
        h1 = monday_broad.iloc[:split]
        h2 = monday_broad.iloc[split:]
        for label, half in (('H1', h1), ('H2', h2), ('FULL', monday_broad)):
            r = report_paired(label, half, 'ret_30m', 'control_ret_30m')
            lines.append(fmt_row(r) + '\n')
            if not np.isnan(r['delta']):
                print(f'    {label:<6} n={r["n"]:3d}  '
                      f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
        lines.append('\n')


# === Main ===

def main():
    print('Loading v4 + candles...')
    v4_df = pd.read_csv(V4_CSV, parse_dates=['event_ts', 'control_ts'])
    conn = psycopg2.connect(DB_URL)
    try:
        candles = load_candles(conn)
    finally:
        conn.close()

    df = attach_control_close(v4_df, candles)
    print(f'  v4 rows: {len(df):,}')
    print(f'  candles rows: {len(candles):,}')

    lines = []
    lines.append('# Final Validation — Multi-Bar Consol + Monday Filter\n\n')
    lines.append(f'v4 rows: {len(df):,}\n\n')

    lead1_multibar_with_control(df, candles, lines)
    lead2_dow_monday(df, candles, lines)

    MD_PATH.write_text(''.join(lines))
    print(f'\nFull findings → {MD_PATH}')


if __name__ == '__main__':
    main()
