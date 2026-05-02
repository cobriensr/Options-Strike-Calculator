"""Phase 13 — Q1 (PM call winners) + Q3 (mixed-flow alerts).

Q1: What discriminates PM CALL winners from PM CALL duds?
    Median PM call peak is only +8%, but SNDK 1175C today fired ~2pm
    and went $0.30 → $15+ (50x). What features did the winners share?

Q3: Are MIXED-side alerts (0.40 < ask% < 0.60, e.g. TSLA 392.5/395 calls,
    SPY 712/714 calls) worth alerting on? Specifically: does HIGH burst
    volume offset lack of side conviction?

Definitions (no silent metric drift):
- "Winner" for Q1 = peak_return_pct >= 50 within day
- "Burst features" come from p11 (1-min window before trigger)
- All metrics per CONTRACT
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def main():
    p11 = pd.read_csv(OUT / 'outputs' / 'p11_flow_classified.csv',
                      parse_dates=['date', 'trigger_time_ct'])
    print(f'Loaded {len(p11):,} v3 alerts')

    # ============================================================
    # Q1 — PM CALL discriminator
    # ============================================================
    print('\n' + '=' * 80)
    print('=== Q1: PM CALL winners vs duds ===')
    print('=' * 80)
    pm_calls = p11.loc[(p11['option_type'] == 'call') & (p11['tod'] == 'PM_open')].copy()
    print(f'PM call alerts: {len(pm_calls)}')
    print(f'  put_ask:   {(pm_calls["flow_quad"]=="call_ask").sum()}')
    print(f'  put_bid:   {(pm_calls["flow_quad"]=="call_bid").sum()}')
    print(f'  put_mixed: {(pm_calls["flow_quad"]=="call_mixed").sum()}')

    # Define winner threshold
    pm_calls['big_winner'] = pm_calls['peak_return_pct'] >= 50
    pm_calls['mod_winner'] = pm_calls['peak_return_pct'] >= 25
    pm_calls['noise'] = pm_calls['time_to_peak_min'] < 5
    n_big = pm_calls['big_winner'].sum()
    n_mod = pm_calls['mod_winner'].sum()
    n_noise = pm_calls['noise'].sum()
    print(f'\nBig winners (peak ≥+50%): {n_big} ({n_big/len(pm_calls)*100:.1f}%)')
    print(f'Mod winners (peak ≥+25%): {n_mod} ({n_mod/len(pm_calls)*100:.1f}%)')
    print(f'Noise (peak <5 min):       {n_noise} ({n_noise/len(pm_calls)*100:.1f}%)')

    # Profile big winners vs the rest
    feat_cols = [
        'trigger_vol_to_oi', 'trigger_iv', 'trigger_delta', 'trigger_ask_pct',
        'open_interest', 'entry_price', 'spot_at_trigger',
        'burst_n_prints', 'burst_total_volume', 'burst_ask_pct_volume',
        'burst_n_distinct_prices', 'burst_largest_print', 'burst_largest_print_pct',
        'hour',
    ]

    print('\n--- Feature comparison: BIG WINNERS (peak ≥+50%) vs DUDS (peak <+25%) ---')
    big = pm_calls.loc[pm_calls['big_winner']]
    dud = pm_calls.loc[~pm_calls['mod_winner']]
    print(f'Big winners n={len(big)}, Duds n={len(dud)}')
    print(f'\n{"feature":<28s} {"BIG median":>12s} {"DUD median":>12s} {"ratio":>8s}')
    for c in feat_cols:
        if c not in pm_calls.columns:
            continue
        b = big[c].median()
        d = dud[c].median()
        ratio = b / d if d not in (0, np.nan) and not pd.isna(d) else np.nan
        print(f'{c:<28s} {b:>12.4f} {d:>12.4f} {ratio:>8.2f}')

    # Identify top 5 big winners for detail inspection
    print('\n--- Top 10 BIG WINNERS detail (sanity check vs SNDK example) ---')
    top = pm_calls.sort_values('peak_return_pct', ascending=False).head(10)
    cols = ['date', 'underlying_symbol', 'strike', 'hour', 'flow_quad',
            'entry_price', 'peak_return_pct', 'time_to_peak_min',
            'burst_total_volume', 'burst_largest_print_pct', 'trigger_vol_to_oi']
    print(top[cols].to_string(index=False))

    # Univariate quintile sweep — find features that separate winners from duds
    print('\n--- Univariate quintile sweep (peak return median by quintile) ---')
    for c in ['burst_total_volume', 'burst_ask_pct_volume', 'burst_largest_print_pct',
              'trigger_vol_to_oi', 'trigger_delta', 'entry_price']:
        if c not in pm_calls.columns:
            continue
        try:
            pm_calls['_q'] = pd.qcut(pm_calls[c].rank(method='first'), 5,
                                     labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
        except ValueError:
            continue
        s = pm_calls.groupby('_q', observed=True).agg(
            n=('peak_return_pct', 'size'),
            median_thresh=(c, 'median'),
            median_peak=('peak_return_pct', 'median'),
            pct_big=('big_winner', lambda s: s.mean() * 100),
            pct_noise=('noise', lambda s: s.mean() * 100),
        ).round(2)
        print(f'\n{c}:')
        print(s.to_string())

    # ============================================================
    # Q3 — MIXED alert value (high volume vs low volume)
    # ============================================================
    print('\n\n' + '=' * 80)
    print('=== Q3: Are MIXED alerts (0.40<ask%<0.60) worth alerting on? ===')
    print('=' * 80)
    print('Compares MIXED vs ASK-DOMINANT vs BID-DOMINANT within option type,')
    print('then segments mixed by burst_total_volume to test if HIGH-volume')
    print('mixed alerts have an edge.\n')

    # Overall comparison
    print('--- Side-vs-side within option type (median peak, win rate) ---')
    print(f'{"flow_quad":<15s} {"n":>5s} {"med peak":>10s} {"med vol":>10s} '
          f'{"win%":>7s} {"big%":>7s} {"noise%":>8s} {"med EoD":>10s}')
    for q, g in p11.groupby('flow_quad'):
        n = len(g)
        med_peak = g['peak_return_pct'].median()
        med_vol = g['burst_total_volume'].median()
        win = (g['peak_return_pct'] > 0).mean() * 100
        big = (g['peak_return_pct'] >= 50).mean() * 100
        noise = (g['time_to_peak_min'] < 5).mean() * 100
        med_eod = g['eod_return_pct'].median()
        print(f'{q:<15s} {n:>5d} {med_peak:>+9.1f}% {med_vol:>10.0f} '
              f'{win:>6.1f}% {big:>6.1f}% {noise:>7.1f}% {med_eod:>+9.1f}%')

    # Mixed alerts — segment by burst total volume (within each option type)
    print('\n--- MIXED alerts: does HIGH burst_total_volume offset side ambiguity? ---')
    for opt_type in ['call', 'put']:
        sub = p11.loc[(p11['option_type'] == opt_type) &
                       (p11['burst_dominant_side'] == 'mixed')].copy()
        if len(sub) < 20:
            continue
        sub['_vq'] = pd.qcut(sub['burst_total_volume'].rank(method='first'),
                             min(5, sub['burst_total_volume'].nunique()),
                             labels=False, duplicates='drop')
        print(f'\n{opt_type.upper()} mixed alerts (n={len(sub)}):')
        print(f'{"vol quintile":<15s} {"n":>5s} {"med vol":>10s} {"med peak":>10s} '
              f'{"win%":>7s} {"big%":>7s} {"noise%":>8s} {"med EoD":>10s}')
        for q, g in sub.groupby('_vq', observed=True):
            n = len(g)
            med_peak = g['peak_return_pct'].median()
            med_vol = g['burst_total_volume'].median()
            win = (g['peak_return_pct'] > 0).mean() * 100
            big = (g['peak_return_pct'] >= 50).mean() * 100
            noise = (g['time_to_peak_min'] < 5).mean() * 100
            med_eod = g['eod_return_pct'].median()
            print(f'Q{int(q)+1:<14d} {n:>5d} {med_vol:>10.0f} {med_peak:>+9.1f}% '
                  f'{win:>6.1f}% {big:>6.1f}% {noise:>7.1f}% {med_eod:>+9.1f}%')

    # Side-by-side: high-vol mixed vs typical ask-dominant
    print('\n--- HIGH-VOLUME MIXED vs ASK-DOMINANT (direct comparison per option type) ---')
    for opt_type in ['call', 'put']:
        sub = p11.loc[p11['option_type'] == opt_type].copy()
        # Define "high-volume mixed" = mixed and burst_total_volume in top 40% of mixed
        mixed_sub = sub.loc[sub['burst_dominant_side'] == 'mixed']
        if len(mixed_sub) < 20:
            continue
        vol_thresh = mixed_sub['burst_total_volume'].quantile(0.60)
        groups = {
            f'{opt_type}_mixed_HIGH_vol (>{vol_thresh:.0f})':
                sub.loc[(sub['burst_dominant_side'] == 'mixed') &
                         (sub['burst_total_volume'] >= vol_thresh)],
            f'{opt_type}_mixed_LOW_vol (≤{vol_thresh:.0f})':
                sub.loc[(sub['burst_dominant_side'] == 'mixed') &
                         (sub['burst_total_volume'] < vol_thresh)],
            f'{opt_type}_ask (all)':
                sub.loc[sub['burst_dominant_side'] == 'ask'],
            f'{opt_type}_bid (all)':
                sub.loc[sub['burst_dominant_side'] == 'bid'],
        }
        print(f'\n{opt_type.upper()}:')
        print(f'{"group":<40s} {"n":>5s} {"med peak":>10s} {"win%":>7s} '
              f'{"big%":>7s} {"noise%":>8s} {"med EoD":>10s}')
        for label, g in groups.items():
            if len(g) == 0:
                continue
            n = len(g)
            med_peak = g['peak_return_pct'].median()
            win = (g['peak_return_pct'] > 0).mean() * 100
            big = (g['peak_return_pct'] >= 50).mean() * 100
            noise = (g['time_to_peak_min'] < 5).mean() * 100
            med_eod = g['eod_return_pct'].median()
            print(f'{label:<40s} {n:>5d} {med_peak:>+9.1f}% {win:>6.1f}% '
                  f'{big:>6.1f}% {noise:>7.1f}% {med_eod:>+9.1f}%')

    # Find recent mixed-call alerts (TSLA, SPY) for sanity check
    print('\n--- RECENT mixed CALL alerts on TSLA / SPY (sanity check vs user examples) ---')
    recent_mixed = p11.loc[(p11['flow_quad'] == 'call_mixed') &
                            (p11['underlying_symbol'].isin(['TSLA', 'SPY', 'QQQ']))].copy()
    recent_mixed = recent_mixed.sort_values(['date', 'underlying_symbol'], ascending=False)
    cols = ['date', 'underlying_symbol', 'strike', 'flow_quad', 'hour',
            'entry_price', 'peak_return_pct', 'time_to_peak_min',
            'burst_total_volume', 'burst_ask_pct_volume', 'burst_largest_print_pct']
    avail = [c for c in cols if c in recent_mixed.columns]
    print(recent_mixed[avail].head(15).to_string(index=False))


if __name__ == '__main__':
    main()
