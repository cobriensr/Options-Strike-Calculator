"""Phase 3 #2 + #7 + #8 — revisit decisions after the 60-min window
sweep validated the default.

#2 — Widen the bracket gap: of -3 deducted alerts, how many still display
     as tier1/tier2 after the deduct (i.e. the magnitude is too soft)?
#7 — Second-pass at 120min: do alerts where 60min net_pct is negative
     but 120min net_pct recovers perform differently from those where
     both are negative?
#8 — Multivariate vs TakeIt: does round_trip_score_deduct add information
     that takeit_prob doesn't already capture? Compute correlation +
     standalone AUCs + combined AUC.

Output: stdout tables + docs/tmp/round-trip-phase3-revisit-2026-05-16.md
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import polars as pl
import psycopg2
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_helper import database_url  # noqa: E402

EXPERIMENT_DIR = Path(__file__).resolve().parent
WINDOWS_PARQUET = EXPERIMENT_DIR / 'alert_features_windows.parquet'
REPO_ROOT = Path(__file__).resolve().parents[3]
REPORT_PATH = REPO_ROOT / 'docs' / 'tmp' / 'round-trip-phase3-revisit-2026-05-16.md'

LOSS_THRESHOLD = -20.0
LOTTERY_TIER1_MIN = 18
LOTTERY_TIER2_MIN = 12
SILENT_BOOM_TIER1_MIN = 21
SILENT_BOOM_TIER2_MIN = 8


def effective_tier(score: int | None, deduct: int | None, tier1_min: int, tier2_min: int) -> str:
    raw = score or 0
    d = deduct or 0
    eff = max(0, raw + d)
    if eff >= tier1_min:
        return 'tier1'
    if eff >= tier2_min:
        return 'tier2'
    return 'tier3'


def question_2_bracket_widen() -> dict:
    """Of deducted alerts, what fraction still display as tier1/tier2?"""
    db = psycopg2.connect(database_url())
    out: dict = {'lottery': {}, 'silent_boom': {}, 'lottery_what_if': {}}
    try:
        with db.cursor() as cur:
            cur.execute("""
                SELECT round_trip_score_deduct, score, COUNT(*) AS n
                FROM lottery_finder_fires
                WHERE round_trip_score_deduct < 0
                  AND enriched_at IS NOT NULL
                  AND score IS NOT NULL
                GROUP BY round_trip_score_deduct, score
            """)
            lottery_rows = cur.fetchall()
            cur.execute("""
                SELECT round_trip_score_deduct, score, COUNT(*) AS n
                FROM silent_boom_alerts
                WHERE round_trip_score_deduct < 0
                  AND enriched_at IS NOT NULL
                  AND score IS NOT NULL
                GROUP BY round_trip_score_deduct, score
            """)
            silent_rows = cur.fetchall()
    finally:
        db.close()

    # Aggregate by (deduct, effective_tier)
    for source, rows, t1, t2 in [
        ('lottery', lottery_rows, LOTTERY_TIER1_MIN, LOTTERY_TIER2_MIN),
        ('silent_boom', silent_rows, SILENT_BOOM_TIER1_MIN, SILENT_BOOM_TIER2_MIN),
    ]:
        agg: dict[tuple[int, str], int] = {}
        for deduct, score, n in rows:
            tier = effective_tier(int(score), int(deduct), t1, t2)
            agg[(int(deduct), tier)] = agg.get((int(deduct), tier), 0) + int(n)
        out[source] = agg

    # What-if: if -3 became -6 for lottery, where would those alerts land?
    whatif: dict[str, int] = {}
    for deduct, score, n in lottery_rows:
        if int(deduct) != -3:
            continue
        new_eff = max(0, int(score) - 6)
        if new_eff >= LOTTERY_TIER1_MIN:
            tier = 'tier1'
        elif new_eff >= LOTTERY_TIER2_MIN:
            tier = 'tier2'
        else:
            tier = 'tier3'
        whatif[tier] = whatif.get(tier, 0) + int(n)
    out['lottery_what_if'] = whatif
    return out


def question_7_second_pass_at_120(df: pl.DataFrame) -> dict:
    """Do alerts where 60min net_pct is negative but 120min recovers
    perform differently from alerts where both are negative?"""
    # Pivot to wide: one row per alert with all 4 windows as cols
    wide = (
        df.filter(pl.col('post_fire_total_size') > 0)
        .pivot(
            values='post_fire_net_pct_of_volume',
            index=['alert_id', 'realized_trail30_10_pct', 'realized_eod_pct', 'peak_ceiling_pct', 'dte'],
            on='window_minutes',
        )
    )
    if wide.is_empty():
        return {}
    # Filter to alerts that would be deducted at 60min (net_pct < -0.10)
    wide = wide.filter(pl.col('60').is_not_null() & pl.col('120').is_not_null())
    deducted_at_60 = wide.filter(pl.col('60') < -0.10)
    if len(deducted_at_60) == 0:
        return {}

    strata = [
        ('60-neg, 120-still-neg (<= -0.10)', pl.col('120') <= -0.10),
        ('60-neg, 120-modest (-0.10..+0.10)', (pl.col('120') > -0.10) & (pl.col('120') <= 0.10)),
        ('60-neg, 120-recovered (> +0.10)', pl.col('120') > 0.10),
    ]
    results = []
    for label, mask in strata:
        sub = deducted_at_60.filter(mask)
        if len(sub) == 0:
            continue
        is_loss = sub['realized_trail30_10_pct'] < LOSS_THRESHOLD
        is_win = sub['peak_ceiling_pct'] >= 50
        results.append({
            'stratum': label,
            'n': len(sub),
            'loss_rate_pct': float(is_loss.mean()) * 100,
            'peak50_win_pct': float(is_win.mean()) * 100,
            'mean_trail': float(sub['realized_trail30_10_pct'].mean()),
            'mean_peak': float(sub['peak_ceiling_pct'].mean()),
        })
    # Baseline: alerts that wouldn't be deducted at 60min (net_pct >= -0.10)
    baseline = wide.filter(pl.col('60') >= -0.10)
    if len(baseline) > 0:
        is_loss = baseline['realized_trail30_10_pct'] < LOSS_THRESHOLD
        is_win = baseline['peak_ceiling_pct'] >= 50
        results.append({
            'stratum': 'baseline (60-pct >= -0.10, no deduct)',
            'n': len(baseline),
            'loss_rate_pct': float(is_loss.mean()) * 100,
            'peak50_win_pct': float(is_win.mean()) * 100,
            'mean_trail': float(baseline['realized_trail30_10_pct'].mean()),
            'mean_peak': float(baseline['peak_ceiling_pct'].mean()),
        })
    return {'strata': results}


def question_8_multivariate_takeit() -> dict:
    """How much does round_trip_score_deduct overlap with takeit_prob?

    Pearson correlation + standalone AUCs + naive combined-score AUC.
    """
    db = psycopg2.connect(database_url())
    try:
        with db.cursor() as cur:
            cur.execute("""
                SELECT
                    takeit_prob::float8,
                    COALESCE(round_trip_score_deduct, 0)::int AS deduct,
                    realized_trail30_10_pct::float8
                FROM lottery_finder_fires
                WHERE takeit_prob IS NOT NULL
                  AND round_trip_net_pct IS NOT NULL
                  AND enriched_at IS NOT NULL
                  AND realized_trail30_10_pct IS NOT NULL
                  AND dte <= 7
            """)
            rows = cur.fetchall()
    finally:
        db.close()
    if not rows:
        return {'n': 0}
    df = pl.DataFrame(
        rows,
        schema={'takeit_prob': pl.Float64, 'deduct': pl.Int64, 'trail': pl.Float64},
        orient='row',
    )
    labels = (df['trail'] < LOSS_THRESHOLD).to_numpy()
    if int(labels.sum()) < 50 or len(df) < 1000:
        return {'n': len(df), 'note': 'insufficient sample'}

    # Pearson correlation between takeit_prob and deduct
    pearson = float(df.select(pl.corr('takeit_prob', 'deduct')).item())
    # AUCs vs is_loss (lower takeit_prob → more loss; lower deduct → more loss)
    auc_takeit = float(roc_auc_score(labels, (1.0 - df['takeit_prob']).to_numpy()))
    auc_deduct = float(roc_auc_score(labels, (-df['deduct']).to_numpy()))
    # Simple combined score (z-score average)
    z_takeit = (1.0 - df['takeit_prob'])
    z_takeit = (z_takeit - z_takeit.mean()) / max(1e-9, z_takeit.std())
    z_deduct = (-df['deduct'])
    z_deduct = (z_deduct - z_deduct.mean()) / max(1e-9, z_deduct.std())
    combined = (z_takeit + z_deduct).to_numpy()
    auc_combined = float(roc_auc_score(labels, combined))

    # Conditional AUC: takeit alone within deducted slice + within baseline slice
    deducted = df.filter(pl.col('deduct') < 0)
    baseline = df.filter(pl.col('deduct') == 0)
    auc_takeit_within_deducted = None
    auc_takeit_within_baseline = None
    if len(deducted) >= 1000:
        d_labels = (deducted['trail'] < LOSS_THRESHOLD).to_numpy()
        if int(d_labels.sum()) >= 50:
            auc_takeit_within_deducted = float(
                roc_auc_score(d_labels, (1.0 - deducted['takeit_prob']).to_numpy())
            )
    if len(baseline) >= 1000:
        b_labels = (baseline['trail'] < LOSS_THRESHOLD).to_numpy()
        if int(b_labels.sum()) >= 50:
            auc_takeit_within_baseline = float(
                roc_auc_score(b_labels, (1.0 - baseline['takeit_prob']).to_numpy())
            )

    return {
        'n': len(df),
        'n_deducted': len(deducted),
        'n_baseline': len(baseline),
        'pearson': pearson,
        'auc_takeit_alone': auc_takeit,
        'auc_deduct_alone': auc_deduct,
        'auc_combined': auc_combined,
        'auc_takeit_within_deducted': auc_takeit_within_deducted,
        'auc_takeit_within_baseline': auc_takeit_within_baseline,
    }


def main() -> int:
    print('=== #2 — Bracket-widen relevance ===', file=sys.stderr)
    q2 = question_2_bracket_widen()
    for source in ('lottery', 'silent_boom'):
        agg = q2[source]
        if not agg:
            print(f'{source}: no deducted alerts', file=sys.stderr)
            continue
        by_deduct = {}
        for (d, tier), n in agg.items():
            by_deduct.setdefault(d, {}).setdefault(tier, 0)
            by_deduct[d][tier] += n
        print(f'\n{source}: effective tier distribution by deduct')
        print(f'{"deduct":>6} {"tier1":>7} {"tier2":>7} {"tier3":>7} {"tier1%":>7}')
        for d in sorted(by_deduct):
            t1 = by_deduct[d].get('tier1', 0)
            t2 = by_deduct[d].get('tier2', 0)
            t3 = by_deduct[d].get('tier3', 0)
            total = t1 + t2 + t3
            t1_pct = t1 / max(1, total) * 100
            print(f'{d:>6} {t1:>7,} {t2:>7,} {t3:>7,} {t1_pct:>6.1f}%')
    if q2['lottery_what_if']:
        whatif = q2['lottery_what_if']
        total = sum(whatif.values())
        print(f'\nLottery -3 alerts WHAT-IF (deduct = -6):')
        for tier in ('tier1', 'tier2', 'tier3'):
            n = whatif.get(tier, 0)
            print(f'  {tier}: {n:,} ({n / max(1, total) * 100:.1f}%)')

    print('\n=== #7 — Second-pass 120min refinement ===', file=sys.stderr)
    if WINDOWS_PARQUET.exists():
        wdf = pl.read_parquet(WINDOWS_PARQUET)
        q7 = question_7_second_pass_at_120(wdf)
        if q7:
            print(f'\nOf alerts deducted at 60min (net_pct < -0.10), stratified by 120min net_pct:')
            print(f'{"stratum":<42} {"n":>8} {"loss%":>7} {"win50%":>7} {"trail":>8} {"peak":>8}')
            for r in q7['strata']:
                print(f'{r["stratum"]:<42} {r["n"]:>8,} {r["loss_rate_pct"]:>6.1f}% {r["peak50_win_pct"]:>6.1f}% {r["mean_trail"]:>+7.2f}% {r["mean_peak"]:>+7.2f}%')
    else:
        q7 = {}
        print('  (skipped — alert_features_windows.parquet missing)')

    print('\n=== #8 — Multivariate: round-trip vs TakeIt ===', file=sys.stderr)
    q8 = question_8_multivariate_takeit()
    if q8.get('n', 0) == 0:
        print('  (skipped — no rows with both takeit_prob and round_trip_net_pct populated)')
    elif q8.get('note'):
        print(f'  {q8["note"]} (n={q8["n"]})')
    else:
        print(f'\nLottery joint sample: n={q8["n"]:,} (deducted={q8["n_deducted"]:,}, baseline={q8["n_baseline"]:,})')
        print(f'Pearson corr(takeit_prob, deduct):  {q8["pearson"]:+.3f}')
        print(f'AUC takeit alone (vs is_loss):      {q8["auc_takeit_alone"]:.3f}')
        print(f'AUC deduct alone (vs is_loss):      {q8["auc_deduct_alone"]:.3f}')
        print(f'AUC combined (z-score sum):         {q8["auc_combined"]:.3f}')
        if q8.get('auc_takeit_within_deducted') is not None:
            print(f'AUC takeit WITHIN deducted slice:   {q8["auc_takeit_within_deducted"]:.3f}')
        if q8.get('auc_takeit_within_baseline') is not None:
            print(f'AUC takeit WITHIN baseline slice:   {q8["auc_takeit_within_baseline"]:.3f}')

    # Write report
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append('# Round-Trip Phase 3 Revisit — #2 / #7 / #8 (2026-05-16)')
    lines.append('')
    lines.append('## #2 — Widen the bracket gap?')
    lines.append('')
    lines.append('**Question:** of deducted alerts, how many still display as tier1/tier2 after the deduct? If many, the −3 magnitude is too soft for the displayed tier to reflect the round-trip noise.')
    lines.append('')
    for source in ('lottery', 'silent_boom'):
        agg = q2[source]
        if not agg:
            continue
        by_deduct = {}
        for (d, tier), n in agg.items():
            by_deduct.setdefault(d, {}).setdefault(tier, 0)
            by_deduct[d][tier] += n
        lines.append(f'### {source}')
        lines.append('')
        lines.append('| Deduct | Tier1 | Tier2 | Tier3 | % still tier1 |')
        lines.append('|---:|---:|---:|---:|---:|')
        for d in sorted(by_deduct):
            t1 = by_deduct[d].get('tier1', 0)
            t2 = by_deduct[d].get('tier2', 0)
            t3 = by_deduct[d].get('tier3', 0)
            total = t1 + t2 + t3
            lines.append(f'| {d} | {t1:,} | {t2:,} | {t3:,} | {t1 / max(1, total) * 100:.1f}% |')
        lines.append('')
    if q2['lottery_what_if']:
        whatif = q2['lottery_what_if']
        total = sum(whatif.values())
        lines.append('### Lottery −3 WHAT-IF (deduct = −6)')
        lines.append('')
        lines.append('| Tier | N | % |')
        lines.append('|---|---:|---:|')
        for tier in ('tier1', 'tier2', 'tier3'):
            n = whatif.get(tier, 0)
            lines.append(f'| {tier} | {n:,} | {n / max(1, total) * 100:.1f}% |')
        lines.append('')

    lines.append('## #7 — Second-pass 120min refinement?')
    lines.append('')
    lines.append('**Question:** of alerts deducted at 60min, do those whose 120min net_pct recovers (>+0.10) perform similarly to baseline non-deducted alerts? If yes, re-evaluating at 120min would un-deduct legitimate signal.')
    lines.append('')
    if q7 and q7.get('strata'):
        lines.append('| Stratum | N | Loss-rate % | Peak50 win % | Mean trail % | Mean peak % |')
        lines.append('|---|---:|---:|---:|---:|---:|')
        for r in q7['strata']:
            lines.append(f'| {r["stratum"]} | {r["n"]:,} | {r["loss_rate_pct"]:.1f}% | {r["peak50_win_pct"]:.1f}% | {r["mean_trail"]:+.2f}% | {r["mean_peak"]:+.2f}% |')
        lines.append('')

    lines.append('## #8 — Multivariate: round-trip vs TakeIt')
    lines.append('')
    lines.append('**Question:** does round_trip_score_deduct add information that takeit_prob (XGBoost trained on full feature set) does not already capture?')
    lines.append('')
    if q8.get('n', 0) > 0 and not q8.get('note'):
        lines.append(f'- **Sample**: n={q8["n"]:,} (deducted={q8["n_deducted"]:,}, baseline={q8["n_baseline"]:,})')
        lines.append(f'- **Pearson corr(takeit_prob, deduct)**: `{q8["pearson"]:+.3f}` — |0.0-0.2| = weak / 0.2-0.5 = moderate / >0.5 = strong')
        lines.append(f'- **AUC takeit alone** (loss-prediction): `{q8["auc_takeit_alone"]:.3f}`')
        lines.append(f'- **AUC deduct alone**: `{q8["auc_deduct_alone"]:.3f}`')
        lines.append(f'- **AUC combined** (z-score sum): `{q8["auc_combined"]:.3f}`')
        if q8.get('auc_takeit_within_deducted') is not None:
            lines.append(f'- **AUC takeit WITHIN deducted slice**: `{q8["auc_takeit_within_deducted"]:.3f}` (does takeit still discriminate among deducted alerts?)')
        if q8.get('auc_takeit_within_baseline') is not None:
            lines.append(f'- **AUC takeit WITHIN baseline slice**: `{q8["auc_takeit_within_baseline"]:.3f}` (does takeit still discriminate among non-deducted?)')
        lines.append('')
        lines.append('**Interpretation rules**:')
        lines.append('- combined AUC > max(takeit, deduct) by ≥0.01 → keep both, they\'re orthogonal')
        lines.append('- combined AUC ≈ max(takeit, deduct) → one signal subsumes the other; drop the weaker')
        lines.append('- |Pearson| > 0.3 + combined ≈ takeit → takeit captures round-trip; retire the deduct')

    REPORT_PATH.write_text('\n'.join(lines))
    print(f'\n✓ Report → {REPORT_PATH}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
