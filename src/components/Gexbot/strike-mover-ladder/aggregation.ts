/**
 * Cross-asset aggregation for the StrikeMoverLadder.
 *
 * Input:  raw MaxchangeWinnerRow[] from `useGexbotData({view:'maxchange-winners'})`.
 * Output: AggregatedRow[] anchored on SPX-equivalent strikes, with
 *         symbol dots and a 2✓ confirmation badge (SPX + SPY).
 *
 * Pipeline:
 *   1. Filter to {SPX, SPY} × the selected model (classic | state) × 0DTE
 *      GEX. ES_SPX and NQ_NDX are not plotted: they are the SPX / NDX chains
 *      shifted to futures levels, so they would plot phantom rows and
 *      double-count an underlying as confirmation.
 *   2. Convert SPY strikes to SPX-equivalent (× 10).
 *   3. Bin to nearest-5 SPX-equivalent strike; merge adjacent bins
 *      within ±CROSS_ASSET_TOLERANCE_PTS into one row.
 *   4. Compute confirmCount (sign agreement among distinct underlyings).
 *   5. Mark the largest |Δ| row.
 *
 * Spec: docs/superpowers/specs/strike-mover-ladder-2026-05-19.md is
 * SUPERSEDED by P6 of docs/superpowers/specs/gexbot-refresh-2026-10-28.md
 * (two model tabs; the 05-19 spec describes the retired five-tab design).
 */

import type { MaxchangeWinnerRow } from '../../../hooks/useGexbotData';
import {
  NEAR_SPOT_BAND_BPS,
  CROSS_ASSET_TOLERANCE_PTS,
  LADDER_CATEGORY,
  MAX_ROWS_PER_SIDE,
  SPY_TO_SPX_RATIO,
  type AggregatedRow,
  type LadderSymbol,
  type ModelTab,
} from './types';

const TICKER_TO_SYMBOL: Record<string, LadderSymbol | undefined> = {
  SPX: 'SPX',
  SPY: 'SPY',
};

const SYMBOL_DISPLAY_ORDER: readonly LadderSymbol[] = ['SPX', 'SPY'];

interface WinnerSample {
  symbol: LadderSymbol;
  /** SPX-equivalent strike (SPY × 10 applied). */
  strikeSpx: number;
  change: number;
}

function toSpxStrike(symbol: LadderSymbol, strike: number): number {
  return symbol === 'SPY' ? strike * SPY_TO_SPX_RATIO : strike;
}

function roundToNearest5(n: number): number {
  return Math.round(n / 5) * 5;
}

function filterWinners(
  rows: MaxchangeWinnerRow[],
  model: ModelTab,
): WinnerSample[] {
  const samples: WinnerSample[] = [];
  for (const r of rows) {
    if (r.endpoint !== model || r.category !== LADDER_CATEGORY) continue;
    const symbol = TICKER_TO_SYMBOL[r.ticker];
    if (!symbol) continue;
    const five = r.windows.five;
    if (!five) continue;
    const [strike, change] = five;
    if (change === 0) continue;
    samples.push({
      symbol,
      strikeSpx: toSpxStrike(symbol, strike),
      change,
    });
  }
  return samples;
}

