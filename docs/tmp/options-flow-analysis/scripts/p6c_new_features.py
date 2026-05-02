"""Phase 6c — extract new features for v3 triggers and re-validate model.

New features added:
  1. vol_oi_velocity:  vol/OI added in last 5 min before trigger (vs lifetime)
  2. iv_change_30m:    (IV at trigger) - (IV 30 min before trigger)
  3. spot_momentum_5m: pct change in underlying in last 5 min
  4. spread_pct:       avg (nbbo_ask - nbbo_bid)/mid in 5-min pre-trigger window
  5. cascade_count:    # of other v3 triggers on same ticker within ±5 min

Re-runs identical 5-fold TimeSeriesSplit validation as Phase 6b for
direct apples-to-apples comparison.
"""
from __future__ import annotations

import glob
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from sklearn.calibration import calibration_curve
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (average_precision_score, brier_score_loss,
                             roc_auc_score)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import OneHotEncoder

warnings.filterwarnings('ignore')
DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = [
    'executed_at', 'underlying_symbol', 'option_chain_id', 'price', 'size',
    'underlying_price', 'implied_volatility', 'nbbo_bid', 'nbbo_ask',
    'open_interest', 'canceled',
]


def _coerce_canceled(s):
    if s.dtype == bool: return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def extract_new_features():
    """For each v3 trigger, compute the 5 new features."""
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
    print(f'Computing new features for {len(v3):,} triggers')

    # === Cascade count: vectorized from v3 alone ===
    # For each trigger, count other triggers on SAME TICKER within ±5 min
    v3['minute_bucket'] = v3['trigger_time_ct'].dt.floor('5min')
    cascade = v3.groupby(['underlying_symbol', 'minute_bucket']).size().reset_index(name='cascade_count_5m')
    v3 = v3.merge(cascade, on=['underlying_symbol', 'minute_bucket'], how='left')
    v3['cascade_count_5m'] -= 1  # subtract self (so 0 = no other triggers in same window)
    print(f'  cascade_count_5m: median={v3["cascade_count_5m"].median():.0f} max={v3["cascade_count_5m"].max():.0f}')

    # === Per-day parquet pull for the option-chain features ===
    chains_by_day: dict[str, set[str]] = {}
    for d, ids in v3.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)
    tickers_by_day: dict[str, set[str]] = {}
    for d, syms in v3.groupby('date_str')['underlying_symbol']:
        tickers_by_day[d] = set(syms)

    rows = []
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in chains_by_day:
            continue
        target_chains = chains_by_day[date_str]
        target_tickers = tickers_by_day[date_str]
        print(f'  {date_str}: {len(target_chains)} chains', flush=True)
        t = pq.read_table(f, columns=COLS)
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled'] & (df['price'] > 0)]
        for c in ['option_chain_id', 'underlying_symbol']:
            df[c] = df[c].astype(str)
        df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')

        # Spot trajectory per ticker — used for spot momentum
        spot_df = df.loc[df['underlying_symbol'].isin(target_tickers),
                         ['underlying_symbol', 'ts_ct', 'underlying_price']]

        # Per chain
        chain_df = df.loc[df['option_chain_id'].isin(target_chains)]
        day_triggers = v3.loc[v3['date_str'] == date_str].set_index('option_chain_id')

        for ch_id, g in chain_df.groupby('option_chain_id'):
            if ch_id not in day_triggers.index:
                continue
            row = day_triggers.loc[ch_id]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            entry_time = pd.Timestamp(row['trigger_time_ct'])
            ticker = row['underlying_symbol']
            oi = float(row['open_interest']) if pd.notna(row['open_interest']) else 1
            g = g.sort_values('ts_ct')

            # Pre-5m and pre-30m windows
            five_ago = entry_time - pd.Timedelta(minutes=5)
            thirty_ago = entry_time - pd.Timedelta(minutes=30)
            pre5 = g.loc[(g['ts_ct'] >= five_ago) & (g['ts_ct'] <= entry_time)]
            pre30 = g.loc[(g['ts_ct'] >= thirty_ago) & (g['ts_ct'] <= entry_time)]
            pre30_to_5 = g.loc[(g['ts_ct'] >= thirty_ago) & (g['ts_ct'] < five_ago)]

            # vol/OI velocity = (size in pre-5m) / OI
            vol_velocity = pre5['size'].sum() / max(oi, 1)

            # IV change
            iv_recent = pre5['implied_volatility'].mean() if len(pre5) > 0 else np.nan
            iv_old = pre30_to_5['implied_volatility'].mean() if len(pre30_to_5) > 0 else np.nan
            iv_change = (iv_recent - iv_old) if pd.notna(iv_recent) and pd.notna(iv_old) else 0.0

            # Spread % in pre-5m (from this chain's prints)
            if len(pre5) > 0:
                ask = pre5['nbbo_ask']
                bid = pre5['nbbo_bid']
                mid = (ask + bid) / 2
                valid = (mid > 0) & (ask > bid)
                if valid.any():
                    spread_pct = ((ask - bid) / mid).loc[valid].mean() * 100
                else:
                    spread_pct = np.nan
            else:
                spread_pct = np.nan

            # Spot momentum (5-min)
            tk_spots = spot_df.loc[spot_df['underlying_symbol'] == ticker]
            spot_now = tk_spots.loc[tk_spots['ts_ct'] <= entry_time]['underlying_price']
            spot_5ago = tk_spots.loc[tk_spots['ts_ct'] <= five_ago]['underlying_price']
            spot_pct_5m = ((spot_now.iloc[-1] / spot_5ago.iloc[-1] - 1) * 100) if len(spot_now) > 0 and len(spot_5ago) > 0 else 0.0

            rows.append({
                'date_str': date_str,
                'option_chain_id': ch_id,
                'vol_oi_velocity_5m': vol_velocity,
                'iv_change_30m_to_5m': iv_change,
                'spread_pct_5m': spread_pct,
                'spot_momentum_5m_pct': spot_pct_5m,
            })

    new_feats = pd.DataFrame(rows)
    out_csv = OUT / 'outputs' / 'p6c_new_features.csv'
    new_feats.to_csv(out_csv, index=False)
    print(f'\nSaved {len(new_feats):,} rows → {out_csv}')

    # Merge cascade back too
    cascade_df = v3[['option_chain_id', 'date_str', 'cascade_count_5m']]
    new_feats = new_feats.merge(cascade_df, on=['option_chain_id', 'date_str'], how='left')
    new_feats.to_csv(out_csv, index=False)
    return new_feats


