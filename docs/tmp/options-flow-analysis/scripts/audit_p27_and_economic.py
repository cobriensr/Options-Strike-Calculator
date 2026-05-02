"""Audit p27 policy grid + economic conclusion.

We discovered the conservative policy (act30_trail10) is actually
NET UNPROFITABLE on RE-LOAD trades, while lottery-hunter policies
(hold_to_eod, hard_30m) are profitable. Before recommending v5 we
need to verify:

  1. The p27 trail policy implementations are correct (independent
     re-implementation, spot-check vs raw parquet)
  2. The right-tail (≥+500% trades) are LEGITIMATE not artifacts
     (single-print, thin-chain, expiration-day spike)
  3. The economic conclusion holds under REALISTIC trader behavior
     (cherry-pick best 1-2 per day, not "every fire equal weight")
  4. The conclusion is robust to sample size (bootstrap)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import glob

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at', 'option_chain_id', 'price', 'size', 'canceled']
TOL = 0.01


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def _trail_pp_indep(prices, entry, act, drop_pp):
    """Independent re-implementation."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    rets = (prices - entry) / entry * 100.0
    activated = False
    peak = -np.inf
    for r in rets:
        if not activated:
            if r >= act:
                activated = True
                peak = r
        else:
            if r > peak:
                peak = r
            if r <= peak - drop_pp:
                return float(r)
    return float(rets[-1])


def _two_tier_indep(prices, entry, ts_min, tier1_pct, tier2_policy):
    if entry <= 0 or len(prices) == 0:
        return 0.0
    rets = (prices - entry) / entry * 100.0
    tier1_done = False
    tier1_ret = 0.0
    tier1_idx = -1
    for i, r in enumerate(rets):
        if r >= tier1_pct:
            tier1_done = True
            tier1_ret = float(r)
            tier1_idx = i
            break
    if not tier1_done:
        return float(rets[-1])
    rest_prices = prices[tier1_idx:]
    if tier2_policy == 'hold_eod':
        tier2_ret = float(rets[-1])
    elif tier2_policy == 'trail50_25_pp':
        tier2_ret = _trail_pp_indep(rest_prices, entry, 50.0, 25.0)
    return (tier1_ret + tier2_ret) / 2.0


