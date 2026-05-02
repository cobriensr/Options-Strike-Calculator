"""Phase 11 — flow direction analysis.

For each v3 alert, extract the burst-minute side breakdown and classify
by FLOW direction (not just option_type direction).

Then test:
  1. Do noise alerts (peak <5min) cluster in specific flow types?
  2. Does time-of-day modify the flow interpretation?
  3. Is there a "fade the block dump" opportunity — when ask% was extreme
     (>90%) in a single burst, does the chain peak immediately?
  4. What about BID-dominant block dumps (closing flow)?

We need to know: which OPTION TYPE + SIDE + TIME-OF-DAY combinations are
the noisy ones vs the real ones.
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at','option_chain_id','side','price','size','canceled']


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t','true','1'])


def main():
    # Load v3 alerts + outcomes
    p3 = pd.read_csv(OUT / 'outputs' / 'p3_triggers.csv',
                     parse_dates=['date','trigger_time_ct'])
    p3['hour'] = p3['trigger_time_ct'].dt.hour + p3['trigger_time_ct'].dt.minute/60
    p3['in_window'] = ((p3['hour'] >= 8.5) & (p3['hour'] < 9.5)) | ((p3['hour'] >= 11.5) & (p3['hour'] < 12.5))
    V3 = ['USAR','WMT','STX','SOUN','RIVN','TSM','SNDK','XOM','WDC','SQQQ',
          'NDXP','USO','TNA','RDDT','SMCI','TSLL','SNOW','TEAM','RKLB','SOFI',
          'RUTW','TSLA','SOXS','WULF','SLV','SMH','UBER','MSTR','TQQQ','RIOT',
          'SOXL','UNH','QQQ','RBLX']
    v3 = p3.loc[(p3['dte']==0) & p3['in_window'] & p3['underlying_symbol'].isin(V3)].copy()
    v3['date_str'] = v3['date'].dt.strftime('%Y-%m-%d')

    # Outcome: peak return + time-to-peak
    p8 = pd.read_csv(OUT / 'outputs' / 'p8_peak_features.csv')
    p8['date_str'] = p8['date'].astype(str)
    p8 = p8[['option_chain_id','date_str','time_to_peak_min','peak_return_pct',
             'eod_return_pct','max_dd_before_peak_pct']]
    v3 = v3.merge(p8, on=['option_chain_id','date_str'], how='left').drop_duplicates(subset=['option_chain_id','date_str']).dropna(subset=['time_to_peak_min'])
    print(f'Loaded {len(v3):,} alerts')

    # === Extract burst-minute side breakdown ===
    print('\nExtracting burst-minute side stats from parquets...')
    burst_features = []

    chains_by_day: dict[str, set[str]] = {}
    for d, ids in v3.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)

    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet','')
        if date_str not in chains_by_day:
            continue
        target_chains = chains_by_day[date_str]
        print(f'  {date_str}: {len(target_chains)} chains', flush=True)
        t = pq.read_table(f, columns=COLS)
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled'] & (df['price'] > 0)]
        for c in ['option_chain_id','side']:
            df[c] = df[c].astype(str)
        df = df.loc[df['option_chain_id'].isin(target_chains)]
        df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')

        day_alerts = v3.loc[v3['date_str']==date_str].set_index('option_chain_id')
        for ch_id, g in df.groupby('option_chain_id'):
            if ch_id not in day_alerts.index:
                continue
            row = day_alerts.loc[ch_id]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            trig_time = pd.Timestamp(row['trigger_time_ct'])
            burst_start = trig_time - pd.Timedelta(minutes=1)
            burst = g.loc[(g['ts_ct'] >= burst_start) & (g['ts_ct'] <= trig_time)]
            if len(burst) == 0:
                continue
            ask = burst.loc[burst['side']=='ask']
            bid = burst.loc[burst['side']=='bid']
            burst_features.append({
                'option_chain_id': ch_id,
                'date_str': date_str,
                'burst_n_prints': len(burst),
                'burst_total_volume': burst['size'].sum(),
                'burst_ask_volume': ask['size'].sum(),
                'burst_bid_volume': bid['size'].sum(),
                'burst_ask_pct_count': len(ask)/len(burst) if len(burst) else 0,
                'burst_ask_pct_volume': ask['size'].sum()/burst['size'].sum() if burst['size'].sum() else 0,
                'burst_n_distinct_prices': burst['price'].nunique(),
                'burst_largest_print': burst['size'].max(),
                'burst_largest_print_pct': burst['size'].max()/burst['size'].sum() if burst['size'].sum() else 0,
            })

    bf = pd.DataFrame(burst_features)
    print(f'Got burst features for {len(bf):,} alerts')
    v3 = v3.merge(bf, on=['option_chain_id','date_str'], how='left').dropna(subset=['burst_total_volume'])
    print(f'Final merged: {len(v3):,}')

    # === Flow direction classification ===
    # Use VOLUME-weighted ask% (more accurate than count)
    v3['burst_dominant_side'] = np.where(v3['burst_ask_pct_volume'] >= 0.60, 'ask',
                               np.where(v3['burst_ask_pct_volume'] <= 0.40, 'bid', 'mixed'))
    def flow_direction(r):
        if r['burst_dominant_side'] == 'ask':
            return 'bullish' if r['option_type']=='call' else 'bearish'
        if r['burst_dominant_side'] == 'bid':
            return 'bearish_close' if r['option_type']=='call' else 'bullish_close'
        return 'mixed'
    v3['flow_direction'] = v3.apply(flow_direction, axis=1)
    v3['flow_quad'] = v3['option_type'] + '_' + v3['burst_dominant_side']

    # Time of day buckets
    v3['tod'] = np.where(v3['hour'] < 9.5, 'AM_open', 'PM_open')

    # === ANALYSIS 1: Flow quadrant breakdown ===
    print('\n' + '=' * 75)
    print('=== FLOW QUADRANT: count + win rate + median peak return ===')
    print('=' * 75)
    print(f'\n{"Quadrant":<14s} {"n":<6s} {"%":<6s} {"% noise <5m":<14s} {"% dev ≥15m":<13s} {"Median peak ret":<18s} {"Median EoD ret"}')
    for quad, g in v3.groupby('flow_quad'):
        n = len(g)
        pct = n / len(v3) * 100
        noise = (g['time_to_peak_min'] < 5).mean() * 100
        dev = (g['time_to_peak_min'] >= 15).mean() * 100
        med_peak = g['peak_return_pct'].median()
        med_eod = g['eod_return_pct'].median()
        print(f'{quad:<14s} {n:>4d}  {pct:>4.1f}% {noise:>9.1f}%      {dev:>9.1f}%    {med_peak:>+10.1f}%        {med_eod:>+8.1f}%')

    # === ANALYSIS 2: Time-of-day × flow ===
    print('\n' + '=' * 75)
    print('=== TIME-OF-DAY × FLOW QUAD ===')
    print('=' * 75)
    print(f'\n{"Quadrant":<14s} {"Window":<10s} {"n":<6s} {"% noise":<10s} {"% dev":<9s} {"Median peak":<14s} {"Median EoD"}')
    for (quad, tod), g in v3.groupby(['flow_quad','tod']):
        if len(g) < 10:
            continue
        n = len(g)
        noise = (g['time_to_peak_min'] < 5).mean() * 100
        dev = (g['time_to_peak_min'] >= 15).mean() * 100
        med_peak = g['peak_return_pct'].median()
        med_eod = g['eod_return_pct'].median()
        print(f'{quad:<14s} {tod:<10s} {n:>4d}  {noise:>5.1f}%     {dev:>5.1f}%   {med_peak:>+8.1f}%       {med_eod:>+8.1f}%')

    # === ANALYSIS 3: Block dump detection ===
    print('\n' + '=' * 75)
    print('=== BLOCK-DUMP DETECTION: largest_print as % of burst volume ===')
    print('=' * 75)
    print('Hypothesis: "single large print" alerts (one block dump) peak immediately.')
    print()
    v3['_q'] = pd.qcut(v3['burst_largest_print_pct'].rank(method='first'), 5,
                       labels=['Q1','Q2','Q3','Q4','Q5'])
    s = v3.groupby('_q', observed=True).agg(
        n=('time_to_peak_min','size'),
        median_largest_pct=('burst_largest_print_pct','median'),
        pct_noise=('time_to_peak_min', lambda s: (s<5).mean()*100),
        pct_dev=('time_to_peak_min', lambda s: (s>=15).mean()*100),
        median_peak=('peak_return_pct','median'),
    ).round(2)
    print(s.to_string())

    # === ANALYSIS 4: Fade hypothesis ===
    print('\n' + '=' * 75)
    print('=== FADE HYPOTHESIS: does the OPPOSITE direction win on closing flows? ===')
    print('=' * 75)
    print('For "_close" flows (call_bid, put_bid), the option direction')
    print('is being closed. Does the underlying tend to move OPPOSITE to')
    print('the option side?  (i.e., put_bid late = puts being closed = stock')
    print('went down already, now closing for cover = could rally)')
    print()
    print('We don\'t have underlying-only return after entry, but EoD return')
    print('on the OPTION shows: did it climb (option direction won) or fall')
    print('(option direction lost)?')
    print()
    for quad in ['call_ask','call_bid','put_ask','put_bid','call_mixed','put_mixed']:
        g = v3.loc[v3['flow_quad']==quad]
        if len(g) < 30:
            continue
        # If win rate (peak > 0) is < 50%, the direction failed — fade may work
        peak_winners = (g['peak_return_pct'] > 0).mean() * 100
        eod_winners = (g['eod_return_pct'] > 0).mean() * 100
        print(f'{quad:<14s}: n={len(g)}  peak winners={peak_winners:.1f}%  eod winners={eod_winners:.1f}%')

    # === Save ===
    v3.to_csv(OUT / 'outputs' / 'p11_flow_classified.csv', index=False)
    print(f'\nSaved → outputs/p11_flow_classified.csv')


if __name__ == '__main__':
    main()
