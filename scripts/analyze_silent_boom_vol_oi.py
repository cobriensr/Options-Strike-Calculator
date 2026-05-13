#!/usr/bin/env python
"""Does {feature} predict silent-boom peak performance?

Hypothesis under test: the best-performing silent-boom alerts (highest
peak_ceiling_pct) score higher on the chosen feature column. Anchored
on a single observed fire (QQQ 706 calls, 5/12, ~40x vol/OI, +1245%
peak) — script asks whether that's representative or right-tail noise.

Reads silent_boom_alerts (DB), restricts to enriched rows
(peak_ceiling_pct IS NOT NULL), and runs three cuts:

  1. Distribution of {feature} across the enriched sample (sanity:
     where do the data points actually live?)

  2. FLAT cut: peak_ceiling_pct stats by feature band, plus Spearman ρ
     across the whole sample.

  3. TIER-STRATIFIED cut: same bands, broken out by score_tier
     (tier1/tier2/tier3). Tells us whether the feature carries
     information above and beyond the existing composite score.

  4. Top 20 fires by peak (sanity anchor).

Output: docs/tmp/silent-boom-{feature}-{stamp}.md

Usage:
    python3 scripts/analyze_silent_boom_vol_oi.py
    python3 scripts/analyze_silent_boom_vol_oi.py --feature ask_pct
    python3 scripts/analyze_silent_boom_vol_oi.py --since 2026-05-01
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import statistics as st
import sys
from datetime import datetime

import psycopg2

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
OUT_DIR = ROOT / 'docs' / 'tmp'

# Per-feature bucket bands + display formatting. Adding a new feature
# means dropping it in here — script is otherwise feature-agnostic.
FEATURES: dict[str, dict] = {
    'vol_oi': {
        'label': 'vol/OI',
        # Log-scaled on the raw ratio. Dashboard renders these as %.
        'bands': [
            (0.0, 1.0, '<1x'),
            (1.0, 3.0, '1-3x'),
            (3.0, 10.0, '3-10x'),
            (10.0, 30.0, '10-30x'),
            (30.0, float('inf'), '30x+'),
        ],
        'unit': 'x',
        'display_scale': 1.0,
    },
    'ask_pct': {
        'label': 'ask %',
        # Stored as fraction (0.0-1.0); load_data scales to 0-100 at
        # read so bands here are in display units.
        'bands': [
            (70.0, 80.0, '70-80%'),
            (80.0, 90.0, '80-90%'),
            (90.0, 95.0, '90-95%'),
            (95.0, 99.99, '95-99%'),
            (99.99, 100.01, '100%'),
        ],
        'unit': '%',
        'display_scale': 100.0,
    },
}

# Win-rate thresholds on peak_ceiling_pct (%). >0 mirrors silent_boom_audit.py.
WIN_THRESHOLDS: list[float] = [0.0, 25.0, 50.0, 100.0]


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def quantile(xs: list[float], q: float) -> float:
    if not xs:
        return float('nan')
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    frac = pos - lo
    return s[lo] + (s[hi] - s[lo]) * frac


def fmt_pct(n: float, sign: bool = True) -> str:
    if n != n:
        return '—'
    fmt = '+.2f' if sign else '.2f'
    return f'{n:{fmt}}%'


def fmt_val(n: float, unit: str) -> str:
    if n != n:
        return '—'
    return f'{n:.2f}{unit}'


def rank(xs: list[float]) -> list[float]:
    """Average-rank assignment for ties (the standard Spearman convention)."""
    indexed = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(indexed):
        j = i
        while j + 1 < len(indexed) and xs[indexed[j + 1]] == xs[indexed[i]]:
            j += 1
        avg = (i + j) / 2 + 1  # 1-indexed average rank for the tie group
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg
        i = j + 1
    return ranks


def pearson(xs: list[float], ys: list[float]) -> float:
    if len(xs) < 3:
        return float('nan')
    mx = st.fmean(xs)
    my = st.fmean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    if dx == 0 or dy == 0:
        return float('nan')
    return num / (dx * dy)


def spearman(xs: list[float], ys: list[float]) -> float:
    """Spearman ρ = Pearson on ranks. Robust to peak_ceiling_pct's heavy tail."""
    return pearson(rank(xs), rank(ys))


