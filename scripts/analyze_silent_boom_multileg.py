#!/usr/bin/env python
"""Is the silent-boom ask% = 1.0 cliff explained by multi-leg spread legs?

Joins enriched silent_boom_alerts against ws_option_trades (per-trade
tape, last ~9 days only) to compute the multi-leg share of each fire's
5-min spike bucket, using UW's OPRA-standard `trade_code` field:

  Multi-leg codes (per OPRA/CTA sale condition spec):
    mlat — Multi-Leg Auto Traded
    mlet — Multi-Leg Electronic Traded
    mlft — Multi-Leg Floor Traded
    mfto — Multi-Leg Floor, Traded against Quote
    masl — Multi-Leg Auto vs Single-Leg
    mesl — Multi-Leg Electronic vs Single-Leg
    mfsl — Multi-Leg Floor vs Single-Leg
    mlct — Multi-Leg Cross Trade

Population baseline (15-min slice 2026-05-12): ~22% of total option
volume is multi-leg. If silent-boom fires with ask_pct = 1.0 show
substantially higher than 22%, the cliff is partly explained by spread-
leg routing rather than pure illiquidity.

Output: docs/tmp/silent-boom-multileg-{stamp}.md

Usage:
    python3 scripts/analyze_silent_boom_multileg.py
"""

from __future__ import annotations

import math
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

MULTI_LEG_CODES = (
    'mlat', 'mlet', 'mlft', 'mfto', 'masl', 'mesl', 'mfsl', 'mlct',
)

# Ask bands in DISPLAY units (0-100). Source column ask_pct is fraction.
ASK_BANDS: list[tuple[float, float, str]] = [
    (0.70, 0.80, '70-80%'),
    (0.80, 0.90, '80-90%'),
    (0.90, 0.95, '90-95%'),
    (0.95, 0.9999, '95-99%'),
    (1.0, 1.001, '100%'),
]

# Multi-leg share buckets (fraction of total bucket size that's multi-leg)
ML_BUCKETS: list[tuple[float, float, str]] = [
    (0.0, 0.10, '<10%'),
    (0.10, 0.30, '10-30%'),
    (0.30, 0.70, '30-70%'),
    (0.70, 0.90, '70-90%'),
    (0.90, 1.01, '≥90%'),
]


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


def fmt_pct(n: float, sign: bool = True) -> str:
    if math.isnan(n):
        return '—'
    fmt = '+.2f' if sign else '.2f'
    return f'{n:{fmt}}%'


