// @vitest-environment node

/**
 * Unit tests for api/_lib/validation/market-data.ts.
 *
 * Covers 7 of its UW / market-flow query schemas plus boundary cases on
 * the bounded fields (ticker enum membership, datetime offset
 * requirement, the strike-trade-volume single-key refinement), and the
 * /api/events start-date schema.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  zeroGammaQuerySchema,
  greekFlowQuerySchema,
  gexStrikeExpiryQuerySchema,
  dealerRegimeQuerySchema,
  strikeTradeVolumeQuerySchema,
  netFlowHistoryQuerySchema,
  tickerCandlesQuerySchema,
  eventsQuerySchema,
} from '../../_lib/validation/market-data.js';

// ── zeroGammaQuerySchema ─────────────────────────────────────

describe('zeroGammaQuerySchema', () => {
  it('parses valid input with no fields (both optional)', () => {
    const result = zeroGammaQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('parses valid ticker+date', () => {
    const result = zeroGammaQuerySchema.safeParse({
      ticker: 'SPX',
      date: '2026-05-10',
    });
    expect(result.success).toBe(true);
  });

  it('rejects lowercase ticker', () => {
    const result = zeroGammaQuerySchema.safeParse({ ticker: 'spx' });
    expect(result.success).toBe(false);
  });

  it('rejects ticker > 5 chars (boundary)', () => {
    const result = zeroGammaQuerySchema.safeParse({ ticker: 'TOOLONG' });
    expect(result.success).toBe(false);
  });
});

// ── greekFlowQuerySchema ─────────────────────────────────────

describe('greekFlowQuerySchema', () => {
  it('parses valid input with default scope=0dte', () => {
    const result = greekFlowQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.scope).toBe('0dte');
  });

  it('accepts scope=all', () => {
    const result = greekFlowQuerySchema.safeParse({ scope: 'all' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.scope).toBe('all');
  });

  it('rejects unknown scope enum value', () => {
    const result = greekFlowQuerySchema.safeParse({ scope: 'weekly' });
    expect(result.success).toBe(false);
  });
});

// ── gexStrikeExpiryQuerySchema ───────────────────────────────

describe('gexStrikeExpiryQuerySchema', () => {
  it('parses valid input', () => {
    const result = gexStrikeExpiryQuerySchema.safeParse({
      ticker: 'SPX',
      expiry: '2026-05-10',
    });
    expect(result.success).toBe(true);
  });

  it('accepts at as ISO datetime with offset', () => {
    const result = gexStrikeExpiryQuerySchema.safeParse({
      ticker: 'SPY',
      expiry: '2026-05-10',
      at: '2026-05-10T13:30:00-04:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing ticker', () => {
    const result = gexStrikeExpiryQuerySchema.safeParse({
      expiry: '2026-05-10',
    });
    expect(result.success).toBe(false);
  });

  it('rejects ticker not in enum', () => {
    const result = gexStrikeExpiryQuerySchema.safeParse({
      ticker: 'IWM',
      expiry: '2026-05-10',
    });
    expect(result.success).toBe(false);
  });

  it('rejects ISO datetime without offset (boundary)', () => {
    const result = gexStrikeExpiryQuerySchema.safeParse({
      ticker: 'SPX',
      expiry: '2026-05-10',
      at: '2026-05-10T13:30:00',
    });
    expect(result.success).toBe(false);
  });
});

// ── dealerRegimeQuerySchema ──────────────────────────────────

describe('dealerRegimeQuerySchema', () => {
  it('parses empty object (both optional)', () => {
    const result = dealerRegimeQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('parses valid date+at', () => {
    const result = dealerRegimeQuerySchema.safeParse({
      date: '2026-05-10',
      at: '2026-05-10T15:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown extra keys (strict)', () => {
    const result = dealerRegimeQuerySchema.safeParse({
      date: '2026-05-10',
      ticker: 'SPX',
    });
    expect(result.success).toBe(false);
  });
});

// ── strikeTradeVolumeQuerySchema ─────────────────────────────

describe('strikeTradeVolumeQuerySchema', () => {
  it('parses bulk mode (ticker + since only)', () => {
    const result = strikeTradeVolumeQuerySchema.safeParse({
      ticker: 'SPY',
      since: '2026-05-10T13:30:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('parses single-key mode (ticker + since + strike + side)', () => {
    const result = strikeTradeVolumeQuerySchema.safeParse({
      ticker: 'SPY',
      since: '2026-05-10T13:30:00Z',
      strike: 600,
      side: 'call',
    });
    expect(result.success).toBe(true);
  });

  it('rejects partial single-key mode (strike without side)', () => {
    const result = strikeTradeVolumeQuerySchema.safeParse({
      ticker: 'SPY',
      since: '2026-05-10T13:30:00Z',
      strike: 600,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['strike']);
      expect(issue?.message).toBe(
        'strike + side must both be present for single-key mode',
      );
    }
  });

  it('rejects ticker outside STRIKE_IV_TICKERS', () => {
    const result = strikeTradeVolumeQuerySchema.safeParse({
      ticker: 'XLE',
      since: '2026-05-10T13:30:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing since', () => {
    const result = strikeTradeVolumeQuerySchema.safeParse({ ticker: 'SPY' });
    expect(result.success).toBe(false);
  });
});

// ── netFlowHistoryQuerySchema ────────────────────────────────

describe('netFlowHistoryQuerySchema', () => {
  it('parses valid input', () => {
    const result = netFlowHistoryQuerySchema.safeParse({ ticker: 'SPY' });
    expect(result.success).toBe(true);
  });

  it('parses with date + HH:MM bounds', () => {
    const result = netFlowHistoryQuerySchema.safeParse({
      ticker: 'SPY',
      date: '2026-05-10',
      from: '08:30',
      to: '15:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects ticker longer than 8 chars (boundary)', () => {
    const result = netFlowHistoryQuerySchema.safeParse({
      ticker: 'TOOLONGTICKER',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed HH:MM from', () => {
    const result = netFlowHistoryQuerySchema.safeParse({
      ticker: 'SPY',
      from: '830',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing ticker', () => {
    const result = netFlowHistoryQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── tickerCandlesQuerySchema ─────────────────────────────────

describe('tickerCandlesQuerySchema', () => {
  it('parses valid input', () => {
    const result = tickerCandlesQuerySchema.safeParse({ ticker: 'SPY' });
    expect(result.success).toBe(true);
  });

  it('parses with optional date', () => {
    const result = tickerCandlesQuerySchema.safeParse({
      ticker: 'SPY',
      date: '2026-05-10',
    });
    expect(result.success).toBe(true);
  });

  it('rejects lowercase ticker', () => {
    const result = tickerCandlesQuerySchema.safeParse({ ticker: 'spy' });
    expect(result.success).toBe(false);
  });

  it('rejects missing ticker', () => {
    const result = tickerCandlesQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── eventsQuerySchema ────────────────────────────────────────

describe('eventsQuerySchema', () => {
  // 2026-11-12 13:00 ET. today + 90 days is 2027-02-10.
  const NOW = new Date('2026-11-12T18:00:00Z');

  afterEach(() => {
    vi.useRealTimers();
  });

  function fromMessage(from: unknown): string | undefined {
    vi.useFakeTimers({ now: NOW });
    const result = eventsQuerySchema.safeParse({ from });
    return result.success ? undefined : result.error.issues[0]?.message;
  }

  it('parses an empty query (from is optional)', () => {
    const result = eventsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.from).toBeUndefined();
  });

  it('parses a past date and ignores the days param', () => {
    vi.useFakeTimers({ now: NOW });
    const result = eventsQuerySchema.safeParse({
      from: '2026-04-29',
      days: '1',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.from).toBe('2026-04-29');
  });

  it('accepts the lower bound 2025-01-01 and rejects the day before', () => {
    expect(fromMessage('2025-01-01')).toBeUndefined();
    expect(fromMessage('2024-12-31')).toBe('from must be 2025-01-01 or later');
  });

  it('accepts today + 90 days and rejects today + 91', () => {
    expect(fromMessage('2027-02-10')).toBeUndefined();
    expect(fromMessage('2027-02-11')).toBe(
      'from must be no more than 90 days after today',
    );
  });

  it('measures the upper bound from the ET date, not the UTC date', () => {
    // 22:00 ET on 11-12 is already 11-13 in UTC; the bound stays 2027-02-10.
    vi.useFakeTimers({ now: new Date('2026-11-13T03:00:00Z') });
    expect(eventsQuerySchema.safeParse({ from: '2027-02-10' }).success).toBe(
      true,
    );
    expect(eventsQuerySchema.safeParse({ from: '2027-02-11' }).success).toBe(
      false,
    );
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10'])(
    'rejects the impossible calendar date %s',
    (from) => {
      expect(fromMessage(from)).toBe('from must be a real date, YYYY-MM-DD');
    },
  );

  it.each(['abc', '', '2026-4-29', '20260429', '2026-04-29T12:00:00Z'])(
    'rejects the malformed value %j',
    (from) => {
      expect(fromMessage(from)).toBe('from must be a real date, YYYY-MM-DD');
    },
  );

  it('rejects a repeated from (array) and a non-string from', () => {
    expect(fromMessage(['2026-04-29', '2026-04-30'])).toBe(
      'from must be a real date, YYYY-MM-DD',
    );
    expect(fromMessage(20260429)).toBe('from must be a real date, YYYY-MM-DD');
  });
});
