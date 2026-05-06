#!/usr/bin/env python
"""Sync ml/data/lottery_score_weights.json into the TS mirror.

`api/_lib/lottery-score-weights.ts` is the runtime source of truth for
detect-lottery-fires.ts. This script keeps the two in lockstep after a
refit. Reads the JSON, regenerates the TS file. Idempotent.

Usage:
    ml/.venv/bin/python scripts/sync_lottery_score_weights.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / 'ml' / 'data' / 'lottery_score_weights.json'
TS_PATH = ROOT / 'api' / '_lib' / 'lottery-score-weights.ts'


def render_ts(weights: dict) -> str:
    ticker_lines = [
        f'  {k}: {v},' for k, v in weights['ticker'].items()
    ]
    price_pairs = ', '.join(
        f'[{t}, {p}]' for t, p in weights['price']['thresholds']
    )
    return f'''/**
 * Lottery fire score weights — derived from a rolling historical window
 * by `ml/src/lottery_scoring.py` and frozen as a TypeScript constant.
 * Source-of-truth is `ml/data/lottery_score_weights.json`; this module
 * mirrors that file inline so the cron handler doesn't touch the
 * filesystem at runtime.
 *
 * Regenerate via `make refit` (which runs the refit + this sync script
 * + a score backfill). Do NOT hand-edit — changes will be lost on the
 * next refit.
 *
 * Score formula (sum of buckets, range 0-25):
 *   ticker (0/5/7/10) + mode (0/5) + price (0/3/5) + tod (0/2/3) + option_type (0/2)
 *
 * Tier cutoffs (validated by `lottery_score_distribution.json`):
 *   Tier 1 — score ≥18 (~80% high-peak rate, ~4 fires/day)
 *   Tier 2 — 12 ≤ score < 18 (~63% high-peak rate, ~84 fires/day)
 *   Tier 3 — score < 12 (~32% high-peak rate, the remainder)
 */

import type {{ LotteryMode, TimeOfDay }} from './lottery-finder.js';

export const LOTTERY_TICKER_WEIGHTS: Readonly<Record<string, number>> = {{
{chr(10).join(ticker_lines)}
}};

/** ($ entry price ≤ threshold → points). Evaluated in order; first match wins. */
export const LOTTERY_PRICE_THRESHOLDS: ReadonlyArray<
  readonly [number, number]
> = [{price_pairs}];

const MODE_WEIGHTS: Readonly<Record<LotteryMode, number>> = {{
  A_intraday_0DTE: {weights['mode']['0DTE']},
  B_multi_day_DTE1_3: {weights['mode']['multi-day']},
  OUT_OF_UNIVERSE: 0,
}};

const TOD_WEIGHTS: Readonly<Record<TimeOfDay, number>> = {{
  AM_open: {weights['tod']['AM_open']},
  MID: {weights['tod']['MID']},
  LUNCH: {weights['tod']['LUNCH']},
  PM: {weights['tod']['PM']},
}};

/** Score → tier label used for badges and the peak-forecast string. */
export type LotteryScoreTier = 'tier1' | 'tier2' | 'tier3';

export const LOTTERY_TIER_THRESHOLDS = {{
  tier1MinScore: 18,
  tier2MinScore: 12,
}} as const;

export function lotteryScoreTier(score: number | null): LotteryScoreTier {{
  if (score == null) return 'tier3';
  if (score >= LOTTERY_TIER_THRESHOLDS.tier1MinScore) return 'tier1';
  if (score >= LOTTERY_TIER_THRESHOLDS.tier2MinScore) return 'tier2';
  return 'tier3';
}}

/**
 * Compute the integer score for a fire. Returns `null` when any input
 * needed to score deterministically is missing (caller should treat
 * null as Tier 3 in the UI but still surface the fire).
 */
export function computeLotteryScore(args: {{
  ticker: string;
  mode: LotteryMode;
  entryPrice: number;
  tod: TimeOfDay;
  optionType: 'C' | 'P';
}}): number {{
  const {{ ticker, mode, entryPrice, tod, optionType }} = args;
  let score = 0;
  score += LOTTERY_TICKER_WEIGHTS[ticker] ?? 0;
  score += MODE_WEIGHTS[mode] ?? 0;
  for (const [threshold, points] of LOTTERY_PRICE_THRESHOLDS) {{
    if (entryPrice <= threshold) {{
      score += points;
      break;
    }}
  }}
  score += TOD_WEIGHTS[tod] ?? 0;
  if (optionType === 'C') score += {weights['option_type']['call']};
  return score;
}}
'''


def main() -> None:
    if not JSON_PATH.exists():
        sys.exit(f'Missing weights JSON: {JSON_PATH}')
    weights = json.loads(JSON_PATH.read_text())

    rendered = render_ts(weights)
    TS_PATH.write_text(rendered)
    print(f'[sync] wrote {TS_PATH}')
    print(f'[sync] tickers: {len(weights["ticker"])}')


if __name__ == '__main__':
    main()
