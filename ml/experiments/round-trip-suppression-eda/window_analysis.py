"""Phase 3 analysis: stratify AUC by (window, ticker, DTE) and pick the
best window per DTE bucket.

Consumes `alert_features_windows.parquet` (produced by slice_window.py)
and writes:
  - stdout tables
  - docs/tmp/round-trip-window-sweep-2026-05-16.md

Decision question: does the 60-min window we shipped in Phase 2B
dominate, or does a different window per DTE bucket give a sharper
discriminator? Drives the Phase 3 cron retune.
"""
from __future__ import annotations

import sys
from pathlib import Path

import polars as pl
from sklearn.metrics import roc_auc_score

EXPERIMENT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = EXPERIMENT_DIR / 'alert_features_windows.parquet'
REPO_ROOT = Path(__file__).resolve().parents[3]
REPORT_PATH = REPO_ROOT / 'docs' / 'tmp' / 'round-trip-window-sweep-2026-05-16.md'

LOSS_THRESHOLD = -20.0
WIN_THRESHOLD = 50.0
WINDOWS = [30, 60, 90, 120]
DTE_BUCKETS = [
    ('0DTE', pl.col('dte') == 0),
    ('1-2DTE', (pl.col('dte') >= 1) & (pl.col('dte') <= 2)),
    ('3-7DTE', (pl.col('dte') >= 3) & (pl.col('dte') <= 7)),
]
TOP_N_TICKERS = 10
MIN_ALERTS_PER_CELL = 200  # ignore tiny buckets where AUC is noisy


def auc_or_none(df: pl.DataFrame) -> tuple[int, float | None]:
    sub = df.filter(
        pl.col('post_fire_net_pct_of_volume').is_not_null()
        & pl.col('realized_trail30_10_pct').is_not_null()
    )
    n_loss = int(sub['is_loss'].sum())
    if len(sub) < MIN_ALERTS_PER_CELL or n_loss < 30:
        return len(sub), None
    scores = -sub['post_fire_net_pct_of_volume'].to_numpy()  # lower = more loss
    labels = sub['is_loss'].to_numpy()
    return len(sub), float(roc_auc_score(labels, scores))


