"""Phase 1 analysis driver — distributions, ROC, threshold sweep, cohort report.

Consumes alert_features.parquet (produced by notebook.py) and outputs:
  ml/plots/round-trip-suppression/{distribution,roc,threshold-sweep}-*.png
  docs/tmp/round-trip-suppression-cohort-results-2026-05-15.md

Usage:
  ml/.venv/bin/python ml/experiments/round-trip-suppression-eda/analysis.py

Outcome labels (loss/win/neutral):
  loss     = realized_trail30_10_pct < -20%   (took a real loss under prod exit)
  win      = peak_ceiling_pct      >= 50%    (had a big intraday move)
  neutral  = neither

Suppression-candidate features ranked first by ROC AUC, then evaluated in the
threshold sweep on the dominant feature(s). Cohort comparison shows whether
the residual signal survives the production-current gating (A vs C).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import polars as pl
from sklearn.metrics import roc_auc_score, roc_curve

sys.path.insert(0, str(Path(__file__).resolve().parent))

EXPERIMENT_DIR = Path(__file__).resolve().parent
DEFAULT_FEATURES_PATH = EXPERIMENT_DIR / 'alert_features.parquet'
# parents[3] is the repo root: ml/experiments/round-trip-suppression-eda/ → ml/experiments/ → ml/ → repo
REPO_ROOT = Path(__file__).resolve().parents[3]
PLOTS_DIR = REPO_ROOT / 'ml' / 'plots' / 'round-trip-suppression'
REPORT_PATH = REPO_ROOT / 'docs' / 'tmp' / 'round-trip-suppression-cohort-results-2026-05-15.md'

# Suppression-candidate features (signed direction-of-evil for the threshold sweep):
# - LOWER value means MORE-likely round-trip / noise → suppress when below threshold.
# For features where HIGHER means more-noise, use the inverted version.
CANDIDATE_FEATURES = [
    # (feature, direction_lower_is_evil, display name)
    ('post_fire_net_pct_of_volume', True,  'Post-fire net (ask − bid) / vol'),
    ('post_fire_net_premium',       True,  'Post-fire net premium ($)'),
    ('time_to_50pct_reversal_min',  True,  'Minutes until 50% bid-reversal'),
    ('post_fire_multi_leg_pct',     False, 'Post-fire multi-leg %'),
    ('mid_print_pct',               False, 'Mid-print %'),
    ('post_fire_print_count',       True,  'Post-fire print count'),
]

LOSS_THRESHOLD = -20.0  # realized_trail30_10_pct < this → loss
WIN_THRESHOLD = 50.0    # peak_ceiling_pct >= this → win


# ─────────────────────────────────────────────────────────────────
# Loading + label assignment
# ─────────────────────────────────────────────────────────────────

def load_features(path: Path) -> pl.DataFrame:
    df = pl.read_parquet(path)
    # Compute outcome label
    df = df.with_columns([
        (pl.col('realized_trail30_10_pct') < LOSS_THRESHOLD).alias('is_loss'),
        (pl.col('peak_ceiling_pct') >= WIN_THRESHOLD).alias('is_win'),
    ])
    df = df.with_columns(
        pl.when(pl.col('is_loss')).then(pl.lit('loss'))
        .when(pl.col('is_win')).then(pl.lit('win'))
        .otherwise(pl.lit('neutral'))
        .alias('outcome')
    )
    return df


def cohort_view(df: pl.DataFrame, cohort: str) -> pl.DataFrame:
    col = {'A': 'cohort_a', 'B': 'cohort_b', 'C': 'cohort_c'}[cohort]
    return df.filter(pl.col(col))


# ─────────────────────────────────────────────────────────────────
# Distribution plots
# ─────────────────────────────────────────────────────────────────

def plot_feature_distribution_by_outcome(
    df: pl.DataFrame,
    feature: str,
    title: str,
    cohort_label: str,
    out_path: Path,
) -> None:
    """Histogram of `feature`, three overlays for loss/win/neutral outcomes."""
    fig, ax = plt.subplots(figsize=(10, 6), constrained_layout=True)
    series = df[feature].drop_nulls().to_numpy()
    if len(series) == 0:
        plt.close(fig)
        return
    # Clip extreme outliers for readable histograms (1st-99th percentile)
    lo, hi = np.percentile(series, [1, 99])
    bins = np.linspace(lo, hi, 50)

    for outcome, color in [('loss', '#d62728'), ('neutral', '#7f7f7f'), ('win', '#2ca02c')]:
        sub = df.filter(pl.col('outcome') == outcome)[feature].drop_nulls().to_numpy()
        if len(sub) == 0:
            continue
        ax.hist(
            np.clip(sub, lo, hi),
            bins=bins,
            alpha=0.55,
            label=f'{outcome} (n={len(sub):,})',
            color=color,
            edgecolor='black',
            linewidth=0.3,
        )
    ax.set_xlabel(title, fontsize=11)
    ax.set_ylabel('Alerts', fontsize=11)
    ax.set_title(f'{title} — Cohort {cohort_label}', fontsize=13, fontweight='bold')
    ax.legend(loc='upper right', fontsize=10)
    ax.grid(True, alpha=0.3)
    fig.savefig(out_path, dpi=150, bbox_inches='tight', facecolor='white')
    plt.close(fig)


# ─────────────────────────────────────────────────────────────────
# ROC curves
# ─────────────────────────────────────────────────────────────────

def compute_roc(
    df: pl.DataFrame,
    feature: str,
    lower_is_loss: bool,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Compute ROC for a single feature against the binary is_loss label.

    `lower_is_loss=True` means LOWER feature value predicts loss → we invert the
    score so sklearn's threshold sweep works naturally (higher score = more loss).
    """
    sub = df.filter(pl.col(feature).is_not_null() & pl.col('realized_trail30_10_pct').is_not_null())
    if len(sub) < 50 or sub['is_loss'].sum() < 5:
        return np.array([]), np.array([]), float('nan')
    scores = sub[feature].to_numpy()
    if lower_is_loss:
        scores = -scores
    labels = sub['is_loss'].to_numpy()
    fpr, tpr, _ = roc_curve(labels, scores)
    auc = roc_auc_score(labels, scores)
    return fpr, tpr, auc


