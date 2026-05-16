"""Per-ticker + per-bucket AUC slice on the existing alert_features.parquet.

Answers: is the post_fire_net_pct_of_volume signal real-and-orthogonal, or
is it carried by a single ticker (leakage suspect)?

Pass criteria (per Phase 2 spec):
  - Top 10 tickers each independently show AUC 0.55-0.62 → real, orthogonal
  - One ticker carries >0.70 while others <0.52 → leakage

Outputs:
  - stdout table of per-ticker AUC + sample size + win/loss/baseline rates
  - per-DTE-bucket AUC for completeness
"""
from __future__ import annotations

import sys
from pathlib import Path

import polars as pl
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analysis import load_features, DEFAULT_FEATURES_PATH  # noqa: E402

FEATURE = 'post_fire_net_pct_of_volume'  # lower = more loss → invert for AUC
MIN_ALERTS_PER_BUCKET = 1000  # ignore tiny buckets where AUC is noisy
TOP_N_TICKERS = 15


def auc_for_subset(sub: pl.DataFrame) -> tuple[int, int, float | None]:
    """Returns (n, n_loss, auc) for the loss-prediction task."""
    sub = sub.filter(pl.col(FEATURE).is_not_null() & pl.col('realized_trail30_10_pct').is_not_null())
    n_loss = int(sub['is_loss'].sum())
    if len(sub) < 100 or n_loss < 20:
        return len(sub), n_loss, None
    scores = -sub[FEATURE].to_numpy()  # lower = more loss → invert
    labels = sub['is_loss'].to_numpy()
    return len(sub), n_loss, float(roc_auc_score(labels, scores))


def per_ticker_table(df: pl.DataFrame) -> pl.DataFrame:
    by_ticker = (
        df.group_by('underlying_symbol')
        .agg(pl.len().alias('n'))
        .sort('n', descending=True)
        .head(TOP_N_TICKERS)
    )
    rows = []
    for t in by_ticker['underlying_symbol'].to_list():
        sub = df.filter(pl.col('underlying_symbol') == t)
        n, n_loss, auc = auc_for_subset(sub)
        rows.append({
            'ticker': t,
            'n_alerts': n,
            'n_loss': n_loss,
            'loss_rate': n_loss / max(1, n),
            'win_rate': float(sub['is_win'].mean()),
            'auc_loss_vs_net_pct': auc,
            'mean_trail_pct': float(sub['realized_trail30_10_pct'].mean()),
        })
    return pl.from_dicts(rows)


def per_dte_table(df: pl.DataFrame) -> pl.DataFrame:
    buckets = [
        ('0DTE',         pl.col('dte') == 0),
        ('1-2DTE',       (pl.col('dte') >= 1) & (pl.col('dte') <= 2)),
        ('3-7DTE',       (pl.col('dte') >= 3) & (pl.col('dte') <= 7)),
        ('8-30DTE',      (pl.col('dte') >= 8) & (pl.col('dte') <= 30)),
        ('>30DTE',       pl.col('dte') > 30),
    ]
    rows = []
    for label, mask in buckets:
        sub = df.filter(mask)
        n, n_loss, auc = auc_for_subset(sub)
        rows.append({
            'dte_bucket': label,
            'n_alerts': n,
            'auc_loss_vs_net_pct': auc,
            'win_rate': float(sub['is_win'].mean()) if len(sub) else None,
            'loss_rate': n_loss / max(1, n),
        })
    return pl.from_dicts(rows)


def per_source_per_ticker(df: pl.DataFrame) -> pl.DataFrame:
    """Top-10 tickers, split by Lottery vs SilentBoom — is the effect concentrated by alert type?"""
    rows = []
    top_tickers = (
        df.group_by('underlying_symbol')
        .agg(pl.len().alias('n'))
        .sort('n', descending=True)
        .head(10)['underlying_symbol'].to_list()
    )
    for t in top_tickers:
        for source in ['lottery', 'silent_boom']:
            sub = df.filter((pl.col('underlying_symbol') == t) & (pl.col('source') == source))
            n, n_loss, auc = auc_for_subset(sub)
            if n < MIN_ALERTS_PER_BUCKET:
                continue
            rows.append({
                'ticker': t,
                'source': source,
                'n': n,
                'auc': auc,
            })
    return pl.from_dicts(rows) if rows else pl.DataFrame()


