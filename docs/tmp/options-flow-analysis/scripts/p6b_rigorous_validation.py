"""Phase 6b — rigorous validation of the existing classifier.

Establishes a HONEST baseline by checking:
  1. 5-fold TimeSeriesSplit cross-validation (no look-ahead)
  2. Per-fold AUC, precision, recall — see how stable the model is
  3. Calibration: does p_win = 0.6 actually mean ~60% win rate?
  4. Per-day AUC — does the model work on every type of day?
  5. Hyperparameter sensitivity (small grid)
  6. Filter performance with confidence intervals across folds

Outputs:
  - p6b_cv_metrics.csv
  - Calibration curve printout
  - Confidence intervals on filter performance
"""
from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (average_precision_score, brier_score_loss,
                             f1_score, precision_score, recall_score,
                             roc_auc_score)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import OneHotEncoder

warnings.filterwarnings('ignore')
OUT = Path(__file__).resolve().parents[1]


def load_data():
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
    v3 = v3.drop_duplicates(subset=['option_chain_id', 'date_str']).dropna(subset=['mult_at_30m'])

    v3['ret_30m_pct'] = (v3['mult_at_30m'] - 1) * 100
    v3['winner_30m'] = (v3['ret_30m_pct'] > 0).astype(int)
    v3['log_entry_price'] = np.log1p(v3['entry_price'])
    v3['moneyness'] = (v3['strike'] - v3['spot_at_trigger']) / v3['spot_at_trigger']
    v3.loc[v3['option_type']=='put', 'moneyness'] = -v3['moneyness']
    v3['abs_otm'] = v3['moneyness'].abs() * 100
    v3['is_call'] = (v3['option_type'] == 'call').astype(int)
    v3['is_morning'] = ((v3['hour'] >= 8.5) & (v3['hour'] < 9.5)).astype(int)
    v3['log_oi'] = np.log1p(v3['open_interest'].clip(lower=0))
    return v3.sort_values('trigger_time_ct').reset_index(drop=True)


def build_features(df, ohe=None):
    feat_num = ['trigger_vol_to_oi', 'trigger_iv', 'trigger_delta',
                'trigger_ask_pct', 'hour', 'abs_otm', 'log_entry_price',
                'log_oi', 'is_call', 'is_morning']
    X_num = df[feat_num].fillna(0).values
    if ohe is None:
        ohe = OneHotEncoder(sparse_output=False, handle_unknown='ignore')
        X_tk = ohe.fit_transform(df[['underlying_symbol']])
    else:
        X_tk = ohe.transform(df[['underlying_symbol']])
    X = np.hstack([X_num, X_tk])
    return X, ohe


