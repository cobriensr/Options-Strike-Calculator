#!/usr/bin/env python3
"""Three follow-ups to brainstorm_alternative_hypotheses.py:

(A) Re-run hypothesis (3) multi-bar consolidation and (5) pin formation
    with looser thresholds (±5 pts and ±7 pts). Tight bands underfired.

(B) Walk-forward the +120m up-wick continuation finding (Δ=-6.10
    p=0.004 in brainstorm). If H1 and H2 both clear, that's a separate
    long-call signal worth investigating.

(C) Sub-regime within chop days: what differentiates H1 chop days
    (strong edge) from H2 chop days (weak edge)? Check iv_30d, day-of-
    week, day's full-day RV, time-of-day distribution of events.
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
MD_PATH = OUT / 'brainstorm_followup_findings.md'


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


# === (A) Looser thresholds on (3) and (5) ===

def looser_pin_formation(df, candles, lines):
    print('\n=== (A1) Pin formation @ looser thresholds ===')
    lines.append('## (A1) Pin formation @ looser thresholds\n\n')
    lines.append('Pin = minutes within ±band of wicked strike in next 120m. '
                 'Pinned if minutes_near ≥ min_min. Test event vs control '
                 'pin rate.\n\n')

    def minutes_near(ts, target_strike, look_min, band):
        if pd.isna(ts) or pd.isna(target_strike):
            return np.nan
        end = ts + pd.Timedelta(minutes=look_min)
        day = ts.tz_convert('America/Chicago').date()
        fwd = candles[(candles['timestamp'] > ts)
                      & (candles['timestamp'] <= end)
                      & (candles['date'] == day)]
        if fwd.empty:
            return np.nan
        within = ((fwd['high'] - target_strike).abs() <= band) & \
                 ((fwd['low'] - target_strike).abs() <= band)
        return int(within.sum())

    for band in (5, 7, 10):
        for min_min in (30, 45):
            ev_min = df.apply(
                lambda r: minutes_near(r['event_ts'], r['node_strike'],
                                       120, band),
                axis=1)
            ct_min = df.apply(
                lambda r: minutes_near(r['control_ts'], r['node_strike'],
                                       120, band)
                if pd.notna(r['control_ts']) else np.nan,
                axis=1)
            ev_pin = (ev_min >= min_min).astype('float').where(ev_min.notna())
            ct_pin = (ct_min >= min_min).astype('float').where(ct_min.notna())
            for direction in ('down', 'up'):
                mask = df['direction'] == direction
                sub_ev = ev_pin[mask]
                sub_ct = ct_pin[mask]
                paired_mask = sub_ev.notna() & sub_ct.notna()
                n = int(paired_mask.sum())
                if n < 5:
                    continue
                ev_rate = float(sub_ev[paired_mask].mean())
                ct_rate = float(sub_ct[paired_mask].mean())
                ev_mins = float(ev_min[mask].dropna().mean())
                ct_mins = float(ct_min[mask].dropna().mean())
                diffs = sub_ev[paired_mask] - sub_ct[paired_mask]
                t, p = stats.ttest_1samp(diffs, 0) if diffs.std() > 0 \
                    else (np.nan, np.nan)
                row = (f'band=±{band}pt ≥{min_min}min {direction:<5}'
                       f': n={n:3d} '
                       f'ev_pin_rate={ev_rate:.1%} ctrl={ct_rate:.1%} '
                       f'Δ_min={ev_mins-ct_mins:+.1f} p={p:.4f}')
                print(' ', row)
                lines.append(f'- {row}\n')
    lines.append('\n')


def looser_multibar(df, candles, lines):
    print('\n=== (A2) Multi-bar consolidation @ looser thresholds ===')
    lines.append('## (A2) Multi-bar consolidation @ looser thresholds\n\n')
    lines.append('Filter events to those where bars +1..+N all close within '
                 '±band of wicked strike. Then compute forward returns from '
                 'consolidation end.\n\n')

    def is_consolidating(ts, target_strike, n, band):
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

    def fwd_from_consol(ts, target_strike, direction, n_bars, h=30):
        end_consol = ts + pd.Timedelta(minutes=n_bars)
        end_target = end_consol + pd.Timedelta(minutes=h)
        day = ts.tz_convert('America/Chicago').date()
        fwd = candles[(candles['timestamp'] > end_consol)
                      & (candles['timestamp'] <= end_target)
                      & (candles['date'] == day)]
        if fwd.empty:
            return np.nan
        end_close = float(fwd.iloc[-1]['close'])
        if direction == 'up':
            return target_strike - end_close
        else:
            return end_close - target_strike

    for band in (5, 7):
        for n_bars in (3, 5):
            consol_mask = df.apply(
                lambda r: is_consolidating(r['event_ts'],
                                           r['node_strike'],
                                           n_bars, band),
                axis=1)
            consol = df[consol_mask].copy()
            consol['ret_post'] = consol.apply(
                lambda r: fwd_from_consol(r['event_ts'],
                                          r['node_strike'],
                                          r['direction'],
                                          n_bars),
                axis=1)
            for direction in ('down', 'up'):
                sub = consol[consol['direction'] == direction]
                valid = sub['ret_post'].dropna()
                if len(valid) < 10:
                    print(f'  band=±{band}pt N={n_bars} {direction}: '
                          f'n={len(valid)} sparse')
                    continue
                t, p = stats.ttest_1samp(valid, 0)
                row = (f'band=±{band}pt N={n_bars} {direction:<5}: '
                       f'n={len(valid):3d} mean={valid.mean():+.2f} '
                       f'median={valid.median():+.2f} p={p:.4f}')
                print(' ', row)
                lines.append(f'- {row}\n')
    lines.append('\n')


# === (B) Walk-forward +120m up-wick continuation ===

def walkforward_120m_upwick(df, candles, lines):
    print('\n=== (B) Walk-forward +120m up-wick continuation ===')
    lines.append('## (B) Walk-forward +120m up-wick continuation\n\n')
    lines.append('Brainstorm found up-wick at +120m has Δ=-6.10 p=0.004 '
                 '(price keeps going up). Direction-adjusted sign flip = '
                 'long-call profit at +120m. Walk-forward to test stability.\n\n')

    def forward_return_at(ts, ref_close, direction, horizon_min):
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
        return (ref_close - end_close) if direction == 'up' \
            else (end_close - ref_close)

    df['ret_120m'] = df.apply(
        lambda r: forward_return_at(r['event_ts'], r['bar_close'],
                                    r['direction'], 120),
        axis=1)
    df['control_ret_120m'] = df.apply(
        lambda r: forward_return_at(r['control_ts'], r['control_close'],
                                    r['direction'], 120)
        if pd.notna(r['control_close']) else np.nan,
        axis=1)

    up = df[df['direction'] == 'up'].sort_values('event_ts').copy()
    split_idx = len(up) // 2
    h1 = up.iloc[:split_idx]
    h2 = up.iloc[split_idx:]
    # For LONG CALL trade: flip the sign (continuation = profit).
    lines.append('### Long-call trade profit at +120m (= -direction_adj ret)\n\n')
    lines.append('| Half | n | Event | Control | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    print('\n  Up-wick +120m long-call trade profit:')
    for label, half in (('H1', h1), ('H2', h2), ('FULL', up)):
        # Negate to convert from "mean-reversion" sign to "long-call profit" sign
        half = half.copy()
        half['long_call_120m'] = -half['ret_120m']
        half['ctrl_long_call_120m'] = -half['control_ret_120m']
        r = report_paired(label, half, 'long_call_120m', 'ctrl_long_call_120m')
        lines.append(fmt_row(r) + '\n')
        if not np.isnan(r['delta']):
            print(f'    {label:<6} n={r["n"]:3d}  '
                  f'Δ={r["delta"]:+.2f}  p={r["p"]:.4f}')
    lines.append('\n')


# === (C) Sub-regime within chop days ===

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


def chop_subregime(df, candles, conn, lines):
    print('\n=== (C) Sub-regime within chop days ===')
    lines.append('## (C) Sub-regime within chop days\n\n')
    lines.append('Chop-day Q1+Q2 GEX pocket: H1 strong (Δ=+10.62), H2 weak '
                 '(Δ=+2.48). What feature separates H1 chop days from H2 chop '
                 'days?\n\n')

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
    ].copy().sort_values('event_ts')

    # Load vol_realized (iv_30d, rv_30d)
    vol_q = """
        SELECT date, iv_30d, rv_30d, iv_rank
        FROM vol_realized
        ORDER BY date
    """
    vol_df = query_df(conn, vol_q)
    for c in ('iv_30d', 'rv_30d', 'iv_rank'):
        vol_df[c] = vol_df[c].astype(float)
    vol_df = vol_df.set_index('date')
    pocket = pocket.merge(vol_df, left_on='event_date', right_index=True,
                          how='left')

    # Per-event features
    pocket['dow'] = pd.to_datetime(pocket['event_ts']).dt.day_name()
    pocket['event_hour_ct'] = pd.to_datetime(pocket['event_ts']).dt.tz_convert(
        'America/Chicago').dt.hour

    # Day-level full-day RV from candles
    candles_full = candles.copy()
    candles_full['logret'] = np.log(candles_full['close']).diff()
    rv_full = (candles_full.groupby('date')['logret'].std()
               * np.sqrt(390) * np.sqrt(252))
    pocket['rv_full_day'] = pocket['event_date'].map(rv_full.to_dict())

    # Split halves
    split_idx = len(pocket) // 2
    h1 = pocket.iloc[:split_idx]
    h2 = pocket.iloc[split_idx:]

    # Feature distributions H1 vs H2
    lines.append('### Feature distributions: H1 chop pocket vs H2 chop pocket\n\n')
    lines.append('| Feature | H1 median | H2 median | H1 mean | H2 mean | '
                 'Welch p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|\n')
    print('\n  H1 vs H2 chop-pocket feature comparison:')
    for feat in ('iv_30d', 'rv_30d', 'iv_rank', 'rv_full_day',
                 'trend_strength', 'bar_range', 'abs_gex'):
        h1_v = h1[feat].dropna()
        h2_v = h2[feat].dropna()
        if len(h1_v) < 5 or len(h2_v) < 5:
            continue
        try:
            t, p = stats.ttest_ind(h1_v, h2_v, equal_var=False)
        except Exception:
            t, p = np.nan, np.nan
        row = (f'| {feat} | {h1_v.median():.3f} | {h2_v.median():.3f} '
               f'| {h1_v.mean():.3f} | {h2_v.mean():.3f} | {p:.4f} |')
        lines.append(row + '\n')
        print(f'    {feat:<18} H1 med={h1_v.median():.3f}  '
              f'H2 med={h2_v.median():.3f}  p={p:.4f}')
    lines.append('\n')

    # Day-of-week breakdown
    lines.append('### Day-of-week distribution (chop pocket events)\n\n')
    dow_counts_h1 = h1['dow'].value_counts()
    dow_counts_h2 = h2['dow'].value_counts()
    lines.append('| DOW | H1 n | H2 n |\n')
    lines.append('|---|---:|---:|\n')
    print('\n  DOW counts (chop pocket):')
    for d in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'):
        h1c = int(dow_counts_h1.get(d, 0))
        h2c = int(dow_counts_h2.get(d, 0))
        lines.append(f'| {d} | {h1c} | {h2c} |\n')
        print(f'    {d:<10} H1={h1c}  H2={h2c}')
    lines.append('\n')

    # Try filtering by iv_30d (key suspected differentiator)
    iv_thresholds = (0.15, 0.18, 0.20)
    lines.append('### Chop-pocket edge filtered by iv_30d threshold (+30m)\n\n')
    lines.append('| iv_30d ≥ | H1 n | H1 Δ | H1 p | H2 n | H2 Δ | H2 p | '
                 'FULL Δ | FULL p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    print('\n  Chop pocket × iv_30d threshold (+30m):')
    for thr in iv_thresholds:
        sub_h1 = h1[h1['iv_30d'] >= thr]
        sub_h2 = h2[h2['iv_30d'] >= thr]
        sub_full = pocket[pocket['iv_30d'] >= thr]
        r1 = report_paired('H1', sub_h1, 'ret_30m', 'control_ret_30m')
        r2 = report_paired('H2', sub_h2, 'ret_30m', 'control_ret_30m')
        rf = report_paired('FULL', sub_full, 'ret_30m', 'control_ret_30m')
        row = (f'| ≥{thr:.2f} | {r1["n"]} | {r1["delta"]:+.2f} '
               f'| {r1["p"]:.4f} | {r2["n"]} | {r2["delta"]:+.2f} '
               f'| {r2["p"]:.4f} | {rf["delta"]:+.2f} | {rf["p"]:.4f} |')
        lines.append(row + '\n')
        print(f'    iv≥{thr:.2f}: H1 n={r1["n"]:3d} Δ={r1["delta"]:+.2f} '
              f'p={r1["p"]:.4f}  '
              f'H2 n={r2["n"]:3d} Δ={r2["delta"]:+.2f} p={r2["p"]:.4f}  '
              f'FULL n={rf["n"]:3d} Δ={rf["delta"]:+.2f} p={rf["p"]:.4f}')
    lines.append('\n')


# === Main ===

def main():
    print('Loading v4 + candles...')
    v4_df = pd.read_csv(V4_CSV, parse_dates=['event_ts', 'control_ts'])
    conn = psycopg2.connect(DB_URL)
    try:
        candles = load_candles(conn)
        df = attach_control_close(v4_df, candles)

        lines = []
        lines.append('# Brainstorm Follow-Ups (2026-05-20)\n\n')
        lines.append(f'v4 rows: {len(df):,}. Candle rows: {len(candles):,}\n\n')

        looser_pin_formation(df, candles, lines)
        looser_multibar(df, candles, lines)
        walkforward_120m_upwick(df, candles, lines)
        chop_subregime(df, candles, conn, lines)
    finally:
        conn.close()

    MD_PATH.write_text(''.join(lines))
    print(f'\nFull findings → {MD_PATH}')


if __name__ == '__main__':
    main()
