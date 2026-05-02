"""Phase 29 — stress test the cheap-call-PM selection rule.

Concern: 48/71 lottery winners (68%) came from 2 of 15 days (5/1 + 4/21).
Is the rule's positive P&L driven entirely by those outlier days?

Tests:
  1. EXCLUDE 5/1 + 4/21, recompute realistic-trader P&L
  2. EXCLUDE only 5/1 (the SNDK rally day)
  3. EXCLUDE only 4/21 (the RUTW put day)
  4. Per-day P&L breakdown — which days does the rule make money on?
  5. Leave-one-out cross validation — train on 14 days, test on held-out
  6. Block bootstrap by DATE (resample 15 days with replacement)
  7. By-date P&L distribution — does any single day account for most of P&L?

PRIMARY METRIC: realized total P&L per $100 risk under each policy
DEFINITIONS:
  - "Cheap call PM" rule: option_type=call AND tod=PM AND entry_price<$1
  - Top-3/day cherry-pick (the recommended cadence)
  - Same exit policies: act30_trail10, hard_30m, tier_50_holdEod, hold_to_eod
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def cherry_pick_total_pnl(df: pd.DataFrame, top_n: int, policy: str) -> dict:
    """For each date, take top-N cheapest qualifying trades. Return total P&L."""
    df['date_only'] = df['date_str'].dt.strftime('%Y-%m-%d') if hasattr(df['date_str'], 'dt') else df['date_str']
    cherry = df.sort_values(['date_only', 'entry_price']).groupby('date_only').head(top_n)
    s = cherry[policy]
    return {
        'n': len(cherry),
        'total': float(s.sum()),
        'median': float(s.median()) if len(s) else 0.0,
        'mean': float(s.mean()) if len(s) else 0.0,
        'win_pct': float((s > 0).mean() * 100) if len(s) else 0.0,
        'days_with_qualifying': int(cherry['date_only'].nunique()),
    }


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p28_reload_with_features.csv',
                      parse_dates=['date_str'])
    print(f'Loaded {len(df)} RE-LOAD trades from p28')

    # Apply cheap-call-PM rule
    rule = (df['option_type'] == 'call') & (df['tod'] == 'PM') & (df['entry_price'] < 1)
    qual = df.loc[rule].copy()
    print(f'Cheap call PM trades: {len(qual)}')
    print(f'Date range: {qual["date_str"].min()} to {qual["date_str"].max()}')
    print()

    policies = ['act30_trail10', 'hard_30m', 'tier_50_holdEod', 'hold_to_eod']
    OUTLIERS = ['2026-05-01', '2026-04-21']

    # ============================================================
    # TEST 1: PER-DAY P&L breakdown
    # ============================================================
    print('=' * 90)
    print('TEST 1: Per-day P&L breakdown for cheap-call-PM, top-3/day, each policy')
    print('=' * 90)
    qual['date_only'] = qual['date_str'].dt.strftime('%Y-%m-%d')
    cherry3 = qual.sort_values(['date_only', 'entry_price']).groupby('date_only').head(3)
    print(f'{"date":<12s} {"n":>3s} ', end='')
    for p in policies:
        print(f'{p:>16s}', end='')
    print()
    for d, g in cherry3.groupby('date_only'):
        print(f'{d:<12s} {len(g):>3d} ', end='')
        for p in policies:
            print(f'${g[p].sum():>+15.0f}', end='')
        print()
    print(f'{"TOTAL":<12s} {len(cherry3):>3d} ', end='')
    for p in policies:
        print(f'${cherry3[p].sum():>+15.0f}', end='')
    print()

    # ============================================================
    # TEST 2: Without outlier days (5/1 + 4/21)
    # ============================================================
    print('\n' + '=' * 90)
    print('TEST 2: Cheap-call-PM EXCLUDING 5/1 + 4/21 (the two outlier days)')
    print('=' * 90)
    no_outliers = qual.loc[~qual['date_str'].dt.strftime('%Y-%m-%d').isin(OUTLIERS)].copy()
    print(f'Trades remaining: {len(no_outliers)} ({len(qual) - len(no_outliers)} dropped)')
    print(f'Date count: {no_outliers["date_only"].nunique()} (was {qual["date_only"].nunique()})')
    print()
    print(f'{"top_n":<8s} {"days":<6s} {"trades":<8s} ', end='')
    for p in policies:
        print(f'{p:>16s}', end='')
    print()
    for top_n in [1, 2, 3, 5]:
        for p in policies:
            r = cherry_pick_total_pnl(no_outliers, top_n, p)
            if p == policies[0]:
                print(f'top-{top_n:<5d} {r["days_with_qualifying"]:<6d} {r["n"]:<8d} ', end='')
            print(f'${r["total"]:>+15.0f}', end='')
        print()

    # ============================================================
    # TEST 3: Compare WITH vs WITHOUT each outlier day individually
    # ============================================================
    print('\n' + '=' * 90)
    print('TEST 3: Single-outlier-removed comparison')
    print('=' * 90)
    for label, exclude in [('all 15 days (baseline)', []),
                            ('exclude 5/1 only', ['2026-05-01']),
                            ('exclude 4/21 only', ['2026-04-21']),
                            ('exclude both', OUTLIERS)]:
        sub = qual.loc[~qual['date_str'].dt.strftime('%Y-%m-%d').isin(exclude)].copy()
        print(f'\n{label}:  {len(sub)} trades, {sub["date_only"].nunique()} days')
        for top_n in [1, 3, 5]:
            print(f'  top-{top_n}/day:  ', end='')
            for p in policies:
                r = cherry_pick_total_pnl(sub, top_n, p)
                print(f'{p}=${r["total"]:>+6.0f}  ', end='')
            print()

    # ============================================================
    # TEST 4: Leave-one-out cross-validation
    # ============================================================
    print('\n' + '=' * 90)
    print('TEST 4: Leave-one-out — for each day, take top-3 cheap-call-PM, sum P&L on held-out')
    print('=' * 90)
    print('This tests: "If today were the only day, would the rule have profited?"')
    all_dates = sorted(qual['date_only'].unique())
    print(f'\n{"held-out date":<14s} {"n trades":<10s} ', end='')
    for p in policies:
        print(f'{p:>16s}', end='')
    print()
    loo_totals = {p: [] for p in policies}
    for d in all_dates:
        held = qual.loc[qual['date_only'] == d]
        cherry = held.sort_values('entry_price').head(3)
        if len(cherry) == 0:
            continue
        print(f'{d:<14s} {len(cherry):<10d} ', end='')
        for p in policies:
            tot = cherry[p].sum()
            loo_totals[p].append(tot)
            print(f'${tot:>+15.0f}', end='')
        print()
    print(f'\n{"profitable days / total days":<28s} ', end='')
    for p in policies:
        n_pos = sum(1 for t in loo_totals[p] if t > 0)
        n_total = len(loo_totals[p])
        print(f'{n_pos}/{n_total} ({n_pos/n_total*100:.0f}%) ', end='')
    print()
    print(f'{"median day P&L":<28s} ', end='')
    for p in policies:
        med = float(pd.Series(loo_totals[p]).median())
        print(f'${med:>+8.0f}        ', end='')
    print()
    print(f'{"mean day P&L":<28s} ', end='')
    for p in policies:
        mean = float(pd.Series(loo_totals[p]).mean())
        print(f'${mean:>+8.0f}        ', end='')
    print()

    # ============================================================
    # TEST 5: Block bootstrap by date (1000 resamples of 15 days w/ replacement)
    # ============================================================
    print('\n' + '=' * 90)
    print('TEST 5: Bootstrap by DATE (1000 resamples) — '
          'how stable is total P&L?')
    print('=' * 90)
    np.random.seed(42)
    n_boot = 1000
    daily_pnl = {p: [] for p in policies}
    for d in all_dates:
        cherry = qual.loc[qual['date_only'] == d].sort_values('entry_price').head(3)
        for p in policies:
            daily_pnl[p].append(float(cherry[p].sum()))
    daily_arr = {p: np.array(v) for p, v in daily_pnl.items()}
    boot_results = {p: [] for p in policies}
    for _ in range(n_boot):
        idx = np.random.choice(len(all_dates), size=len(all_dates), replace=True)
        for p in policies:
            boot_results[p].append(daily_arr[p][idx].sum())
    print(f'\n{"policy":<24s} {"mean total":>11s} {"std":>10s} '
          f'{"5th pct":>10s} {"50th pct":>10s} {"95th pct":>10s} {"% > $0":>8s}')
    for p in policies:
        arr = np.array(boot_results[p])
        print(f'{p:<24s} ${arr.mean():>+10.0f} ${arr.std():>+9.0f} '
              f'${np.percentile(arr, 5):>+9.0f} ${np.percentile(arr, 50):>+9.0f} '
              f'${np.percentile(arr, 95):>+9.0f} {(arr > 0).mean()*100:>7.1f}%')

    # ============================================================
    # TEST 6: P&L concentration — what % of total P&L from top-N days?
    # ============================================================
    print('\n' + '=' * 90)
    print('TEST 6: P&L concentration — what % of total comes from top-N days?')
    print('=' * 90)
    for p in policies:
        sorted_days = sorted(daily_pnl[p], reverse=True)
        total = sum(sorted_days)
        if total == 0:
            continue
        top1 = sum(sorted_days[:1])
        top2 = sum(sorted_days[:2])
        top3 = sum(sorted_days[:3])
        top5 = sum(sorted_days[:5])
        print(f'\n{p}:')
        print(f'  total: ${total:+.0f}')
        print(f'  top 1 day:  ${top1:+.0f} ({top1/total*100:+.0f}%)')
        print(f'  top 2 days: ${top2:+.0f} ({top2/total*100:+.0f}%)')
        print(f'  top 3 days: ${top3:+.0f} ({top3/total*100:+.0f}%)')
        print(f'  top 5 days: ${top5:+.0f} ({top5/total*100:+.0f}%)')


if __name__ == '__main__':
    main()
