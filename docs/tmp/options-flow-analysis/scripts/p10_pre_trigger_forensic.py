"""Phase 10 — pre-trigger forensic.

For RBLX early-noise alerts (peak < 5 min after entry), extract the FULL
pre-trigger trajectory of:
  - Option price (per minute, 30 min before alert)
  - Cumulative volume (was it building?)
  - Underlying spot move (was the chain reacting to a spot move that
    started earlier?)
  - When did our trigger criteria FIRST start trending toward firing?

Hypothesis A: Real signal exists 5-15 min before alert (we fire too late)
Hypothesis B: No pre-trigger signal — chain genuinely just spikes from noise

If A, the trigger needs an earlier-firing version using rate-of-change
features. If B, the alerts on these tickers should be filtered out.
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at','underlying_symbol','option_chain_id','side','price','size',
        'underlying_price','implied_volatility','delta','open_interest','canceled']


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t','true','1'])


def main():
    # Identify RBLX early-noise alerts
    p8 = pd.read_csv(OUT / 'outputs' / 'p8_peak_features.csv')
    rblx_noise = p8.loc[
        (p8['underlying_symbol'] == 'RBLX')
        & (p8['time_to_peak_min'] < 5)
    ]
    print(f'RBLX early-noise alerts (<5 min to peak): {len(rblx_noise)}')

    # Also pull a sample of "developer" alerts on RBLX for comparison
    rblx_dev = p8.loc[
        (p8['underlying_symbol'] == 'RBLX')
        & (p8['time_to_peak_min'] >= 15)
    ]
    print(f'RBLX developer alerts (≥15 min to peak): {len(rblx_dev)}')

    # Get trigger metadata
    p3 = pd.read_csv(OUT / 'outputs' / 'p3_triggers.csv',
                     parse_dates=['date','trigger_time_ct'])
    p3 = p3[['option_chain_id','date','trigger_time_ct','strike','option_type',
             'open_interest','spot_at_trigger','entry_price','trigger_vol_to_oi',
             'trigger_iv','trigger_delta','trigger_ask_pct']]
    p3['date_str'] = p3['date'].dt.strftime('%Y-%m-%d')

    rblx_noise = rblx_noise.merge(p3, on=['option_chain_id'], how='left',
                                   suffixes=('','_p3'))
    rblx_dev = rblx_dev.merge(p3, on=['option_chain_id'], how='left',
                              suffixes=('','_p3'))

    # === Extract pre-trigger trajectory from parquets ===
    print('\nExtracting pre-trigger trajectories from parquet...')
    all_traj = {'noise': [], 'dev': []}

    for label, sample in [('noise', rblx_noise), ('dev', rblx_dev)]:
        for date_str, day_alerts in sample.groupby('date_str'):
            f = f'{DATA_DIR}/{date_str}-trades.parquet'
            try:
                t = pq.read_table(f, columns=COLS, filters=[('underlying_symbol','=','RBLX')])
            except Exception as e:
                print(f'  skip {date_str}: {e}')
                continue
            df = t.to_pandas()
            df['canceled'] = _coerce_canceled(df['canceled'])
            df = df.loc[~df['canceled'] & (df['price'] > 0)]
            df['option_chain_id'] = df['option_chain_id'].astype(str)
            df['side'] = df['side'].astype(str)
            df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')

            for _, row in day_alerts.iterrows():
                ch_id = row['option_chain_id']
                trig_time = pd.Timestamp(row['trigger_time_ct'])
                window_start = trig_time - pd.Timedelta(minutes=30)
                # Chain-specific prints in the pre-trigger window
                pre = df.loc[
                    (df['option_chain_id'] == ch_id)
                    & (df['ts_ct'] >= window_start)
                    & (df['ts_ct'] <= trig_time)
                ].sort_values('ts_ct')
                if len(pre) == 0:
                    continue

                # Bucket prints into 1-min buckets relative to trigger
                pre['min_before_trigger'] = (
                    (trig_time - pre['ts_ct']).dt.total_seconds() / 60
                ).round(0).astype(int)
                pre['min_before_trigger'] = pre['min_before_trigger'].clip(lower=0, upper=30)

                grouped = pre.groupby('min_before_trigger').agg(
                    n_prints=('price','size'),
                    total_size=('size','sum'),
                    avg_price=('price','mean'),
                    last_price=('price','last'),
                    n_ask=('side', lambda s: (s=='ask').sum()),
                    n_bid=('side', lambda s: (s=='bid').sum()),
                ).reset_index()

                all_traj[label].append({
                    'option_chain_id': ch_id,
                    'date': date_str,
                    'strike': row['strike'],
                    'option_type': row['option_type'],
                    'trigger_time': trig_time,
                    'trigger_entry_price': row['entry_price'],
                    'oi': row['open_interest'],
                    'spot': row['spot_at_trigger'],
                    'peak_return_pct': row['peak_return_pct'],
                    'time_to_peak': row['time_to_peak_min'],
                    'pre_30min_total_volume': pre['size'].sum(),
                    'pre_5min_total_volume': pre.loc[pre['min_before_trigger']<=5,'size'].sum(),
                    'pre_30min_n_prints': len(pre),
                    'pre_5min_n_prints': (pre['min_before_trigger']<=5).sum(),
                    'pre_30_to_15_volume': pre.loc[(pre['min_before_trigger']>=15)&(pre['min_before_trigger']<=30),'size'].sum(),
                    'pre_15_to_5_volume': pre.loc[(pre['min_before_trigger']>=5)&(pre['min_before_trigger']<15),'size'].sum(),
                    'price_30min_before': pre.loc[pre['min_before_trigger'].idxmax(),'price'] if len(pre) else np.nan,
                    'price_5min_before': pre.loc[pre['min_before_trigger']>=5,'price'].iloc[-1] if (pre['min_before_trigger']>=5).any() else np.nan,
                    'price_at_trigger': pre['price'].iloc[-1],
                    'minute_buckets': grouped.to_dict('records'),
                })

    print(f'  noise sample: {len(all_traj["noise"])}')
    print(f'  dev   sample: {len(all_traj["dev"])}')

    # === Aggregate analysis: were there pre-trigger build-ups? ===
    print('\n' + '=' * 70)
    print('=== AGGREGATE: NOISE alerts pre-trigger profile ===')
    print('=' * 70)
    if all_traj['noise']:
        ndf = pd.DataFrame(all_traj['noise'])
        print(f'\nMedian pre-30min volume: {ndf["pre_30min_total_volume"].median():.0f}')
        print(f'Median pre-5min volume:  {ndf["pre_5min_total_volume"].median():.0f}')
        print(f'Median pre-30min prints: {ndf["pre_30min_n_prints"].median():.0f}')
        print(f'Median pre-5min prints:  {ndf["pre_5min_n_prints"].median():.0f}')
        print(f'\nVolume distribution by window:')
        print(f'  pre 30-15min:  median={ndf["pre_30_to_15_volume"].median():.0f}')
        print(f'  pre 15-5min:   median={ndf["pre_15_to_5_volume"].median():.0f}')
        print(f'  pre 5min:      median={ndf["pre_5min_total_volume"].median():.0f}')
        print(f'\nPrice trajectory:')
        print(f'  Median price 30min before trigger: ${ndf["price_30min_before"].median():.3f}')
        print(f'  Median price 5min before trigger:  ${ndf["price_5min_before"].median():.3f}')
        print(f'  Median price at trigger:           ${ndf["price_at_trigger"].median():.3f}')
        print(f'  Median entry price:                ${ndf["trigger_entry_price"].median():.3f}')

    print('\n' + '=' * 70)
    print('=== AGGREGATE: DEVELOPER alerts pre-trigger profile ===')
    print('=' * 70)
    if all_traj['dev']:
        ddf = pd.DataFrame(all_traj['dev'])
        print(f'\nMedian pre-30min volume: {ddf["pre_30min_total_volume"].median():.0f}')
        print(f'Median pre-5min volume:  {ddf["pre_5min_total_volume"].median():.0f}')
        print(f'Median pre-30min prints: {ddf["pre_30min_n_prints"].median():.0f}')
        print(f'Median pre-5min prints:  {ddf["pre_5min_n_prints"].median():.0f}')
        print(f'\nVolume distribution by window:')
        print(f'  pre 30-15min:  median={ddf["pre_30_to_15_volume"].median():.0f}')
        print(f'  pre 15-5min:   median={ddf["pre_15_to_5_volume"].median():.0f}')
        print(f'  pre 5min:      median={ddf["pre_5min_total_volume"].median():.0f}')
        print(f'\nPrice trajectory:')
        print(f'  Median price 30min before trigger: ${ddf["price_30min_before"].median():.3f}')
        print(f'  Median price 5min before trigger:  ${ddf["price_5min_before"].median():.3f}')
        print(f'  Median price at trigger:           ${ddf["price_at_trigger"].median():.3f}')
        print(f'  Median entry price:                ${ddf["trigger_entry_price"].median():.3f}')

    # === Show 5 noise + 5 developer alerts in detail ===
    print('\n' + '=' * 70)
    print('=== TIME-DETAIL: 5 NOISE alerts (look for pre-trigger build-up) ===')
    print('=' * 70)
    for traj in all_traj['noise'][:5]:
        print(f'\n[{traj["date"]}] {traj["option_type"]} strike {traj["strike"]} entry@${traj["trigger_entry_price"]:.2f}, peak={traj["peak_return_pct"]:+.1f}% in {traj["time_to_peak"]:.1f}min')
        print(f'  Min before trigger | n_prints | volume | price')
        for b in sorted(traj['minute_buckets'], key=lambda x: -x['min_before_trigger']):
            ask_share = b['n_ask']/(b['n_ask']+b['n_bid']) * 100 if (b['n_ask']+b['n_bid'])>0 else 0
            print(f'    -{b["min_before_trigger"]:>3d}min       {b["n_prints"]:>4d}     {b["total_size"]:>5d}    ${b["last_price"]:.3f}  ask%={ask_share:.0f}')

    print('\n' + '=' * 70)
    print('=== TIME-DETAIL: 5 DEVELOPER alerts (compare profile) ===')
    print('=' * 70)
    for traj in all_traj['dev'][:5]:
        print(f'\n[{traj["date"]}] {traj["option_type"]} strike {traj["strike"]} entry@${traj["trigger_entry_price"]:.2f}, peak={traj["peak_return_pct"]:+.1f}% in {traj["time_to_peak"]:.1f}min')
        print(f'  Min before trigger | n_prints | volume | price')
        for b in sorted(traj['minute_buckets'], key=lambda x: -x['min_before_trigger']):
            ask_share = b['n_ask']/(b['n_ask']+b['n_bid']) * 100 if (b['n_ask']+b['n_bid'])>0 else 0
            print(f'    -{b["min_before_trigger"]:>3d}min       {b["n_prints"]:>4d}     {b["total_size"]:>5d}    ${b["last_price"]:.3f}  ask%={ask_share:.0f}')


if __name__ == '__main__':
    main()