def plot_roc_per_feature(df: pl.DataFrame, cohort_label: str, out_path: Path) -> dict[str, float]:
    """Single-panel ROC with one curve per candidate feature; returns AUC dict."""
    fig, ax = plt.subplots(figsize=(9, 7), constrained_layout=True)
    aucs: dict[str, float] = {}
    for feat, lower_is_loss, title in CANDIDATE_FEATURES:
        if feat not in df.columns:
            continue
        fpr, tpr, auc = compute_roc(df, feat, lower_is_loss)
        if len(fpr) == 0:
            continue
        aucs[feat] = auc
        ax.plot(fpr, tpr, label=f'{title}  (AUC={auc:.3f})', linewidth=2)
    ax.plot([0, 1], [0, 1], '--', color='gray', alpha=0.6, label='Random')
    ax.set_xlabel('False positive rate', fontsize=11)
    ax.set_ylabel('True positive rate', fontsize=11)
    ax.set_title(f'ROC — predict loss (trail30/10 < {LOSS_THRESHOLD}%) — Cohort {cohort_label}',
                 fontsize=12, fontweight='bold')
    ax.legend(loc='lower right', fontsize=9)
    ax.grid(True, alpha=0.3)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    fig.savefig(out_path, dpi=150, bbox_inches='tight', facecolor='white')
    plt.close(fig)
    return aucs


# ─────────────────────────────────────────────────────────────────
# Threshold sweep
# ─────────────────────────────────────────────────────────────────

def threshold_sweep(
    df: pl.DataFrame,
    feature: str,
    thresholds: list[float],
    lower_is_evil: bool,
) -> pl.DataFrame:
    """For each threshold, compute % suppressed + win/loss rates of suppressed vs surviving.

    `lower_is_evil`: True → suppress where feature < threshold; False → > threshold.
    """
    base = df.filter(pl.col(feature).is_not_null())
    rows: list[dict] = []
    for t in thresholds:
        if lower_is_evil:
            suppressed_mask = pl.col(feature) < t
        else:
            suppressed_mask = pl.col(feature) > t
        sup = base.filter(suppressed_mask)
        surv = base.filter(~suppressed_mask)
        rows.append({
            'threshold': t,
            'n_suppressed': len(sup),
            'pct_suppressed': len(sup) / max(1, len(base)),
            'sup_win_rate': sup['is_win'].mean() if len(sup) else float('nan'),
            'sup_loss_rate': sup['is_loss'].mean() if len(sup) else float('nan'),
            'sup_mean_trail': sup['realized_trail30_10_pct'].mean() if len(sup) else float('nan'),
            'surv_win_rate': surv['is_win'].mean() if len(surv) else float('nan'),
            'surv_loss_rate': surv['is_loss'].mean() if len(surv) else float('nan'),
            'surv_mean_trail': surv['realized_trail30_10_pct'].mean() if len(surv) else float('nan'),
            'lift_mean_trail': (
                (surv['realized_trail30_10_pct'].mean() if len(surv) else 0.0)
                - (base['realized_trail30_10_pct'].mean() if len(base) else 0.0)
            ),
        })
    return pl.from_dicts(rows)


