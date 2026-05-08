#!/usr/bin/env python
"""Stratify silent_boom_alerts by candidate score features and report
which buckets predict peak_ceiling_pct >= 50%.

Output: a markdown report ranking each feature's buckets by lift over
the global high-peak baseline (currently 15.9%). Wilson 95% CIs flag
which lifts are real vs sampling noise.

Phase 0 of docs/superpowers/specs/silent-boom-scoring-2026-05-08.md.
The audit informs Phase 1's score weights — every weight in the
score library MUST trace back to a row in this report.

Usage:
    ml/.venv/bin/python scripts/silent_boom_feature_audit.py
    ml/.venv/bin/python scripts/silent_boom_feature_audit.py --out docs/tmp/silent-boom-feature-audit.md
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
DEFAULT_OUT = ROOT / 'docs' / 'tmp' / 'silent-boom-feature-audit-2026-05-08.md'

HIGH_PEAK_THRESHOLD = 50.0
"""peak_ceiling_pct >= 50% is the "high-peak" definition. Mirrors the
lottery scoring methodology — a 50% peak roughly corresponds to "the
kind of move that pays for the trade plus all the losers around it"
in the user's discretionary framing."""

LOW_CONFIDENCE_N = 100
"""Strata with sample below this are flagged in the report."""


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def fetch_alerts(conn) -> pd.DataFrame:
    """Pull every enriched alert with the columns we'll stratify on."""
    df = pd.read_sql(
        """
        SELECT
          date,
          bucket_ct,
          underlying_symbol,
          option_type,
          strike,
          dte,
          spike_volume,
          baseline_volume,
          spike_ratio,
          ask_pct,
          vol_oi,
          entry_price,
          open_interest,
          peak_ceiling_pct,
          minutes_to_peak,
          realized_60m_pct
        FROM silent_boom_alerts
        WHERE peak_ceiling_pct IS NOT NULL
        """,
        conn,
    )
    # bucket_ct is timestamptz — convert to CT minute-of-day for TOD bucketing.
    df['bucket_ct'] = pd.to_datetime(df['bucket_ct'], utc=True)
    df['bucket_ct_central'] = df['bucket_ct'].dt.tz_convert('America/Chicago')
    df['minute_of_day'] = (
        df['bucket_ct_central'].dt.hour * 60
        + df['bucket_ct_central'].dt.minute
    )
    # Numeric coercions — psycopg2 returns numeric as Decimal.
    for col in (
        'spike_ratio',
        'ask_pct',
        'vol_oi',
        'baseline_volume',
        'entry_price',
        'peak_ceiling_pct',
    ):
        df[col] = pd.to_numeric(df[col], errors='coerce')
    return df


# ============================================================
# Statistics helpers
# ============================================================


def wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson 95% CI for a binomial proportion. Returns (lo, hi) in %.
    More stable than normal-approximation for n<200 and proportions
    near 0/1 — both common in this audit's tails."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt((p * (1 - p) / n) + (z * z / (4 * n * n))) / denom
    return (max(0.0, (centre - half) * 100), min(100.0, (centre + half) * 100))


@dataclass
class StratumStats:
    label: str
    n: int
    pct_high_peak: float
    ci_lo: float
    ci_hi: float
    mean_peak: float
    median_peak: float
    lift: float


