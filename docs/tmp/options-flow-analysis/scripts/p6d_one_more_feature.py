"""Phase 6d — add ONE feature: directional_range_position.

Idea: at trigger time, compute where the underlying sits in its day's
high-low range so far. Then orient by option direction:
  - For CALL triggers: directional_RP = (spot - day_low) / (day_high - day_low)
    Want this near 1.0 (already at day's high — uptrend)
  - For PUT triggers: directional_RP = (day_high - spot) / (day_high - day_low)
    Want this near 1.0 (already at day's low — downtrend)

So in both cases, directional_RP near 1.0 = trade aligned with intraday trend.

Then re-run identical 5-fold CV vs baseline.
"""
from __future__ import annotations

import glob
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import OneHotEncoder

warnings.filterwarnings('ignore')
DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def extract_directional_rp():
    """For each v3 trigger, compute directional_range_position."""
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
    print(f'Computing directional_RP for {len(v3):,} triggers')

    tickers_by_day: dict[str, set[str]] = {}
    for d, syms in v3.groupby('date_str')['underlying_symbol']:
        tickers_by_day[d] = set(syms)

    rows = []
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in tickers_by_day:
            continue
        target_tickers = tickers_by_day[date_str]
        print(f'  {date_str}', flush=True)
        t = pq.read_table(f, columns=[
            'executed_at', 'underlying_symbol', 'underlying_price', 'canceled',
        ])
        df = t.to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled']]
        df['underlying_symbol'] = df['underlying_symbol'].astype(str)
        df = df.loc[df['underlying_symbol'].isin(target_tickers)]
        df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
        df = df[['underlying_symbol', 'ts_ct', 'underlying_price']].sort_values('ts_ct')

        # Per-ticker, compute running min/max of spot
        for ticker, g in df.groupby('underlying_symbol'):
            g = g.reset_index(drop=True)
            g['day_low'] = g['underlying_price'].cummin()
            g['day_high'] = g['underlying_price'].cummax()
            day_triggers = v3.loc[(v3['date_str'] == date_str) &
                                  (v3['underlying_symbol'] == ticker)]
            for _, row in day_triggers.iterrows():
                tt = pd.Timestamp(row['trigger_time_ct'])
                # Find last spot snapshot before or at trigger time
                snap = g.loc[g['ts_ct'] <= tt]
                if len(snap) == 0:
                    rows.append({
                        'option_chain_id': row['option_chain_id'],
                        'date_str': date_str,
                        'spot_at_trigger_v2': np.nan,
                        'day_low_at_trigger': np.nan,
                        'day_high_at_trigger': np.nan,
                        'directional_rp': 0.5,
                    })
                    continue
                last = snap.iloc[-1]
                spot = last['underlying_price']
                lo = last['day_low']
                hi = last['day_high']
                rng = hi - lo
                if rng <= 0:
                    rp = 0.5
                else:
                    raw_rp = (spot - lo) / rng  # 0 = day low, 1 = day high
                    if row['option_type'] == 'call':
                        rp = raw_rp  # call wants near high
                    else:
                        rp = 1 - raw_rp  # put wants near low
                rows.append({
                    'option_chain_id': row['option_chain_id'],
                    'date_str': date_str,
                    'spot_at_trigger_v2': spot,
                    'day_low_at_trigger': lo,
                    'day_high_at_trigger': hi,
                    'directional_rp': rp,
                })

    out = pd.DataFrame(rows)
    out_csv = OUT / 'outputs' / 'p6d_directional_rp.csv'
    out.to_csv(out_csv, index=False)
    print(f'Saved {len(out):,} rows → {out_csv}')
    return out


def load_full_data(rp_feats):
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
    v3 = v3.merge(rp_feats[['option_chain_id', 'date_str', 'directional_rp']],
                  on=['option_chain_id', 'date_str'], how='left')
    v3['directional_rp'] = v3['directional_rp'].fillna(0.5)

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