def main():
    p27 = pd.read_csv(OUT / 'outputs' / 'p27_policy_grid.csv')
    p14 = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                       parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    p14['date_str'] = p14['date'].dt.strftime('%Y-%m-%d')

    # ============================================================
    # AUDIT 1: invariants
    # ============================================================
    print('=' * 80)
    print('AUDIT 1: Invariants on p27 grid')
    print('=' * 80)
    print(f'rows: {len(p27):,}')
    nulls = p27.isnull().sum()
    print(f'nulls: {nulls.sum()}')
    print(f'entry_price <= 0: {(p27["entry_price"] <= 0).sum()}')

    # Peak ceiling should be >= every realized exit
    for col in ['act30_trail10', 'hold_to_eod', 'hard_30m', 'tier_50_holdEod',
                 'act100_trail50']:
        ok = (p27['peak_ceiling'] >= p27[col] - 0.01).sum()
        if ok < len(p27):
            print(f'  ❌ {col}: peak_ceiling >= {col} fails on {len(p27) - ok} rows')
        else:
            print(f'  ✓ peak_ceiling >= {col} on all rows')

    # Trail wider should >= trail tighter (more upside)? Not always — trail can exit
    # at different points so we can't enforce this.

    # Hold-to-EoD == realized_eod from p26 (which we already audited)
    p26 = pd.read_csv(OUT / 'outputs' / 'p26_per_trade_realized.csv')
    merge = p27.merge(p26[['date_str','option_chain_id','entry_price',
                            'realized_eod_pct','realized_hard30m_pct','peak_ceiling_pct']],
                       on=['date_str','option_chain_id','entry_price'], how='left',
                       suffixes=('','_p26'))
    eod_diff = (merge['hold_to_eod'] - merge['realized_eod_pct']).abs()
    hard30_diff = (merge['hard_30m'] - merge['realized_hard30m_pct']).abs()
    peak_diff = (merge['peak_ceiling'] - merge['peak_ceiling_pct']).abs()
    print(f'\nhold_to_eod vs p26 realized_eod_pct: max diff {eod_diff.max():.4f}')
    print(f'hard_30m vs p26 realized_hard30m_pct: max diff {hard30_diff.max():.4f}')
    print(f'peak_ceiling vs p26 peak_ceiling_pct: max diff {peak_diff.max():.4f}')

    # ============================================================
    # AUDIT 2: spot check policies against raw parquet for diverse samples
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT 2: Independent re-implementation against raw parquet')
    print('=' * 80)

    p14_idx = p14.set_index(['option_chain_id', 'date_str', 'alert_seq'])

    # Sample: 5 random RE-LOAD trades + the SNDK fire #4 + 5 lottery winners + 5 big losers
    samples_idx = []
    rl = p27.loc[p27['reload']].sample(min(5, p27['reload'].sum()), random_state=42).index.tolist()
    samples_idx.extend(rl)
    sndk = p27.loc[(p27['option_chain_id']=='SNDK260501C01175000')
                    & (p27['date_str']=='2026-05-01')
                    & (abs(p27['entry_price'] - 1.30) < 0.01)].index.tolist()
    samples_idx.extend(sndk)
    lottery = p27.loc[p27['hold_to_eod'] >= 500].sample(
        min(5, (p27['hold_to_eod'] >= 500).sum()), random_state=42).index.tolist()
    samples_idx.extend(lottery)
    losers = p27.loc[p27['hold_to_eod'] <= -90].sample(
        min(5, (p27['hold_to_eod'] <= -90).sum()), random_state=42).index.tolist()
    samples_idx.extend(losers)

    discrepancies = 0
    for idx in samples_idx:
        r = p27.loc[idx]
        chain = r['option_chain_id']
        date = r['date_str']
        entry = float(r['entry_price'])

        # Try to find matching p14 row by entry_price (and chain/date)
        p14_match = p14.loc[(p14['option_chain_id']==chain) & (p14['date_str']==date)
                             & (abs(p14['entry_price'] - entry) < 0.001)]
        if len(p14_match) == 0:
            continue
        entry_time = pd.Timestamp(p14_match['entry_time_ct'].iloc[0])

        # Pull chain prices
        f = f'{DATA_DIR}/{date}-trades.parquet'
        try:
            t = pq.read_table(f, columns=COLS)
        except Exception:
            continue
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled'] & (df['price'] > 0)]
        df['option_chain_id'] = df['option_chain_id'].astype(str)
        df = df.loc[df['option_chain_id'] == chain]
        df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
        df = df.sort_values('ts_ct').reset_index(drop=True)
        post = df.loc[df['ts_ct'] >= entry_time]
        if len(post) == 0:
            continue
        prices = post['price'].values
        ts_min = (post['ts_ct'].values - np.datetime64(entry_time)).astype(
            'timedelta64[s]').astype(float) / 60.0

        # Recompute key policies
        act30_t10 = _trail_pp_indep(prices, entry, 30, 10)
        act100_t50 = _trail_pp_indep(prices, entry, 100, 50)
        tier_50 = _two_tier_indep(prices, entry, ts_min, 50, 'hold_eod')
        eod = float((prices[-1] - entry) / entry * 100)

        diffs = []
        for label, stored, recomp in [
            ('act30_trail10', r['act30_trail10'], act30_t10),
            ('act100_trail50', r['act100_trail50'], act100_t50),
            ('tier_50_holdEod', r['tier_50_holdEod'], tier_50),
            ('hold_to_eod', r['hold_to_eod'], eod),
        ]:
            if abs(stored - recomp) > TOL:
                diffs.append(f'{label}: stored={stored:.4f} recomp={recomp:.4f}')
        if diffs:
            discrepancies += 1
            print(f'❌ {chain} {date} entry={entry:.2f}: {diffs}')
        else:
            print(f'✓ {chain} {date} entry={entry:.2f} '
                  f'(eod={eod:+.1f}%, peak={r["peak_ceiling"]:+.0f}%)')

    print(f'\nSpot-check discrepancies: {discrepancies}/{len(samples_idx)}')

    # ============================================================
    # AUDIT 3: Examine the right-tail — are the +500% trades legitimate?
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT 3: Right-tail trade legitimacy')
    print('=' * 80)
    rl = p27.loc[p27['reload']].copy()
    print(f'\nRE-LOAD trades with hold_to_eod >= 500%: {(rl["hold_to_eod"] >= 500).sum()}')
    big = rl.loc[rl['hold_to_eod'] >= 500].sort_values('hold_to_eod', ascending=False)
    print(f'\nTop 22 lottery winners under hold_to_eod (RE-LOAD):')
    print(big[['date_str','option_chain_id','entry_price','hold_to_eod','peak_ceiling',
               'flow_quad','tod','underlying_symbol']].to_string(index=False))

    # Validate by checking #prints in chain after entry, did it actually trade
    print('\n--- Validating each lottery winner has REAL prints (not single-print spike) ---')
    invalid = 0
    by_day = big.groupby('date_str')
    for date, gd in by_day:
        f = f'{DATA_DIR}/{date}-trades.parquet'
        try:
            t = pq.read_table(f, columns=COLS, filters=[('option_chain_id','in',list(gd['option_chain_id']))])
        except Exception:
            continue
        d = t.to_pandas()
        d['canceled'] = _coerce_canceled(d['canceled'])
        d = d.loc[~d['canceled'] & (d['price'] > 0)]
        d['option_chain_id'] = d['option_chain_id'].astype(str)
        for _, row in gd.iterrows():
            chain = row['option_chain_id']
            entry = row['entry_price']
            cdf = d.loc[d['option_chain_id']==chain]
            n_prints = len(cdf)
            n_at_peak = (cdf['price'] >= cdf['price'].max() * 0.95).sum()
            max_size = cdf['size'].max() if len(cdf) else 0
            if n_prints < 50 or n_at_peak < 3:
                print(f'  ⚠️  {chain} {date}: only {n_prints} prints, '
                      f'{n_at_peak} near peak — possibly thin')
                invalid += 1
            else:
                print(f'  ✓ {chain} {date}: {n_prints} prints, {n_at_peak} near peak, '
                      f'max contracts/print={max_size}')
    print(f'\nPotentially-thin lottery trades: {invalid}/{len(big)}')

    # ============================================================
    # AUDIT 4: Realistic-trader scenario — cherry pick top N RE-LOAD trades per day
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT 4: Realistic trader simulation (1, 2, 3 RE-LOAD trades/day)')
    print('=' * 80)
    print('Take only the TOP-N RE-LOAD trades per day (highest trigger_window_size)')
    print('= more realistic than "every RE-LOAD fire equal weight"')
    print()

    # Need to add trigger_window_size from p14 to p27
    p14_size = p14[['option_chain_id','date_str','entry_price','trigger_window_size']]
    rl2 = rl.merge(p14_size, on=['option_chain_id','date_str','entry_price'], how='left')

    for top_n in [1, 2, 3, 5, 10]:
        # For each date, take top-N RE-LOAD by burst size
        cherry = rl2.sort_values(['date_str','trigger_window_size'], ascending=[True, False])
        cherry = cherry.groupby('date_str').head(top_n)
        n_total = len(cherry)
        if n_total == 0:
            continue
        print(f'\n--- Top-{top_n} RE-LOAD per day (n={n_total} total trades over 15 days) ---')
        hdr = f'{"policy":<24s} {"median%":>9s} {"mean%":>9s} {"total $":>9s} {"win%>0":>8s} {"≥+50%":>7s}'
        print(hdr)
        for p in ['act30_trail10', 'tier_25_then_t50_25', 'tier_50_holdEod',
                   'hold_to_eod', 'hard_30m']:
            s = cherry[p]
            print(f'{p:<24s} {s.median():>+8.1f}% {s.mean():>+8.1f}% '
                  f'${s.sum():>+7.0f} '
                  f'{(s>0).mean()*100:>7.1f}% {(s>=50).mean()*100:>6.1f}%')

    # ============================================================
    # AUDIT 5: Bootstrap robustness
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT 5: Bootstrap (1000 resamples of n=676 with replacement)')
    print('=' * 80)
    print('How stable is the rank ordering of total P&L?')
    np.random.seed(42)
    n_bootstrap = 1000
    policy_means = {p: [] for p in ['act30_trail10','tier_50_holdEod','hold_to_eod','hard_30m']}
    rl_arr = {p: rl[p].values for p in policy_means}
    n = len(rl)
    for _ in range(n_bootstrap):
        idx = np.random.choice(n, size=n, replace=True)
        for p in policy_means:
            policy_means[p].append(rl_arr[p][idx].sum())  # total
    hdr2 = f'{"policy":<24s} {"mean total $":>12s} {"std":>10s} {"5th pct":>10s} {"95th pct":>10s} {"% > 0":>8s}'
    print(f'\n{hdr2}')
    for p, totals in policy_means.items():
        arr = np.array(totals)
        print(f'{p:<24s} ${arr.mean():>+11.0f} ${arr.std():>+9.0f} '
              f'${np.percentile(arr, 5):>+9.0f} ${np.percentile(arr, 95):>+9.0f} '
              f'{(arr > 0).mean()*100:>7.1f}%')


if __name__ == '__main__':
    main()
