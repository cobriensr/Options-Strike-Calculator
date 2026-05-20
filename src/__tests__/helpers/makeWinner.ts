import type { MaxchangeWinnerRow } from '../../hooks/useGexbotData';

/**
 * Shared test factory for MaxchangeWinnerRow rows. Used by both the
 * StrikeMoverLadder component tests and the aggregation pipeline tests.
 */
export function makeWinner(
  ticker: string,
  category: string,
  strike: number,
  change: number,
): MaxchangeWinnerRow {
  return {
    ticker,
    endpoint: `/foo/${ticker}`,
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