def build_features(df, ohe=None, include_rp=True):
    feat_num = ['trigger_vol_to_oi', 'trigger_iv', 'trigger_delta',
                'trigger_ask_pct', 'hour', 'abs_otm', 'log_entry_price',
                'log_oi', 'is_call', 'is_morning']
    if include_rp:
        feat_num += ['directional_rp']
    X_num = df[feat_num].fillna(0).values
    if ohe is None:
        ohe = OneHotEncoder(sparse_output=False, handle_unknown='ignore')
        X_tk = ohe.fit_transform(df[['underlying_symbol']])
    else:
        X_tk = ohe.transform(df[['underlying_symbol']])
    X = np.hstack([X_num, X_tk])
    feat_names = feat_num + [f'tk_{c}' for c in ohe.categories_[0]]
    return X, ohe, feat_names


def cv_evaluate(v3, include_rp, label):
    print('\n' + '=' * 70)
    print(f'=== {label} ===')
    print('=' * 70)
    tscv = TimeSeriesSplit(n_splits=5)
    metrics = []
    for fold, (tri, tei) in enumerate(tscv.split(v3), 1):
        train, test = v3.iloc[tri], v3.iloc[tei]
        X_train, ohe, feat_names = build_features(train, include_rp=include_rp)
        X_test, _, _ = build_features(test, ohe, include_rp=include_rp)
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
            'p60_avg_ret': kept_60['ret_30m_pct'].mean() if len(kept_60) else np.nan,
            'p60_win_rate': (kept_60['winner_30m']==1).mean()*100 if len(kept_60) else np.nan,
        }
        metrics.append(m)
        print(f'Fold {fold}: AUC={auc:.3f}  p55: n={m["p55_n"]} ret={m["p55_avg_ret"]:+.2f}% win={m["p55_win_rate"]:.1f}%')
    df = pd.DataFrame(metrics)
    print(f'\nMEAN ± STD:')
    for col in ['auc_test', 'p55_avg_ret', 'p55_win_rate', 'p60_avg_ret', 'p60_win_rate']:
        s = df[col].dropna()
        if len(s):
            print(f'  {col:<18s} {s.mean():+.3f} ± {s.std():.3f}')
    return df


def main():
    rp_csv = OUT / 'outputs' / 'p6d_directional_rp.csv'
    if rp_csv.exists():
        print(f'Loading cached RP features from {rp_csv}')
        rp = pd.read_csv(rp_csv)
    else:
        rp = extract_directional_rp()

    v3 = load_full_data(rp)
    print(f'\nFinal: {len(v3):,} trades, base rate {v3["winner_30m"].mean()*100:.1f}%')

    # Univariate
    print('\n=== UNIVARIATE: directional_rp by quintile ===')
    v3['_q'] = pd.qcut(v3['directional_rp'].rank(method='first'), 5, labels=['Q1','Q2','Q3','Q4','Q5'])
    s = v3.groupby('_q', observed=True).agg(
        n=('winner_30m', 'size'),
        win_rate=('winner_30m', lambda s: s.mean()*100),
        avg_ret=('ret_30m_pct', 'mean'),
        rp_min=('directional_rp', 'min'),
        rp_max=('directional_rp', 'max'),
    ).round(2)
    spread = s['win_rate'].max() - s['win_rate'].min()
    print(f'directional_rp  (Q5-Q1 spread: {spread:+.1f} pts)')
    print(s.to_string())

    # Compare baseline vs +RP
    df_base = cv_evaluate(v3, include_rp=False, label='BASELINE: 10 features (no RP)')
    df_rp = cv_evaluate(v3, include_rp=True, label='WITH RP: 11 features')

    # Head-to-head
    print('\n' + '=' * 70)
    print('=== HEAD-TO-HEAD: baseline vs +directional_rp ===')
    print('=' * 70)
    print(f'{"Metric":<22s} {"Baseline":<22s} {"+ RP":<22s} {"Δ"}')
    print('-' * 80)
    for col in ['auc_test', 'p55_avg_ret', 'p55_win_rate', 'p60_avg_ret', 'p60_win_rate']:
        b = df_base[col].dropna()
        n = df_rp[col].dropna()
        bv = f'{b.mean():+6.3f} ± {b.std():.3f}'
        nv = f'{n.mean():+6.3f} ± {n.std():.3f}'
        delta = n.mean() - b.mean()
        marker = ' ←improve' if delta > 0 else (' ←regression' if delta < -0.1 else '')
        print(f'{col:<22s} {bv:<22s} {nv:<22s} {delta:+.3f}{marker}')


if __name__ == '__main__':
    main()
