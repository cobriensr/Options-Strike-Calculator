"""Phase 7 — filter feature selection + AND-rule ensemble.

For each candidate feature, compute univariate signal strength.
Then greedily pick INDEPENDENT high-signal features (correlation < 0.5).
Then exhaustively try all 2/3/4-feature AND combinations.
Validate top combos with 5-fold CV.

Goal: simple, interpretable rule set that beats both the ML model AND
the baseline of "trade everything."
"""
from __future__ import annotations

import warnings
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit

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

    # Outcome
    p4 = pd.read_csv(OUT / 'outputs' / 'p4_exits.csv')
    p4['date_str'] = p4['date'].astype(str)
    p4 = p4[['option_chain_id','date_str','mult_at_30m']]
    v3 = v3.merge(p4, on=['option_chain_id','date_str'], how='left').drop_duplicates(subset=['option_chain_id','date_str']).dropna(subset=['mult_at_30m'])
    v3['ret_30m_pct'] = (v3['mult_at_30m'] - 1) * 100
    v3['winner'] = (v3['ret_30m_pct'] > 0).astype(int)

    # Cascade count
    v3['minute_bucket'] = v3['trigger_time_ct'].dt.floor('5min')
    cascade = v3.groupby(['underlying_symbol','minute_bucket']).size().reset_index(name='cascade_count')
    v3 = v3.merge(cascade, on=['underlying_symbol','minute_bucket'], how='left')
    v3['cascade_count'] -= 1

    # Directional RP from cached file
    rp = pd.read_csv(OUT / 'outputs' / 'p6d_directional_rp.csv')
    v3 = v3.merge(rp[['option_chain_id','date_str','directional_rp']],
                  on=['option_chain_id','date_str'], how='left')
    v3['directional_rp'] = v3['directional_rp'].fillna(0.5)

    # Derived
    v3['log_entry_price'] = np.log1p(v3['entry_price'])
    v3['moneyness'] = (v3['strike'] - v3['spot_at_trigger']) / v3['spot_at_trigger']
    v3.loc[v3['option_type']=='put','moneyness'] = -v3['moneyness']
    v3['abs_otm'] = v3['moneyness'].abs() * 100
    v3['log_oi'] = np.log1p(v3['open_interest'].clip(lower=0))
    v3['log_vol_oi'] = np.log1p(v3['trigger_vol_to_oi'])

    return v3.sort_values('trigger_time_ct').reset_index(drop=True)


def univariate_score(df, feat):
    """Return Q5-Q1 win-rate spread + Q5-Q1 avg-return spread + best threshold."""
    try:
        df = df.copy()
        df['_q'] = pd.qcut(df[feat].rank(method='first'), 5,
                           labels=['Q1','Q2','Q3','Q4','Q5'])
        s = df.groupby('_q', observed=True).agg(
            n=('winner','size'),
            wr=('winner', lambda s: s.mean()*100),
            ar=('ret_30m_pct','mean'),
            vmax=(feat,'max'),
            vmin=(feat,'min'),
        )
        # Best quintile = highest avg_return
        best_q = s['ar'].idxmax()
        threshold = s.loc[best_q, 'vmin']
        return {
            'feature': feat,
            'wr_spread': s['wr'].max() - s['wr'].min(),
            'ar_spread': s['ar'].max() - s['ar'].min(),
            'best_q': best_q,
            'best_q_wr': s.loc[best_q,'wr'],
            'best_q_ar': s.loc[best_q,'ar'],
            'best_q_n': s.loc[best_q,'n'],
            'threshold_min': s.loc[best_q,'vmin'],
            'threshold_max': s.loc[best_q,'vmax'],
        }
    except Exception as e:
        return None


