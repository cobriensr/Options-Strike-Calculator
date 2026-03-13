// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(),
}));

import handler from '../quotes.js';
import {
  rejectIfNotOwner,
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
      tradeTime: Date.now(),
    },
  };
}

describe('GET /api/quotes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(401);
  });

  it('returns quote data for all symbols', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);
    vi.mocked(schwabFetch).mockResolvedValue({
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
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

  it('forwards error from schwabFetch', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      error: 'Token expired',
      status: 401,
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Token expired' });
  });
});