def main() -> int:
    print(f'Loading {DEFAULT_FEATURES_PATH}...', file=sys.stderr)
    df = load_features(DEFAULT_FEATURES_PATH)
    # Restrict to Cohort A (production-current rules) for the most-decision-relevant slice
    cohort_a = df.filter(pl.col('cohort_a'))
    print(f'Cohort A: {len(cohort_a):,} alerts', file=sys.stderr)

    print('\n=== Per-ticker AUC (Cohort A, top-15 by alert count) ===')
    tab = per_ticker_table(cohort_a)
    # Pretty print
    print(f'{"ticker":<8} {"n_alerts":>10} {"n_loss":>8} {"loss%":>7} {"win%":>7} {"AUC":>8} {"mean_trail":>11}')
    for r in tab.iter_rows(named=True):
        auc = f'{r["auc_loss_vs_net_pct"]:.3f}' if r['auc_loss_vs_net_pct'] is not None else '   —'
        print(
            f'{r["ticker"]:<8} {r["n_alerts"]:>10,} {r["n_loss"]:>8,} '
            f'{r["loss_rate"]*100:>6.1f}% {r["win_rate"]*100:>6.1f}% '
            f'{auc:>8} {r["mean_trail_pct"]:>+10.2f}%'
        )

    aucs = [r['auc_loss_vs_net_pct'] for r in tab.iter_rows(named=True) if r['auc_loss_vs_net_pct'] is not None]
    if aucs:
        print(f'\nPer-ticker AUC: min={min(aucs):.3f}  median={sorted(aucs)[len(aucs)//2]:.3f}  max={max(aucs):.3f}')

    print('\n=== Per-DTE-bucket AUC (Cohort A) ===')
    dtab = per_dte_table(cohort_a)
    print(f'{"bucket":<10} {"n_alerts":>10} {"AUC":>8} {"win%":>7} {"loss%":>7}')
    for r in dtab.iter_rows(named=True):
        auc = f'{r["auc_loss_vs_net_pct"]:.3f}' if r['auc_loss_vs_net_pct'] is not None else '   —'
        win = f'{r["win_rate"]*100:.1f}%' if r['win_rate'] is not None else '—'
        print(
            f'{r["dte_bucket"]:<10} {r["n_alerts"]:>10,} {auc:>8} '
            f'{win:>7} {r["loss_rate"]*100:>6.1f}%'
        )

    print('\n=== Per (ticker, source) AUC — top-10 tickers, split by alert type ===')
    ts = per_source_per_ticker(cohort_a)
    if len(ts) > 0:
        print(f'{"ticker":<8} {"source":<13} {"n":>8} {"AUC":>8}')
        for r in ts.iter_rows(named=True):
            auc = f'{r["auc"]:.3f}' if r['auc'] is not None else '   —'
            print(f'{r["ticker"]:<8} {r["source"]:<13} {r["n"]:>8,} {auc:>8}')
    else:
        print('(no buckets with ≥1000 alerts when split by source)')

    print('\n=== Verdict ===')
    if aucs:
        spread = max(aucs) - min(aucs)
        if spread < 0.07 and min(aucs) >= 0.55:
            print('✓ PASS — signal distributes uniformly across top tickers (real, orthogonal).')
            print('   Recommend green-lighting Phase 2A.')
        elif spread > 0.12:
            print('✗ FAIL — single-ticker carry (max-min > 0.12). Signal likely ticker-specific.')
            print('   Recommend revisiting before Phase 2A.')
        else:
            print('⚠️ MIXED — moderate spread. Phase 2A acceptable with ticker-level monitoring.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
