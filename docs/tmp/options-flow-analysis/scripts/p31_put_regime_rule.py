"""Phase 31 — test cheap-put-PM RE-LOAD rule on bearish-regime days.

Hypothesis from p30:
  - Macro features (spy_flow_diff, zero_dte_diff, spx_spot_charm_oi)
    predict lottery rate, but in the BEARISH direction (Q1 = lottery).
  - The cheap-call-PM rule captures call-lotteries on neutral days.
  - A symmetrical "cheap-put-PM AND bearish-regime" rule should capture
    put-lotteries on bearish days (RUTW 4/21 archetype).

Tests:
  1. Univariate: which putside features predict put-lottery best?
  2. AND-rule: cheap-put-PM combined with each bearish-regime indicator
  3. Combined 2-mode selector: cheap-call-PM (calm/bullish) OR cheap-put-PM (bearish)
  4. Realistic-trader test on the combined rule

Definitions (no silent metric drift):
  - Same as p28/p30: lottery = realized_eod_pct >= 200%
  - "Cheap-put-PM" = option_type=put AND tod=PM AND entry_price < 1
  - "Bearish regime" thresholds tested: spy_flow_diff < 0, zero_dte_diff < 0,
    spx_spot_charm_oi < median, etc.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parents[1] / 'outputs'


def main():
    df = pd.read_csv(OUT / 'p30_reload_with_macro.csv',
                     parse_dates=['date_str', 'trigger_time_ct'])
    print(f'Loaded {len(df)} RE-LOAD fires (with macro features)')

    df['lottery'] = (df['hold_to_eod'] >= 200).astype(int)
    df['big_lottery'] = (df['hold_to_eod'] >= 500).astype(int)

    # Defining filters
    is_call_pm_cheap = ((df['option_type'] == 'call')
                        & (df['tod'] == 'PM')
                        & (df['entry_price'] < 1))
    is_put_pm_cheap = ((df['option_type'] == 'put')
                       & (df['tod'] == 'PM')
                       & (df['entry_price'] < 1))

    base = df['lottery'].mean() * 100
    print(f'Baseline lottery rate: {base:.1f}%\n')

    # Quick subset summary
    for label, mask in [
        ('all RE-LOAD', pd.Series(True, index=df.index)),
        ('all puts', df['option_type'] == 'put'),
        ('all calls', df['option_type'] == 'call'),
        ('cheap-call-PM', is_call_pm_cheap),
        ('cheap-put-PM', is_put_pm_cheap),
        ('cheap-put-ANY-tod', (df['option_type']=='put') & (df['entry_price'] < 1)),
        ('cheap-put-AM_open', (df['option_type']=='put') & (df['tod']=='AM_open') & (df['entry_price']<1)),
        ('cheap-put-MID', (df['option_type']=='put') & (df['tod']=='MID') & (df['entry_price']<1)),
    ]:
        g = df.loc[mask]
        if len(g) < 5:
            continue
        lot = g['lottery'].mean() * 100
        big_lot = g['big_lottery'].mean() * 100
        med = g['hold_to_eod'].median()
        mean = g['hold_to_eod'].mean()
        lift = lot / base if base > 0 else 0
        print(f'{label:<28s} n={len(g):>4d}  lottery={lot:>5.1f}% (lift {lift:.1f}x)  '
              f'big={big_lot:>4.1f}%  med_eod={med:>+7.1f}%  mean_eod={mean:>+7.1f}%')

    # =================================================================
    # AND-rules: cheap-put-PM AND various bearish-regime filters
    # =================================================================
    print('\n' + '=' * 95)
    print('AND-RULES: cheap-put-PM AND bearish-regime indicators')
    print('=' * 95)
    print(f'{"rule":<60s} {"n":>5s} {"lot %":>8s} {"big_lot %":>10s} {"lift":>6s} '
          f'{"med_eod%":>10s} {"mean_eod%":>11s}')

    # Compute Q1 thresholds for bearish features (~bottom 20%)
    spy_flow_q1 = df['spy_flow_diff'].quantile(0.20)
    zero_dte_q1 = df['zero_dte_diff'].quantile(0.20)
    charm_q1 = df['spx_spot_charm_oi'].quantile(0.20)
    gamma_vol_q1 = df['spx_spot_gamma_vol'].quantile(0.20)
    print(f'(Q1 thresholds: spy_flow≤{spy_flow_q1:.0f}, zero_dte≤{zero_dte_q1:.0f}, '
          f'charm≤{charm_q1:.2e}, gamma_vol≤{gamma_vol_q1:.2e})\n')

    rules = {
        'baseline (all RE-LOAD)':
            pd.Series(True, index=df.index),
        'cheap-put-PM (no macro)':
            is_put_pm_cheap,
        'cheap-put-PM AND spy_flow_diff < 0':
            is_put_pm_cheap & (df['spy_flow_diff'] < 0),
        'cheap-put-PM AND zero_dte_diff < 0':
            is_put_pm_cheap & (df['zero_dte_diff'] < 0),
        'cheap-put-PM AND spy_flow Q1':
            is_put_pm_cheap & (df['spy_flow_diff'] <= spy_flow_q1),
        'cheap-put-PM AND zero_dte Q1':
            is_put_pm_cheap & (df['zero_dte_diff'] <= zero_dte_q1),
        'cheap-put-PM AND charm Q1':
            is_put_pm_cheap & (df['spx_spot_charm_oi'] <= charm_q1),
        'cheap-put-PM AND gamma_vol Q1':
            is_put_pm_cheap & (df['spx_spot_gamma_vol'] <= gamma_vol_q1),
        'cheap-put-PM AND (spy_flow<0 OR zero_dte<0)':
            is_put_pm_cheap & ((df['spy_flow_diff'] < 0) | (df['zero_dte_diff'] < 0)),
        'cheap-put-PM AND (spy_flow<0 AND zero_dte<0)':
            is_put_pm_cheap & (df['spy_flow_diff'] < 0) & (df['zero_dte_diff'] < 0),
        # Try more relaxed put filters (any tod, any entry price) with strong bearish
        'cheap-put-ANY-tod AND zero_dte Q1':
            (df['option_type']=='put') & (df['entry_price']<1) & (df['zero_dte_diff'] <= zero_dte_q1),
        'put-PM (no entry filter) AND zero_dte Q1':
            (df['option_type']=='put') & (df['tod']=='PM') & (df['zero_dte_diff'] <= zero_dte_q1),
        'put (any tod, any entry) AND charm Q1':
            (df['option_type']=='put') & (df['spx_spot_charm_oi'] <= charm_q1),
    }
    for name, mask in rules.items():
        g = df.loc[mask.fillna(False)]
        if len(g) < 5:
            continue
        lot = g['lottery'].mean() * 100
        big_lot = g['big_lottery'].mean() * 100
        lift = lot / base if base > 0 else 0
        med = g['hold_to_eod'].median()
        mean = g['hold_to_eod'].mean()
        flag = ' ★' if lift >= 2 else ''
        print(f'{name:<60s} {len(g):>5d} {lot:>7.1f}% {big_lot:>9.1f}% '
              f'{lift:>5.1f}x {med:>+9.1f}% {mean:>+10.1f}%{flag}')

    # =================================================================
    # COMBINED 2-MODE SELECTOR: call rule on calm days, put rule on bearish days
    # =================================================================
    print('\n' + '=' * 95)
    print('COMBINED 2-MODE SELECTOR (call rule + put rule, with regime gating)')
    print('=' * 95)

    # Define regime labels
    df['regime_bearish'] = ((df['spy_flow_diff'] < 0)
                             | (df['zero_dte_diff'] < 0)).fillna(False)
    df['regime_strong_bearish'] = ((df['spy_flow_diff'] <= spy_flow_q1)
                                    | (df['zero_dte_diff'] <= zero_dte_q1)).fillna(False)

    combined_rules = {
        'cheap-call-PM only (current rule)':
            is_call_pm_cheap,
        'cheap-put-PM only':
            is_put_pm_cheap,
        '2-mode (call OR put, no regime)':
            is_call_pm_cheap | is_put_pm_cheap,
        '2-mode regime-gated: call on neutral, put on bearish':
            (is_call_pm_cheap & ~df['regime_bearish'])
            | (is_put_pm_cheap & df['regime_bearish']),
        '2-mode strong-regime: call on bullish, put on strong-bearish':
            (is_call_pm_cheap & ~df['regime_bearish'])
            | (is_put_pm_cheap & df['regime_strong_bearish']),
        '2-mode any: call OR put with macro Q1 of own side':
            (is_call_pm_cheap & ~df['regime_strong_bearish'])
            | (is_put_pm_cheap & df['regime_strong_bearish']),
    }
    print(f'{"rule":<60s} {"n":>5s} {"lot %":>8s} {"big %":>8s} {"lift":>6s} '
          f'{"med_eod%":>10s} {"mean_eod%":>11s}')
    for name, mask in combined_rules.items():
        g = df.loc[mask.fillna(False)]
        if len(g) < 5:
            continue
        lot = g['lottery'].mean() * 100
        big_lot = g['big_lottery'].mean() * 100
        lift = lot / base if base > 0 else 0
        med = g['hold_to_eod'].median()
        mean = g['hold_to_eod'].mean()
        flag = ' ★' if lift >= 2 else ''
        print(f'{name:<60s} {len(g):>5d} {lot:>7.1f}% {big_lot:>7.1f}% '
              f'{lift:>5.1f}x {med:>+9.1f}% {mean:>+10.1f}%{flag}')

    # =================================================================
    # REALISTIC TRADER TEST on combined rule
    # =================================================================
    print('\n' + '=' * 95)
    print('REALISTIC TRADER TEST: 2-mode regime-gated rule, top-N/day cherry-pick')
    print('=' * 95)
    best_combined = ((is_call_pm_cheap & ~df['regime_bearish'])
                     | (is_put_pm_cheap & df['regime_bearish']))
    g = df.loc[best_combined.fillna(False)].copy()
    g['date_only'] = g['date_str'].dt.strftime('%Y-%m-%d')
    print(f'Total qualifying trades over 15 days: {len(g)} ({len(g)/15:.1f}/day avg)')
    print(f'Days with at least one qualifying trade: {g["date_only"].nunique()}')
    print()
    if len(g) >= 5:
        for top_n in [1, 2, 3, 5]:
            cherry = g.sort_values(['date_only', 'entry_price']).groupby('date_only').head(top_n)
            for policy in ['act30_trail10', 'hard_30m', 'tier_50_holdEod', 'hold_to_eod']:
                s = cherry[policy]
                tot = s.sum()
                med = s.median()
                win = (s > 0).mean() * 100
                print(f'  top-{top_n} ({len(cherry):>3d} trades) {policy:<22s}: '
                      f'total ${tot:>+7.0f} median {med:>+6.1f}% win% {win:>5.1f}%')

    # Per-day breakdown for the combined rule
    print('\n' + '-' * 95)
    print('Per-day P&L for 2-mode regime-gated rule, top-3/day, act30_trail10')
    print('-' * 95)
    cherry3 = g.sort_values(['date_only', 'entry_price']).groupby('date_only').head(3)
    by_day = cherry3.groupby('date_only').agg(
        n=('act30_trail10', 'size'),
        total_act30=('act30_trail10', 'sum'),
        total_hard30=('hard_30m', 'sum'),
        total_holdeod=('hold_to_eod', 'sum'),
        n_calls=('option_type', lambda s: (s == 'call').sum()),
        n_puts=('option_type', lambda s: (s == 'put').sum()),
    ).round(0)
    print(by_day.to_string())

    g.to_csv(OUT / 'p31_combined_rule_features.csv', index=False)
    print(f'\nSaved → outputs/p31_combined_rule_features.csv ({len(g)} rows)')


if __name__ == '__main__':
    main()