def load_data(
    conn: psycopg2.extensions.connection,
    feature: str,
    since: str | None,
) -> list[dict]:
    if feature not in FEATURES:
        sys.exit(f'Unknown feature: {feature}. Choices: {list(FEATURES)}')
    where = 'peak_ceiling_pct IS NOT NULL'
    params: list[object] = []
    if since:
        where += ' AND date >= %s'
        params.append(since)
    scale = FEATURES[feature]['display_scale']
    # feature is whitelisted against FEATURES dict above — safe to inline.
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {feature}, peak_ceiling_pct, score_tier, option_type,
                   underlying_symbol, date
            FROM silent_boom_alerts
            WHERE {where}
            """,
            params,
        )
        rows: list[dict] = []
        for feat_val, peak, tier, opt_type, sym, date in cur.fetchall():
            if feat_val is None or peak is None:
                continue
            rows.append({
                'feature': float(feat_val) * scale,
                'peak': float(peak),
                'tier': tier or 'untiered',
                'option_type': opt_type,
                'symbol': sym,
                'date': date.isoformat() if date else None,
            })
        return rows


# ──────────────────────────────────────────────────────────────────
# Section 1: distribution
# ──────────────────────────────────────────────────────────────────


def section_distribution(
    rows: list[dict], feature: str, md: list[str],
) -> None:
    cfg = FEATURES[feature]
    label = cfg['label']
    unit = cfg['unit']
    md.append(f'## 1. {label} distribution across enriched sample\n')
    md.append(
        f'_Just a sanity probe: where do enriched silent-boom alerts '
        f'actually sit on the {label} axis?_\n',
    )
    md.append(f'| stat | {label} |')
    md.append('|---|--:|')
    vs = [r['feature'] for r in rows]
    md.append(f'| n | {len(vs)} |')
    md.append(f'| min | {fmt_val(min(vs), unit)} |')
    md.append(f'| mean | {fmt_val(st.fmean(vs), unit)} |')
    md.append(f'| median (P50) | {fmt_val(quantile(vs, 0.50), unit)} |')
    md.append(f'| P75 | {fmt_val(quantile(vs, 0.75), unit)} |')
    md.append(f'| P90 | {fmt_val(quantile(vs, 0.90), unit)} |')
    md.append(f'| P95 | {fmt_val(quantile(vs, 0.95), unit)} |')
    md.append(f'| P99 | {fmt_val(quantile(vs, 0.99), unit)} |')
    md.append(f'| max | {fmt_val(max(vs), unit)} |')
    md.append('')


# ──────────────────────────────────────────────────────────────────
# Section 2: flat cut + Spearman ρ
# ──────────────────────────────────────────────────────────────────


def _win_columns(peaks: list[float]) -> list[str]:
    """Return formatted win-% strings at each WIN_THRESHOLDS level."""
    if not peaks:
        return ['—'] * len(WIN_THRESHOLDS)
    n = len(peaks)
    return [
        f'{sum(1 for p in peaks if p > t) / n * 100:.1f}%'
        for t in WIN_THRESHOLDS
    ]


def _bucket_row(
    label: str,
    peaks: list[float],
) -> str:
    if not peaks:
        return f'| {label} | 0 | — | — | — | — | — | — | — | — |'
    wins = _win_columns(peaks)
    return (
        f'| {label} | {len(peaks)} | '
        f'{fmt_pct(st.median(peaks))} | {fmt_pct(st.fmean(peaks))} | '
        f'{fmt_pct(quantile(peaks, 0.75))} | '
        f'{fmt_pct(quantile(peaks, 0.90))} | '
        f'{fmt_pct(max(peaks))} | '
        f'{wins[0]} | {wins[1]} | {wins[2]} | {wins[3]} |'
    )


def section_flat_cut(
    rows: list[dict], feature: str, md: list[str],
) -> None:
    cfg = FEATURES[feature]
    label = cfg['label']
    md.append(f'## 2. FLAT cut: peak_ceiling_pct by {label} band\n')
    win_cols = ' | '.join(f'win > {int(t)}%' for t in WIN_THRESHOLDS)
    md.append(
        f'_Primary table. "win" = peak_ceiling_pct > threshold. Higher '
        f'thresholds tighten the bar from "ever positive" to "fired and '
        f'actually doubled". If {label} predicts performance, expect '
        f'median/mean/P90 to rise monotonically as you walk down the '
        f'bands._\n',
    )
    md.append(
        f'| {label} band | n | median | mean | P75 | P90 | max | '
        f'{win_cols} |',
    )
    md.append('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|')

    for lo, hi, band_label in cfg['bands']:
        peaks = [r['peak'] for r in rows if lo <= r['feature'] < hi]
        md.append(_bucket_row(band_label, peaks))

    md.append('')
    md.append('### Correlation coefficients\n')
    md.append(
        f'_Spearman ρ is the headline number — it asks "do alerts that '
        f'rank higher on {label} also rank higher on peak?" without '
        f'letting any single huge peak dominate. Pearson r is included '
        f'for reference but the peak distribution is heavy-tailed '
        f'enough that it overweights outliers._\n',
    )
    vs = [r['feature'] for r in rows]
    ps = [r['peak'] for r in rows]
    rho = spearman(vs, ps)
    r = pearson(vs, ps)
    md.append('| metric | value | reading |')
    md.append('|---|--:|---|')
    md.append(
        f'| Spearman ρ ({feature}, peak) | {rho:+.3f} | '
        f'{_rho_reading(rho)} |',
    )
    md.append(
        f'| Pearson r ({feature}, peak) | {r:+.3f} | '
        f'{_rho_reading(r)} |',
    )
    md.append('')


def _rho_reading(rho: float) -> str:
    if rho != rho:
        return '—'
    a = abs(rho)
    if a < 0.05:
        return 'no relationship'
    if a < 0.10:
        return 'trivial'
    if a < 0.20:
        return 'weak'
    if a < 0.40:
        return 'moderate'
    return 'strong'


# ──────────────────────────────────────────────────────────────────
# Section 3: tier-stratified
# ──────────────────────────────────────────────────────────────────


def section_tier_stratified(
    rows: list[dict], feature: str, md: list[str],
) -> None:
    cfg = FEATURES[feature]
    label = cfg['label']
    md.append('## 3. Stratified by score_tier\n')
    md.append(
        f'_Does {label} add information once the composite tier is '
        f'already controlling for the other features? If the within-'
        f'tier medians still climb with {label} band, {label} carries '
        f'orthogonal signal. If they go flat, {label} is mostly '
        f'proxying for whatever tier already encodes._\n',
    )
    win_cols = ' | '.join(f'win > {int(t)}%' for t in WIN_THRESHOLDS)
    md.append(
        f'| tier | {label} band | n | median | mean | P90 | {win_cols} |',
    )
    md.append('|---|---|--:|--:|--:|--:|--:|--:|--:|--:|')

    for tier in ('tier1', 'tier2', 'tier3', 'untiered'):
        tier_rows = [r for r in rows if r['tier'] == tier]
        if not tier_rows:
            continue
        peaks_all = [r['peak'] for r in tier_rows]
        wins = _win_columns(peaks_all)
        md.append(
            f'| **{tier}** | ALL | {len(peaks_all)} | '
            f'{fmt_pct(st.median(peaks_all))} | '
            f'{fmt_pct(st.fmean(peaks_all))} | '
            f'{fmt_pct(quantile(peaks_all, 0.90))} | '
            f'{wins[0]} | {wins[1]} | {wins[2]} | {wins[3]} |',
        )
        for lo, hi, band_label in cfg['bands']:
            peaks = [r['peak'] for r in tier_rows if lo <= r['feature'] < hi]
            if len(peaks) < 5:
                continue
            wins = _win_columns(peaks)
            md.append(
                f'| {tier} | {band_label} | {len(peaks)} | '
                f'{fmt_pct(st.median(peaks))} | '
                f'{fmt_pct(st.fmean(peaks))} | '
                f'{fmt_pct(quantile(peaks, 0.90))} | '
                f'{wins[0]} | {wins[1]} | {wins[2]} | {wins[3]} |',
            )
    md.append('')


# ──────────────────────────────────────────────────────────────────
# Section 4: anchor row — the QQQ 706 the experiment started from
# ──────────────────────────────────────────────────────────────────


def section_anchors(
    rows: list[dict], feature: str, md: list[str],
) -> None:
    cfg = FEATURES[feature]
    label = cfg['label']
    unit = cfg['unit']
    md.append('## 4. Top 20 fires by peak_ceiling_pct\n')
    md.append(
        f'_Sanity check — where do the top fires sit on {label} '
        f'relative to the rest of the distribution?_\n',
    )
    md.append(f'| rank | date | ticker | type | tier | {label} | peak |')
    md.append('|--:|---|---|---|---|--:|--:|')
    top = sorted(rows, key=lambda r: r['peak'], reverse=True)[:20]
    for i, r in enumerate(top, 1):
        md.append(
            f"| {i} | {r['date']} | {r['symbol']} | {r['option_type']} | "
            f"{r['tier']} | {fmt_val(r['feature'], unit)} | "
            f"{fmt_pct(r['peak'])} |",
        )
    md.append('')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--feature',
        type=str,
        default='vol_oi',
        choices=sorted(FEATURES),
        help='Feature column on silent_boom_alerts to test. '
             f'Choices: {sorted(FEATURES)}.',
    )
    parser.add_argument(
        '--since',
        type=str,
        default=None,
        help='Restrict to fires on/after this date (YYYY-MM-DD).',
    )
    args = parser.parse_args()
    load_env()

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        print(f'Loading silent_boom_alerts ({args.feature}, enriched only)…')
        rows = load_data(conn, args.feature, args.since)
        print(f'  {len(rows)} enriched fires')
    finally:
        conn.close()

    if not rows:
        sys.exit('No enriched silent_boom_alerts in scope. '
                 'Run enrich_silent_boom_outcomes.py first.')

    cfg = FEATURES[args.feature]
    md: list[str] = []
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    title_suffix = f' (since {args.since})' if args.since else ''
    md.append(
        f'# Silent-boom {cfg["label"]} vs peak performance{title_suffix}\n',
    )
    md.append(
        f'_Joined {len(rows)} enriched fires from `silent_boom_alerts`. '
        f'Outcome metric: `peak_ceiling_pct`. Feature: `{args.feature}` '
        f'({cfg["label"]})._\n',
    )

    section_distribution(rows, args.feature, md)
    section_flat_cut(rows, args.feature, md)
    section_tier_stratified(rows, args.feature, md)
    section_anchors(rows, args.feature, md)

    output = '\n'.join(md)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = args.feature.replace('_', '-')
    out_path = OUT_DIR / f'silent-boom-{slug}-{stamp}.md'
    out_path.write_text(output, encoding='utf-8')
    print(f'\nwrote {out_path}')
    print('\n' + output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
