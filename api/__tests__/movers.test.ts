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

import handler from '../movers.js';
import {
  guardOwnerOrGuestEndpoint,
  schwabFetch,
  isMarketOpen,
} from '../_lib/api-helpers.js';

function makeMover(
  symbol: string,
  change: number,
  direction: string,
  last = 100,
) {
  return {
    symbol,
    change,
    direction,
    description: `${symbol} Inc`,
    last,
    totalVolume: 1_000_000,
  };
}

describe('GET /api/movers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 for non-owner', async () => {
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

  it('returns movers with concentration analysis', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    // Up movers include mega-caps
    vi.mocked(schwabFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          screeners: [
            makeMover('AAPL', 3.5, 'up', 180),
            makeMover('MSFT', 2.1, 'up', 400),
            makeMover('XYZ', 1.8, 'up'),
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          screeners: [
            makeMover('NVDA', -2.0, 'down', 800),
            makeMover('ABC', -1.5, 'down'),
          ],
        },
      });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.marketOpen).toBe(true);
    expect((json.up as unknown[]).length).toBe(3);
    expect((json.down as unknown[]).length).toBe(2);

    const analysis = json.analysis as {
      concentrated: boolean;
      megaCapCount: number;
      megaCapSymbols: string[];
      bias: string;
    };
    expect(analysis.megaCapCount).toBe(3);
    expect(analysis.concentrated).toBe(true);
    expect(analysis.megaCapSymbols).toContain('AAPL');
    expect(analysis.megaCapSymbols).toContain('NVDA');
  });

  it('handles schwabFetch errors gracefully (empty arrays)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);

    // Both return errors
    vi.mocked(schwabFetch)
      .mockResolvedValueOnce({ ok: false, error: 'fail', status: 502 })
      .mockResolvedValueOnce({ ok: false, error: 'fail', status: 502 });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.up).toEqual([]);
    expect(json.down).toEqual([]);
  });

  it('detects bullish bias when top up change is much larger', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    vi.mocked(schwabFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: { screeners: [makeMover('XYZ', 5.0, 'up')] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { screeners: [makeMover('ABC', -1.0, 'down')] },
      });

    const res = mockResponse();
    await handler(mockRequest(), res);

    const json = res._json as { analysis: { bias: string } };
    expect(json.analysis.bias).toBe('bullish');
  });

  it('detects bearish bias when top down change is much larger', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    vi.mocked(schwabFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: { screeners: [makeMover('XYZ', 1.0, 'up')] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { screeners: [makeMover('ABC', -5.0, 'down')] },
      });

    const res = mockResponse();
    await handler(mockRequest(), res);

    const json = res._json as { analysis: { bias: string } };
    expect(json.analysis.bias).toBe('bearish');
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

  it('detects mixed bias when moves are similar', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    vi.mocked(schwabFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: { screeners: [makeMover('XYZ', 2.0, 'up')] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { screeners: [makeMover('ABC', -2.0, 'down')] },
      });

    const res = mockResponse();
    await handler(mockRequest(), res);

    const json = res._json as { analysis: { bias: string } };
    expect(json.analysis.bias).toBe('mixed');
  });
});