def load_full_data(new_feats):
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
    p4 = p4[['option_chain_id', 'date_str', 'mult_at_30m']]
    v3 = v3.merge(p4, on=['option_chain_id', 'date_str'], how='left').drop_duplicates(subset=['option_chain_id','date_str']).dropna(subset=['mult_at_30m'])

    v3 = v3.merge(new_feats, on=['option_chain_id', 'date_str'], how='left')

    v3['ret_30m_pct'] = (v3['mult_at_30m'] - 1) * 100
    v3['winner_30m'] = (v3['ret_30m_pct'] > 0).astype(int)
    v3['log_entry_price'] = np.log1p(v3['entry_price'])
    v3['moneyness'] = (v3['strike'] - v3['spot_at_trigger']) / v3['spot_at_trigger']
    v3.loc[v3['option_type']=='put', 'moneyness'] = -v3['moneyness']
    v3['abs_otm'] = v3['moneyness'].abs() * 100
    v3['is_call'] = (v3['option_type'] == 'call').astype(int)
    v3['is_morning'] = ((v3['hour'] >= 8.5) & (v3['hour'] < 9.5)).astype(int)
    v3['log_oi'] = np.log1p(v3['open_interest'].clip(lower=0))
    v3['log_vol_velocity'] = np.log1p(v3['vol_oi_velocity_5m'].fillna(0))
    return v3.sort_values('trigger_time_ct').reset_index(drop=True)


def build_features(df, ohe=None, include_new=True):
    feat_num = ['trigger_vol_to_oi', 'trigger_iv', 'trigger_delta',
                'trigger_ask_pct', 'hour', 'abs_otm', 'log_entry_price',
                'log_oi', 'is_call', 'is_morning']
    if include_new:
        feat_num += ['log_vol_velocity', 'iv_change_30m_to_5m',
                     'spread_pct_5m', 'spot_momentum_5m_pct',
                     'cascade_count_5m']
    X_num = df[feat_num].fillna(0).values
    if ohe is None:
        ohe = OneHotEncoder(sparse_output=False, handle_unknown='ignore')
        X_tk = ohe.fit_transform(df[['underlying_symbol']])
    else:
        X_tk = ohe.transform(df[['underlying_symbol']])
    X = np.hstack([X_num, X_tk])
    feat_names = feat_num + [f'tk_{c}' for c in ohe.categories_[0]]
    return X, ohe, feat_names


