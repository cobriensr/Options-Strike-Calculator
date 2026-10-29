import type { MaxchangeWinnerRow } from '../../hooks/useGexbotData';

/**
 * Shared test factory for MaxchangeWinnerRow rows. Used by both the
 * StrikeMoverLadder component tests and the aggregation pipeline tests.
 * `endpoint` is the GEXBot model: 'classic' or 'state'.
 */
export function makeWinner(
  ticker: string,
  category: string,
  strike: number,
  change: number,
  endpoint: 'classic' | 'state' = 'classic',
): MaxchangeWinnerRow {
  return {
    ticker,
    endpoint,
    category,
    capturedAt: '2026-05-19T17:00:00Z',
    windows: {
      current: null,
      one: null,
      five: [strike, change],
      ten: null,
      fifteen: null,
      thirty: null,
    },
  };
}
