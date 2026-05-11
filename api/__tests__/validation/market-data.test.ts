// @vitest-environment node

/**
 * Unit tests for api/_lib/validation/market-data.ts.
 *
 * Covers the 9 UW / market-flow query schemas plus boundary cases on
 * the bounded fields (ticker enum membership, limit caps, datetime
 * offset requirement, history-mode refinements).
 */

import { describe, it, expect } from 'vitest';
import {
  zeroGammaQuerySchema,
  greekFlowQuerySchema,
  gexStrikeExpiryQuerySchema,
  dealerRegimeQuerySchema,
  ivAnomaliesQuerySchema,
  strikeTradeVolumeQuerySchema,
  ivAnomaliesCrossAssetBodySchema,
  netFlowHistoryQuerySchema,
  tickerCandlesQuerySchema,
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

// ── ivAnomaliesQuerySchema ───────────────────────────────────

describe('ivAnomaliesQuerySchema', () => {
  it('parses list mode (no strike/side/expiry)', () => {
    const result = ivAnomaliesQuerySchema.safeParse({ ticker: 'SPY' });
    expect(result.success).toBe(true);
  });

  it('parses history mode (all four fields present)', () => {
    const result = ivAnomaliesQuerySchema.safeParse({
      ticker: 'SPY',
      strike: 600,
      side: 'call',
      expiry: '2026-05-10',
    });
    expect(result.success).toBe(true);
  });

  it('rejects partial history mode (missing expiry)', () => {
    const result = ivAnomaliesQuerySchema.safeParse({
      ticker: 'SPY',
      strike: 600,
      side: 'call',
    });
    expect(result.success).toBe(false);
  });

  it('rejects history mode without ticker', () => {
    const result = ivAnomaliesQuerySchema.safeParse({
      strike: 600,
      side: 'call',
      expiry: '2026-05-10',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Note: the refine declares `path: ['strike']` even when the
      // missing field is `ticker`. This is intentional in the original
      // schema — the refine attaches the error to the canonical
      // "history mode" field rather than the absent one — but worth
      // pinning so any future schema change surfaces it explicitly.
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['strike']);
      expect(issue?.message).toBe(
        'strike+side+expiry+ticker must all be present for per-strike history',
      );
    }
  });

  it('rejects limit > 500 (boundary)', () => {
    const result = ivAnomaliesQuerySchema.safeParse({ limit: 501 });
    expect(result.success).toBe(false);
  });

  it('rejects ticker outside STRIKE_IV_TICKERS', () => {
    const result = ivAnomaliesQuerySchema.safeParse({ ticker: 'XLE' });
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

// ── ivAnomaliesCrossAssetBodySchema ──────────────────────────

describe('ivAnomaliesCrossAssetBodySchema', () => {
  const validKey = {
    ticker: 'SPY' as const,
    strike: 600,
    side: 'call' as const,
    expiry: '2026-05-10',
    alertTs: '2026-05-10T13:30:00Z',
  };

  it('parses 1-key payload', () => {
    const result = ivAnomaliesCrossAssetBodySchema.safeParse({
      keys: [validKey],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty keys array (boundary)', () => {
    const result = ivAnomaliesCrossAssetBodySchema.safeParse({ keys: [] });
    expect(result.success).toBe(false);
  });

  it('rejects > 200 keys (boundary)', () => {
    const result = ivAnomaliesCrossAssetBodySchema.safeParse({
      keys: Array.from({ length: 201 }, () => validKey),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid side value', () => {
    const result = ivAnomaliesCrossAssetBodySchema.safeParse({
      keys: [{ ...validKey, side: 'long' }],
    });
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
