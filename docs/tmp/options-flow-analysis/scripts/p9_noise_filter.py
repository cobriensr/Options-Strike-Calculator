"""Phase 9 — save per-ticker TTP reference + find filters that eliminate
"immediate peak" noise alerts.

Goal: cut the 24% of alerts that peak in <5 minutes (median peak +7%, EoD
-97%). These are useless — trader can't execute fast enough, profit is tiny
even if caught.

Approach:
  1. Save per-ticker TTP reference table (markdown + CSV)
  2. Univariate: what features distinguish early peakers (<5 min) from
     late peakers (≥15 min)?
  3. Build AND-filters that remove the noise without dropping good trades
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def main():
    # === Load all features ===
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

    p8 = pd.read_csv(OUT / 'outputs' / 'p8_peak_features.csv')
    p8['date_str'] = p8['date'].astype(str)
    p8 = p8[['option_chain_id','date_str','time_to_peak_min','peak_return_pct',
             'eod_return_pct','max_dd_before_peak_pct']]
    df = v3.merge(p8, on=['option_chain_id','date_str'], how='left').drop_duplicates(subset=['option_chain_id','date_str']).dropna(subset=['time_to_peak_min'])

    # Add cascade
    df['minute_bucket'] = df['trigger_time_ct'].dt.floor('5min')
    cascade = df.groupby(['underlying_symbol','minute_bucket']).size().reset_index(name='cascade_count')
    df = df.merge(cascade, on=['underlying_symbol','minute_bucket'], how='left')
    df['cascade_count'] -= 1

    # Add directional_rp
    rp = pd.read_csv(OUT / 'outputs' / 'p6d_directional_rp.csv')
    df = df.merge(rp[['option_chain_id','date_str','directional_rp']],
                  on=['option_chain_id','date_str'], how='left')
    df['directional_rp'] = df['directional_rp'].fillna(0.5)

    df['log_oi'] = np.log1p(df['open_interest'].clip(lower=0))
    df['log_vol_oi'] = np.log1p(df['trigger_vol_to_oi'])
    df['abs_otm'] = ((df['strike'] - df['spot_at_trigger']) / df['spot_at_trigger']).abs() * 100
    df['log_entry_price'] = np.log1p(df['entry_price'])

    # Label: early peaker (noise) vs late peaker (good)
    df['is_early_noise'] = (df['time_to_peak_min'] < 5).astype(int)
    df['is_developer'] = (df['time_to_peak_min'] >= 15).astype(int)

    print(f'Loaded {len(df):,} trades')
    print(f'Early peakers (<5 min, NOISE): {df["is_early_noise"].sum()} ({df["is_early_noise"].mean()*100:.1f}%)')
    print(f'Late developers (≥15 min):     {df["is_developer"].sum()} ({df["is_developer"].mean()*100:.1f}%)')

    # === STEP 1: Save per-ticker TTP reference ===
    print('\n=== Saving per-ticker TTP reference ===')
    ref = df.groupby('underlying_symbol').agg(
        n=('time_to_peak_min','size'),
        median_ttp_min=('time_to_peak_min','median'),
        median_peak_ret_pct=('peak_return_pct','median'),
        median_pre_peak_dd_pct=('max_dd_before_peak_pct','median'),
        pct_noise_lt5min=('is_early_noise', lambda s: s.mean()*100),
        pct_developer_gt15min=('is_developer', lambda s: s.mean()*100),
        pct_late_gt60min=('time_to_peak_min', lambda s: (s>=60).mean()*100),
    ).round(1).sort_values('median_peak_ret_pct', ascending=False)

    # Categorize
    def categorize(r):
        if r['median_ttp_min'] < 20 and r['median_peak_ret_pct'] >= 50:
            return 'fast_clean'  # quick + sizeable
        if r['median_ttp_min'] >= 60 and r['median_peak_ret_pct'] >= 40:
            return 'patient'  # slow + sizeable
        if r['pct_noise_lt5min'] >= 50:
            return 'noise_heavy'  # mostly noise
        if r['pct_noise_lt5min'] >= 30 and r['pct_late_gt60min'] >= 30:
            return 'bimodal'  # noise + late peakers
        return 'standard'
    ref['category'] = ref.apply(categorize, axis=1)
    ref.to_csv(OUT / 'outputs' / 'p9_ticker_reference.csv')
    print(ref.to_string())
    print(f'\nSaved → outputs/p9_ticker_reference.csv')

    # === STEP 2: Univariate analysis — what predicts EARLY NOISE? ===
    print('\n' + '=' * 75)
    print('=== STEP 2: Features that distinguish EARLY NOISE (<5min) from DEVELOPERS (≥15min) ===')
    print('=' * 75)

    devs = df[df['is_developer']==1]
    noise = df[df['is_early_noise']==1]
    print(f'\n{"Feature":<24s} {"Noise median":<14s} {"Dev median":<14s} {"Δ":<10s} {"Direction"}')
    print('-' * 80)
    for feat in ['trigger_vol_to_oi','log_vol_oi','trigger_iv','trigger_delta',
                 'trigger_ask_pct','hour','abs_otm','log_entry_price','log_oi',
                 'cascade_count','directional_rp']:
        n_med = noise[feat].median()
        d_med = devs[feat].median()
        delta = d_med - n_med
        direction = 'developer ↑' if delta > 0 else ('noise ↑' if delta < -0.001 else '~same')
        print(f'{feat:<24s} {n_med:>10.3f}    {d_med:>10.3f}    {delta:>+8.3f}  {direction}')

    # Quintile analysis on top discriminators
    print('\n=== Quintile analysis: % NOISE in each quintile (lower = better) ===')
    for feat in ['cascade_count','log_oi','log_vol_oi','hour','abs_otm']:
        df['_q'] = pd.qcut(df[feat].rank(method='first'), 5, labels=['Q1','Q2','Q3','Q4','Q5'])
        s = df.groupby('_q', observed=True).agg(
            n=('is_early_noise','size'),
            pct_noise=('is_early_noise', lambda s: s.mean()*100),
            pct_developer=('is_developer', lambda s: s.mean()*100),
            median_peak=('peak_return_pct','median'),
            fmin=(feat,'min'),
            fmax=(feat,'max'),
        ).round(2)
        spread_noise = s['pct_noise'].max() - s['pct_noise'].min()
        print(f'\n{feat}  (Q5−Q1 noise spread: {spread_noise:+.1f} pts)')
        print(s.to_string())

    # === STEP 3: AND-rule filters to remove noise ===
    print('\n' + '=' * 75)
    print('=== STEP 3: AND-rule filters — keep alerts likely to be developers ===')
    print('=' * 75)
    print('\nGoal: a filter that REJECTS most noise, KEEPS most developers.')
    print('Metric: noise_rejection_rate × developer_keep_rate')
    print()

    rules = {
        'cascade_count >= 1':  df['cascade_count'] >= 1,
        'cascade_count >= 2':  df['cascade_count'] >= 2,
        'log_oi >= 6':         df['log_oi'] >= 6,
        'log_oi >= 7':         df['log_oi'] >= 7,
        'log_vol_oi <= 0.5':   df['log_vol_oi'] <= 0.5,
        'directional_rp >= 0.7': df['directional_rp'] >= 0.7,
        'abs_otm >= 1':        df['abs_otm'] >= 1,
        'abs_otm <= 5':        df['abs_otm'] <= 5,
        'hour >= 8.7':         df['hour'] >= 8.7,
    }
    print(f'{"Rule":<30s} {"Kept":<8s} {"Noise%":<10s} {"Dev%":<10s} {"NoiseRej":<10s} {"DevKeep":<10s}')
    base_noise_count = df['is_early_noise'].sum()
    base_dev_count = df['is_developer'].sum()
    for name, mask in rules.items():
        kept = df[mask]
        n_noise_in_kept = kept['is_early_noise'].sum()
        n_dev_in_kept = kept['is_developer'].sum()
        noise_rej_pct = (1 - n_noise_in_kept/base_noise_count) * 100
        dev_keep_pct = n_dev_in_kept / base_dev_count * 100
        kept_pct = len(kept)/len(df)*100
        in_kept_noise_pct = n_noise_in_kept/len(kept)*100 if len(kept) else 0
        in_kept_dev_pct = n_dev_in_kept/len(kept)*100 if len(kept) else 0
        print(f'{name:<30s} {kept_pct:>5.1f}%  {in_kept_noise_pct:>5.1f}%    {in_kept_dev_pct:>5.1f}%   {noise_rej_pct:>5.1f}%    {dev_keep_pct:>5.1f}%')

    # AND combinations
    print('\n=== AND-combinations of 2-3 rules (sorted by noise rejection × dev keep) ===')
    from itertools import combinations
    rule_keys = list(rules.keys())
    combos = []
    for k in [2, 3]:
        for combo in combinations(rule_keys, k):
            mask = pd.Series(True, index=df.index)
            for r in combo:
                mask &= rules[r]
            kept = df[mask]
            if len(kept) < 100:
                continue
            n_noise = kept['is_early_noise'].sum()
            n_dev = kept['is_developer'].sum()
            noise_rej = (1 - n_noise/base_noise_count) * 100
            dev_keep = n_dev/base_dev_count * 100
            combos.append({
                'k': k,
                'combo': ' AND '.join(combo),
                'kept_n': len(kept),
                'kept_pct': len(kept)/len(df)*100,
                'noise_pct_of_kept': n_noise/len(kept)*100,
                'dev_pct_of_kept': n_dev/len(kept)*100,
                'noise_reject_rate': noise_rej,
                'developer_keep_rate': dev_keep,
                'score': dev_keep - (n_noise/len(kept)*100),  # custom: keep developers, exclude noise
            })
    cdf = pd.DataFrame(combos).sort_values('score', ascending=False).head(15)
    print(f'\n{"Combo":<70s} {"n":<7s} {"%kept":<7s} {"noise%":<8s} {"dev%":<7s} {"score"}')
    for _, r in cdf.iterrows():
        print(f'{r["combo"]:<70s} {r["kept_n"]:<6d} {r["kept_pct"]:<6.1f}% {r["noise_pct_of_kept"]:<6.1f}%  {r["dev_pct_of_kept"]:<5.1f}%   {r["score"]:+.1f}')

    # Best combo's effect on overall metrics
    print('\n=== EFFECT OF TOP NOISE-REJECTION FILTER ON FULL METRICS ===')
    if len(cdf):
        best = cdf.iloc[0]
        combo = best['combo'].split(' AND ')
        mask = pd.Series(True, index=df.index)
        for r in combo:
            mask &= rules[r]
        filtered = df[mask]
        print(f'Filter: {best["combo"]}')
        print(f'Kept {len(filtered)} of {len(df)} trades ({len(filtered)/len(df)*100:.1f}%)')
        print(f'\nBaseline (all alerts):')
        print(f'  Median TTP: {df["time_to_peak_min"].median():.1f} min')
        print(f'  Median peak return: {df["peak_return_pct"].median():.1f}%')
        print(f'  Median EoD return: {df["eod_return_pct"].median():.1f}%')
        print(f'\nWith filter:')
        print(f'  Median TTP: {filtered["time_to_peak_min"].median():.1f} min')
        print(f'  Median peak return: {filtered["peak_return_pct"].median():.1f}%')
        print(f'  Median EoD return: {filtered["eod_return_pct"].median():.1f}%')

    # === Save ticker reference as markdown ===
    md_path = OUT / 'outputs' / 'p9_ticker_reference.md'
    with open(md_path, 'w') as f:
        f.write('# Per-Ticker TTP Reference (15 trade days, v3 alerts only)\n\n')
        f.write('| Ticker | n | Median TTP | Median peak ret | Pre-peak DD | % noise <5m | % dev ≥15m | % late ≥60m | Category |\n')
        f.write('|---|---:|---:|---:|---:|---:|---:|---:|---|\n')
        for tk, r in ref.iterrows():
            f.write(f'| {tk} | {int(r["n"])} | {r["median_ttp_min"]:.0f} min | {r["median_peak_ret_pct"]:+.0f}% | {r["median_pre_peak_dd_pct"]:.0f}% | {r["pct_noise_lt5min"]:.0f}% | {r["pct_developer_gt15min"]:.0f}% | {r["pct_late_gt60min"]:.0f}% | {r["category"]} |\n')
        f.write('\n## Categories\n\n')
        f.write('- **fast_clean**: median TTP < 20min AND median peak ≥ 50% — fast pop, decent size\n')
        f.write('- **patient**: median TTP ≥ 60min AND median peak ≥ 40% — slow grinder, big winner\n')
        f.write('- **noise_heavy**: ≥50% of alerts peak in <5min — likely tradeable rarely\n')
        f.write('- **bimodal**: ≥30% noise AND ≥30% late peakers — needs a filter to separate the two\n')
        f.write('- **standard**: everything else\n')
    print(f'\nSaved → outputs/p9_ticker_reference.md')


if __name__ == '__main__':
    main()