# ─────────────────────────────────────────────────────────────────
# Cohort comparison report
# ─────────────────────────────────────────────────────────────────

def cohort_summary_table(df_full: pl.DataFrame) -> pl.DataFrame:
    rows: list[dict] = []
    for cohort in ['A', 'B', 'C']:
        cdf = cohort_view(df_full, cohort)
        if len(cdf) == 0:
            continue
        rows.append({
            'cohort': cohort,
            'n_alerts': len(cdf),
            'n_lottery': int((cdf['source'] == 'lottery').sum()),
            'n_silent_boom': int((cdf['source'] == 'silent_boom').sum()),
            'win_rate': float(cdf['is_win'].mean()),
            'loss_rate': float(cdf['is_loss'].mean()),
            'mean_trail_pct': float(cdf['realized_trail30_10_pct'].mean()),
            'mean_peak_pct': float(cdf['peak_ceiling_pct'].mean()),
        })
    return pl.from_dicts(rows)


def write_report(
    df_full: pl.DataFrame,
    aucs_per_cohort: dict[str, dict[str, float]],
    sweeps_per_cohort: dict[str, pl.DataFrame],
    chosen_feature: str,
    out_path: Path,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append('# Round-Trip Suppression — Phase 1 Cohort Results (2026-05-15)')
    lines.append('')
    lines.append(f'**Spec:** [`docs/superpowers/specs/lottery-silent-boom-round-trip-suppression-2026-05-15.md`](../superpowers/specs/lottery-silent-boom-round-trip-suppression-2026-05-15.md)')
    lines.append('')
    lines.append(f'Sample: {len(df_full):,} enriched alerts with computed suppression features.')
    lines.append('')
    lines.append(f'**Outcome labels:** loss = `realized_trail30_10_pct < {LOSS_THRESHOLD}%`, '
                 f'win = `peak_ceiling_pct ≥ {WIN_THRESHOLD}%`, else neutral.')
    lines.append('')

    lines.append('## Cohort baseline')
    lines.append('')
    summary = cohort_summary_table(df_full)
    lines.append('| Cohort | N | Lottery | SilentBoom | Win % | Loss % | Mean trail % | Mean peak % |')
    lines.append('|---|---:|---:|---:|---:|---:|---:|---:|')
    for r in summary.iter_rows(named=True):
        lines.append(
            f'| {r["cohort"]} | {r["n_alerts"]:,} | {r["n_lottery"]:,} | {r["n_silent_boom"]:,} '
            f'| {r["win_rate"]*100:.1f}% | {r["loss_rate"]*100:.1f}% '
            f'| {r["mean_trail_pct"]:+.2f}% | {r["mean_peak_pct"]:+.2f}% |'
        )
    lines.append('')

    lines.append('## Feature AUC by cohort (predict loss)')
    lines.append('')
    feats = list(aucs_per_cohort.get('A', {}).keys())
    lines.append('| Feature | AUC (A) | AUC (B) | AUC (C) |')
    lines.append('|---|---:|---:|---:|')
    for f in feats:
        a = aucs_per_cohort.get('A', {}).get(f, float('nan'))
        b = aucs_per_cohort.get('B', {}).get(f, float('nan'))
        c = aucs_per_cohort.get('C', {}).get(f, float('nan'))
        lines.append(f'| `{f}` | {a:.3f} | {b:.3f} | {c:.3f} |')
    lines.append('')
    lines.append('AUC = 0.5 → random. > 0.55 → meaningful signal. > 0.65 → strong predictor.')
    lines.append('')

    lines.append(f'## Threshold sweep — `{chosen_feature}` (top-AUC suppression candidate)')
    lines.append('')
    for cohort in ['A', 'B', 'C']:
        sweep = sweeps_per_cohort.get(cohort)
        if sweep is None or len(sweep) == 0:
            continue
        lines.append(f'### Cohort {cohort}')
        lines.append('')
        lines.append('| Threshold | % Suppressed | Sup. Win % | Sup. Loss % | Surv. Win % | Surv. Loss % | Lift (mean trail %) |')
        lines.append('|---:|---:|---:|---:|---:|---:|---:|')
        for r in sweep.iter_rows(named=True):
            sup_w = '—' if r['sup_win_rate'] != r['sup_win_rate'] else f'{r["sup_win_rate"]*100:.1f}%'
            sup_l = '—' if r['sup_loss_rate'] != r['sup_loss_rate'] else f'{r["sup_loss_rate"]*100:.1f}%'
            lines.append(
                f'| {r["threshold"]:+.2f} | {r["pct_suppressed"]*100:.1f}% | {sup_w} | {sup_l} '
                f'| {r["surv_win_rate"]*100:.1f}% | {r["surv_loss_rate"]*100:.1f}% | {r["lift_mean_trail"]:+.2f}pp |'
            )
        lines.append('')

    lines.append('## Decision gate (per spec)')
    lines.append('')
    lines.append('- Ship Phase 2 only if suppressed alerts have ≤ 30% peak-50% win rate AND surviving alerts maintain/improve.')
    lines.append('- Effect must concentrate (per `feedback_uniform_lift_is_leakage.md` — uniform lift is suspicious).')
    lines.append('')

    out_path.write_text('\n'.join(lines))
    print(f'✓ Report written → {out_path}', file=sys.stderr)


# ─────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Phase 1 analysis driver')
    p.add_argument('--features', type=Path, default=DEFAULT_FEATURES_PATH)
    p.add_argument('--chosen-feature', default='post_fire_net_pct_of_volume',
                   help='Feature to drive the threshold sweep')
    p.add_argument('--plots-dir', type=Path, default=PLOTS_DIR)
    p.add_argument('--report-path', type=Path, default=REPORT_PATH)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not args.features.exists():
        print(f'Missing features parquet: {args.features}\n'
              f'Run notebook.py first to generate it.', file=sys.stderr)
        return 1

    args.plots_dir.mkdir(parents=True, exist_ok=True)

    df = load_features(args.features)
    print(f'Loaded {len(df):,} alert-features rows', file=sys.stderr)

    outcomes = df.group_by('outcome').len().sort('outcome')
    print('Outcome distribution:', file=sys.stderr)
    print(outcomes, file=sys.stderr)

    # Per-cohort: distribution plots + ROC + threshold sweep
    aucs_per_cohort: dict[str, dict[str, float]] = {}
    sweeps_per_cohort: dict[str, pl.DataFrame] = {}

    for cohort in ['A', 'B', 'C']:
        cdf = cohort_view(df, cohort)
        if len(cdf) < 100:
            print(f'Cohort {cohort}: only {len(cdf)} alerts — skipping plots', file=sys.stderr)
            continue
        print(f'\nCohort {cohort}: {len(cdf):,} alerts', file=sys.stderr)

        # Distribution plots — one per candidate feature
        for feat, _, title in CANDIDATE_FEATURES:
            if feat not in cdf.columns:
                continue
            out = args.plots_dir / f'distribution-cohort-{cohort}-{feat}.png'
            plot_feature_distribution_by_outcome(cdf, feat, title, cohort, out)

        # ROC
        roc_out = args.plots_dir / f'roc-cohort-{cohort}.png'
        aucs = plot_roc_per_feature(cdf, cohort, roc_out)
        aucs_per_cohort[cohort] = aucs

        # Threshold sweep on the chosen feature
        feat_entry = next((e for e in CANDIDATE_FEATURES if e[0] == args.chosen_feature), None)
        if feat_entry and feat_entry[0] in cdf.columns:
            _, lower_is_evil, _ = feat_entry
            # Sweep thresholds across reasonable range for net_pct: -0.5 .. +0.2
            if args.chosen_feature == 'post_fire_net_pct_of_volume':
                thresholds = [-0.50, -0.40, -0.30, -0.20, -0.10, 0.0, 0.10, 0.20]
            else:
                series = cdf[args.chosen_feature].drop_nulls().to_numpy()
                lo, hi = np.percentile(series, [10, 90])
                thresholds = list(np.linspace(lo, hi, 8))
            sweep = threshold_sweep(cdf, args.chosen_feature, thresholds, lower_is_evil)
            sweeps_per_cohort[cohort] = sweep

    write_report(df, aucs_per_cohort, sweeps_per_cohort, args.chosen_feature, args.report_path)
    print(f'\n✓ Wrote {len(list(args.plots_dir.glob("*.png")))} plots to {args.plots_dir}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