def main():
    v3 = load_data()
    print(f'Loaded {len(v3):,} trades, base rate winner_30m: {v3["winner_30m"].mean()*100:.1f}%')
    print()

    # === 1. TimeSeriesSplit cross-validation ===
    print('=' * 75)
    print('=== 1. 5-fold TimeSeriesSplit cross-validation ===')
    print('=' * 75)
    tscv = TimeSeriesSplit(n_splits=5)
    cv_metrics = []
    for fold, (train_idx, test_idx) in enumerate(tscv.split(v3), 1):
        train = v3.iloc[train_idx].copy()
        test = v3.iloc[test_idx].copy()
        X_train, ohe = build_features(train)
        X_test, _ = build_features(test, ohe)
        y_train, y_test = train['winner_30m'].values, test['winner_30m'].values

        model = GradientBoostingClassifier(n_estimators=200, max_depth=3,
                                           learning_rate=0.05, subsample=0.8,
                                           random_state=42)
        model.fit(X_train, y_train)
        p_train = model.predict_proba(X_train)[:, 1]
        p_test = model.predict_proba(X_test)[:, 1]

        auc_tr = roc_auc_score(y_train, p_train)
        auc_te = roc_auc_score(y_test, p_test)
        pr_tr = average_precision_score(y_train, p_train)
        pr_te = average_precision_score(y_test, p_test)
        brier = brier_score_loss(y_test, p_test)

        # Filter performance @ p≥0.55
        kept_55 = test.assign(p=p_test).loc[p_test >= 0.55]
        kept_60 = test.assign(p=p_test).loc[p_test >= 0.60]

        d_train_min = train['date'].min().date()
        d_train_max = train['date'].max().date()
        d_test_min = test['date'].min().date()
        d_test_max = test['date'].max().date()

        m = {
            'fold': fold,
            'train_size': len(train),
            'test_size': len(test),
            'train_dates': f'{d_train_min} → {d_train_max}',
            'test_dates': f'{d_test_min} → {d_test_max}',
            'auc_train': auc_tr,
            'auc_test': auc_te,
            'overfit_gap': auc_tr - auc_te,
            'pr_test': pr_te,
            'brier': brier,
            'all_avg_ret': test['ret_30m_pct'].mean(),
            'all_win_rate': (test['winner_30m']==1).mean()*100,
            'p55_n': len(kept_55),
            'p55_avg_ret': kept_55['ret_30m_pct'].mean() if len(kept_55) else np.nan,
            'p55_win_rate': (kept_55['winner_30m']==1).mean()*100 if len(kept_55) else np.nan,
            'p60_n': len(kept_60),
            'p60_avg_ret': kept_60['ret_30m_pct'].mean() if len(kept_60) else np.nan,
            'p60_win_rate': (kept_60['winner_30m']==1).mean()*100 if len(kept_60) else np.nan,
        }
        cv_metrics.append(m)
        print(f'Fold {fold}: train {m["train_size"]:>4d} ({m["train_dates"]}) → test {m["test_size"]:>4d} ({m["test_dates"]})')
        print(f'         AUC train={auc_tr:.3f} test={auc_te:.3f} (gap={m["overfit_gap"]:+.3f}) | brier={brier:.3f}')
        print(f'         All test trades:  avg_ret={m["all_avg_ret"]:+.2f}% win={m["all_win_rate"]:.1f}%')
        print(f'         p_win >= 0.55:    n={m["p55_n"]:>3d} avg_ret={m["p55_avg_ret"]:+.2f}% win={m["p55_win_rate"]:.1f}%')
        print(f'         p_win >= 0.60:    n={m["p60_n"]:>3d} avg_ret={m["p60_avg_ret"]:+.2f}% win={m["p60_win_rate"]:.1f}%')
        print()

    cv_df = pd.DataFrame(cv_metrics)
    cv_df.to_csv(OUT / 'outputs' / 'p6b_cv_metrics.csv', index=False)

    # CV summary
    print('=' * 75)
    print('=== CV SUMMARY (mean ± std across 5 folds) ===')
    print('=' * 75)
    for col in ['auc_test', 'overfit_gap', 'all_avg_ret', 'all_win_rate',
                'p55_avg_ret', 'p55_win_rate', 'p60_avg_ret', 'p60_win_rate']:
        s = cv_df[col].dropna()
        if len(s) == 0:
            continue
        print(f'  {col:<20s} {s.mean():+7.3f} ± {s.std():.3f}  (range {s.min():+.3f} to {s.max():+.3f})')

    # === 2. Calibration check (use largest fold) ===
    print()
    print('=' * 75)
    print('=== 2. Calibration check (last fold only) ===')
    print('=' * 75)
    train_idx, test_idx = list(tscv.split(v3))[-1]
    train, test = v3.iloc[train_idx], v3.iloc[test_idx]
    X_train, ohe = build_features(train)
    X_test, _ = build_features(test, ohe)
    model = GradientBoostingClassifier(n_estimators=200, max_depth=3,
                                       learning_rate=0.05, subsample=0.8,
                                       random_state=42)
    model.fit(X_train, train['winner_30m'].values)
    p = model.predict_proba(X_test)[:, 1]
    fraction_of_positives, mean_predicted = calibration_curve(test['winner_30m'].values, p, n_bins=10, strategy='quantile')
    print('Predicted prob bin → Actual win rate (perfect calibration: equal)')
    for pred, actual in zip(mean_predicted, fraction_of_positives):
        bar = '█' * int(actual * 30)
        marker = ' ← well-calibrated' if abs(pred - actual) < 0.05 else ''
        print(f'  predicted ~{pred:.3f} → actual {actual:.3f}  {bar}{marker}')

    # === 3. Per-day AUC ===
    print()
    print('=' * 75)
    print('=== 3. Per-day AUC stability (using last-fold model) ===')
    print('=' * 75)
    test_with_p = test.copy()
    test_with_p['p_win'] = p
    print(f'{"Date":<12s} {"trades":<8s} {"win%":<8s} {"AUC":<8s} {"p≥0.55 n":<10s} {"p≥0.55 win%"}')
    for date, day in test_with_p.groupby('date'):
        if len(day) < 5 or day['winner_30m'].nunique() < 2:
            continue
        try:
            auc = roc_auc_score(day['winner_30m'].values, day['p_win'].values)
        except ValueError:
            auc = float('nan')
        wr = (day['winner_30m']==1).mean() * 100
        kept = day.loc[day['p_win'] >= 0.55]
        kw = (kept['winner_30m']==1).mean()*100 if len(kept) else 0
        print(f'{str(date.date()):<12s} {len(day):<8d} {wr:<7.1f}% {auc:<7.3f} {len(kept):<10d} {kw:.1f}%')

    # === 4. Hyperparameter sensitivity ===
    print()
    print('=' * 75)
    print('=== 4. Hyperparameter sensitivity (last fold) ===')
    print('=' * 75)
    grid = [
        ('default', {'n_estimators': 200, 'max_depth': 3, 'learning_rate': 0.05}),
        ('shallow', {'n_estimators': 100, 'max_depth': 2, 'learning_rate': 0.1}),
        ('deep',    {'n_estimators': 100, 'max_depth': 5, 'learning_rate': 0.1}),
        ('regularized', {'n_estimators': 500, 'max_depth': 2, 'learning_rate': 0.02, 'subsample': 0.6}),
        ('big_trees', {'n_estimators': 50, 'max_depth': 6, 'learning_rate': 0.1}),
    ]
    print(f'{"Config":<14s} {"AUC train":<11s} {"AUC test":<11s} {"Overfit gap":<13s} {"p≥0.55 win%":<14s}')
    for name, params in grid:
        m = GradientBoostingClassifier(random_state=42, **params)
        m.fit(X_train, train['winner_30m'].values)
        ptr = m.predict_proba(X_train)[:,1]
        pte = m.predict_proba(X_test)[:,1]
        atr = roc_auc_score(train['winner_30m'].values, ptr)
        ate = roc_auc_score(test['winner_30m'].values, pte)
        kept = test.assign(p=pte).loc[pte >= 0.55]
        kwr = (kept['winner_30m']==1).mean()*100 if len(kept) else 0
        print(f'{name:<14s} {atr:<10.3f}  {ate:<10.3f}  {atr-ate:+10.3f}    n={len(kept)} win%={kwr:.1f}')


if __name__ == '__main__':
    main()
