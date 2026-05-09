#!/usr/bin/env python
"""Recompute the (tier, ticker) -> avg-hold-minutes lookup that powers
the SilentBoomRow `~Nmin` chip and prints a TypeScript constant block
suitable for paste into `api/_lib/silent-boom-hold.ts`.

The lookup is a P75 of `minutes_to_peak` among winners
(peak_ceiling_pct >= 50) — the historical "if this works, expect it to
peak by here" boundary. Tier defaults always have plenty of n;
per-ticker overrides only kick in when the ticker has both:

  * n >= TICKER_OVERRIDE_MIN_N winners for that tier, AND
  * |ticker_p75 - tier_p75| / tier_p75 >= TICKER_OVERRIDE_MIN_DELTA_PCT

Run monthly. The expected drift on a 14k+ enriched sample over one
month is small (<5min on tier defaults) so this is NOT a daily job.

Spec: docs/superpowers/specs/silent-boom-flame-exit-2026-05-08.md

Usage:
    ml/.venv/bin/python scripts/recompute_silent_boom_hold_minutes.py
"""

from __future__ import annotations

import os
import re
import sys
from datetime import date
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'

HIGH_PEAK_THRESHOLD = 50.0
TICKER_OVERRIDE_MIN_N = 30
TICKER_OVERRIDE_MIN_DELTA_PCT = 0.25

TIERS = ('tier1', 'tier2', 'tier3')


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


def fetch_tier_defaults(conn) -> dict[str, int]:
    """P75 of minutes_to_peak among winners, by tier."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT score_tier,
               percentile_cont(0.75) WITHIN GROUP (ORDER BY minutes_to_peak)
        FROM silent_boom_alerts
        WHERE peak_ceiling_pct >= %s
          AND score_tier IS NOT NULL
        GROUP BY score_tier
        """,
        (HIGH_PEAK_THRESHOLD,),
    )
    out: dict[str, int] = {}
    for tier, p75 in cur.fetchall():
        if p75 is None:
            continue
        out[tier] = int(round(float(p75)))
    return out


def fetch_ticker_overrides(
    conn, tier_defaults: dict[str, int]
) -> list[tuple[str, str, int, int, float]]:
    """Per-(ticker, tier) P75 with significance filter.

    Returns rows of (ticker, tier, p75, n, delta_pct) only where:
      n >= TICKER_OVERRIDE_MIN_N AND
      |ticker_p75 - tier_p75| / tier_p75 >= TICKER_OVERRIDE_MIN_DELTA_PCT
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT underlying_symbol, score_tier,
               COUNT(*) AS n,
               percentile_cont(0.75) WITHIN GROUP (ORDER BY minutes_to_peak)
        FROM silent_boom_alerts
        WHERE peak_ceiling_pct >= %s
          AND score_tier IS NOT NULL
        GROUP BY underlying_symbol, score_tier
        HAVING COUNT(*) >= %s
        """,
        (HIGH_PEAK_THRESHOLD, TICKER_OVERRIDE_MIN_N),
    )
    out: list[tuple[str, str, int, int, float]] = []
    for ticker, tier, n, p75 in cur.fetchall():
        if p75 is None or tier not in tier_defaults:
            continue
        ticker_p75 = int(round(float(p75)))
        tier_p75 = tier_defaults[tier]
        delta = abs(ticker_p75 - tier_p75) / tier_p75
        if delta < TICKER_OVERRIDE_MIN_DELTA_PCT:
            continue
        out.append((ticker, tier, ticker_p75, n, delta))
    out.sort(key=lambda r: (r[1], -r[4]))
    return out


def fetch_sample_size(conn) -> tuple[int, str | None, str | None]:
    """Returns (n_winners, min_date, max_date) for the cohort."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT COUNT(*),
               MIN(date)::text,
               MAX(date)::text
        FROM silent_boom_alerts
        WHERE peak_ceiling_pct >= %s
          AND score_tier IS NOT NULL
        """,
        (HIGH_PEAK_THRESHOLD,),
    )
    row = cur.fetchone()
    if row is None:
        return 0, None, None
    n, lo, hi = row
    return int(n), lo, hi


def render_ts_block(
    tier_defaults: dict[str, int],
    overrides: list[tuple[str, str, int, int, float]],
    n_winners: int,
    min_date: str | None,
    max_date: str | None,
) -> str:
    """Format the constants as a TypeScript block ready for paste."""
    today = date.today().isoformat()
    lines = [
        f'// Recomputed {today} from {n_winners:,} enriched winners',
        f'// (peak_ceiling_pct >= {HIGH_PEAK_THRESHOLD:.0f}, '
        f'date range {min_date} -> {max_date}).',
        '// Paste into api/_lib/silent-boom-hold.ts.',
        '',
        '/** Tier-default P75 minutes-to-peak among winners. */',
        'const TIER_DEFAULTS: Readonly<Record<SilentBoomScoreTier, number>> = {',
    ]
    for tier in TIERS:
        if tier in tier_defaults:
            lines.append(f'  {tier}: {tier_defaults[tier]},')
    lines.append('} as const;')
    lines.append('')

    if overrides:
        lines.append(
            '/**\n'
            ' * Per-(ticker, tier) overrides — only included when both:\n'
            f' *   - n >= {TICKER_OVERRIDE_MIN_N} historical winners, AND\n'
            f' *   - |ticker_p75 - tier_p75| / tier_p75 >= '
            f'{TICKER_OVERRIDE_MIN_DELTA_PCT:.2f}\n'
            ' */'
        )
        lines.append('const TICKER_OVERRIDES: ReadonlyMap<string, number> = new Map([')
        for ticker, tier, p75, n, delta in overrides:
            sign = '+' if p75 > tier_defaults[tier] else '-'
            lines.append(
                f"  ['{ticker}:{tier}', {p75}],"
                f'  // n={n}, {sign}{delta * 100:.0f}% vs tier default '
                f'({tier_defaults[tier]})'
            )
        lines.append(']);')
    else:
        lines.append(
            '// No per-ticker overrides cleared the n + delta thresholds today.'
        )
        lines.append('const TICKER_OVERRIDES: ReadonlyMap<string, number> = new Map();')

    return '\n'.join(lines)


def main() -> None:
    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get('DATABASE_URL')
    if not db_url:
        sys.exit('DATABASE_URL not set in env')
    conn = psycopg2.connect(db_url)
    try:
        tier_defaults = fetch_tier_defaults(conn)
        if set(tier_defaults) != set(TIERS):
            missing = set(TIERS) - set(tier_defaults)
            print(
                f'WARNING: missing tier defaults for {sorted(missing)} '
                f'— not enough winners in those tiers yet.',
                file=sys.stderr,
            )
        overrides = fetch_ticker_overrides(conn, tier_defaults)
        n, lo, hi = fetch_sample_size(conn)
    finally:
        conn.close()

    print(render_ts_block(tier_defaults, overrides, n, lo, hi))


if __name__ == '__main__':
    main()
