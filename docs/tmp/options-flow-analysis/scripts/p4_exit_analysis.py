"""Phase 4 — exit-policy deep-dive on v3 alerts.

For each of the 1,600 v3 triggers, extract the full post-entry price
trajectory and compute:

  1. EoD price (hold-to-close return)
  2. Price at +1min, +5min, +15min, +30min, +60min, +120min after entry
  3. Drawdown depth (lowest price reached after entry)
  4. Time-to-peak

Then sweep TP thresholds (1.5x, 2x, 3x, 5x, 10x) and compute EV at each.

Output:
  - p4_exits.csv — per-trigger trajectory data
  - Summary tables for hold-to-close, optimal-TP, time-of-edge
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = [
    'executed_at', 'underlying_symbol', 'option_chain_id',
    'price', 'canceled',
]
HORIZONS_MIN = [1, 2, 5, 10, 15, 30, 60, 90, 120, 240]
TP_LEVELS = [1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.5, 10.0, 15.0, 20.0]


def _coerce_canceled(s):
    if s.dtype == bool: return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def main():
    # Load triggers
    trig = pd.read_csv(OUT / 'outputs' / 'p3_triggers.csv',
                       parse_dates=['date', 'trigger_time_ct'])
    trig['hour'] = trig['trigger_time_ct'].dt.hour + trig['trigger_time_ct'].dt.minute / 60
    trig['in_window'] = ((trig['hour'] >= 8.5) & (trig['hour'] < 9.5)) | ((trig['hour'] >= 11.5) & (trig['hour'] < 12.5))
    V3 = ['USAR','WMT','STX','SOUN','RIVN','TSM','SNDK','XOM','WDC','SQQQ',
          'NDXP','USO','TNA','RDDT','SMCI','TSLL','SNOW','TEAM','RKLB','SOFI',
          'RUTW','TSLA','SOXS','WULF','SLV','SMH','UBER','MSTR','TQQQ','RIOT',
          'SOXL','UNH','QQQ','RBLX']
    v3 = trig.loc[(trig['dte']==0) & trig['in_window'] & trig['underlying_symbol'].isin(V3)].copy()
    print(f'Processing {len(v3):,} v3 triggers...')

    # Build per-(date, chain) lookup
    v3['date_str'] = v3['date'].dt.strftime('%Y-%m-%d')
    chains_by_day: dict[str, set[str]] = {}
    for d, ids in v3.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)

    # For each day file, extract prints for the relevant chains
    all_results = []
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in chains_by_day:
            continue
        target_chains = chains_by_day[date_str]
        print(f'  {date_str}: {len(target_chains):,} chains', flush=True)
        t = pq.read_table(f, columns=COLS)
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled'] & (df['price'] > 0)]
        df['option_chain_id'] = df['option_chain_id'].astype(str)
        df = df.loc[df['option_chain_id'].isin(target_chains)]
        df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')

        # Per-chain trajectory
        day_triggers = v3.loc[v3['date_str'] == date_str].set_index('option_chain_id')
        for ch_id, g in df.groupby('option_chain_id'):
            if ch_id not in day_triggers.index: continue
            row = day_triggers.loc[ch_id]
            # Handle duplicate index (multiple triggers per chain — keep first)
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            entry_time = pd.Timestamp(row['trigger_time_ct'])
            entry_price = float(row['entry_price'])
            g = g.sort_values('ts_ct').reset_index(drop=True)
            post = g.loc[g['ts_ct'] >= entry_time].copy()
            if len(post) == 0:
                continue
            # Build trajectory
            res = {
                'date': date_str,
                'option_chain_id': ch_id,
                'entry_price': entry_price,
                'eod_price': float(post['price'].iloc[-1]),
                'max_price': float(post['price'].max()),
                'min_price': float(post['price'].min()),
            }
            res['eod_mult'] = res['eod_price'] / max(entry_price, 0.01)
            res['max_mult'] = res['max_price'] / max(entry_price, 0.01)
            res['min_mult'] = res['min_price'] / max(entry_price, 0.01)

            # Time to peak
            peak_idx = post['price'].idxmax()
            t_to_peak_sec = (post.loc[peak_idx, 'ts_ct'] - entry_time).total_seconds()
            res['min_to_peak'] = t_to_peak_sec / 60.0

            # Price at each horizon (last print at-or-before horizon)
            for h_min in HORIZONS_MIN:
                target = entry_time + pd.Timedelta(minutes=h_min)
                at_or_before = post.loc[post['ts_ct'] <= target]
                res[f'price_at_{h_min}m'] = float(at_or_before['price'].iloc[-1]) if len(at_or_before) > 0 else float(entry_price)
                res[f'mult_at_{h_min}m'] = res[f'price_at_{h_min}m'] / max(entry_price, 0.01)

            all_results.append(res)

    out = pd.DataFrame(all_results)
    out_csv = OUT / 'outputs' / 'p4_exits.csv'
    out.to_csv(out_csv, index=False)
    print(f'\nSaved → {out_csv}  ({len(out):,} rows)')

    # === ANALYSIS 1: Hold to end of day ===
    print('\n' + '=' * 80)
    print('=== ANALYSIS 1: Hold to end-of-day ===')
    print('=' * 80)
    out['eod_pnl'] = ((out['eod_mult'] - 1) * 100).clip(lower=-100)
    print(f'Win rate (eod > entry): {(out["eod_mult"] > 1).mean()*100:.1f}%')
    print(f'Avg P&L per trade ($100/trade): ${out["eod_pnl"].mean():.2f}')
    print(f'Total P&L: ${out["eod_pnl"].sum():,.0f}')
    print(f'Median EoD multiple: {out["eod_mult"].median():.3f}x')
    print(f'Mean EoD multiple:   {out["eod_mult"].mean():.3f}x')
    print()
    print('EoD outcome distribution:')
    bins = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, float('inf')]
    labels = ['<25%','25-50%','50-75%','75-100%','100-150%','150-200%','200-300%','300-500%','500%+']
    out['eod_bucket'] = pd.cut(out['eod_mult'], bins=bins, labels=labels)
    eod_dist = out['eod_bucket'].value_counts().sort_index()
    for label, count in eod_dist.items():
        bar = '█' * int(count / 15)
        print(f'  {str(label):<10s} {count:>4} ({count/len(out)*100:>4.1f}%) {bar}')

    # === ANALYSIS 2: Optimal TP threshold ===
    print('\n' + '=' * 80)
    print('=== ANALYSIS 2: Optimal Take-Profit threshold ===')
    print('=' * 80)
    print(f'For each TP level: assume you exit at TP if max_price/entry hits TP, else EoD')
    print()
    print(f'{"TP":<8} {"% trades hit TP":<18} {"avg P&L":<12} {"total P&L":<14} {"P&L vs uncapped":<18}')
    pnl_uncapped = out['eod_pnl'].sum()
    for tp in TP_LEVELS:
        hit_tp = out['max_mult'] >= tp
        pnl = np.where(hit_tp, (tp - 1) * 100, out['eod_pnl'])
        avg_pnl = pnl.mean()
        total = pnl.sum()
        print(f'{tp:>4.2f}x   {hit_tp.mean()*100:>5.1f}%             ${avg_pnl:>5.0f}        ${total:>8,.0f}     {(total-pnl_uncapped)/abs(pnl_uncapped)*100:+.1f}%')
    print()
    print(f'(EoD baseline: ${pnl_uncapped:,.0f}, ${out["eod_pnl"].mean():.0f}/trade)')

    # === ANALYSIS 3: Time-of-edge (when does profitability die?) ===
    print('\n' + '=' * 80)
    print('=== ANALYSIS 3: How long does the edge last? ===')
    print('=' * 80)
    print(f'For each horizon, % of trades that are above breakeven:')
    print()
    print(f'{"Horizon":<12} {"% above 1x":<14} {"% above 1.5x":<16} {"% above 2x":<14} {"avg mult":<12} {"median mult"}')
    for h_min in HORIZONS_MIN:
        col = f'mult_at_{h_min}m'
        above_1 = (out[col] > 1.0).mean() * 100
        above_15 = (out[col] >= 1.5).mean() * 100
        above_2 = (out[col] >= 2.0).mean() * 100
        avg = out[col].mean()
        med = out[col].median()
        print(f'+{h_min}min       {above_1:>5.1f}%         {above_15:>5.1f}%           {above_2:>5.1f}%         {avg:>5.2f}x       {med:>5.2f}x')
    above_1_eod = (out['eod_mult'] > 1.0).mean() * 100
    above_15_eod = (out['eod_mult'] >= 1.5).mean() * 100
    above_2_eod = (out['eod_mult'] >= 2.0).mean() * 100
    print(f'EoD          {above_1_eod:>5.1f}%         {above_15_eod:>5.1f}%           {above_2_eod:>5.1f}%         {out["eod_mult"].mean():>5.2f}x       {out["eod_mult"].median():>5.2f}x')

    # === ANALYSIS 4: Time to peak ===
    print('\n' + '=' * 80)
    print('=== ANALYSIS 4: Time-to-peak distribution ===')
    print('=' * 80)
    bins = [0, 1, 5, 15, 30, 60, 120, 240, float('inf')]
    labels = ['<1min','1-5min','5-15min','15-30min','30-60min','60-120min','120-240min','>240min']
    out['t_to_peak_bucket'] = pd.cut(out['min_to_peak'], bins=bins, labels=labels)
    print('Time from entry to peak price:')
    for label, count in out['t_to_peak_bucket'].value_counts().sort_index().items():
        pct = count / len(out) * 100
        bar = '█' * int(pct / 2)
        print(f'  {str(label):<12s} {count:>4} ({pct:>4.1f}%) {bar}')
    print(f'\nMedian time-to-peak: {out["min_to_peak"].median():.1f} min')
    print(f'Mean time-to-peak:   {out["min_to_peak"].mean():.1f} min')


if __name__ == '__main__':
    main()
