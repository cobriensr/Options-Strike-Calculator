/**
 * flow-confluence — pair intraday retail flow with whale positioning where
 * both populations are transacting near the same strike.
 *
 * Why this exists
 * ---------------
 * Retail 0-1 DTE flow and institutional 2-7 DTE whale prints are two
 * different tapes. When they converge on the same strike level — or when
 * whales park size just outside retail's stop cluster — the combined read
 * is more interesting than either feed in isolation:
 *
 *   - aligned-call / aligned-put: both sides lean the same way, a
 *     conviction signal.
 *   - retail-call-whale-put:     retail chases upside while whales buy
 *     protection — classic institutional-hedge-while-retail-chases. This
 *     is the core use case the panel was built to surface.
 *   - retail-put-whale-call:     contrarian inversion, rare but worth a
 *     second look when it fires.
 *
 * The module is intentionally pure — no React, no fetch, no time source.
 * All tunables live in `CONFLUENCE_CONSTANTS`; callers can override via
 * the `opts` argument on `findConfluences`.
 */

import type { RankedStrike, WhaleAlert } from '../types/flow';

// ============================================================
// TUNABLES
// ============================================================

export const CONFLUENCE_CONSTANTS = {
  /**
   * SPX points window around a retail strike in which a whale strike
   * still counts as "same area". 50 pts ≈ 0.7% at 7000 spot — close
   * enough for pin pressure / hedge logic to plausibly relate.
   */
  STRIKE_PROXIMITY: 50,
  /**
   * Hard premium floor for whale alerts fed into confluence matching.
   * Even though `useWhalePositioning` can return alerts as small as
   * $500K, confluence is only interesting at genuine whale size.
   */
  MIN_WHALE_PREMIUM: 1_000_000,
  /**
   * Max matches returned from `findConfluences`. Prevents the panel from
   * overflowing on high-flow days and keeps the output focused on the
   * strongest signals.
   */
  MAX_MATCHES: 10,
} as const;

// ============================================================
// TYPES
// ============================================================

export type ConfluenceRelationship =
  | 'aligned-call'
  | 'aligned-put'
  | 'retail-call-whale-put'
  | 'retail-put-whale-call';

export interface ConfluenceMatch {
  retail_strike: number;
  retail_side: 'call' | 'put';
  retail_premium: number;
  retail_hit_count: number;
  retail_ask_side_ratio: number;
  whale_strike: number;
  whale_side: 'call' | 'put';
  whale_premium: number;
  whale_expiry: string;
  whale_dte: number;
  whale_option_chain: string;
  /** whale_strike - retail_strike (signed). */
  strike_delta: number;
  relationship: ConfluenceRelationship;
}

export interface FindConfluencesOptions {
  strikeProximity?: number;
  minWhalePremium?: number;
  maxMatches?: number;
}

// ============================================================
// RELATIONSHIP CLASSIFIER
// ============================================================

function classifyRelationship(
  retailSide: 'call' | 'put',
  whaleSide: 'call' | 'put',
): ConfluenceRelationship {
  if (retailSide === 'call' && whaleSide === 'call') return 'aligned-call';
  if (retailSide === 'put' && whaleSide === 'put') return 'aligned-put';
  if (retailSide === 'call' && whaleSide === 'put') {
    return 'retail-call-whale-put';
  }
  return 'retail-put-whale-call';
}

// ============================================================
// DEDUP KEY
// ============================================================

/**
 * Dedup key: one ConfluenceMatch per (retail strike+side, whale
 * strike+side) pair. When multiple whale alerts land on the same key
 * we keep the largest-premium one — the headline print.
 */
function pairKey(m: ConfluenceMatch): string {
  return [
    m.retail_strike,
    m.retail_side,
    m.whale_strike,
    m.whale_side,
  ].join('|');
}

// ============================================================
// MAIN
// ============================================================

/**
 * Find strikes where intraday retail flow and whale positioning
 * converge (same or nearby strike), classified by how the two sides
 * line up directionally. Returns at most `maxMatches` entries sorted
 * by retail premium desc, then strike proximity asc (tighter pair
 * wins on ties).
 */
export function findConfluences(
  retailStrikes: RankedStrike[],
  whaleAlerts: WhaleAlert[],
  opts: FindConfluencesOptions = {},
): ConfluenceMatch[] {
  const proximity = opts.strikeProximity ?? CONFLUENCE_CONSTANTS.STRIKE_PROXIMITY;
  const minWhalePrem =
    opts.minWhalePremium ?? CONFLUENCE_CONSTANTS.MIN_WHALE_PREMIUM;
  const maxMatches = opts.maxMatches ?? CONFLUENCE_CONSTANTS.MAX_MATCHES;

  if (retailStrikes.length === 0 || whaleAlerts.length === 0) return [];

  // Filter whale alerts up front — cheaper than re-checking inside the
  // O(N*M) loop below.
  const qualifyingWhales = whaleAlerts.filter(
    (w) => w.total_premium >= minWhalePrem,
  );
  if (qualifyingWhales.length === 0) return [];

  // Build all candidate pairs. Dedup by pairKey keeping the largest
  // whale premium per (retail, whale-strike-side) pair.
  const bestByPair = new Map<string, ConfluenceMatch>();

  for (const retail of retailStrikes) {
    for (const whale of qualifyingWhales) {
      const delta = whale.strike - retail.strike;
      if (Math.abs(delta) > proximity) continue;

      const candidate: ConfluenceMatch = {
        retail_strike: retail.strike,
        retail_side: retail.type,
        retail_premium: retail.total_premium,
        retail_hit_count: retail.hit_count,
        retail_ask_side_ratio: retail.ask_side_ratio,
        whale_strike: whale.strike,
        whale_side: whale.type,
        whale_premium: whale.total_premium,
        whale_expiry: whale.expiry,
        whale_dte: whale.dte_at_alert,
        whale_option_chain: whale.option_chain,
        strike_delta: delta,
        relationship: classifyRelationship(retail.type, whale.type),
      };

      const key = pairKey(candidate);
      const prior = bestByPair.get(key);
      if (!prior || candidate.whale_premium > prior.whale_premium) {
        bestByPair.set(key, candidate);
      }
    }
  }

  const matches = Array.from(bestByPair.values());

  // Sort: retail premium desc; on ties, tighter proximity wins.
  matches.sort((a, b) => {
    if (a.retail_premium !== b.retail_premium) {
      return b.retail_premium - a.retail_premium;
    }
    return Math.abs(a.strike_delta) - Math.abs(b.strike_delta);
  });

  return matches.slice(0, maxMatches);
}