def main():
    v3 = load_data()
    print(f'Loaded {len(v3):,} trades, base rate winner = {v3["winner"].mean()*100:.1f}%, base avg ret = {v3["ret_30m_pct"].mean():+.2f}%')

    candidates = [
        'trigger_vol_to_oi', 'trigger_iv', 'trigger_delta',
        'trigger_ask_pct', 'hour', 'abs_otm', 'log_entry_price',
        'log_oi', 'log_vol_oi', 'directional_rp', 'cascade_count',
    ]

    # === STEP 1: Univariate ranking ===
    print('\n=== STEP 1: Univariate scores (sorted by avg-return spread) ===')
    scores = []
    for f in candidates:
        s = univariate_score(v3, f)
        if s: scores.append(s)
    scores_df = pd.DataFrame(scores).sort_values('ar_spread', ascending=False)
    print(scores_df[['feature','wr_spread','ar_spread','best_q','best_q_wr','best_q_ar','best_q_n','threshold_min']].round(2).to_string(index=False))

    # === STEP 2: Correlation matrix ===
    print('\n=== STEP 2: Feature correlation matrix (Pearson) ===')
    corr = v3[candidates].corr()
    print(corr.round(2).to_string())

    # === STEP 3: Greedy independent feature selection ===
    print('\n=== STEP 3: Greedy independent selection (corr < 0.5 with picked) ===')
    ranked = scores_df['feature'].tolist()
    picked = []
    for f in ranked:
        # Check correlation with already-picked
        if not picked:
            picked.append(f)
            continue
        max_corr = max(abs(corr.loc[f, p]) for p in picked)
        if max_corr < 0.5:
            picked.append(f)
        if len(picked) >= 6:
            break
    print(f'Selected {len(picked)} independent features: {picked}')

    # === STEP 4: Build & test all 2/3/4-feature AND combos ===
    print('\n=== STEP 4: Top AND-rule combinations (k=2,3,4) ===')

    # Build per-feature filter rule from best quintile
    def make_rule(feat, score_row):
        thr = score_row['threshold_min']
        return lambda df: df[feat] >= thr, f'{feat} >= {thr:.3f}'

    rule_map = {row['feature']: make_rule(row['feature'], row)
                for _, row in scores_df.iterrows() if row['feature'] in picked}

    print(f'\n{"Combo":<60s}  {"n":<6s} {"%kept":<8s} {"win%":<8s} {"avg ret%":<10s}')
    print('-' * 100)
    all_combos = []
    base_n = len(v3)
    for k in [1, 2, 3, 4]:
        for combo in combinations(picked, k):
            mask = pd.Series(True, index=v3.index)
            for f in combo:
                rule_fn, _ = rule_map[f]
                mask &= rule_fn(v3)
            kept = v3.loc[mask]
            if len(kept) < 30:  # need stable sample
                continue
            avg_ret = kept['ret_30m_pct'].mean()
            wr = (kept['winner']==1).mean() * 100
            all_combos.append({
                'k': k,
                'combo': combo,
                'n': len(kept),
                'pct_kept': len(kept)/base_n*100,
                'win_rate': wr,
                'avg_ret': avg_ret,
                'composite': avg_ret * np.sqrt(len(kept)),
            })

    combos_df = pd.DataFrame(all_combos).sort_values('avg_ret', ascending=False).head(15)
    for _, r in combos_df.iterrows():
        combo_str = ' AND '.join(r['combo'])
        print(f'{combo_str:<60s}  {r["n"]:<6d} {r["pct_kept"]:<7.1f}% {r["win_rate"]:<7.1f}% {r["avg_ret"]:+9.2f}%')

    # === STEP 5: Take top 3 candidates and validate with 5-fold CV ===
    print('\n=== STEP 5: 5-fold TimeSeriesSplit CV on top 3 candidate combos ===')
    top3 = combos_df.head(3)
    tscv = TimeSeriesSplit(n_splits=5)
    for _, candidate in top3.iterrows():
        combo = candidate['combo']
        combo_str = ' AND '.join(combo)
        print(f'\nCombo: {combo_str}')
        print(f'  Static: n={candidate["n"]} win={candidate["win_rate"]:.1f}% avg={candidate["avg_ret"]:+.2f}%')

        per_fold = []
        for fold, (tri, tei) in enumerate(tscv.split(v3), 1):
            test = v3.iloc[tei]
            mask = pd.Series(True, index=test.index)
            for f in combo:
                rule_fn, _ = rule_map[f]
                mask &= rule_fn(test)
            kept = test.loc[mask]
            if len(kept) == 0:
                per_fold.append({'fold':fold,'n':0,'wr':np.nan,'ar':np.nan})
                continue
            per_fold.append({
                'fold': fold,
                'n': len(kept),
                'wr': (kept['winner']==1).mean()*100,
                'ar': kept['ret_30m_pct'].mean(),
            })
        cv_df = pd.DataFrame(per_fold)
        cv_df['fold_baseline_wr'] = [v3.iloc[tei]['winner'].mean()*100 for _, tei in tscv.split(v3)]
        cv_df['fold_baseline_ar'] = [v3.iloc[tei]['ret_30m_pct'].mean() for _, tei in tscv.split(v3)]
        print('  Per-fold validation:')
        for _, f in cv_df.iterrows():
            wr_str = f'{f["wr"]:.1f}%' if pd.notna(f["wr"]) else 'n/a'
            ar_str = f'{f["ar"]:+.2f}%' if pd.notna(f["ar"]) else 'n/a'
            uplift = (f["wr"] - f["fold_baseline_wr"]) if pd.notna(f["wr"]) else None
            print(f'    Fold {int(f["fold"])}: n={int(f["n"])} win={wr_str} avg={ar_str}  '
                  f'(baseline win={f["fold_baseline_wr"]:.1f}%, uplift {f"+{uplift:.1f}" if uplift is not None else "n/a"} pts)')
        valid = cv_df.dropna()
        if len(valid):
            print(f'  CV mean: win={valid["wr"].mean():.1f}% ± {valid["wr"].std():.1f}, '
                  f'avg={valid["ar"].mean():+.2f}% ± {valid["ar"].std():.2f}')

    # Save
    combos_df.to_csv(OUT / 'outputs' / 'p7_combos.csv', index=False)
    scores_df.to_csv(OUT / 'outputs' / 'p7_univariate_scores.csv', index=False)
    print(f'\nSaved → outputs/p7_combos.csv, p7_univariate_scores.csv')


if __name__ == '__main__':
    main()
