"""Phase 28 — does ANY feature predict which RE-LOAD trade becomes a lottery?

Setup (no silent metric drift):
  * Universe: RE-LOAD trades (n=676 from p26/p27)
  * "Lottery" = realized_eod_pct >= 200%  (~clear right-tail, ~13-22 trades)
  * Goal: find a feature or AND-rule that predicts lottery membership
    well enough to convert a "look at all RE-LOAD" alert system into a
    "here's the cherry-picked candidate" alert system

Workflow:
  1. Univariate quintile analysis: for each feature, what's the lottery
     hit rate by feature value?
  2. Multivariate: find AND-rules that separate lottery winners from duds
  3. ONLY THEN test economic outcome: if the rule had been used to pick
     trades, what's realized P&L at realistic trade counts?

Realized exit policy used throughout: hold_to_eod (the only realized policy
that captures the lottery upside; rule's job is to make this profitable).

Features to test (all available pre-trade):
  - entry_price, log entry_price
  - option_type (call/put)
  - tod, hour
  - flow_quad
  - alert_seq, minutes_since_prev_fire
  - trigger_window_size (burst), burst_ratio_vs_prev
  - entry_drop_pct_vs_prev
  - trigger_iv, trigger_delta, |trigger_delta|
  - trigger_vol_to_oi_window, trigger_vol_to_oi_cum
  - underlying_symbol
  - day-of-week
  - date (proxy for day-regime)
  - mode (A vs B)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def lottery_rate(s_lottery: pd.Series) -> float:
    if len(s_lottery) == 0:
        return 0.0
    return float(s_lottery.mean() * 100.0)


def main():
    p27 = pd.read_csv(OUT / 'outputs' / 'p27_policy_grid.csv',
                       parse_dates=['date_str'])
    p14 = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                       parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    p14['date_str'] = pd.to_datetime(p14['date'].dt.strftime('%Y-%m-%d'))

    # Pull richer feature set from p14 + merge alert_seq + trigger features
    feat_cols = ['option_chain_id', 'date_str', 'entry_price', 'alert_seq',
                 'option_type',
                 'minutes_since_prev_fire', 'trigger_window_size',
                 'trigger_vol_to_oi_window', 'trigger_vol_to_oi_cum',
                 'trigger_iv', 'trigger_delta', 'trigger_ask_pct',
                 'open_interest', 'spot_at_first', 'strike']
    p14f = p14[feat_cols]

    df = p27.merge(p14f, on=['option_chain_id', 'date_str', 'entry_price'], how='left')
    rl = df.loc[df['reload']].copy()
    rl['date_str'] = pd.to_datetime(rl['date_str'])
    rl['lottery'] = (rl['hold_to_eod'] >= 200).astype(int)
    rl['big_lottery'] = (rl['hold_to_eod'] >= 500).astype(int)
    rl['day_of_week'] = rl['date_str'].dt.dayofweek
    rl['log_entry'] = np.log(rl['entry_price'].clip(lower=0.01))
    rl['abs_delta'] = rl['trigger_delta'].abs()
    rl['moneyness_pct'] = (rl['strike'] / rl['spot_at_first'] - 1) * 100
    rl['abs_moneyness'] = rl['moneyness_pct'].abs()

    # prev-fire features (re-derive)
    rl_sorted = rl.sort_values(['date_str', 'option_chain_id', 'alert_seq'])
    grp = rl_sorted.groupby(['date_str', 'option_chain_id'])
    rl_sorted['burst_ratio_vs_prev'] = (rl_sorted['trigger_window_size']
                                          / grp['trigger_window_size'].shift(1))
    rl_sorted['entry_drop_pct_vs_prev'] = (
        (rl_sorted['entry_price'] - grp['entry_price'].shift(1))
        / grp['entry_price'].shift(1) * 100
    )
    rl = rl_sorted

    n = len(rl)
    n_lot = rl['lottery'].sum()
    n_big_lot = rl['big_lottery'].sum()
    base = n_lot / n * 100
    base_big = n_big_lot / n * 100
    print(f'RE-LOAD trades: {n}')
    print(f'Lottery (>= +200% EoD): {n_lot} ({base:.1f}% baseline)')
    print(f'Big lottery (>= +500% EoD): {n_big_lot} ({base_big:.1f}% baseline)')

    # ============================================================
    # AUDIT 1: Univariate quintile sweeps
    # ============================================================
    print('\n' + '=' * 90)
    print('=== UNIVARIATE QUINTILE SWEEPS — what predicts lottery? ===')
    print('=' * 90)
    print(f'(Baseline lottery rate: {base:.1f}%)\n')

    numeric_features = [
        'entry_price', 'log_entry', 'trigger_window_size', 'trigger_vol_to_oi_window',
        'trigger_vol_to_oi_cum', 'trigger_iv', 'abs_delta', 'trigger_ask_pct',
        'open_interest', 'minutes_since_prev_fire', 'alert_seq',
        'burst_ratio_vs_prev', 'entry_drop_pct_vs_prev', 'abs_moneyness',
    ]
    for c in numeric_features:
        if c not in rl.columns:
            continue
        s = rl.dropna(subset=[c])
        if len(s) < 50:
            continue
        try:
            s['_q'] = pd.qcut(s[c].rank(method='first'), 5, labels=['Q1','Q2','Q3','Q4','Q5'])
        except ValueError:
            continue
        agg = s.groupby('_q', observed=True).agg(
            n=('lottery', 'size'),
            median_thresh=(c, 'median'),
            lottery_pct=('lottery', lambda x: x.mean()*100),
            big_lot_pct=('big_lottery', lambda x: x.mean()*100),
            median_eod=('hold_to_eod', 'median'),
            mean_eod=('hold_to_eod', 'mean'),
        )
        # Compute lift (Q5 vs baseline)
        q5_lift = agg.loc['Q5', 'lottery_pct'] / base if base > 0 else 0
        flag = ' ★' if q5_lift >= 2.0 else ''
        print(f'\n{c} (Q5 lift vs baseline: {q5_lift:.1f}x){flag}')
        print(agg.round(2).to_string())

    # ============================================================
    # AUDIT 2: Categorical features
    # ============================================================
    print('\n' + '=' * 90)
    print('=== CATEGORICAL FEATURES ===')
    print('=' * 90)
    for c in ['option_type', 'tod', 'flow_quad', 'mode', 'day_of_week']:
        if c not in rl.columns:
            continue
        agg = rl.groupby(c).agg(
            n=('lottery', 'size'),
            lottery_pct=('lottery', lambda x: x.mean()*100),
            big_lot_pct=('big_lottery', lambda x: x.mean()*100),
            median_eod=('hold_to_eod', 'median'),
        ).sort_values('lottery_pct', ascending=False)
        # Filter to subgroups with meaningful n
        agg = agg.loc[agg['n'] >= 30]
        print(f'\n{c}:')
        print(agg.round(2).to_string())

    # ============================================================
    # AUDIT 3: Per-ticker lottery concentration
    # ============================================================
    print('\n' + '=' * 90)
    print('=== PER-TICKER LOTTERY DISTRIBUTION ===')
    print('=' * 90)
    print('Where do the lottery winners come from?')
    lots = rl.loc[rl['lottery'] == 1]
    print(f'\nLottery winners by ticker:')
    print(lots['underlying_symbol'].value_counts().to_string())
    print(f'\nLottery winners by date:')
    lots_d = lots.groupby(lots['date_str'].dt.strftime('%Y-%m-%d')).size().sort_values(ascending=False)
    print(lots_d.to_string())

    # ============================================================
    # AUDIT 4: AND-rule construction
    # ============================================================
    print('\n' + '=' * 90)
    print('=== AND-RULE CANDIDATES ===')
    print('=' * 90)
    print(f'Baseline lottery rate: {base:.1f}%, big lottery: {base_big:.1f}%\n')
    rules = {
        'baseline (all RE-LOAD)':
            pd.Series(True, index=rl.index),
        'entry_price < $1':
            rl['entry_price'] < 1,
        'entry_price < $0.50':
            rl['entry_price'] < 0.50,
        'option_type=call':
            rl['option_type'] == 'call',
        'cheap call (entry<$1 AND option=call)':
            (rl['entry_price'] < 1) & (rl['option_type'] == 'call'),
        'cheap call AM_open':
            (rl['entry_price'] < 1) & (rl['option_type']=='call') & (rl['tod']=='AM_open'),
        'cheap call PM':
            (rl['entry_price'] < 1) & (rl['option_type']=='call') & (rl['tod']=='PM'),
        'cheap call lateseq (alert_seq>=4)':
            (rl['entry_price'] < 1) & (rl['option_type']=='call') & (rl['alert_seq']>=4),
        'cheap call burst>=200':
            (rl['entry_price'] < 1) & (rl['option_type']=='call') & (rl['trigger_window_size']>=200),
        'cheap put (entry<$1 AND option=put)':
            (rl['entry_price'] < 1) & (rl['option_type']=='put'),
        'cheap call PM lateseq':
            (rl['entry_price'] < 1) & (rl['option_type']=='call')
            & (rl['tod']=='PM') & (rl['alert_seq']>=4),
        'mode A (0DTE) cheap call':
            (rl['mode']=='A_intraday_0DTE') & (rl['entry_price']<1) & (rl['option_type']=='call'),
        'mode A cheap call PM':
            (rl['mode']=='A_intraday_0DTE') & (rl['entry_price']<1)
            & (rl['option_type']=='call') & (rl['tod']=='PM'),
        'cheap call ANY tod, burst>=500':
            (rl['entry_price']<1) & (rl['option_type']=='call') & (rl['trigger_window_size']>=500),
        'entry < $0.50 AND late seq':
            (rl['entry_price'] < 0.50) & (rl['alert_seq']>=4),
    }
    print(f'{"rule":<55s} {"n":>5s} {"lot %":>8s} {"big_lot %":>10s} {"lift":>6s} {"med_eod%":>10s} {"mean_eod%":>11s}')
    for name, mask in rules.items():
        g = rl.loc[mask.fillna(False)]
        if len(g) < 5:
            continue
        lot = g['lottery'].mean() * 100
        big_lot = g['big_lottery'].mean() * 100
        med = g['hold_to_eod'].median()
        mean = g['hold_to_eod'].mean()
        lift = lot / base if base > 0 else 0
        flag = ' ★' if lift >= 2 else ''
        print(f'{name:<55s} {len(g):>5d} {lot:>7.1f}% {big_lot:>9.1f}% '
              f'{lift:>5.1f}x {med:>+9.1f}% {mean:>+10.1f}%{flag}')

    # ============================================================
    # AUDIT 5: Best rule's REALIZED P&L at realistic trade counts
    # ============================================================
    print('\n' + '=' * 90)
    print('=== REALISTIC TRADER TEST: best rule, 1-3 trades/day ===')
    print('=' * 90)
    print('For each candidate rule, simulate taking top-N qualifying trades per day.')
    print('"Top" here means lowest entry_price within qualifying set.\n')

    candidate_rules = {
        'cheap call (e<$1, calls only)':
            (rl['entry_price'] < 1) & (rl['option_type']=='call'),
        'cheap call PM':
            (rl['entry_price'] < 1) & (rl['option_type']=='call') & (rl['tod']=='PM'),
        'cheap call burst>=200':
            (rl['entry_price'] < 1) & (rl['option_type']=='call') & (rl['trigger_window_size']>=200),
        'mode A cheap call':
            (rl['mode']=='A_intraday_0DTE') & (rl['entry_price']<1) & (rl['option_type']=='call'),
        'entry < $0.50':
            rl['entry_price'] < 0.50,
        'all RE-LOAD (control)':
            pd.Series(True, index=rl.index),
    }

    for rule_name, mask in candidate_rules.items():
        g = rl.loc[mask.fillna(False)].copy()
        if len(g) < 10:
            continue
        print(f'\n--- Rule: {rule_name} ---')
        print(f'  Total qualifying trades over 15 days: {len(g)} ({len(g)/15:.1f}/day avg)')
        # For each TopN per day, sum P&L under hold_to_eod
        g['date_only'] = g['date_str'].dt.strftime('%Y-%m-%d') if hasattr(g['date_str'], 'dt') else g['date_str']
        for top_n in [1, 2, 3, 5]:
            cherry = g.sort_values(['date_only', 'entry_price']).groupby('date_only').head(top_n)
            for policy in ['hold_to_eod', 'hard_30m', 'tier_50_holdEod', 'act30_trail10']:
                s = cherry[policy]
                tot = s.sum()
                med = s.median()
                win = (s > 0).mean() * 100
                print(f'  top-{top_n} ({len(cherry):>3d} trades) {policy:<22s}: '
                      f'total ${tot:>+7.0f} median {med:>+6.1f}% win% {win:>5.1f}%')

    # ============================================================
    # SAVE
    # ============================================================
    rl.to_csv(OUT / 'outputs' / 'p28_reload_with_features.csv', index=False)
    print(f'\nSaved → outputs/p28_reload_with_features.csv')


if __name__ == '__main__':
    main()
