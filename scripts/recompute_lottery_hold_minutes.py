#!/usr/bin/env python
"""Recompute the (tier, ticker) -> avg-hold-minutes lookup for the
LotteryRow `~Nmin` chip and print a TypeScript constant block suitable
for paste into `api/_lib/lottery-hold.ts`.

Same shape as scripts/recompute_silent_boom_hold_minutes.py with two
key differences:

  * lottery_finder_fires has no `score_tier` column — tier is computed
    from `score` at query time via a CASE expression matching the
    thresholds in api/_lib/lottery-score-weights.ts (tier1 >= 18,
    tier2 12-17, tier3 < 12 incl NULL).
  * Stricter override thresholds than silent-boom (n >= 50,
    |delta| >= 0.40 vs silent-boom's 30 / 0.25). Lottery has 10x the
    data density and the looser bar yielded 41 entries — too many
    to maintain by hand. See spec for the rationale.

Spec: docs/superpowers/specs/lottery-finder-avg-hold-2026-05-08.md

Usage:
    ml/.venv/bin/python scripts/recompute_lottery_hold_minutes.py
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
TICKER_OVERRIDE_MIN_N = 50
TICKER_OVERRIDE_MIN_DELTA_PCT = 0.40

TIERS = ('tier1', 'tier2', 'tier3')

# Keep these thresholds in sync with api/_lib/lottery-score-weights.ts
# (lotteryScoreTier()). NULL score coalesces to tier3.
TIER_CASE_SQL = """
  CASE
    WHEN score IS NULL THEN 'tier3'
    WHEN score >= 18 THEN 'tier1'
    WHEN score >= 12 THEN 'tier2'
    ELSE 'tier3'
  END
"""


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
    """P75 of minutes_to_peak among winners, by computed tier."""
    cur = conn.cursor()
    cur.execute(
        f"""
        SELECT {TIER_CASE_SQL} AS tier,
               percentile_cont(0.75) WITHIN GROUP (ORDER BY minutes_to_peak)
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct >= %s
        GROUP BY {TIER_CASE_SQL}
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
        f"""
        SELECT underlying_symbol,
               {TIER_CASE_SQL} AS tier,
               COUNT(*) AS n,
               percentile_cont(0.75) WITHIN GROUP (ORDER BY minutes_to_peak)
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct >= %s
        GROUP BY underlying_symbol, {TIER_CASE_SQL}
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
    cur = conn.cursor()
    cur.execute(
        """
        SELECT COUNT(*),
               MIN(date)::text,
               MAX(date)::text
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct >= %s
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
    today = date.today().isoformat()
    lines = [
        f'// Recomputed {today} from {n_winners:,} enriched lottery winners',
        f'// (peak_ceiling_pct >= {HIGH_PEAK_THRESHOLD:.0f}, '
        f'date range {min_date} -> {max_date}).',
        '// Paste into api/_lib/lottery-hold.ts.',
        '',
        '/** Tier-default P75 minutes-to-peak among winners. */',
        'const TIER_DEFAULTS: Readonly<Record<LotteryScoreTier, number>> = {',
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
        # Group entries visually by tier.
        last_tier = None
        for ticker, tier, p75, n, delta in overrides:
            if tier != last_tier:
                if last_tier is not None:
                    lines.append('')
                lines.append(f'  // {tier}')
                last_tier = tier
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
