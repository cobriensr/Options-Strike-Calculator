"""Phase 4 — NDX-complex vs SPX-complex predictor arm comparison.

Reads ml/experiments/nq-flow-leadership/correlations.parquet and produces a
side-by-side comparison answering: do SPX-complex (SPX, SPXW, SPY) tickers
predict NQ better than NDX-complex (NDX, NDXP, QQQ) tickers?

Output: ml/experiments/nq-flow-leadership/spx_vs_ndx_arm_comparison.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

EXP_DIR = Path(__file__).resolve().parents[3] / 'ml' / 'experiments' / 'nq-flow-leadership'
INPUT_PATH = EXP_DIR / 'correlations.parquet'
OUTPUT_PATH = EXP_DIR / 'spx_vs_ndx_arm_comparison.json'

NDX_COMPLEX = ['NDX', 'NDXP', 'QQQ']
SPX_COMPLEX = ['SPX', 'SPXW', 'SPY']


def main() -> int:
    if not INPUT_PATH.exists():
        print(f'ERROR: {INPUT_PATH} not found (run correlate first)', file=sys.stderr)
        return 1

    df = pd.read_parquet(INPUT_PATH)

    # Restrict to overall-bucket, valid correlations.
    overall = df[(df['bucket'] == 'overall') & df['rho'].notna()].copy()
    overall['abs_rho'] = overall['rho'].abs()
    overall['arm'] = overall['ticker'].map(
        lambda t: 'NDX-complex' if t in NDX_COMPLEX else ('SPX-complex' if t in SPX_COMPLEX else 'other')
    )

    # Per-ticker summary.
    per_ticker = []
    for ticker in NDX_COMPLEX + SPX_COMPLEX:
        sub = overall[overall['ticker'] == ticker]
        if sub.empty:
            continue
        best = sub.loc[sub['abs_rho'].idxmax()]
        per_ticker.append({
            'ticker': ticker,
            'arm': 'NDX-complex' if ticker in NDX_COMPLEX else 'SPX-complex',
            'n_significant_bonf': int((sub['p_bonf'] < 0.05).sum()),
            'n_significant_p05':  int((sub['p_value'] < 0.05).sum()),
            'best_abs_rho': float(best['abs_rho']),
            'best_signed_rho': float(best['rho']),
            'best_feature': str(best['feature']),
            'best_window_min': int(best['window_min']),
            'best_horizon_min': int(best['horizon_min']),
            'best_expiry_filter': str(best['expiry_filter']),
            'best_n': int(best['n']),
        })

    # Per-arm aggregate.
    per_arm = []
    for arm_name, members in [('NDX-complex', NDX_COMPLEX), ('SPX-complex', SPX_COMPLEX)]:
        sub = overall[overall['ticker'].isin(members)]
        per_arm.append({
            'arm': arm_name,
            'tickers': members,
            'n_total_correlations': int(len(sub)),
            'n_bonf_significant': int((sub['p_bonf'] < 0.05).sum()),
            'pct_bonf_significant': round(100 * (sub['p_bonf'] < 0.05).mean(), 2),
            'mean_abs_rho_among_bonf_sig': (
                round(float(sub.loc[sub['p_bonf'] < 0.05, 'abs_rho'].mean()), 4)
                if (sub['p_bonf'] < 0.05).any() else None
            ),
            'max_abs_rho': round(float(sub['abs_rho'].max()), 4),
            'top10_mean_abs_rho': round(float(sub.nlargest(10, 'abs_rho')['abs_rho'].mean()), 4),
        })

    # Per-feature: which arm wins?
    per_feature = []
    for feat in overall['feature'].unique():
        sub = overall[overall['feature'] == feat]
        ndx_max = sub[sub['arm'] == 'NDX-complex']['abs_rho'].max() if (sub['arm'] == 'NDX-complex').any() else 0
        spx_max = sub[sub['arm'] == 'SPX-complex']['abs_rho'].max() if (sub['arm'] == 'SPX-complex').any() else 0
        per_feature.append({
            'feature': feat,
            'ndx_complex_max_abs_rho': round(float(ndx_max), 4),
            'spx_complex_max_abs_rho': round(float(spx_max), 4),
            'winner': 'SPX-complex' if spx_max > ndx_max else ('NDX-complex' if ndx_max > spx_max else 'tie'),
            'gap': round(float(abs(spx_max - ndx_max)), 4),
        })
    per_feature.sort(key=lambda x: max(x['ndx_complex_max_abs_rho'], x['spx_complex_max_abs_rho']), reverse=True)

    # Verdict.
    ndx_wins = sum(1 for f in per_feature if f['winner'] == 'NDX-complex')
    spx_wins = sum(1 for f in per_feature if f['winner'] == 'SPX-complex')
    ties = sum(1 for f in per_feature if f['winner'] == 'tie')
    spx_arm = next(a for a in per_arm if a['arm'] == 'SPX-complex')
    ndx_arm = next(a for a in per_arm if a['arm'] == 'NDX-complex')

    if spx_arm['top10_mean_abs_rho'] > ndx_arm['top10_mean_abs_rho'] * 1.15:
        verdict = 'SPX-complex meaningfully outperforms — supports switching to ES'
    elif ndx_arm['top10_mean_abs_rho'] > spx_arm['top10_mean_abs_rho'] * 1.15:
        verdict = 'NDX-complex meaningfully outperforms — stay on NQ, use NDX-complex flow'
    else:
        verdict = 'No meaningful gap — instrument choice should be driven by other factors (cost, trader fit)'

    output = {
        'verdict': verdict,
        'feature_winner_count': {
            'NDX-complex': ndx_wins,
            'SPX-complex': spx_wins,
            'tie': ties,
        },
        'per_arm': per_arm,
        'per_ticker': per_ticker,
        'per_feature': per_feature,
    }
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)
    print(f'Wrote {OUTPUT_PATH}')

    # Console preview.
    print('\n=== Per-arm summary ===')
    for a in per_arm:
        print(
            f'  {a["arm"]:>13}: bonf-sig={a["n_bonf_significant"]:>4}/{a["n_total_correlations"]:>4} '
            f'({a["pct_bonf_significant"]:>5.2f}%)  '
            f'top10_mean|rho|={a["top10_mean_abs_rho"]:.3f}  max|rho|={a["max_abs_rho"]:.3f}'
        )
    print('\n=== Per-ticker best correlation ===')
    for t in per_ticker:
        print(
            f'  {t["ticker"]:<5} ({t["arm"]:<11}): {t["best_feature"]:<14} '
            f'win={t["best_window_min"]:>2}m exp={t["best_expiry_filter"]:<4} h={t["best_horizon_min"]:>2}m  '
            f'rho={t["best_signed_rho"]:+.3f}  bonf-sig={t["n_significant_bonf"]:>3}'
        )
    print(f'\n=== Per-feature winners ===')
    for f in per_feature:
        print(f'  {f["feature"]:<14}: NDX-max={f["ndx_complex_max_abs_rho"]:.3f}  '
              f'SPX-max={f["spx_complex_max_abs_rho"]:.3f}  WINNER={f["winner"]}  gap={f["gap"]:.3f}')
    print(f'\n>>> VERDICT: {verdict}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
