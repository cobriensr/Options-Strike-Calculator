"""Phase 6 — Feature engineering: what separates winners from losers?

Goal: predict whether a v3 trigger will return positive % at +30min, using
features available at trigger time.

Method:
  1. Build feature matrix (4 trigger features + derived: hour, otm, entry,
     ticker one-hot, option_type)
  2. Train gradient-boosted classifier with time-based split (train on first
     12 days, test on last 3)
  3. Report feature importances + per-feature win-rate stratification
  4. Partial dependence on top features
  5. Test the classifier as a filter: does keeping only "predicted winners"
     improve avg % return per trade?
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (classification_report, confusion_matrix,
                             roc_auc_score)
from sklearn.preprocessing import OneHotEncoder

OUT = Path(__file__).resolve().parents[1]


def main():
    # Load and join data
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

    p4 = pd.read_csv(OUT / 'outputs' / 'p4_exits.csv')
    p4['date_str'] = p4['date'].astype(str)
    p4 = p4[['option_chain_id', 'date_str', 'mult_at_30m', 'eod_price']]
    v3 = v3.merge(p4, on=['option_chain_id', 'date_str'], how='left')
    v3 = v3.drop_duplicates(subset=['option_chain_id', 'date_str'])
    v3 = v3.dropna(subset=['mult_at_30m'])

    # Outcome variable: did it return positive at +30min?
    v3['ret_30m_pct'] = (v3['mult_at_30m'] - 1) * 100
    v3['winner_30m'] = (v3['ret_30m_pct'] > 0).astype(int)
    print(f'Universe: {len(v3):,} trades')
    print(f'Base rate winner_30m: {v3["winner_30m"].mean()*100:.1f}%')
    print()

    # Feature engineering
    v3['log_entry_price'] = np.log1p(v3['entry_price'])
    # Compute moneyness from strike + spot
    v3['moneyness'] = (v3['strike'] - v3['spot_at_trigger']) / v3['spot_at_trigger']
    # For puts, OTM is negative direction — make abs_otm intuitive
    v3.loc[v3['option_type'] == 'put', 'moneyness'] = -v3['moneyness']
    v3['abs_otm'] = v3['moneyness'].abs() * 100
    v3['is_call'] = (v3['option_type'] == 'call').astype(int)
    v3['is_morning'] = ((v3['hour'] >= 8.5) & (v3['hour'] < 9.5)).astype(int)
    v3['log_vol_oi'] = np.log1p(v3['trigger_vol_to_oi'])
    v3['log_oi'] = np.log1p(v3['open_interest'].clip(lower=0))

    # Per-feature win-rate stratification (no model needed)
    print('=' * 75)
    print('=== UNIVARIATE FEATURE ANALYSIS: win rate by feature quintile ===')
    print('=' * 75)
    cont_features = ['trigger_vol_to_oi', 'trigger_iv', 'trigger_delta',
                     'trigger_ask_pct', 'hour', 'abs_otm', 'log_entry_price',
                     'log_oi']
    for feat in cont_features:
        try:
            v3['_q'] = pd.qcut(v3[feat].rank(method='first'), 5, labels=['Q1','Q2','Q3','Q4','Q5'])
            s = v3.groupby('_q', observed=True).agg(
                n=('winner_30m', 'size'),
                win_rate_pct=('winner_30m', lambda s: s.mean()*100),
                avg_ret_pct=('ret_30m_pct', 'mean'),
                feat_min=(feat, 'min'),
                feat_max=(feat, 'max'),
            )
            spread = s['win_rate_pct'].max() - s['win_rate_pct'].min()
            print(f'\n{feat:<25s}  (Q5−Q1 win-rate spread: {spread:+.1f} pts)')
            print(s.round(2).to_string())
        except Exception as e:
            print(f'  skip {feat}: {e}')

    # Per-ticker win rate
    print()
    print('=' * 75)
    print('=== Per-ticker win rate (sorted) ===')
    print('=' * 75)
    tk_summary = v3.groupby('underlying_symbol').agg(
        n=('winner_30m', 'size'),
        win_rate_pct=('winner_30m', lambda s: s.mean()*100),
        avg_ret_pct=('ret_30m_pct', 'mean'),
    ).sort_values('win_rate_pct', ascending=False).round(2)
    print(tk_summary.to_string())

    # === MODELING ===
    print()
    print('=' * 75)
    print('=== GRADIENT BOOSTING CLASSIFIER (predict winner_30m) ===')
    print('=' * 75)

    # Time-based split (last 3 calendar days = test)
    unique_dates = sorted(v3['date'].dropna().unique())
    cutoff = unique_dates[-3]  # third-to-last unique date is the train/test boundary
    train = v3.loc[v3['date'] < cutoff].copy()
    test = v3.loc[v3['date'] >= cutoff].copy()
    print(f'Train: {len(train)} ({train["date"].min().date()} to {train["date"].max().date()})')
    print(f'Test:  {len(test)} ({test["date"].min().date()} to {test["date"].max().date()})')

    feat_num = ['trigger_vol_to_oi', 'trigger_iv', 'trigger_delta',
                'trigger_ask_pct', 'hour', 'abs_otm', 'log_entry_price',
                'log_oi', 'is_call', 'is_morning']
    X_num_train = train[feat_num].fillna(0).values
    X_num_test = test[feat_num].fillna(0).values

    # One-hot encode ticker
    ohe = OneHotEncoder(sparse_output=False, handle_unknown='ignore')
    X_tk_train = ohe.fit_transform(train[['underlying_symbol']])
    X_tk_test = ohe.transform(test[['underlying_symbol']])
    feat_tk = [f'tk_{c}' for c in ohe.categories_[0]]

    X_train = np.hstack([X_num_train, X_tk_train])
    X_test = np.hstack([X_num_test, X_tk_test])
    feature_names = feat_num + feat_tk

    y_train = train['winner_30m'].values
    y_test = test['winner_30m'].values

    model = GradientBoostingClassifier(n_estimators=200, max_depth=3, learning_rate=0.05,
                                        subsample=0.8, random_state=42)
    model.fit(X_train, y_train)

    # Eval
    p_train = model.predict_proba(X_train)[:, 1]
    p_test = model.predict_proba(X_test)[:, 1]
    auc_train = roc_auc_score(y_train, p_train)
    auc_test = roc_auc_score(y_test, p_test)
    print(f'\nROC-AUC train: {auc_train:.3f}')
    print(f'ROC-AUC test:  {auc_test:.3f}  (>0.55 = useful signal)')

    # Feature importance
    print('\n=== Feature importances (top 20) ===')
    imps = pd.DataFrame({'feature': feature_names, 'importance': model.feature_importances_})
    imps = imps.sort_values('importance', ascending=False)
    print(imps.head(20).to_string(index=False))

    # As a filter: does keeping high-prob trades help avg return?
    print('\n=== Using classifier as a filter on TEST set ===')
    test = test.copy()
    test['p_win'] = p_test
    print(f'\nIf you keep ALL {len(test)} test trades:')
    print(f'  Avg return: {test["ret_30m_pct"].mean():+.2f}%')
    print(f'  Win rate:   {(test["ret_30m_pct"]>0).mean()*100:.1f}%')

    for thresh in [0.4, 0.5, 0.55, 0.6, 0.65, 0.7]:
        kept = test.loc[test['p_win'] >= thresh]
        if len(kept) == 0:
            continue
        avg = kept['ret_30m_pct'].mean()
        wr = (kept['ret_30m_pct'] > 0).mean() * 100
        retain = len(kept) / len(test) * 100
        print(f'\nIf p_win ≥ {thresh:.2f}: keep {len(kept)}/{len(test)} trades ({retain:.0f}%)')
        print(f'  Avg return: {avg:+.2f}%')
        print(f'  Win rate:   {wr:.1f}%')

    # Save scored test set
    test_out = test[['date','underlying_symbol','option_type','strike','entry_price',
                     'ret_30m_pct','winner_30m','p_win']].copy()
    test_out.to_csv(OUT / 'outputs' / 'p6_test_scored.csv', index=False)
    print(f'\nSaved scored test set → outputs/p6_test_scored.csv')


if __name__ == '__main__':
    main()