def main() -> int:
    load_env()
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT MIN(executed_at), MAX(executed_at) FROM ws_option_trades',
            )
            tape_min, tape_max = cur.fetchone()
            print(f'ws_option_trades coverage: {tape_min} → {tape_max}')

            # Pull fires that overlap with tape coverage AND have peaks.
            cur.execute(
                """
                SELECT id, option_chain_id, bucket_ct, ask_pct,
                       peak_ceiling_pct, score_tier
                FROM silent_boom_alerts
                WHERE peak_ceiling_pct IS NOT NULL
                  AND bucket_ct >= %s
                  AND bucket_ct < %s
                """,
                (tape_min, tape_max),
            )
            fires = [
                {
                    'id': r[0],
                    'chain': r[1],
                    'bucket_ct': r[2],
                    'ask_pct': float(r[3]) * 100.0,
                    'peak': float(r[4]),
                    'tier': r[5] or 'untiered',
                }
                for r in cur.fetchall()
            ]
            print(f'  → {len(fires)} enriched fires in overlap window')

            # For each fire, compute multi-leg share of size in the bucket.
            # Single query per fire is too slow (n=many); use a SQL CTE to
            # batch the lookup with array binds.
            multi_codes_arr = list(MULTI_LEG_CODES)
            rows_out: list[dict] = []
            BATCH = 200
            for i in range(0, len(fires), BATCH):
                chunk = fires[i:i + BATCH]
                chain_ids = [f['chain'] for f in chunk]
                bucket_lows = [f['bucket_ct'] for f in chunk]
                cur.execute(
                    """
                    WITH targets AS (
                        SELECT UNNEST(%s::text[]) AS chain,
                               UNNEST(%s::timestamptz[]) AS bucket_lo
                    )
                    SELECT t.chain, t.bucket_lo,
                           COALESCE(SUM(w.size), 0) AS total_size,
                           COALESCE(SUM(w.size) FILTER (
                               WHERE w.raw_payload->>'trade_code' = ANY(%s)
                           ), 0) AS ml_size
                    FROM targets t
                    LEFT JOIN ws_option_trades w
                      ON w.option_chain = t.chain
                     AND w.executed_at >= t.bucket_lo
                     AND w.executed_at <  t.bucket_lo + INTERVAL '5 minutes'
                     AND w.canceled = FALSE
                    GROUP BY t.chain, t.bucket_lo
                    """,
                    (chain_ids, bucket_lows, multi_codes_arr),
                )
                lookup: dict[tuple[str, str], tuple[int, int]] = {}
                for chain, bucket_lo, total, ml in cur.fetchall():
                    key = (chain, bucket_lo.isoformat())
                    lookup[key] = (int(total), int(ml))
                for f in chunk:
                    key = (f['chain'], f['bucket_ct'].isoformat())
                    total, ml = lookup.get(key, (0, 0))
                    if total == 0:
                        continue
                    rows_out.append({
                        **f,
                        'total_size': total,
                        'ml_size': ml,
                        'ml_share': ml / total,
                    })
                print(
                    f'  …processed {min(i + BATCH, len(fires)):>5}/{len(fires)}',
                )
    finally:
        conn.close()

    if not rows_out:
        sys.exit('No fires had matching trade-tape data.')

    print(f'\n{len(rows_out)} fires with tape coverage')

    md: list[str] = []
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    md.append(f'# Silent-boom multi-leg attribution ({stamp})\n')
    md.append(
        f'_Joined {len(rows_out)} enriched silent_boom_alerts against '
        f'ws_option_trades (tape coverage ~9 days). Multi-leg share = '
        f'sum of trade size whose `trade_code` is one of '
        f'`{", ".join(MULTI_LEG_CODES)}` divided by total bucket size._\n',
    )

    # Section 1: ask-band × multi-leg-share cross-tab (count of fires)
    md.append(
        '## 1. Multi-leg share distribution within each ask% band\n',
    )
    md.append(
        '_If the ask=100% cliff is multi-leg-driven, the 100% band\'s '
        'multi-leg share distribution should skew much higher than the '
        '70-80% band. Population baseline ≈ 22% multi-leg by size._\n',
    )
    md.append(
        f'| ask band | n | {" | ".join(b[2] for b in ML_BUCKETS)} | median ML share |',
    )
    md.append('|---|--:|' + '--:|' * (len(ML_BUCKETS) + 1))

    for lo_a, hi_a, label_a in ASK_BANDS:
        sub = [
            r for r in rows_out
            if lo_a * 100 <= r['ask_pct'] < hi_a * 100
        ]
        if not sub:
            continue
        n = len(sub)
        counts: list[int] = []
        for lo_m, hi_m, _ in ML_BUCKETS:
            counts.append(
                sum(1 for r in sub if lo_m <= r['ml_share'] < hi_m),
            )
        cells = ' | '.join(
            f'{c} ({c / n * 100:.0f}%)' for c in counts
        )
        med = st.median([r['ml_share'] for r in sub]) * 100
        md.append(
            f'| {label_a} | {n} | {cells} | {med:.1f}% |',
        )
    md.append('')

    # Section 2: peak vs ml_share inside the ask=100% cohort
    md.append('## 2. Inside the ask=100% band: does multi-leg explain underperformance?\n')
    md.append(
        '_Splits the ask=100% fires by their multi-leg size share. If '
        'multi-leg fires underperform low-multi-leg fires within this '
        'cohort, the cliff is the spread-leg-routing artifact you '
        'asked about. If both subsets underperform similarly, the '
        'cliff is structural illiquidity._\n',
    )
    md.append('| ML share | n | median peak | mean peak | win > 0% | win > 100% |')
    md.append('|---|--:|--:|--:|--:|--:|')
    one00 = [r for r in rows_out if r['ask_pct'] >= 100.0]
    for lo_m, hi_m, label_m in ML_BUCKETS:
        sub = [r for r in one00 if lo_m <= r['ml_share'] < hi_m]
        if not sub:
            continue
        peaks = [r['peak'] for r in sub]
        w0 = sum(1 for p in peaks if p > 0) / len(peaks) * 100
        w100 = sum(1 for p in peaks if p > 100) / len(peaks) * 100
        md.append(
            f'| {label_m} | {len(sub)} | '
            f'{fmt_pct(st.median(peaks))} | '
            f'{fmt_pct(st.fmean(peaks))} | '
            f'{w0:.1f}% | {w100:.1f}% |',
        )
    md.append('')

    # Section 3: same split but inside the "control" 95-99% band — should
    # NOT show the same pattern if multi-leg is genuinely the issue, since
    # 95-99% fires already perform fine.
    md.append('## 3. Control: same split inside the 95-99% band\n')
    md.append(
        '_If multi-leg fires in the 95-99% band also underperform, '
        'multi-leg is a general problem (not just an ask=100% phenomenon). '
        'If 95-99% multi-leg fires perform fine, the issue is the '
        'interaction of multi-leg WITH the saturation condition._\n',
    )
    md.append('| ML share | n | median peak | mean peak | win > 0% | win > 100% |')
    md.append('|---|--:|--:|--:|--:|--:|')
    control = [r for r in rows_out if 95.0 <= r['ask_pct'] < 99.99]
    for lo_m, hi_m, label_m in ML_BUCKETS:
        sub = [r for r in control if lo_m <= r['ml_share'] < hi_m]
        if not sub:
            continue
        peaks = [r['peak'] for r in sub]
        w0 = sum(1 for p in peaks if p > 0) / len(peaks) * 100
        w100 = sum(1 for p in peaks if p > 100) / len(peaks) * 100
        md.append(
            f'| {label_m} | {len(sub)} | '
            f'{fmt_pct(st.median(peaks))} | '
            f'{fmt_pct(st.fmean(peaks))} | '
            f'{w0:.1f}% | {w100:.1f}% |',
        )
    md.append('')

    # Section 4: top performers from ask=100% — what's their ML share?
    md.append('## 4. Ask=100% fires that DID win > 100% peak\n')
    md.append(
        '_Sanity check: when an ask=100% fire actually does deliver a '
        'big peak, is it a low-multi-leg "real demand" print or a '
        'high-multi-leg outlier?_\n',
    )
    md.append('| date | chain | tier | ask% | ML share | total size | peak |')
    md.append('|---|---|---|--:|--:|--:|--:|')
    winners = sorted(
        [r for r in one00 if r['peak'] > 100],
        key=lambda r: r['peak'],
        reverse=True,
    )[:20]
    for r in winners:
        md.append(
            f"| {r['bucket_ct'].strftime('%Y-%m-%d %H:%M')} | "
            f"{r['chain']} | {r['tier']} | "
            f"{r['ask_pct']:.1f}% | "
            f"{r['ml_share'] * 100:.1f}% | "
            f"{r['total_size']:,} | "
            f"{fmt_pct(r['peak'])} |",
        )
    md.append('')

    output = '\n'.join(md)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f'silent-boom-multileg-{stamp}.md'
    out_path.write_text(output, encoding='utf-8')
    print(f'wrote {out_path}')
    print('\n' + output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