def cv_evaluate(v3, include_new, label):
    print()
    print('=' * 75)
    print(f'=== {label} ===')
    print('=' * 75)
    tscv = TimeSeriesSplit(n_splits=5)
    metrics = []
    for fold, (tri, tei) in enumerate(tscv.split(v3), 1):
        train, test = v3.iloc[tri], v3.iloc[tei]
        X_train, ohe, feat_names = build_features(train, include_new=include_new)
        X_test, _, _ = build_features(test, ohe, include_new=include_new)
        y_train, y_test = train['winner_30m'].values, test['winner_30m'].values
        model = GradientBoostingClassifier(n_estimators=200, max_depth=3,
                                           learning_rate=0.05, subsample=0.8,
                                           random_state=42)
        model.fit(X_train, y_train)
        p = model.predict_proba(X_test)[:, 1]
        auc = roc_auc_score(y_test, p)
        kept_55 = test.assign(p=p).loc[p >= 0.55]
        kept_60 = test.assign(p=p).loc[p >= 0.60]
        m = {
            'fold': fold,
            'auc_test': auc,
            'all_avg_ret': test['ret_30m_pct'].mean(),
            'p55_n': len(kept_55),
            'p55_avg_ret': kept_55['ret_30m_pct'].mean() if len(kept_55) else np.nan,
            'p55_win_rate': (kept_55['winner_30m']==1).mean()*100 if len(kept_55) else np.nan,
            'p60_n': len(kept_60),
            'p60_win_rate': (kept_60['winner_30m']==1).mean()*100 if len(kept_60) else np.nan,
        }
        metrics.append(m)
        print(f'Fold {fold}: AUC={auc:.3f}  all_avg={m["all_avg_ret"]:+.2f}%  '
              f'p55: n={m["p55_n"]} ret={m["p55_avg_ret"]:+.2f}% win={m["p55_win_rate"]:.1f}%')
    df = pd.DataFrame(metrics)
    print(f'\nMEAN ± STD across 5 folds:')
    for col in ['auc_test', 'all_avg_ret', 'p55_avg_ret', 'p55_win_rate', 'p60_win_rate']:
        s = df[col].dropna()
        if len(s):
            print(f'  {col:<18s} {s.mean():+.3f} ± {s.std():.3f}  (range {s.min():+.3f} to {s.max():+.3f})')
    return df, model, feat_names


def main():
    # Step 1: extract or load new features
    new_feats_csv = OUT / 'outputs' / 'p6c_new_features.csv'
    if new_feats_csv.exists():
        print(f'Loading cached features from {new_feats_csv}')
        new_feats = pd.read_csv(new_feats_csv)
    else:
        new_feats = extract_new_features()

    v3 = load_full_data(new_feats)
    print(f'\nFinal universe: {len(v3):,} trades, base rate {v3["winner_30m"].mean()*100:.1f}%')

    # Quick univariate of new features
    print('\n=== UNIVARIATE: new features by quintile ===')
    for feat in ['vol_oi_velocity_5m', 'iv_change_30m_to_5m', 'spread_pct_5m',
                 'spot_momentum_5m_pct', 'cascade_count_5m']:
        try:
            v3['_q'] = pd.qcut(v3[feat].rank(method='first'), 5, labels=['Q1','Q2','Q3','Q4','Q5'])
            s = v3.groupby('_q', observed=True).agg(
                n=('winner_30m', 'size'),
                win_rate=('winner_30m', lambda s: s.mean()*100),
                avg_ret=('ret_30m_pct', 'mean'),
                fmin=(feat, 'min'),
                fmax=(feat, 'max'),
            ).round(2)
            spread = s['win_rate'].max() - s['win_rate'].min()
            print(f'\n{feat}  (Q5−Q1 spread: {spread:+.1f} pts)')
            print(s.to_string())
        except Exception as e:
            print(f'  skip {feat}: {e}')

    # Side-by-side: baseline (existing features) vs +new features
    df_base, _, _ = cv_evaluate(v3, include_new=False, label='BASELINE: existing 10 features only')
    df_new, model_new, feat_names = cv_evaluate(v3, include_new=True, label='WITH NEW: 15 features')

    # Comparison table
    print()
    print('=' * 75)
    print('=== HEAD-TO-HEAD ===')
    print('=' * 75)
    print(f'{"Metric":<22s} {"Baseline":<22s} {"With new":<22s} {"Δ"}')
    print('-' * 80)
    for col in ['auc_test', 'p55_avg_ret', 'p55_win_rate', 'p60_win_rate']:
        b = df_base[col].dropna()
        n = df_new[col].dropna()
        bv = f'{b.mean():+6.3f} ± {b.std():.3f}'
        nv = f'{n.mean():+6.3f} ± {n.std():.3f}'
        delta = n.mean() - b.mean()
        print(f'{col:<22s} {bv:<22s} {nv:<22s} {delta:+.3f}')

    # Feature importance from full model (last fold)
    print()
    print('=== Top 20 features by importance (with new features) ===')
    train, test = v3.iloc[list(TimeSeriesSplit(5).split(v3))[-1][0]], v3.iloc[list(TimeSeriesSplit(5).split(v3))[-1][1]]
    X_train, ohe, fn = build_features(train, include_new=True)
    m = GradientBoostingClassifier(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8, random_state=42)
    m.fit(X_train, train['winner_30m'].values)
    imp_df = pd.DataFrame({'feature': fn, 'importance': m.feature_importances_}).sort_values('importance', ascending=False)
    print(imp_df.head(20).to_string(index=False))


if __name__ == '__main__':
    main()
