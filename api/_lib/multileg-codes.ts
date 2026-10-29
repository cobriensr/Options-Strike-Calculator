/**
 * Single source of truth for which OPRA trade codes mark an option print as
 * a leg of a larger order. Source: OPRA Pillar output spec, verified against
 * live ws_option_trades data (`raw_payload->>'trade_code'`).
 *
 * `mfto` is NOT an OPRA code and must not be added here.
 */
import type { AnchorLegKind } from '../../src/types/spread-legs.js';

/** Multi-leg sale conditions (option legs against other option legs). */
export const MULTI_LEG_TRADE_CODES: readonly string[] = [
  'mlat',
  'mlet',
  'mlft',
  'masl',
  'mesl',
  'mfsl',
  'mlct',
  'cbmo',
  // Per the OPRA Pillar output spec, MCTP is an "execution in a proprietary
  // product done as part of a multilateral compression. Trades are executed
  // outside of regular trading hours at prices derived from end of day
  // markets." So it cannot anchor an intraday fire; listed because it is a
  // multi-leg code.
  'mctp',
];

/** Option legs of a stock+option order (kept apart from multi-leg). */
export const STOCK_TIED_TRADE_CODES: readonly string[] = [
  'tlet',
  'tlat',
  'tlft',
  'tlct',
  'tesl',
  'tasl',
  'tfsl',
];

/** null/empty → null (no code reported); unlisted → 'single'. */
export function legKindForTradeCode(
  code: string | null | undefined,
): AnchorLegKind | null {
  if (code == null || code === '') return null;
  const lower = code.toLowerCase();
  if (MULTI_LEG_TRADE_CODES.includes(lower)) return 'multi_leg';
  if (STOCK_TIED_TRADE_CODES.includes(lower)) return 'stock_tied';
  return 'single';
}
