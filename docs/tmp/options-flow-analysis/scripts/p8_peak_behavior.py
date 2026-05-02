"""Phase 8 — peak behavior analysis.

For each v3 trigger, extract the full intraday post-entry trajectory and study:

  1. Time-to-peak distribution
  2. Max drawdown BEFORE peak (how much pain you have to endure)
  3. Post-peak decay (price at peak+5min, +15min, +30min, +60min, EoD)
  4. Behavior categories: cliff, slow_fade, chop, multi_peak
  5. Trailing stop backtest — find the % drawdown threshold that captures
     the most peak gain across the universe

Goal: design a real-time exit rule that can capture most of the peak
without requiring perfect timing.
"""
from __future__ import annotations

import glob
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

warnings.filterwarnings('ignore')
DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at', 'option_chain_id', 'price', 'canceled']


def _coerce_canceled(s):
    if s.dtype == bool: return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def extract_peak_features():
    trig = pd.read_csv(OUT / 'outputs' / 'p3_triggers.csv',
                       parse_dates=['date', 'trigger_time_ct'])
    trig['hour'] = trig['trigger_time_ct'].dt.hour + trig['trigger_time_ct'].dt.minute / 60
    trig['in_window'] = ((trig['hour'] >= 8.5) & (trig['hour'] < 9.5)) | ((trig['hour'] >= 11.5) & (trig['hour'] < 12.5))
    V3 = ['USAR','WMT','STX','SOUN','RIVN','TSM','SNDK','XOM','WDC','SQQQ',
          'NDXP','USO','TNA','RDDT','SMCI','TSLL','SNOW','TEAM','RKLB','SOFI',
          'RUTW','TSLA','SOXS','WULF','SLV','SMH','UBER','MSTR','TQQQ','RIOT',
          'SOXL','UNH','QQQ','RBLX']
    v3 = trig.loc[(trig['dte']==0) & trig['in_window'] & trig['underlying_symbol'].isin(V3)].copy()
    v3['date_str'] = v3['date'].dt.strftime('%Y-%m-%d')
    print(f'Extracting peak behavior for {len(v3):,} triggers')

    chains_by_day: dict[str, set[str]] = {}
    for d, ids in v3.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)

    rows = []
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in chains_by_day:
            continue
        target_chains = chains_by_day[date_str]
        print(f'  {date_str}: {len(target_chains)} chains', flush=True)
        t = pq.read_table(f, columns=COLS)
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled'] & (df['price'] > 0)]
        df['option_chain_id'] = df['option_chain_id'].astype(str)
        df = df.loc[df['option_chain_id'].isin(target_chains)]
        df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')

        day_triggers = v3.loc[v3['date_str'] == date_str].set_index('option_chain_id')
        for ch_id, g in df.groupby('option_chain_id'):
            if ch_id not in day_triggers.index:
                continue
            row = day_triggers.loc[ch_id]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            entry_time = pd.Timestamp(row['trigger_time_ct'])
            entry_price = float(row['entry_price'])
            g = g.sort_values('ts_ct').reset_index(drop=True)
            post = g.loc[g['ts_ct'] >= entry_time].copy()
            if len(post) < 3:
                continue

            # Peak
            peak_idx = post['price'].idxmax()
            peak_time = post.loc[peak_idx, 'ts_ct']
            peak_price = post.loc[peak_idx, 'price']
            time_to_peak = (peak_time - entry_time).total_seconds() / 60.0  # minutes

            # Max drawdown BEFORE peak
            pre_peak = post.loc[post['ts_ct'] <= peak_time]
            min_before_peak = pre_peak['price'].min()
            max_dd_before_peak_pct = (min_before_peak / entry_price - 1) * 100  # negative if drawdown

            # Post-peak trajectory
            post_peak = post.loc[post['ts_ct'] > peak_time]
            res = {
                'date': date_str,
                'option_chain_id': ch_id,
                'underlying_symbol': row['underlying_symbol'],
                'option_type': row['option_type'],
                'entry_price': entry_price,
                'peak_price': peak_price,
                'eod_price': float(post['price'].iloc[-1]),
                'time_to_peak_min': time_to_peak,
                'max_dd_before_peak_pct': max_dd_before_peak_pct,
                'peak_return_pct': (peak_price / entry_price - 1) * 100,
                'eod_return_pct': (post['price'].iloc[-1] / entry_price - 1) * 100,
            }

            # Price at peak+5/15/30/60/EoD as % of peak
            for h_min in [1, 5, 15, 30, 60, 120]:
                target = peak_time + pd.Timedelta(minutes=h_min)
                window = post_peak.loc[post_peak['ts_ct'] <= target]
                if len(window) > 0:
                    res[f'pct_of_peak_at_+{h_min}m'] = window['price'].iloc[-1] / peak_price * 100
                else:
                    res[f'pct_of_peak_at_+{h_min}m'] = np.nan
            res[f'pct_of_peak_at_eod'] = post['price'].iloc[-1] / peak_price * 100

            # Time from peak to lose 50% of peak gain (and to breakeven)
            peak_gain = peak_price - entry_price
            half_peak = entry_price + peak_gain * 0.5
            below_half = post_peak.loc[post_peak['price'] <= half_peak]
            res['min_to_lose_half_peak_gain'] = (below_half['ts_ct'].iloc[0] - peak_time).total_seconds() / 60.0 if len(below_half) > 0 else np.nan
            below_entry = post_peak.loc[post_peak['price'] <= entry_price]
            res['min_to_lose_all_peak_gain'] = (below_entry['ts_ct'].iloc[0] - peak_time).total_seconds() / 60.0 if len(below_entry) > 0 else np.nan

            # Was there a secondary peak (price returned to >=90% of peak after dropping <70%)?
            # Track maxes after the main peak
            after_peak_low_idx = post_peak['price'].idxmin() if len(post_peak) > 0 else None
            if after_peak_low_idx is not None:
                trough_after_peak = post_peak.loc[after_peak_low_idx, 'price']
                trough_pct_of_peak = trough_after_peak / peak_price * 100
                # Was there another peak ≥80% of original peak AFTER the trough?
                after_trough = post_peak.loc[post_peak.index > after_peak_low_idx]
                if len(after_trough) > 0:
                    secondary_peak_price = after_trough['price'].max()
                    res['has_secondary_peak'] = (secondary_peak_price / peak_price >= 0.80) and (trough_pct_of_peak < 70)
                    res['secondary_peak_pct'] = secondary_peak_price / peak_price * 100
                else:
                    res['has_secondary_peak'] = False
                    res['secondary_peak_pct'] = trough_pct_of_peak
            else:
                res['has_secondary_peak'] = False
                res['secondary_peak_pct'] = 100.0

            rows.append(res)

    out = pd.DataFrame(rows)
    out.to_csv(OUT / 'outputs' / 'p8_peak_features.csv', index=False)
    print(f'\nSaved {len(out):,} rows → outputs/p8_peak_features.csv')
    return out


