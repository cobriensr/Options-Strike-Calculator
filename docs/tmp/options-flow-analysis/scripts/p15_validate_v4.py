"""Phase 15 — validate v4 trigger set + test alert_seq hypothesis.

Three checks:
  1) Did v4 actually catch the SNDK 1175C 5/1 13:45 re-entry that v3 missed?
  2) Does alert_seq carry signal? Compare 1st fires vs 2nd+ fires on the
     same chain. If repetition predicts higher win rate, "stay/add" is a
     real coded signal worth surfacing in live.
  3) For analysis: tag the BEST entry per (date, chain) — defined as the
     fire with the highest realized_multiple_eod — and profile what
     distinguishes it from sibling fires on the same chain.

Definitions (no silent metric drift):
  * "alert_seq" = 1 means first fire on that chain on that day; 2 means
    second fire; etc. Within-chain ordering only.
  * "win" = realized_multiple_eod >= 2.0 (chain at least doubled at EoD peak)
  * "big_win" = realized_multiple_eod >= 5.0 (5x+ explosive)
  * "best entry" = within (date, chain), the fire with max realized_multiple_eod
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} v4 fires across {df["option_chain_id"].nunique():,} unique chains')
    df['date_str'] = df['date'].dt.strftime('%Y-%m-%d')

    # ============================================================
    # Check 1: SNDK 1175C 5/1 — did v4 catch the 13:45 re-entry?
    # ============================================================
    print('\n' + '=' * 80)
    print('=== CHECK 1: SNDK 1175C 0DTE on 2026-05-01 — v4 fires ===')
    print('=' * 80)
    sndk = df.loc[
        (df['underlying_symbol'] == 'SNDK')
        & (df['date_str'] == '2026-05-01')
        & (df['strike'] == 1175)
        & (df['option_type'] == 'call')
        & (df['dte'] == 0)
    ].sort_values('trigger_time_ct')
    print(f'v4 fires for SNDK 1175C 0DTE 5/1: {len(sndk)}')
    if len(sndk) > 0:
        cols = ['alert_seq', 'trigger_time_ct', 'entry_price',
                'future_max_30min', 'future_max_to_eod',
                'realized_multiple_30', 'realized_multiple_eod',
                'minutes_to_peak_eod', 'minutes_since_prev_fire',
                'trigger_vol_to_oi_window', 'trigger_ask_pct']
        print(sndk[cols].to_string(index=False))

    # Compare to v3
    print('\n--- v3 (for contrast) — first/only trigger ---')
    p3 = pd.read_csv(OUT / 'outputs' / 'p3_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct'])
    p3_sndk = p3.loc[(p3['underlying_symbol'] == 'SNDK') &
                     (p3['date'].dt.strftime('%Y-%m-%d') == '2026-05-01') &
                     (p3['strike'] == 1175) & (p3['option_type'] == 'call') &
                     (p3['dte'] == 0)]
    cols3 = ['trigger_time_ct', 'entry_price', 'future_max',
             'realized_multiple', 'trigger_vol_to_oi', 'trigger_ask_pct']
    print(p3_sndk[cols3].to_string(index=False))

    # ============================================================
    # Check 2: Distribution of fires per chain
    # ============================================================
    print('\n' + '=' * 80)
    print('=== CHECK 2: How many fires per (date, chain)? ===')
    print('=' * 80)
    fires_per = df.groupby(['date_str', 'option_chain_id']).size()
    print('Fires per chain-day distribution:')
    print(fires_per.describe().to_string())
    print(f'\nMax fires on a single chain-day: {fires_per.max()}')
    top = fires_per.sort_values(ascending=False).head(10)
    print('\nTop 10 chain-days by fire count:')
    print(top.to_string())

    # ============================================================
    # Check 3: alert_seq hypothesis — do 2nd+ fires beat 1st fires?
    # ============================================================
    print('\n' + '=' * 80)
    print('=== CHECK 3: Does alert_seq carry signal? (1st vs 2nd+ fires) ===')
    print('=' * 80)
    df['win_2x'] = (df['realized_multiple_eod'] >= 2.0).astype(int)
    df['big_win_5x'] = (df['realized_multiple_eod'] >= 5.0).astype(int)
    df['seq_bucket'] = df['alert_seq'].clip(upper=5)

    print(f'{"alert_seq":<12s} {"n":>6s} {"win 2x%":>9s} {"win 5x%":>9s} '
          f'{"med mult":>10s} {"med 30min mult":>16s} {"med EoD ret%":>14s}')
    for seq, g in df.groupby('seq_bucket'):
        seq_label = f'≥{seq}' if seq == 5 else str(int(seq))
        n = len(g)
        win2 = g['win_2x'].mean() * 100
        win5 = g['big_win_5x'].mean() * 100
        med_mult = g['realized_multiple_eod'].median()
        med_30 = g['realized_multiple_30'].median()
        med_eod = g['eod_return_pct'].median()
        print(f'{seq_label:<12s} {n:>6d} {win2:>8.1f}% {win5:>8.1f}% '
              f'{med_mult:>10.2f} {med_30:>16.2f} {med_eod:>+13.1f}%')

    # ============================================================
    # Check 4: Tag best entry per chain-day, profile vs siblings
    # ============================================================
    print('\n' + '=' * 80)
    print('=== CHECK 4: BEST ENTRY (per chain-day) profile vs siblings ===')
    print('=' * 80)
    df['_rank'] = df.groupby(['date_str', 'option_chain_id'])['realized_multiple_eod'].rank(
        method='first', ascending=False)
    df['is_best'] = (df['_rank'] == 1).astype(int)
    n_chains = df.groupby(['date_str', 'option_chain_id']).ngroups
    multi = df.groupby(['date_str', 'option_chain_id']).size()
    n_multi = (multi >= 2).sum()
    print(f'Chain-days with ≥2 fires: {n_multi:,} of {n_chains:,} ({n_multi/n_chains*100:.1f}%)')
    print(f'\nFor chain-days with multiple fires, where does the BEST fire rank by alert_seq?')
    # Only multi-fire chain-days
    multi_keys = set(multi.loc[multi >= 2].index)
    df_multi = df.set_index(['date_str', 'option_chain_id'])
    df_multi = df_multi.loc[df_multi.index.isin(multi_keys)].reset_index()
    best_seq_dist = df_multi.loc[df_multi['is_best'] == 1, 'alert_seq'].value_counts().sort_index()
    print(best_seq_dist.head(10).to_string())

    # Of multi-fire chains, what's the win rate of the LAST fire vs the FIRST?
    print('\n--- Multi-fire chains only (n_chains with ≥2 fires) ---')
    last_per_chain = df_multi.groupby(['date_str', 'option_chain_id']).tail(1)
    first_per_chain = df_multi.groupby(['date_str', 'option_chain_id']).head(1)
    print(f'{"position":<15s} {"n":>6s} {"win 2x%":>9s} {"win 5x%":>9s} '
          f'{"med 30min mult":>16s} {"med EoD ret%":>14s}')
    for label, g in [('first fire', first_per_chain), ('last fire', last_per_chain)]:
        n = len(g)
        win2 = (g['realized_multiple_eod'] >= 2).mean() * 100
        win5 = (g['realized_multiple_eod'] >= 5).mean() * 100
        med30 = g['realized_multiple_30'].median()
        med_eod = g['eod_return_pct'].median()
        print(f'{label:<15s} {n:>6d} {win2:>8.1f}% {win5:>8.1f}% '
              f'{med30:>16.2f} {med_eod:>+13.1f}%')

    # ============================================================
    # Save tagged set
    # ============================================================
    df.drop(columns=['_rank', 'seq_bucket', 'win_2x', 'big_win_5x'], errors='ignore').to_csv(
        OUT / 'outputs' / 'p15_v4_with_best_tag.csv', index=False)
    print(f'\nSaved → outputs/p15_v4_with_best_tag.csv (with is_best column)')


if __name__ == '__main__':
    main()