export function buildLadderRows(
  rows: MaxchangeWinnerRow[],
  model: ModelTab,
): AggregatedRow[] {
  const samples = filterWinners(rows, model);
  if (samples.length === 0) return [];

  // Bin by SPX-equivalent strike, rounded to nearest 5.
  const bins = new Map<number, WinnerSample[]>();
  for (const s of samples) {
    const key = roundToNearest5(s.strikeSpx);
    const bucket = bins.get(key) ?? [];
    bucket.push(s);
    bins.set(key, bucket);
  }

  // Merge adjacent bins whose centers are within tolerance. Walk in
  // sorted order; if the next key is within ±tolerance of the active
  // bucket key, fold it in. Otherwise it becomes a new active bucket.
  const orderedKeys = [...bins.keys()].sort((a, b) => a - b);
  const merged = new Map<number, WinnerSample[]>();
  let activeKey: number | null = null;
  // Trailing edge of the active bucket — compare against this, not the
  // bucket's anchor key. Otherwise three bins each exactly within
  // tolerance pairwise (e.g. 6745/6750/6755 at tolerance 5) fail to
  // coalesce because the third compares against the original anchor.
  let maxKeyInBucket: number | null = null;
  for (const key of orderedKeys) {
    if (
      activeKey !== null &&
      maxKeyInBucket !== null &&
      key - maxKeyInBucket <= CROSS_ASSET_TOLERANCE_PTS
    ) {
      const existingBucket = merged.get(activeKey);
      if (existingBucket) {
        const incoming = bins.get(key) ?? [];
        existingBucket.push(...incoming);
      }
      maxKeyInBucket = key;
    } else {
      merged.set(key, [...(bins.get(key) ?? [])]);
      activeKey = key;
      maxKeyInBucket = key;
    }
  }

  const out: AggregatedRow[] = [];
  for (const [strike, bucket] of merged) {
    const spx = bucket.find((b) => b.symbol === 'SPX');
    const canonical = spx ?? bucket[0]!;

    const presentSet = new Set(bucket.map((b) => b.symbol));
    const symbols = SYMBOL_DISPLAY_ORDER.filter((s) => presentSet.has(s));

    const canonicalSign = Math.sign(canonical.change);
    const allAgree = bucket.every((b) => Math.sign(b.change) === canonicalSign);
    const confirmCount: 0 | 2 = allAgree && symbols.length >= 2 ? 2 : 0;

    out.push({
      strike,
      change: canonical.change,
      symbols,
      confirmCount,
      isLargestMover: false,
    });
  }

  // Mark the largest mover by |change|. Strict `>` means ties resolve
  // to the first row encountered (Map insertion order = sorted-strike
  // order from the merge loop above). Display-only signal, so the
  // tie-break choice is not load-bearing.
  let maxAbs = 0;
  let maxIdx = -1;
  for (let i = 0; i < out.length; i++) {
    const abs = Math.abs(out[i]!.change);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxIdx = i;
    }
  }
  if (maxIdx >= 0) out[maxIdx]!.isLargestMover = true;

  return out;
}

/**
 * Split rows into above-spot / near-spot / below-spot, cap each side at MAX_ROWS_PER_SIDE
 * (preferring proximity to spot), then re-sort the visible set by
 * strike descending for top-to-bottom display.
 */
export function sortAndCapRows(
  rows: AggregatedRow[],
  spot: number,
): AggregatedRow[] {
  const bandWidth = spot * (NEAR_SPOT_BAND_BPS / 10_000);
  const above: AggregatedRow[] = [];
  const below: AggregatedRow[] = [];
  const atm: AggregatedRow[] = [];
  for (const r of rows) {
    const dist = Math.abs(r.strike - spot);
    if (dist <= bandWidth) atm.push(r);
    else if (r.strike > spot) above.push(r);
    else below.push(r);
  }

  above.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  below.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  atm.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const trimmedAbove = above.slice(0, MAX_ROWS_PER_SIDE);
  const trimmedBelow = below.slice(0, MAX_ROWS_PER_SIDE);
  // Cap ATM at the same per-side budget. With NEAR_SPOT_BAND_BPS = 25 (±0.25%
  // of spot) and 5-pt SPX strikes, only ~6 strikes can land in the band
  // at any time, but capping keeps the contract symmetric with the
  // above/below sides and prevents pathological inputs from blowing
  // up the visible row count.
  const trimmedAtm = atm.slice(0, MAX_ROWS_PER_SIDE);

  const all = [...trimmedAbove, ...trimmedAtm, ...trimmedBelow];
  all.sort((a, b) => b.strike - a.strike);
  return all;
}