def trailing_stop_backtest(df, stop_pcts):
    """For each trade, simulate a trailing stop at X% drawdown from running max."""
    print('\n' + '=' * 70)
    print('=== TRAILING STOP BACKTEST ===')
    print('=' * 70)
    print('Trailing stop = exit when price drops X% from the running max.')
    print('"Capture %" = realized exit / peak (perfect timing = 100%)')
    print()
    print(f'{"Stop %":<10s} {"Avg captured":<15s} {"Median capt":<15s} {"Avg ret %":<12s} {"Win %":<8s}')
    print('-' * 65)

    # We approximate trailing-stop exits using our existing data:
    # If trailing_stop_pct = X, and we know: peak_price, eod_price, secondary_peak_pct
    # The TS exit was triggered the FIRST time price dropped X% from the running max.
    # We don't have minute-by-minute series in the CSV — so we approximate:
    #   - If max_drawdown_before_peak_pct (which we have, but it's relative to ENTRY)
    #     was less than X, then trailing-stop wouldn't have fired before peak
    #   - Post-peak: use secondary_peak_pct vs the X% threshold
    # CAVEAT: this is approximate. For a precise number we'd need full trajectory.
    # Better: use the minute-snapshot columns from p4_exits.csv.

    # Simple approximation: assume capture = peak * (1 - stop_pct) if we sold on the FIRST X% drawdown
    # But we have to handle pre-peak drawdowns too.
    # If max_dd_before_peak <= -X (i.e., dropped X% from entry before peak), then trailing stop
    # fired BEFORE peak and we exited at a loss / lower price.
    for stop_pct in stop_pcts:
        ts_exit_pct = []
        for _, r in df.iterrows():
            entry = r['entry_price']
            peak = r['peak_price']
            # Track running max from entry. Simplified approximation:
            # The trailing stop fires if at any point price < (running_max * (1 - stop_pct/100))
            # Pre-peak: if max_dd_before_peak_pct < -stop_pct (i.e., dropped enough early), TS fires.
            #   Approximate exit = entry * (1 + max_dd_before_peak_pct/100) — no, better use
            #   entry_max * (1-stop_pct), but pre-peak running max could be entry itself for
            #   chains that drop right away
            # For chains where pre-peak drawdown is shallower than stop, TS fires post-peak.
            pre_dd = r['max_dd_before_peak_pct']  # negative
            if pre_dd < -stop_pct:
                # Stop fires before peak — exit at entry × (1 - stop_pct/100)
                # Approximation; real exit would be when running max × (1-stop_pct) is hit
                exit_price = entry * (1 - stop_pct / 100)
            else:
                # Stop fires post-peak when price drops stop_pct from peak
                exit_price = peak * (1 - stop_pct / 100)
            captured = (exit_price - entry) / (peak - entry) if peak > entry else 0
            ts_exit_pct.append({
                'exit_price': exit_price,
                'captured_pct_of_peak_gain': captured * 100,
                'ret_pct': (exit_price - entry) / entry * 100,
            })
        ts_df = pd.DataFrame(ts_exit_pct)
        avg_capt = ts_df['captured_pct_of_peak_gain'].mean()
        med_capt = ts_df['captured_pct_of_peak_gain'].median()
        avg_ret = ts_df['ret_pct'].mean()
        win_rate = (ts_df['ret_pct'] > 0).mean() * 100
        print(f'{stop_pct:>5.0f}%     {avg_capt:>10.1f}%     {med_capt:>10.1f}%     {avg_ret:>+7.2f}%   {win_rate:>5.1f}%')


