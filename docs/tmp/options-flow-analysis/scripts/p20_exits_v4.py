"""Phase 20 — exit policy curves on v4 trigger set, by TOD × RE-LOAD.

Pulls per-minute post-trigger price for the 15,790 v3-style filtered v4
fires, builds checkpoint return matrix, and tests:
  * Hard time-stops at multiple checkpoints
  * Trailing stops (activation × trail combos)
  * Hold-to-30min (matches typical scalp timeframe)
  * Hold-to-EoD baseline

All metrics broken down by:
  * tod: AM_open / MID / LUNCH / PM
  * reload: YES / no (the SNDK profile from p18)

Methodology declarations (no silent metric drift):
  * "Return at minute M" = (price_at_M - entry) / entry × 100, point-in-time
  * "Win rate at M" = % of trades positive at M
  * "Median realized return under policy P" = 50th percentile of P's exit
  * Per-contract, no fractional sizing
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at', 'option_chain_id', 'price', 'size', 'canceled']

V3 = ['USAR', 'WMT', 'STX', 'SOUN', 'RIVN', 'TSM', 'SNDK', 'XOM', 'WDC', 'SQQQ',
      'NDXP', 'USO', 'TNA', 'RDDT', 'SMCI', 'TSLL', 'SNOW', 'TEAM', 'RKLB', 'SOFI',
      'RUTW', 'TSLA', 'SOXS', 'WULF', 'SLV', 'SMH', 'UBER', 'MSTR', 'TQQQ', 'RIOT',
      'SOXL', 'UNH', 'QQQ', 'RBLX']

CHECKPOINTS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120]


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def tod_bucket(h: float) -> str:
    if h < 9.5:
        return 'AM_open'
    if h < 11.5:
        return 'MID'
    if h < 12.5:
        return 'LUNCH'
    return 'PM'


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} v4 fires')

    sub = df.loc[
        (df['dte'] == 0)
        & (df['underlying_symbol'].isin(V3))
        & (df['trigger_ask_pct'] >= 0.52)
    ].copy()
    sub = sub.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)
    grp = sub.groupby(['date', 'option_chain_id'])
    sub['prev_window_size'] = grp['trigger_window_size'].shift(1)
    sub['prev_entry_price'] = grp['entry_price'].shift(1)
    sub['burst_ratio_vs_prev'] = sub['trigger_window_size'] / sub['prev_window_size']
    sub['entry_drop_pct_vs_prev'] = (
        (sub['entry_price'] - sub['prev_entry_price']) / sub['prev_entry_price'] * 100
    )
    sub['reload'] = ((sub['burst_ratio_vs_prev'] >= 2)
                      & (sub['entry_drop_pct_vs_prev'] <= -30)).fillna(False)
    sub['hour'] = sub['trigger_time_ct'].dt.hour + sub['trigger_time_ct'].dt.minute / 60
    sub['tod'] = sub['hour'].apply(tod_bucket)
    sub['date_str'] = sub['date'].dt.strftime('%Y-%m-%d')
    print(f'v3-style v4 set: {len(sub):,}')

    # === Pull post-trigger trajectories ===
    print('\nExtracting post-trigger trajectories...')
    chains_by_day: dict[str, set[str]] = {}
    for d, ids in sub.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)

    # Need per-FIRE matrix — multiple fires per chain → per-chain prints
    # Build a dict: (chain_id, date_str) -> sorted minute prices
    minutes_by_chain: dict[tuple[str, str], pd.DataFrame] = {}

    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in chains_by_day:
            continue
        target_chains = chains_by_day[date_str]
        print(f'  {date_str}: {len(target_chains)} chains', flush=True)
        df_p = pq.read_table(f, columns=COLS).to_pandas()
        df_p['canceled'] = _coerce_canceled(df_p['canceled'])
        df_p = df_p.loc[~df_p['canceled'] & (df_p['price'] > 0)]
        df_p['option_chain_id'] = df_p['option_chain_id'].astype(str)
        df_p = df_p.loc[df_p['option_chain_id'].isin(target_chains)]
        df_p['ts_ct'] = df_p['executed_at'].dt.tz_convert('America/Chicago')
        for ch_id, g in df_p.groupby('option_chain_id'):
            minutes_by_chain[(ch_id, date_str)] = g[['ts_ct', 'price']].sort_values('ts_ct')

    print(f'Loaded chain prices: {len(minutes_by_chain):,}')

    # === Build per-fire checkpoint matrix ===
    print('\nBuilding per-fire checkpoint matrix...')
    rows = []
    for _, row in sub.iterrows():
        key = (row['option_chain_id'], row['date_str'])
        prices = minutes_by_chain.get(key)
        if prices is None or len(prices) == 0:
            continue
        entry = float(row['entry_price'])
        if entry <= 0:
            continue
        entry_time = pd.Timestamp(row['entry_time_ct'])
        post = prices.loc[prices['ts_ct'] >= entry_time]
        if len(post) == 0:
            continue
        rec = {
            'option_chain_id': row['option_chain_id'],
            'date_str': row['date_str'],
            'alert_seq': row['alert_seq'],
            'tod': row['tod'],
            'reload': bool(row['reload']),
            'option_type': row['option_type'],
            'entry_price': entry,
        }
        last_known = entry
        for cp in CHECKPOINTS:
            cutoff = entry_time + pd.Timedelta(minutes=cp)
            ps = post.loc[post['ts_ct'] <= cutoff, 'price']
            if len(ps):
                last_known = float(ps.iloc[-1])
            rec[f'ret_m{cp}'] = (last_known - entry) / entry * 100
        rows.append(rec)

    mat = pd.DataFrame(rows)
    print(f'Per-fire matrix: {len(mat):,}')
    mat.to_csv(OUT / 'outputs' / 'p20_v4_exit_curve.csv', index=False)

    # === Print exit curve by TOD ===
    print('\n' + '=' * 90)
    print('=== EXIT CURVE BY TOD (median return at each minute checkpoint) ===')
    print('=' * 90)
    for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
        g = mat.loc[mat['tod'] == tod]
        if len(g) < 30:
            continue
        print(f'\n--- {tod} (n={len(g):,}) ---')
        print(f'{"min":>4} {"win%":>7} {"p25":>8} {"median":>8} {"p75":>8}')
        for cp in CHECKPOINTS:
            col = f'ret_m{cp}'
            s = g[col].dropna()
            if len(s) < 5:
                continue
            print(f'{cp:>4d} {(s>0).mean()*100:>6.1f}% {s.quantile(0.25):>+7.1f}% '
                  f'{s.median():>+7.1f}% {s.quantile(0.75):>+7.1f}%')

    # === Exit curve by RE-LOAD ===
    print('\n' + '=' * 90)
    print('=== EXIT CURVE BY RE-LOAD TAG ===')
    print('=' * 90)
    for tag in [True, False]:
        g = mat.loc[mat['reload'] == tag]
        if len(g) < 30:
            continue
        print(f'\n--- reload={tag} (n={len(g):,}) ---')
        print(f'{"min":>4} {"win%":>7} {"p25":>8} {"median":>8} {"p75":>8}')
        for cp in CHECKPOINTS:
            col = f'ret_m{cp}'
            s = g[col].dropna()
            if len(s) < 5:
                continue
            print(f'{cp:>4d} {(s>0).mean()*100:>6.1f}% {s.quantile(0.25):>+7.1f}% '
                  f'{s.median():>+7.1f}% {s.quantile(0.75):>+7.1f}%')

    # === Policy comparison: per-trade realized return ===
    print('\n' + '=' * 100)
    print('=== POLICY COMPARISON (median realized return per trade) — by TOD ===')
    print('=' * 100)
    print(f'\n{"tod":<10s} {"policy":<22s} {"n":>5s} {"median":>8s} {"mean":>8s} '
          f'{"win%":>6s} {"≥+25%":>7s} {"≥+50%":>7s} {"<-25%":>7s}')
    policies_for = lambda g: [
        (f'hard_stop_m{m}', g[f'ret_m{m}'].dropna()) for m in [5, 10, 15, 20, 30, 45, 60]
    ]
    for tod in ['AM_open', 'MID', 'LUNCH', 'PM']:
        g_tod = mat.loc[mat['tod'] == tod]
        if len(g_tod) < 30:
            continue
        # Build minute-series per trade for trailing sims
        minutes_by_fire = {}
        for _, row in g_tod.iterrows():
            key = (row['option_chain_id'], row['date_str'], row['alert_seq'])
            ch_minutes = minutes_by_chain.get((row['option_chain_id'], row['date_str']))
            if ch_minutes is None:
                continue
            entry_time = pd.Timestamp(
                sub.loc[(sub['option_chain_id'] == row['option_chain_id'])
                        & (sub['date_str'] == row['date_str'])
                        & (sub['alert_seq'] == row['alert_seq']),
                        'entry_time_ct'].iloc[0])
            post = ch_minutes.loc[ch_minutes['ts_ct'] >= entry_time].copy()
            minutes_by_fire[key] = (post, row['entry_price'])
        # Trailing function
        def trail(post: pd.DataFrame, entry: float, act: float, tr: float) -> float:
            peak = -np.inf
            activated = False
            for _, p in post.iterrows():
                ret = (p['price'] - entry) / entry * 100
                if not activated and ret >= act:
                    activated = True
                    peak = ret
                elif activated:
                    if ret > peak:
                        peak = ret
                    elif ret <= peak - tr:
                        return ret
            if len(post) == 0:
                return 0.0
            last_ret = (post['price'].iloc[-1] - entry) / entry * 100
            return last_ret
        # Hard stops
        for name, s in policies_for(g_tod):
            if len(s) < 5:
                continue
            print(f'{tod:<10s} {name:<22s} {len(s):>5d} '
                  f'{s.median():>+7.1f}% {s.mean():>+7.1f}% '
                  f'{(s>0).mean()*100:>5.1f}% '
                  f'{(s>=25).mean()*100:>6.1f}% {(s>=50).mean()*100:>6.1f}% '
                  f'{(s<-25).mean()*100:>6.1f}%')
        # Trailing
        for act, tr in [(20, 10), (30, 10), (30, 15)]:
            results = []
            for key, (post, entry) in minutes_by_fire.items():
                results.append(trail(post, entry, act, tr))
            s = pd.Series(results)
            if len(s) < 5:
                continue
            print(f'{tod:<10s} {f"trail_act{act}_trail{tr}":<22s} {len(s):>5d} '
                  f'{s.median():>+7.1f}% {s.mean():>+7.1f}% '
                  f'{(s>0).mean()*100:>5.1f}% '
                  f'{(s>=25).mean()*100:>6.1f}% {(s>=50).mean()*100:>6.1f}% '
                  f'{(s<-25).mean()*100:>6.1f}%')

    # Same for RE-LOAD
    print('\n' + '=' * 100)
    print('=== POLICY COMPARISON — RE-LOAD vs not ===')
    print('=' * 100)
    print(f'\n{"reload":<8s} {"policy":<22s} {"n":>5s} {"median":>8s} {"mean":>8s} '
          f'{"win%":>6s} {"≥+25%":>7s} {"≥+50%":>7s} {"<-25%":>7s}')
    for tag in [True, False]:
        g_r = mat.loc[mat['reload'] == tag]
        if len(g_r) < 30:
            continue
        minutes_by_fire = {}
        for _, row in g_r.iterrows():
            key = (row['option_chain_id'], row['date_str'], row['alert_seq'])
            ch_minutes = minutes_by_chain.get((row['option_chain_id'], row['date_str']))
            if ch_minutes is None:
                continue
            entry_time = pd.Timestamp(
                sub.loc[(sub['option_chain_id'] == row['option_chain_id'])
                        & (sub['date_str'] == row['date_str'])
                        & (sub['alert_seq'] == row['alert_seq']),
                        'entry_time_ct'].iloc[0])
            post = ch_minutes.loc[ch_minutes['ts_ct'] >= entry_time].copy()
            minutes_by_fire[key] = (post, row['entry_price'])
        def trail(post, entry, act, tr):
            peak = -np.inf
            activated = False
            for _, p in post.iterrows():
                ret = (p['price'] - entry) / entry * 100
                if not activated and ret >= act:
                    activated = True
                    peak = ret
                elif activated:
                    if ret > peak:
                        peak = ret
                    elif ret <= peak - tr:
                        return ret
            if len(post) == 0:
                return 0.0
            return (post['price'].iloc[-1] - entry) / entry * 100
        for name, s in policies_for(g_r):
            if len(s) < 5:
                continue
            print(f'{"YES" if tag else "no":<8s} {name:<22s} {len(s):>5d} '
                  f'{s.median():>+7.1f}% {s.mean():>+7.1f}% '
                  f'{(s>0).mean()*100:>5.1f}% '
                  f'{(s>=25).mean()*100:>6.1f}% {(s>=50).mean()*100:>6.1f}% '
                  f'{(s<-25).mean()*100:>6.1f}%')
        for act, tr in [(20, 10), (30, 10), (30, 15)]:
            results = [trail(p, e, act, tr) for p, e in minutes_by_fire.values()]
            s = pd.Series(results)
            if len(s) < 5:
                continue
            print(f'{"YES" if tag else "no":<8s} {f"trail_act{act}_trail{tr}":<22s} {len(s):>5d} '
                  f'{s.median():>+7.1f}% {s.mean():>+7.1f}% '
                  f'{(s>0).mean()*100:>5.1f}% '
                  f'{(s>=25).mean()*100:>6.1f}% {(s>=50).mean()*100:>6.1f}% '
                  f'{(s<-25).mean()*100:>6.1f}%')


if __name__ == '__main__':
    main()
