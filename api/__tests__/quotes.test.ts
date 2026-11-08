// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

import handler from '../quotes.js';
import {
  guardOwnerOrGuestEndpoint,
  schwabFetch,
  isMarketOpen,
} from '../_lib/api-helpers.js';

function makeSchwabQuote(overrides: Partial<Record<string, number>> = {}) {
  return {
    quote: {
      lastPrice: overrides.lastPrice ?? 500,
      openPrice: overrides.openPrice ?? 498,
      highPrice: overrides.highPrice ?? 502,
      lowPrice: overrides.lowPrice ?? 497,
      closePrice: overrides.closePrice ?? 499,
      netChange: overrides.netChange ?? 1.5,
      netPercentChange: overrides.netPercentChange ?? 0.3,
      tradeTime: overrides.tradeTime ?? Date.now(),
    },
  };
}

describe('GET /api/quotes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 for non-owner (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(401);
  });

  it('returns quote data for all symbols', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        SPY: makeSchwabQuote({ lastPrice: 550 }),
        $SPX: makeSchwabQuote({ lastPrice: 5500 }),
        $VIX: makeSchwabQuote({ lastPrice: 18 }),
        $VIX1D: makeSchwabQuote({ lastPrice: 15 }),
        $VIX9D: makeSchwabQuote({ lastPrice: 17 }),
        $VVIX: makeSchwabQuote({ lastPrice: 90 }),
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.marketOpen).toBe(true);
    expect(json.asOf).toBeDefined();
    expect((json.spy as { price: number }).price).toBe(550);
    expect((json.spx as { price: number }).price).toBe(5500);
    expect((json.vix as { price: number }).price).toBe(18);
    expect((json.vix1d as { price: number }).price).toBe(15);
    expect((json.vix9d as { price: number }).price).toBe(17);
    expect((json.vvix as { price: number }).price).toBe(90);
  });

  it('returns null for missing symbols', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        SPY: makeSchwabQuote(),
        // Other symbols missing
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.spy).not.toBeNull();
    expect(json.spx).toBeNull();
    expect(json.vix).toBeNull();
  });

  describe('quotedAt (Schwab tradeTime, epoch ms)', () => {
    // 2026-11-06 21:37:09.801Z, the $SPX tradeTime a live probe returned.
    const SPX_TRADE_TIME = 1794001029801;
    const VIX_TRADE_TIME = 1793999701329;

    async function getQuotes(spxQuote: unknown) {
      vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
      vi.mocked(isMarketOpen).mockReturnValue(true);
      vi.mocked(schwabFetch).mockResolvedValue({
        ok: true,
        data: {
          SPY: makeSchwabQuote({ lastPrice: 550 }),
          $SPX: spxQuote,
          $VIX: makeSchwabQuote({ lastPrice: 18, tradeTime: VIX_TRADE_TIME }),
          $VIX1D: makeSchwabQuote({ tradeTime: VIX_TRADE_TIME }),
          $VIX9D: makeSchwabQuote({ tradeTime: VIX_TRADE_TIME }),
          $VVIX: makeSchwabQuote({ tradeTime: VIX_TRADE_TIME }),
        },
      } as never);
      const res = mockResponse();
      await handler(mockRequest(), res);
      expect(res._status).toBe(200);
      return res._json as Record<
        string,
        { price: number; quotedAt: number | null }
      >;
    }

    it('copies tradeTime to quotedAt on every slice, price fields unchanged', async () => {
      const json = await getQuotes(
        makeSchwabQuote({ lastPrice: 7416, tradeTime: SPX_TRADE_TIME }),
      );
      expect(json.spx).toEqual({
        price: 7416,
        open: 498,
        high: 502,
        low: 497,
        prevClose: 499,
        change: 1.5,
        changePct: 0.3,
        quotedAt: SPX_TRADE_TIME,
      });
      expect(json.vix?.quotedAt).toBe(VIX_TRADE_TIME);
      expect(json.vix1d?.quotedAt).toBe(VIX_TRADE_TIME);
      expect(json.vix9d?.quotedAt).toBe(VIX_TRADE_TIME);
      expect(json.vvix?.quotedAt).toBe(VIX_TRADE_TIME);
    });

    function quoteWith(tradeTime: unknown) {
      const q = makeSchwabQuote();
      return { quote: { ...q.quote, tradeTime } };
    }

    it('is null when Schwab omits tradeTime', async () => {
      const quote: Partial<ReturnType<typeof makeSchwabQuote>['quote']> = {
        ...makeSchwabQuote().quote,
      };
      delete quote.tradeTime;
      const json = await getQuotes({ quote });
      expect(json.spx?.quotedAt).toBeNull();
    });

    it.each([
      ['a string', '1794001029801'],
      ['zero', 0],
      ['a negative number', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['null', null],
      // The snapshot schema takes a safe integer only (z.number().int()), so
      // anything else would 400 the whole live POST and lose the slot.
      ['a fraction', 1794001029801.5],
      ['2^53, the first unsafe integer', 2 ** 53],
      ['1e21', 1e21],
    ])('is null when tradeTime is %s', async (_label, tradeTime) => {
      const json = await getQuotes(quoteWith(tradeTime));
      expect(json.spx?.quotedAt).toBeNull();
      // A bad time never drops the quote itself.
      expect(json.spx?.price).toBe(500);
    });

    it('keeps the largest safe integer', async () => {
      const json = await getQuotes(quoteWith(Number.MAX_SAFE_INTEGER));
      expect(json.spx?.quotedAt).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  it('returns 403 when bot detected (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 500 when handler throws unexpected error', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockImplementation(() => {
      throw new Error('Crash');
    });

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
  });

  it('forwards error from schwabFetch', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'Token expired',
      status: 401,
      code: 'SCHWAB_TOKEN_EXPIRED',
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Token expired' });
  });
});