def main():
    cache = OUT / 'outputs' / 'p8_peak_features.csv'
    if cache.exists():
        print(f'Loading cached features from {cache}')
        df = pd.read_csv(cache)
    else:
        df = extract_peak_features()

    print(f'\nLoaded {len(df):,} trades with peak trajectories')

    # === 1. Time to peak ===
    print('\n' + '=' * 70)
    print('=== 1. TIME-TO-PEAK distribution ===')
    print('=' * 70)
    bins = [-1, 0, 1, 5, 15, 30, 60, 120, 240, float('inf')]
    labels = ['<0','0-1m','1-5m','5-15m','15-30m','30-60m','60-120m','120-240m','>240m']
    df['ttp_bucket'] = pd.cut(df['time_to_peak_min'], bins=bins, labels=labels)
    counts = df['ttp_bucket'].value_counts().sort_index()
    for label, count in counts.items():
        bar = '█' * int(count / 15)
        pct = count / len(df) * 100
        print(f'  {str(label):<12s} {count:>5} ({pct:>4.1f}%) {bar}')
    print(f'\nMedian TTP: {df["time_to_peak_min"].median():.1f} min')
    print(f'Mean TTP:   {df["time_to_peak_min"].mean():.1f} min')

    # === 2. Max drawdown BEFORE peak ===
    print('\n' + '=' * 70)
    print('=== 2. MAX DRAWDOWN BEFORE PEAK ===')
    print('=' * 70)
    print('How much pain do you have to endure before the peak?')
    bins = [-101, -75, -50, -30, -20, -10, -5, 0, 1]
    labels = ['<-75%','-75 to -50%','-50 to -30%','-30 to -20%','-20 to -10%','-10 to -5%','-5 to 0%','>=0%']
    df['dd_bucket'] = pd.cut(df['max_dd_before_peak_pct'], bins=bins, labels=labels)
    counts = df['dd_bucket'].value_counts().sort_index()
    for label, count in counts.items():
        bar = '█' * int(count / 15)
        pct = count / len(df) * 100
        print(f'  {str(label):<14s} {count:>5} ({pct:>4.1f}%) {bar}')
    print(f'\nMedian pre-peak DD: {df["max_dd_before_peak_pct"].median():.1f}%')

    # === 3. Post-peak decay curve ===
    print('\n' + '=' * 70)
    print('=== 3. POST-PEAK DECAY: avg price as % of peak ===')
    print('=' * 70)
    decay_cols = ['pct_of_peak_at_+1m', 'pct_of_peak_at_+5m', 'pct_of_peak_at_+15m',
                  'pct_of_peak_at_+30m', 'pct_of_peak_at_+60m', 'pct_of_peak_at_+120m',
                  'pct_of_peak_at_eod']
    print(f'{"After peak":<14s} {"Median %":<12s} {"Mean %":<10s} {"% still ≥80% of peak"}')
    for col in decay_cols:
        s = df[col].dropna()
        med = s.median()
        mn = s.mean()
        pct_above_80 = (s >= 80).mean() * 100
        label = col.replace('pct_of_peak_at_', '')
        print(f'+{label:<12s} {med:>5.1f}%      {mn:>5.1f}%     {pct_above_80:>5.1f}%')

    # === 4. Time-from-peak metrics ===
    print('\n' + '=' * 70)
    print('=== 4. HOW FAST DOES PROFIT EVAPORATE? ===')
    print('=' * 70)
    s_half = df['min_to_lose_half_peak_gain'].dropna()
    s_all = df['min_to_lose_all_peak_gain'].dropna()
    print(f'Trades that EVER lose 50% of peak gain: {len(s_half):,} of {len(df):,} ({len(s_half)/len(df)*100:.1f}%)')
    print(f'  Median minutes from peak to lose half: {s_half.median():.1f} min')
    print(f'Trades that EVER lose 100% of peak gain: {len(s_all):,} of {len(df):,} ({len(s_all)/len(df)*100:.1f}%)')
    print(f'  Median minutes from peak to lose all:  {s_all.median():.1f} min')
    print(f'Trades that NEVER lose 50% of peak gain: {len(df) - len(s_half):,} ({(1-len(s_half)/len(df))*100:.1f}%)')
    print(f'Trades that NEVER lose 100% of peak gain: {len(df) - len(s_all):,} ({(1-len(s_all)/len(df))*100:.1f}%)')

    # === 5. Behavior categories ===
    print('\n' + '=' * 70)
    print('=== 5. POST-PEAK BEHAVIOR CATEGORIES ===')
    print('=' * 70)
    df['behavior'] = 'unknown'
    # Cliff: lose 50%+ of peak gain in first 5 min
    cliff = df['pct_of_peak_at_+5m'] <= 50
    df.loc[cliff, 'behavior'] = 'cliff (≥50% give-back in 5min)'
    # Slow fade: at peak+30m still ≥30% of peak gain
    slow_fade = (~cliff) & (df['pct_of_peak_at_+30m'] >= 50) & (df['pct_of_peak_at_+30m'] < 80)
    df.loc[slow_fade, 'behavior'] = 'slow fade (gradual decline)'
    # Holds: at peak+30m still ≥80% of peak
    holds = (~cliff) & (df['pct_of_peak_at_+30m'] >= 80)
    df.loc[holds, 'behavior'] = 'holds (stays near peak 30m+)'
    # Multi-peak: had a secondary peak ≥80% of original
    multi = (~cliff) & df['has_secondary_peak'].fillna(False)
    df.loc[multi & ~holds, 'behavior'] = 'multi-peak (re-tests high)'

    counts = df['behavior'].value_counts()
    for label, count in counts.items():
        bar = '█' * int(count / 15)
        pct = count / len(df) * 100
        print(f'  {label:<40s} {count:>5} ({pct:>4.1f}%) {bar}')

    # === 6. Trailing stop backtest ===
    trailing_stop_backtest(df, [10, 15, 20, 25, 30, 40, 50, 60, 70])


if __name__ == '__main__':
    main()
