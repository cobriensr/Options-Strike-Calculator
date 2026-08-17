/**
 * Tests for the schwab-fetch dispatch layer (Phase 2 of
 * schwab-replacement-2026-08-16).
 *
 * `schwabFetch` keeps its exported signature + ApiResult envelope but
 * routes by path prefix to the market-data adapters instead of calling
 * Schwab. `schwabTraderFetch` (positions) stays on the real Schwab
 * Trader API with the OAuth token machinery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/market-data-adapters.js', () => ({
  chainAdapter: vi.fn(),
  historyAdapter: vi.fn(),
  quotesAdapter: vi.fn(),
  moversAdapter: vi.fn(),
  sourceUnavailable: vi.fn((path: string) => ({
    ok: false,
    status: 501,
    code: 'SOURCE_UNAVAILABLE',
    error: `[SOURCE_UNAVAILABLE] No market-data source for ${path}`,
  })),
}));

vi.mock('../_lib/schwab.js', () => ({
  getAccessToken: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: {
    schwabCall: vi.fn(() => vi.fn()),
    tokenRefresh: vi.fn(),
  },
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { schwabFetch, schwabTraderFetch } from '../_lib/schwab-fetch.js';
import {
  chainAdapter,
  historyAdapter,
  moversAdapter,
  quotesAdapter,
} from '../_lib/market-data-adapters.js';
import { getAccessToken } from '../_lib/schwab.js';

const okResult = { ok: true as const, data: { marker: 'adapter' } };

beforeEach(() => {
  vi.mocked(chainAdapter).mockResolvedValue(okResult);
  vi.mocked(historyAdapter).mockResolvedValue(okResult);
  vi.mocked(quotesAdapter).mockResolvedValue(okResult);
  vi.mocked(moversAdapter).mockResolvedValue(okResult);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('schwabFetch dispatch', () => {
  it.each([
    ['/chains?symbol=$SPX&strikeCount=80', chainAdapter],
    ['/pricehistory?symbol=%24SPX&frequency=5', historyAdapter],
    ['/quotes?symbols=SPY%2C%24SPX&fields=quote', quotesAdapter],
    ['/movers/$SPX?sort=percent_change_up&frequency=0', moversAdapter],
  ])(
    'routes %s to its adapter and passes the result through',
    async (path, adapter) => {
      const result = await schwabFetch(path);
      expect(adapter).toHaveBeenCalledWith(path);
      expect(result).toEqual(okResult);
    },
  );

  it('never touches the Schwab OAuth token machinery', async () => {
    await schwabFetch('/quotes?symbols=%24SPX&fields=quote');
    await schwabFetch('/chains?symbol=$SPX');
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('returns 501 SOURCE_UNAVAILABLE for paths with no replacement source', async () => {
    const result = await schwabFetch('/instruments?cusip=12345');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(501);
    expect(result.code).toBe('SOURCE_UNAVAILABLE');
    expect(chainAdapter).not.toHaveBeenCalled();
    expect(historyAdapter).not.toHaveBeenCalled();
    expect(quotesAdapter).not.toHaveBeenCalled();
    expect(moversAdapter).not.toHaveBeenCalled();
  });

  it('propagates adapter failures unchanged (error-string contract)', async () => {
    vi.mocked(quotesAdapter).mockResolvedValue({
      ok: false,
      status: 429,
      error: '[SCHWAB_API_429] rate limited',
    });
    const result = await schwabFetch('/quotes?symbols=%24SPX');
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: '[SCHWAB_API_429] rate limited',
    });
  });
});

describe('schwabTraderFetch (unchanged Schwab path)', () => {
  it('still calls the Schwab Trader API with a bearer token', async () => {
    vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok-123' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ hashValue: 'abc' }],
    } as unknown as Response);

    const result = await schwabTraderFetch('/accounts/accountNumbers');
    expect(result).toEqual({ ok: true, data: [{ hashValue: 'abc' }] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.schwabapi.com/trader/v1/accounts/accountNumbers',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-123',
    );
  });

  it('maps an expired refresh token to 401 SCHWAB_TOKEN_EXPIRED', async () => {
    vi.mocked(getAccessToken).mockResolvedValue({
      error: { type: 'expired_refresh', message: 'Run /api/auth/init' },
    });
    const result = await schwabTraderFetch('/accounts/accountNumbers');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.error.startsWith('[SCHWAB_TOKEN_EXPIRED]')).toBe(true);
  });
});
