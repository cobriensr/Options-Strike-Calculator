import { describe, it, expect } from 'vitest';

import {
  GEXBOT_FUTURES_VIEWS,
  GEXBOT_TICKER_ORDER,
  GEXBOT_UNDERLYING_ORDER,
} from '../components/Gexbot/ticker-order';

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
    const indexes = ['SPX', 'ES_SPX', 'NDX', 'NQ_NDX', 'RUT', 'VIX'] as const;
    const firstEtfIdx = GEXBOT_TICKER_ORDER.indexOf('SPY');
    for (const idx of indexes) {
      expect(GEXBOT_TICKER_ORDER.indexOf(idx)).toBeLessThan(firstEtfIdx);
    }
  });

  it('has no duplicate tickers', () => {
    const set = new Set<string>(GEXBOT_TICKER_ORDER);
    expect(set.size).toBe(GEXBOT_TICKER_ORDER.length);
  });

  it('names ES_SPX and NQ_NDX as futures views of SPX and NDX', () => {
    expect([...GEXBOT_FUTURES_VIEWS]).toEqual(['ES_SPX', 'NQ_NDX']);
  });

  it('GEXBOT_UNDERLYING_ORDER is the 14 distinct underlyings, same order', () => {
    expect(GEXBOT_UNDERLYING_ORDER).toHaveLength(14);
    expect([...GEXBOT_UNDERLYING_ORDER]).not.toContain('ES_SPX');
    expect([...GEXBOT_UNDERLYING_ORDER]).not.toContain('NQ_NDX');
    expect([...GEXBOT_UNDERLYING_ORDER]).toEqual(
      GEXBOT_TICKER_ORDER.filter((t) => t !== 'ES_SPX' && t !== 'NQ_NDX'),
    );
  });
});