def stratum_stats(
    df: pd.DataFrame, baseline_high_peak_rate: float, label: str
) -> StratumStats:
    n = len(df)
    if n == 0:
        return StratumStats(label, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    high = (df['peak_ceiling_pct'] >= HIGH_PEAK_THRESHOLD).sum()
    pct = (high / n) * 100
    lo, hi = wilson_ci(int(high), n)
    return StratumStats(
        label=label,
        n=n,
        pct_high_peak=pct,
        ci_lo=lo,
        ci_hi=hi,
        mean_peak=float(df['peak_ceiling_pct'].mean()),
        median_peak=float(df['peak_ceiling_pct'].median()),
        lift=pct / baseline_high_peak_rate if baseline_high_peak_rate > 0 else 0.0,
    )


# ============================================================
# Feature stratifications
# ============================================================


def bucket_spike_ratio(x: float) -> str:
    if x < 10: return '1) 5–10×'
    if x < 25: return '2) 10–25×'
    if x < 50: return '3) 25–50×'
    if x < 100: return '4) 50–100×'
    return '5) 100×+'


def bucket_vol_oi(x: float) -> str:
    if x < 0.5: return '1) 0.25–0.5'
    if x < 1.0: return '2) 0.5–1.0'
    if x < 2.0: return '3) 1.0–2.0'
    return '4) 2.0+'


def bucket_ask_pct(x: float) -> str:
    if x < 0.85: return '1) 0.70–0.85'
    if x < 0.95: return '2) 0.85–0.95'
    return '3) 0.95+'


def bucket_oi(x: float) -> str:
    if x < 500: return '1) <500'
    if x < 2000: return '2) 500–2k'
    if x < 10000: return '3) 2k–10k'
    return '4) 10k+'


def bucket_dte(x: int) -> str:
    if x == 0: return '1) 0DTE'
    if x <= 3: return '2) 1–3D'
    if x <= 7: return '3) 4–7D'
    if x <= 30: return '4) 8–30D'
    return '5) 30D+'


def bucket_entry_price(x: float) -> str:
    if x < 0.5: return '1) <$0.50'
    if x < 1.0: return '2) $0.50–1.00'
    if x < 5.0: return '3) $1.00–5.00'
    return '4) $5.00+'


def bucket_baseline(x: float) -> str:
    if x < 50: return '1) <50'
    if x < 200: return '2) 50–200'
    return '3) 200–500'


def bucket_tod(min_of_day: int) -> str:
    """Match the user's intraday phases (CT). Open is 08:30; market
    closes at 15:00 CT for SPX 0DTE — anything past 15:00 is the
    cash-options ETF tail."""
    if min_of_day < 10 * 60:           return '1) AM_open (08:30–10:00)'
    if min_of_day < 12 * 60:           return '2) MID (10:00–12:00)'
    if min_of_day < 13 * 60:           return '3) LUNCH (12:00–13:00)'
    if min_of_day < 15 * 60:           return '4) PM (13:00–15:00)'
    return '5) LATE (15:00+)'


FEATURES: list[tuple[str, str, callable]] = [
    ('spike_ratio', 'Spike ratio (multiple of baseline median)', lambda r: bucket_spike_ratio(r['spike_ratio'])),
    ('vol_oi', 'Vol / OI in spike bucket', lambda r: bucket_vol_oi(r['vol_oi'])),
    ('ask_pct', 'Ask-side share of spike bucket', lambda r: bucket_ask_pct(r['ask_pct'])),
    ('open_interest', 'Open interest at spike', lambda r: bucket_oi(r['open_interest'])),
    ('dte', 'Days-to-expiry', lambda r: bucket_dte(r['dte'])),
    ('option_type', 'Option type (C vs P)', lambda r: 'C' if r['option_type'] == 'C' else 'P'),
    ('tod', 'Time of day (CT)', lambda r: bucket_tod(r['minute_of_day'])),
    ('entry_price', 'Entry price (vwap of spike bucket)', lambda r: bucket_entry_price(r['entry_price'])),
    ('baseline_volume', 'Baseline median volume (silence depth)', lambda r: bucket_baseline(r['baseline_volume'])),
]


# ============================================================
# Report formatting
# ============================================================


def format_section(
    title: str, stats: list[StratumStats], baseline: float
) -> str:
    out = [f'## {title}', '']
    out.append('| Bucket | n | high-peak% | 95% CI | mean peak | median peak | lift |')
    out.append('|---|---:|---:|---|---:|---:|---:|')
    # Sort by bucket label so the natural ordering (the leading "1)..."
    # numeric prefix) renders increasing across the row.
    for s in sorted(stats, key=lambda x: x.label):
        flag = ' ⚠️' if s.n < LOW_CONFIDENCE_N else ''
        out.append(
            f'| {s.label}{flag} | {s.n:,} | '
            f'{s.pct_high_peak:.1f}% | '
            f'{s.ci_lo:.1f}–{s.ci_hi:.1f}% | '
            f'{s.mean_peak:+.1f}% | '
            f'{s.median_peak:+.1f}% | '
            f'{s.lift:.2f}× |'
        )
    out.append('')
    out.append(f'_Baseline high-peak rate: {baseline:.1f}%. Strata flagged ⚠️ have n < {LOW_CONFIDENCE_N}._')
    out.append('')
    return '\n'.join(out)


def render_report(
    df: pd.DataFrame, baseline_high_peak_rate: float, n_total: int
) -> str:
    head = [
        '# Silent-Boom Feature Audit',
        '',
        '**Generated:** by `scripts/silent_boom_feature_audit.py`  ',
        '**Sample:** silent_boom_alerts where peak_ceiling_pct IS NOT NULL  ',
        f'**n:** {n_total:,}  ',
        f'**Baseline high-peak rate** (peak ≥ 50%): **{baseline_high_peak_rate:.1f}%**  ',
        '',
        'Stratifies the enriched silent-boom sample by each candidate ',
        'score feature. "lift" is the bucket\'s high-peak rate divided ',
        'by the global baseline — values >1 mean the bucket beats the ',
        'baseline; the 95% Wilson CI shows whether the lift is real.',
        '',
        'The Phase 1 score library translates the strongest-lift ',
        'buckets into integer score points. Buckets with overlapping ',
        'CIs that span 1.0 should not get differentiating weights.',
        '',
        '---',
        '',
    ]

    sections: list[str] = []
    summary_rows: list[tuple[str, str, float, float, float, int]] = []
    for feature_key, title, bucketer in FEATURES:
        df = df.copy()
        df['_bucket'] = df.apply(bucketer, axis=1)
        stats = []
        for label, sub in df.groupby('_bucket'):
            stats.append(stratum_stats(sub, baseline_high_peak_rate, label))
        sections.append(format_section(title, stats, baseline_high_peak_rate))
        # Track best & worst stratum for the summary table.
        if stats:
            best = max(stats, key=lambda s: (s.pct_high_peak, s.n))
            worst = min(stats, key=lambda s: (s.pct_high_peak, -s.n))
            summary_rows.append((
                title, best.label, best.lift, worst.lift,
                best.pct_high_peak - worst.pct_high_peak, best.n,
            ))

    summary_rows.sort(key=lambda r: r[4], reverse=True)
    summary = ['## Summary — features ranked by within-feature lift spread', '']
    summary.append('| Feature | Best bucket | Best lift | Worst lift | Spread (pp) | Best n |')
    summary.append('|---|---|---:|---:|---:|---:|')
    for r in summary_rows:
        summary.append(
            f'| {r[0]} | {r[1]} | {r[2]:.2f}× | {r[3]:.2f}× | '
            f'{r[4]:+.1f}pp | {r[5]:,} |'
        )
    summary.append('')
    summary.append(
        'Spread is the percentage-point gap between the best and worst '
        'buckets within a feature — a high spread means the feature '
        'genuinely segments. Use this to pick which features get '
        'meaningful score weights vs. which collapse into noise.'
    )
    summary.append('')

    return '\n'.join(head + summary + ['---', ''] + sections)


# ============================================================
# Main
# ============================================================


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default=str(DEFAULT_OUT))
    args = parser.parse_args()

    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)
    df = fetch_alerts(conn)
    n_total = len(df)
    if n_total == 0:
        sys.exit('No enriched silent-boom alerts to audit.')

    high_peak_rate = (
        (df['peak_ceiling_pct'] >= HIGH_PEAK_THRESHOLD).sum() / n_total * 100
    )
    print(f'[silent-boom-audit] n={n_total:,}, baseline high-peak rate={high_peak_rate:.1f}%')

    report = render_report(df, high_peak_rate, n_total)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report, encoding='utf-8')
    print(f'[silent-boom-audit] report → {out_path}')


if __name__ == '__main__':
    main()
