import { describe, it, expect } from 'vitest';

import { GEXBOT_TICKER_ORDER } from '../components/Gexbot/ticker-order';

describe('GEXBOT_TICKER_ORDER', () => {
  it('contains exactly 16 tickers', () => {
    expect(GEXBOT_TICKER_ORDER).toHaveLength(16);
  });

  it('matches the backend GEXBOT_TICKERS list (drift guard)', () => {
    // Hardcoded mirror of GEXBOT_TICKERS in api/_lib/gexbot-client.ts.
    // If these two lists drift apart, the frontend renders a different
    // ticker set than the capture crons populate — a silent bug.
    const expected = [
      // Indexes
      'SPX',
      'ES_SPX',
      'NDX',
      'NQ_NDX',
      'RUT',
      'VIX',
      // ETFs
      'SPY',
      'QQQ',
      'IWM',
      'TLT',
      'GLD',
      'USO',
      'TQQQ',
      'UVXY',
      'HYG',
      'SLV',
    ];
    expect([...GEXBOT_TICKER_ORDER]).toEqual(expected);
  });

  it('places indexes before ETFs (display convention)', () => {
    const indexes = ['SPX', 'ES_SPX', 'NDX', 'NQ_NDX', 'RUT', 'VIX'];
    const firstEtfIdx = GEXBOT_TICKER_ORDER.indexOf('SPY');
    for (const idx of indexes) {
      expect(GEXBOT_TICKER_ORDER.indexOf(idx)).toBeLessThan(firstEtfIdx);
    }
  });

  it('has no duplicate tickers', () => {
    const set = new Set<string>(GEXBOT_TICKER_ORDER);
    expect(set.size).toBe(GEXBOT_TICKER_ORDER.length);
  });
});