def main() -> int:
    if not DEFAULT_INPUT.exists():
        print(f'Missing input: {DEFAULT_INPUT}\nRun slice_window.py first.', file=sys.stderr)
        return 1
    df = pl.read_parquet(DEFAULT_INPUT)
    df = df.with_columns([
        (pl.col('realized_trail30_10_pct') < LOSS_THRESHOLD).alias('is_loss'),
        (pl.col('peak_ceiling_pct') >= WIN_THRESHOLD).alias('is_win'),
    ])
    print(f'Loaded {len(df):,} rows ({df.n_unique("alert_id")} alerts × {df.n_unique("window_minutes")} windows)', file=sys.stderr)

    # --- Per-window AUC across all eligible alerts ---
    print('\n=== Per-window AUC (Cohort A, all DTEs) ===')
    print(f'{"window":>8} {"n":>9} {"AUC":>7}')
    per_window: dict[int, float] = {}
    for w in WINDOWS:
        sub = df.filter((pl.col('window_minutes') == w) & pl.col('cohort_a'))
        n, auc = auc_or_none(sub)
        per_window[w] = auc if auc is not None else float('nan')
        auc_str = f'{auc:.3f}' if auc is not None else '   —'
        print(f'{w:>8} {n:>9,} {auc_str:>7}')

    # --- (Window × DTE) matrix ---
    print('\n=== (Window × DTE) AUC matrix (Cohort A) ===')
    header = f'{"DTE":<8} ' + ' '.join(f'{w:>6}' for w in WINDOWS)
    print(header)
    per_dte_per_window: dict[str, dict[int, float]] = {}
    for bucket_label, bucket_mask in DTE_BUCKETS:
        row = [f'{bucket_label:<8}']
        per_dte_per_window[bucket_label] = {}
        for w in WINDOWS:
            sub = df.filter(
                (pl.col('window_minutes') == w) & pl.col('cohort_a') & bucket_mask
            )
            _, auc = auc_or_none(sub)
            per_dte_per_window[bucket_label][w] = auc if auc is not None else float('nan')
            row.append(f'{auc:.3f}' if auc is not None else '   —')
        print(' '.join(row))

    # --- (Window × top ticker) matrix ---
    print(f'\n=== (Window × top-{TOP_N_TICKERS} tickers) AUC matrix (Cohort A) ===')
    top_tickers = (
        df.filter(pl.col('window_minutes') == 60)  # any window for the count
        .group_by('underlying_symbol')
        .agg(pl.len().alias('n'))
        .sort('n', descending=True)
        .head(TOP_N_TICKERS)['underlying_symbol']
        .to_list()
    )
    print(f'{"ticker":<8} ' + ' '.join(f'{w:>6}' for w in WINDOWS))
    per_ticker_per_window: dict[str, dict[int, float]] = {}
    for ticker in top_tickers:
        row = [f'{ticker:<8}']
        per_ticker_per_window[ticker] = {}
        for w in WINDOWS:
            sub = df.filter(
                (pl.col('window_minutes') == w)
                & pl.col('cohort_a')
                & (pl.col('underlying_symbol') == ticker)
            )
            _, auc = auc_or_none(sub)
            per_ticker_per_window[ticker][w] = auc if auc is not None else float('nan')
            row.append(f'{auc:.3f}' if auc is not None else '   —')
        print(' '.join(row))

    # --- Best window per DTE ---
    print('\n=== Best window per DTE bucket (highest AUC wins) ===')
    best_per_dte: dict[str, tuple[int, float]] = {}
    for bucket_label in per_dte_per_window:
        aucs = per_dte_per_window[bucket_label]
        valid = [(w, a) for w, a in aucs.items() if a == a]  # filter NaN
        if not valid:
            continue
        best_w, best_a = max(valid, key=lambda x: x[1])
        baseline_a = aucs.get(60, float('nan'))
        delta = best_a - baseline_a
        marker = '★' if abs(delta) >= 0.01 else ''
        print(
            f'  {bucket_label:<8}: best window = {best_w} min (AUC {best_a:.3f}); '
            f'vs 60min ({baseline_a:.3f}) = {delta:+.3f} {marker}'
        )
        best_per_dte[bucket_label] = (best_w, best_a)

    # --- Write markdown report ---
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append('# Round-Trip Window Sweep — Phase 3 EDA (2026-05-16)')
    lines.append('')
    lines.append(f'**Input:** [`alert_features_windows.parquet`](../../ml/experiments/round-trip-suppression-eda/alert_features_windows.parquet) — {df.n_unique("alert_id"):,} alerts × 4 windows from 2026-04-14 → 2026-05-15.')
    lines.append('')
    lines.append('**Goal:** confirm whether the 60-min window shipped in Phase 2B is optimal or whether a different window per DTE bucket gives sharper discrimination.')
    lines.append('')
    lines.append('## Per-window AUC (all DTEs, Cohort A)')
    lines.append('')
    lines.append('| Window (min) | AUC |')
    lines.append('|---:|---:|')
    for w in WINDOWS:
        a = per_window.get(w, float('nan'))
        lines.append(f'| {w} | {a:.3f} |' if a == a else f'| {w} | — |')
    lines.append('')
    lines.append('## (Window × DTE) AUC matrix')
    lines.append('')
    lines.append('| DTE | ' + ' | '.join(f'{w}min' for w in WINDOWS) + ' |')
    lines.append('|---|' + '---:|' * len(WINDOWS))
    for bucket_label in per_dte_per_window:
        row = [bucket_label]
        for w in WINDOWS:
            a = per_dte_per_window[bucket_label].get(w, float('nan'))
            row.append(f'{a:.3f}' if a == a else '—')
        lines.append('| ' + ' | '.join(row) + ' |')
    lines.append('')
    lines.append(f'## (Window × top-{TOP_N_TICKERS} tickers) AUC matrix')
    lines.append('')
    lines.append('| Ticker | ' + ' | '.join(f'{w}min' for w in WINDOWS) + ' |')
    lines.append('|---|' + '---:|' * len(WINDOWS))
    for ticker in top_tickers:
        row = [ticker]
        for w in WINDOWS:
            a = per_ticker_per_window[ticker].get(w, float('nan'))
            row.append(f'{a:.3f}' if a == a else '—')
        lines.append('| ' + ' | '.join(row) + ' |')
    lines.append('')
    lines.append('## Best window per DTE bucket')
    lines.append('')
    lines.append('| DTE | Best window | AUC | vs 60min |')
    lines.append('|---|---:|---:|---:|')
    for bucket_label, (best_w, best_a) in best_per_dte.items():
        baseline_a = per_dte_per_window[bucket_label].get(60, float('nan'))
        delta = best_a - baseline_a if baseline_a == baseline_a else float('nan')
        delta_str = f'{delta:+.3f}' if delta == delta else '—'
        lines.append(f'| {bucket_label} | {best_w} min | {best_a:.3f} | {delta_str} |')
    lines.append('')
    lines.append('## Interpretation')
    lines.append('')
    lines.append('- Delta ≥ +0.01 vs 60-min baseline → retune the cron to use that window for the DTE bucket.')
    lines.append('- Delta < 0.01 → keep 60-min uniformly (the existing default is fine).')
    lines.append('- Per-ticker dispersion of >0.05 between windows → consider per-ticker calibration in a follow-up.')

    REPORT_PATH.write_text('\n'.join(lines))
    print(f'\n✓ Report → {REPORT_PATH}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
