/**
 * Tests for the schwab-fetch dispatch layer (Phase 2 of
 * schwab-replacement-2026-08-16).
 *
 * `schwabFetch` keeps its exported signature + ApiResult envelope but
 * routes by path prefix to the market-data adapters instead of calling
 * Schwab. Paths/symbols the adapters report as 501 SOURCE_UNAVAILABLE
 * pass through to the real Schwab Market Data API when (and only when)
 * SCHWAB_CLIENT_ID + SCHWAB_CLIENT_SECRET are set (readiness-loose-ends
 * 2026-08-18, phase G). `schwabTraderFetch` (positions) stays on the
 * real Schwab Trader API with the OAuth token machinery.
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

const unavailableResult = {
  ok: false as const,
  status: 501,
  code: 'SOURCE_UNAVAILABLE',
  error: '[SOURCE_UNAVAILABLE] No market-data source for /pricehistory',
};

const originalEnv = process.env;

beforeEach(() => {
  // Default: Schwab NOT configured — passthrough must stay dormant.
  process.env = { ...originalEnv };
  delete process.env.SCHWAB_CLIENT_ID;
  delete process.env.SCHWAB_CLIENT_SECRET;
  vi.mocked(chainAdapter).mockResolvedValue(okResult);
  vi.mocked(historyAdapter).mockResolvedValue(okResult);
  vi.mocked(quotesAdapter).mockResolvedValue(okResult);
  vi.mocked(moversAdapter).mockResolvedValue(okResult);
});

afterEach(() => {
  process.env = originalEnv;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function configureSchwab(): void {
  process.env.SCHWAB_CLIENT_ID = 'client-id';
  process.env.SCHWAB_CLIENT_SECRET = 'client-secret';
}

function spyFetchOk(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => data,
  } as unknown as Response);
}

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

describe('schwabFetch Schwab Market Data passthrough (facade gaps)', () => {
  it('leaves 501 SOURCE_UNAVAILABLE unchanged when Schwab is not configured', async () => {
    vi.mocked(historyAdapter).mockResolvedValue(unavailableResult);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await schwabFetch('/pricehistory?symbol=%24TICK');

    expect(result).toEqual(unavailableResult);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats empty-string credentials as unconfigured (no passthrough)', async () => {
    process.env.SCHWAB_CLIENT_ID = '';
    process.env.SCHWAB_CLIENT_SECRET = '';
    vi.mocked(historyAdapter).mockResolvedValue(unavailableResult);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await schwabFetch('/pricehistory?symbol=%24TICK');

    expect(result).toEqual(unavailableResult);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires BOTH credentials before passing through', async () => {
    process.env.SCHWAB_CLIENT_ID = 'client-id';
    vi.mocked(historyAdapter).mockResolvedValue(unavailableResult);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await schwabFetch('/pricehistory?symbol=%24TICK');

    expect(result).toEqual(unavailableResult);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls the real Schwab Market Data API when configured and the adapter has no source', async () => {
    configureSchwab();
    vi.mocked(historyAdapter).mockResolvedValue(unavailableResult);
    vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok-md' });
    const payload = { symbol: '$TICK', empty: false, candles: [] };
    const fetchSpy = spyFetchOk(payload);

    const path = '/pricehistory?symbol=%24TICK&frequency=1';
    const result = await schwabFetch(path);

    expect(historyAdapter).toHaveBeenCalledWith(path);
    expect(result).toEqual({ ok: true, data: payload });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.schwabapi.com/marketdata/v1${path}`);
    expect(url.startsWith('https://api.schwabapi.com/marketdata/v1')).toBe(
      true,
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-md',
    );
  });

  it('passes through paths that have no adapter at all when configured', async () => {
    configureSchwab();
    vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok-md' });
    const fetchSpy = spyFetchOk({ instruments: [] });

    const path = '/instruments?cusip=12345';
    const result = await schwabFetch(path);

    expect(result).toEqual({ ok: true, data: { instruments: [] } });
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.schwabapi.com/marketdata/v1${path}`);
  });

  it('returns the 401 SCHWAB_TOKEN_EXPIRED envelope when configured but not connected', async () => {
    configureSchwab();
    vi.mocked(historyAdapter).mockResolvedValue(unavailableResult);
    vi.mocked(getAccessToken).mockResolvedValue({
      error: {
        type: 'expired_refresh',
        message: 'No tokens found. Run /api/auth/init to authenticate.',
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await schwabFetch('/pricehistory?symbol=%24TICK');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.code).toBe('SCHWAB_TOKEN_EXPIRED');
    expect(result.error.startsWith('[SCHWAB_TOKEN_EXPIRED]')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the 500 SCHWAB_TOKEN_ERROR envelope on token machinery failure', async () => {
    configureSchwab();
    vi.mocked(historyAdapter).mockResolvedValue(unavailableResult);
    vi.mocked(getAccessToken).mockResolvedValue({
      error: { type: 'token_error', message: 'Token refresh failed' },
    });

    const result = await schwabFetch('/pricehistory?symbol=%24TICK');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.code).toBe('SCHWAB_TOKEN_ERROR');
    expect(result.error.startsWith('[SCHWAB_TOKEN_ERROR]')).toBe(true);
  });

  it('does not pass through when the adapter succeeds', async () => {
    configureSchwab();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await schwabFetch('/quotes?symbols=%24SPX&fields=quote');

    expect(result).toEqual(okResult);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not pass through on transient adapter failures (502)', async () => {
    configureSchwab();
    vi.mocked(quotesAdapter).mockResolvedValue({
      ok: false,
      status: 502,
      error: '[SCHWAB_API_502] UW upstream error',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await schwabFetch('/quotes?symbols=%24SPX');

    expect(result).toEqual({
      ok: false,
      status: 502,
      error: '[SCHWAB_API_502] UW upstream error',
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the legacy [SCHWAB_API_*] error strings on passthrough failures', async () => {
    configureSchwab();
    vi.mocked(historyAdapter).mockResolvedValue(unavailableResult);
    vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok-md' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as unknown as Response);

    const result = await schwabFetch('/pricehistory?symbol=%24TICK');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.error.startsWith('[SCHWAB_API_REJECTED]')).toBe(true);
  });

  it('logs the passthrough activation once per process, not per call', async () => {
    // Fresh module instance so the module-level "announced" latch starts
    // cleared regardless of what earlier tests in this file did.
    vi.resetModules();
    const { schwabFetch: freshSchwabFetch } =
      await import('../_lib/schwab-fetch.js');
    const { default: freshLogger } = await import('../_lib/logger.js');
    const adapters = await import('../_lib/market-data-adapters.js');
    const schwab = await import('../_lib/schwab.js');

    configureSchwab();
    vi.mocked(adapters.historyAdapter).mockResolvedValue(unavailableResult);
    vi.mocked(schwab.getAccessToken).mockResolvedValue({ token: 'tok-md' });
    spyFetchOk({ candles: [] });

    await freshSchwabFetch('/pricehistory?symbol=%24TICK');
    await freshSchwabFetch('/pricehistory?symbol=%24TRIN');
    await freshSchwabFetch('/pricehistory?symbol=%24TICK');

    const announcements = vi
      .mocked(freshLogger.info)
      .mock.calls.filter(([, msg]) => String(msg).includes('passthrough'));
    expect(announcements).toHaveLength(1);
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
