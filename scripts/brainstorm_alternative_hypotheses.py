#!/usr/bin/env python3
"""Test four alternative framings of the gamma-node rejection idea.

(1) Day-type pre-classification: does the H1 edge concentrate on
    morning-chop days vs morning-trend days?
(3) Multi-bar consolidation: does requiring 5-bar tight close near the
    wicked strike filter out noise events?
(4) Longer horizons: does the edge grow or stabilize at 90/120/180/EOD?
(5) Pin formation: do wick events predict intraday pin behavior at
    the wicked strike? (would justify iron condor framing).

Reads v4 CSV + index_candles_1m. Output:
docs/tmp/forensic-multi-day/brainstorm_findings_2026-05-20.md
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
MD_PATH = OUT / 'brainstorm_findings_2026-05-20.md'

LATEST_EVENT_CT_MINUTES = 14 * 60


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
        return (f"| {r['label']} | {r['n']} | n/a | n/a | n/a | n/a | n/a |")
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


# === Hypothesis 4: Longer horizons ===

def forward_return_at(candles, ts, ref_close, direction, horizon_min):
    """Direction-adjusted return at +horizon_min, same-day only."""
    if pd.isna(ts):
        return np.nan
    target = ts + pd.Timedelta(minutes=horizon_min)
    day = ts.tz_convert('America/Chicago').date()
    fwd = candles[(candles['timestamp'] > ts)
                  & (candles['timestamp'] <= target)
                  & (candles['date'] == day)]
    if fwd.empty:
        return np.nan
    end_close = float(fwd.iloc[-1]['close'])
    return (ref_close - end_close) if direction == 'up' else (end_close - ref_close)


def eod_return(candles, ts, ref_close, direction):
    """Direction-adjusted return to last RTH bar of the same trading day."""
    if pd.isna(ts):
        return np.nan
    day = ts.tz_convert('America/Chicago').date()
    fwd = candles[(candles['timestamp'] > ts)
                  & (candles['date'] == day)]
    if fwd.empty:
        return np.nan
    end_close = float(fwd.iloc[-1]['close'])
    return (ref_close - end_close) if direction == 'up' else (end_close - ref_close)


def analyze_longer_horizons(df, candles, lines):
    HORIZONS = [60, 90, 120, 180]
    print('\n=== Hypothesis (4): Longer horizons ===')
    lines.append('## Hypothesis (4): Longer horizons\n\n')
    lines.append('Forward returns at +60/+90/+120/+180m and EOD. '
                 'Positive = mean-reversion (good for short premium).\n\n')

    # Compute event and control forward returns at new horizons
    for h in HORIZONS:
        df[f'ret_{h}m_v5'] = df.apply(
            lambda r: forward_return_at(candles, r['event_ts'],
                                        r['bar_close'], r['direction'], h),
            axis=1)
        df[f'control_ret_{h}m_v5'] = df.apply(
            lambda r: forward_return_at(candles, r['control_ts'],
                                        r['control_close'], r['direction'], h)
            if pd.notna(r['control_close']) else np.nan,
            axis=1)

    df['ret_eod'] = df.apply(
        lambda r: eod_return(candles, r['event_ts'],
                             r['bar_close'], r['direction']),
        axis=1)
    df['control_ret_eod'] = df.apply(
        lambda r: eod_return(candles, r['control_ts'],
                             r['control_close'], r['direction'])
        if pd.notna(r['control_close']) else np.nan,
        axis=1)

    for direction in ('down', 'up'):
        sub = df[df['direction'] == direction]
        lines.append(f'### {direction}-wick\n\n')
        lines.append('| Horizon | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        print(f'\n  {direction}-wick:')
        for h in HORIZONS:
            r = report_paired(f'+{h}m', sub,
                              f'ret_{h}m_v5', f'control_ret_{h}m_v5')
            lines.append(fmt_row(r) + '\n')
            if not np.isnan(r['delta']):
                print(f'    +{h}m: n={r["n"]:3d}  '
                      f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
        r = report_paired('EOD', sub, 'ret_eod', 'control_ret_eod')
        lines.append(fmt_row(r) + '\n\n')
        if not np.isnan(r['delta']):
            print(f'    EOD: n={r["n"]:3d}  '
                  f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')

    # Walk-forward at +180m on down-wick Q1+Q2 (pocket)
    down = df[df['direction'] == 'down'].copy()
    down['abs_gex'] = down['node_gex'].abs()
    down['gex_q'] = pd.qcut(down['abs_gex'], q=4,
                            labels=['Q1', 'Q2', 'Q3', 'Q4'], duplicates='drop')
    pocket = down[down['gex_q'].isin(['Q1', 'Q2'])].sort_values('event_ts')
    split_idx = len(pocket) // 2
    h1 = pocket.iloc[:split_idx]
    h2 = pocket.iloc[split_idx:]
    lines.append('### Walk-forward Q1+Q2 pocket at +180m and EOD\n\n')
    lines.append('| Cell | n | Event | Control | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    print('\n  Walk-forward Q1+Q2 pocket:')
    for horizon_label, ev, ct in (('+180m', 'ret_180m_v5',
                                    'control_ret_180m_v5'),
                                   ('EOD', 'ret_eod', 'control_ret_eod')):
        for label, half in (('H1', h1), ('H2', h2)):
            r = report_paired(f'{horizon_label} {label}', half, ev, ct)
            lines.append(fmt_row(r) + '\n')
            if not np.isnan(r['delta']):
                print(f'    {horizon_label} {label}: n={r["n"]:3d}  '
                      f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
        lines.append('|  |  |  |  |  |  |  |\n')
    lines.append('\n')


# === Hypothesis 1: Day-type classifier ===

def compute_day_classification(candles):
    """For each trading day, compute morning (8:30-10:00 CT) close-open
    and range as a trend/chop classifier. Trending = large |close-open|
    relative to range."""
    candles_ct = candles.copy()
    candles_ct['ct_ts'] = candles_ct['timestamp'].dt.tz_convert(
        'America/Chicago')
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


def analyze_day_type(df, candles, lines):
    print('\n=== Hypothesis (1): Day-type pre-classification ===')
    lines.append('## Hypothesis (1): Day-type pre-classification\n\n')
    lines.append('Day type derived from morning 8:30-10:00 CT bar bundle: '
                 'trend_strength = |morning_close - morning_open| / '
                 'morning_range. Trending = directional move with full range; '
                 'chop = small net move with wide range. Cut at median.\n\n')

    day_class = compute_day_classification(candles)
    df['event_date'] = df['event_ts'].dt.date
    df = df.merge(day_class[['trend_strength']],
                  left_on='event_date', right_index=True, how='left')

    # Bucket by trend_strength quartile
    df['trend_q'] = pd.qcut(df['trend_strength'].dropna(), q=4,
                            labels=['Q1_chop', 'Q2', 'Q3', 'Q4_trend'],
                            duplicates='drop')

    down = df[df['direction'] == 'down'].copy()
    down['abs_gex'] = down['node_gex'].abs()
    down['gex_q'] = pd.qcut(down['abs_gex'], q=4,
                            labels=['GEX_Q1', 'GEX_Q2', 'GEX_Q3', 'GEX_Q4'],
                            duplicates='drop')

    lines.append('### Down-wick edge at +30m by trend-strength quartile\n\n')
    lines.append('Q1 = lowest trend_strength = choppiest mornings; Q4 = '
                 'strong directional opens.\n\n')
    lines.append('| Trend Q | n | Event | Control | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    print('\n  Down-wick by trend-strength quartile (+30m):')
    for q in ['Q1_chop', 'Q2', 'Q3', 'Q4_trend']:
        sub = down[down['trend_q'] == q]
        r = report_paired(q, sub, 'ret_30m', 'control_ret_30m')
        lines.append(fmt_row(r) + '\n')
        if not np.isnan(r['delta']):
            print(f'    {q:<10} n={r["n"]:3d}  '
                  f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
    lines.append('\n')

    # Q1+Q2 pocket × trend quartile (the key test)
    pocket = down[down['gex_q'].isin(['GEX_Q1', 'GEX_Q2'])]
    lines.append('### Q1+Q2 GEX pocket × trend quartile at +30m\n\n')
    lines.append('| Trend Q | n | Event | Control | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    print('\n  Q1+Q2 GEX pocket × trend quartile (+30m):')
    for q in ['Q1_chop', 'Q2', 'Q3', 'Q4_trend']:
        sub = pocket[pocket['trend_q'] == q]
        r = report_paired(q, sub, 'ret_30m', 'control_ret_30m')
        lines.append(fmt_row(r) + '\n')
        if not np.isnan(r['delta']):
            print(f'    {q:<10} n={r["n"]:3d}  '
                  f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
    lines.append('\n')

    # Walk-forward Q1+Q2 pocket within "chop" days only (Q1+Q2 trend)
    chop_pocket = pocket[pocket['trend_q'].isin(['Q1_chop', 'Q2'])]
    chop_pocket = chop_pocket.sort_values('event_ts')
    split_idx = len(chop_pocket) // 2
    h1 = chop_pocket.iloc[:split_idx]
    h2 = chop_pocket.iloc[split_idx:]
    lines.append('### Walk-forward of CHOP-day × GEX-Q1+Q2 pocket at +30m\n\n')
    lines.append('| Half | n | Event | Control | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    print('\n  Walk-forward chop-day × Q1+Q2 pocket:')
    for label, half in (('H1', h1), ('H2', h2), ('FULL', chop_pocket)):
        r = report_paired(label, half, 'ret_30m', 'control_ret_30m')
        lines.append(fmt_row(r) + '\n')
        if not np.isnan(r['delta']):
            print(f'    {label:<6} n={r["n"]:3d}  '
                  f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
    lines.append('\n')


# === Hypothesis 5: Pin formation ===

def analyze_pin_formation(df, candles, lines, pin_band_pts=3, pin_min_min=60):
    """For each event, check whether price stayed within ±pin_band_pts of
    the wicked node strike for at least pin_min_min minutes within the
    next 120 min. Compare events vs controls."""
    print(f'\n=== Hypothesis (5): Pin formation '
          f'(±{pin_band_pts}pts, ≥{pin_min_min}min) ===')
    lines.append(f'## Hypothesis (5): Pin formation '
                 f'(±{pin_band_pts}pts of node, ≥{pin_min_min}min)\n\n')
    lines.append('For each event, count minutes within ±3 pts of the '
                 'wicked strike in the 120 min after event close. If ≥60, '
                 'it formed a pin. Compare event pin rate vs control pin '
                 'rate (control uses a SYNTHETIC pin level — the strike '
                 'closest to spot at control_ts).\n\n')

    def minutes_near(ts, target_strike, look_min=120, band=pin_band_pts):
        if pd.isna(ts) or pd.isna(target_strike):
            return np.nan
        end = ts + pd.Timedelta(minutes=look_min)
        day = ts.tz_convert('America/Chicago').date()
        fwd = candles[(candles['timestamp'] > ts)
                      & (candles['timestamp'] <= end)
                      & (candles['date'] == day)]
        if fwd.empty:
            return np.nan
        # Each candle = 1 min. Count candles where both high and low are
        # within band of target (the price never strayed far during that
        # minute).
        within = ((fwd['high'] - target_strike).abs() <= band) & \
                 ((fwd['low'] - target_strike).abs() <= band)
        return int(within.sum())

    df['event_minutes_near'] = df.apply(
        lambda r: minutes_near(r['event_ts'], r['node_strike']),
        axis=1)
    # Control's "synthetic pin level": use the same node_strike — keeps the
    # test apples-to-apples (was there pin formation at that price level on
    # the day, regardless of trigger).
    df['control_minutes_near'] = df.apply(
        lambda r: minutes_near(r['control_ts'], r['node_strike'])
        if pd.notna(r['control_ts']) else np.nan,
        axis=1)

    df['event_pinned'] = (df['event_minutes_near'] >= pin_min_min).astype(
        'float').where(df['event_minutes_near'].notna())
    df['control_pinned'] = (df['control_minutes_near'] >= pin_min_min).astype(
        'float').where(df['control_minutes_near'].notna())

    for direction in ('down', 'up'):
        sub = df[df['direction'] == direction]
        paired = sub[['event_pinned', 'control_pinned']].dropna()
        n = len(paired)
        if n < 5:
            continue
        ev_rate = paired['event_pinned'].mean()
        ct_rate = paired['control_pinned'].mean()
        ev_min = sub['event_minutes_near'].mean()
        ct_min = sub['control_minutes_near'].mean()
        # McNemar-style: test if pin rate differs
        diffs = paired['event_pinned'] - paired['control_pinned']
        t, p = stats.ttest_1samp(diffs, 0)
        lines.append(f'### {direction}-wick: pin rate event vs control\n\n')
        lines.append(f'- n: {n}\n')
        lines.append(f'- Event pin rate: {ev_rate:.1%}\n')
        lines.append(f'- Control pin rate: {ct_rate:.1%}\n')
        lines.append(f'- Mean minutes near strike (next 120m): '
                     f'event={ev_min:.1f}, control={ct_min:.1f}\n')
        lines.append(f'- Paired t-test on (event_pinned − control_pinned): '
                     f't={t:+.2f}, p={p:.4f}\n\n')
        print(f'\n  {direction}-wick: n={n}  '
              f'event_pin_rate={ev_rate:.1%}  ctrl_pin_rate={ct_rate:.1%}  '
              f'Δ_min_near={ev_min - ct_min:+.1f}  p={p:.4f}')


# === Hypothesis 3: Multi-bar consolidation ===

def analyze_multibar(df, candles, lines, consol_band_pts=3, consol_bars=5):
    """Filter events to those followed by N consecutive bars whose close
    is within ±X pts of the wicked node strike. These are 'rejection
    confirmed by consolidation' events. Test forward returns from the
    consolidation end (T + N bars), not from T."""
    print(f'\n=== Hypothesis (3): Multi-bar consolidation '
          f'(N={consol_bars}, ±{consol_band_pts}pts) ===')
    lines.append(f'## Hypothesis (3): Multi-bar consolidation\n\n')
    lines.append(f'Filter events to those where bars +1..+{consol_bars} all '
                 f'close within ±{consol_band_pts} pts of the wicked strike. '
                 'Then compute forward returns from the END of the '
                 'consolidation window (event_ts + N min).\n\n')

    def is_consolidating(ts, target_strike, n=consol_bars,
                         band=consol_band_pts):
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

    df['is_consol'] = df.apply(
        lambda r: is_consolidating(r['event_ts'], r['node_strike']),
        axis=1)
    consol = df[df['is_consol']].copy()

    print(f'  Total events: {len(df):,}')
    print(f'  Events with {consol_bars}-bar consolidation: '
          f'{len(consol):,} ({len(consol)/len(df):.1%})')
    lines.append(f'- Total events: {len(df):,}\n')
    lines.append(f'- Events with {consol_bars}-bar consolidation '
                 f'at ±{consol_band_pts}pts: {len(consol):,} '
                 f'({len(consol)/len(df):.1%})\n\n')

    if len(consol) < 20:
        lines.append('Too few consolidated events for stat tests.\n\n')
        print('  Too few events for stats.')
        return

    # Forward return from T + N to T + N + 30m
    def fwd_from_consol_end(ts, target_strike, direction, h=30):
        end_consol = ts + pd.Timedelta(minutes=consol_bars)
        end_target = end_consol + pd.Timedelta(minutes=h)
        day = ts.tz_convert('America/Chicago').date()
        fwd = candles[(candles['timestamp'] > end_consol)
                      & (candles['timestamp'] <= end_target)
                      & (candles['date'] == day)]
        if fwd.empty:
            return np.nan
        end_close = float(fwd.iloc[-1]['close'])
        # Reference is target_strike (the consolidation level) — measure
        # which way price broke from the pin.
        # Convention same as v3/v4: positive = mean-reversion from wick
        # direction.
        if direction == 'up':
            # up-wick rejection: positive = price moved DOWN from strike
            return target_strike - end_close
        else:
            # down-wick rejection: positive = price moved UP from strike
            return end_close - target_strike

    consol['ret_after_consol_30m'] = consol.apply(
        lambda r: fwd_from_consol_end(r['event_ts'], r['node_strike'],
                                       r['direction']),
        axis=1)

    for direction in ('down', 'up'):
        sub = consol[consol['direction'] == direction]
        valid = sub['ret_after_consol_30m'].dropna()
        if len(valid) < 10:
            continue
        t, p = stats.ttest_1samp(valid, 0)
        lines.append(f'### {direction}-wick + consolidation: '
                     f'+30m ret vs zero\n\n')
        lines.append(f'- n: {len(valid)}\n')
        lines.append(f'- Mean ret_30m (post-consol): {valid.mean():+.2f} pts\n')
        lines.append(f'- Median: {valid.median():+.2f} pts\n')
        lines.append(f'- t-test vs 0: t={t:+.2f}, p={p:.4f}\n\n')
        print(f'\n  {direction}-wick + consol: n={len(valid):3d}  '
              f'mean={valid.mean():+.2f}  median={valid.median():+.2f}  '
              f'p={p:.4f}')


# === Main ===

def main():
    print('Loading v4 events + candles...')
    v4_df = pd.read_csv(V4_CSV, parse_dates=['event_ts', 'control_ts'])
    print(f'  v4 rows: {len(v4_df):,}')

    conn = psycopg2.connect(DB_URL)
    try:
        candles = load_candles(conn)
    finally:
        conn.close()
    print(f'  candles rows: {len(candles):,}')

    df = attach_control_close(v4_df, candles)

    lines = []
    lines.append('# Brainstorm — Alternative Hypotheses (2026-05-20)\n\n')
    lines.append(f'Reads v4 CSV (n={len(df):,} (event, node) rows) and '
                 'tests 4 alternative framings.\n\n')

    analyze_longer_horizons(df, candles, lines)
    analyze_day_type(df, candles, lines)
    analyze_pin_formation(df, candles, lines)
    analyze_multibar(df, candles, lines)

    MD_PATH.write_text(''.join(lines))
    print(f'\nFull findings → {MD_PATH}')


if __name__ == '__main__':
    main()
