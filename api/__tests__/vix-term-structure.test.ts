// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSchwabFetch, mockUwFetch, mockRedisGet, mockRedisSet } = vi.hoisted(
  () => ({
    mockSchwabFetch: vi.fn(),
    mockUwFetch: vi.fn(),
    mockRedisGet: vi.fn(),
    mockRedisSet: vi.fn(),
  }),
);

vi.mock('../_lib/schwab-fetch.js', () => ({ schwabFetch: mockSchwabFetch }));
vi.mock('../_lib/uw-fetch.js', () => ({ uwFetch: mockUwFetch }));
// Keep the real safeRedis / safeRedisVoid so "Redis down" exercises the
// production swallow + `redis.error` path; only the client is faked.
vi.mock('../_lib/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/redis.js')>();
  return {
    ...actual,
    limiterRedis: { get: mockRedisGet, set: mockRedisSet },
  };
});
vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
}));
vi.mock('../_lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  classifyVixRatio,
  fetchVixTermStructure,
  parseVixFuturesRegime,
  vixRatio,
} from '../_lib/vix-term-structure.js';
import { metrics, Sentry } from '../_lib/sentry.js';

// ── Fixtures ────────────────────────────────────────────────

const NOW = new Date('2026-10-02T15:00:00.000Z');
const VIX_TRADE_MS = NOW.getTime() - 30_000;
const VIX3M_TRADE_MS = NOW.getTime() - 90_000;
const CACHE_KEY = 'vix-term:uw-close:v1';

function schwabQuote(lastPrice: number, tradeTime?: number) {
  return {
    assetMainType: 'INDEX',
    quote: { lastPrice, closePrice: lastPrice, tradeTime },
  };
}

function schwabOk(data: unknown) {
  return { ok: true as const, data };
}

/** The live UW shape: payload wrapped in `data` (2026-10-01 probe). */
function uwWrapped(market: Record<string, unknown>) {
  return {
    data: {
      date: '2026-10-01',
      ticker: 'SPX',
      market,
      term_structure: { regime: 'contango' },
    },
  };
}

const UW_MARKET = {
  vix: 16.39,
  vix3m: 18.58,
  vix_curve_inverted: false,
  vix_futures_regime: 'contango',
};

/** uwFetch returns `extract(body)` for the module's `(b) => [b]` extractor. */
function uwReturns(body: unknown) {
  mockUwFetch.mockImplementationOnce(
    async (
      _key: string,
      _path: string,
      extract: (b: Record<string, unknown>) => unknown[],
    ) => extract(body as Record<string, unknown>),
  );
}

function liveQuotes(vix = 16.5, vix3m = 18.6) {
  mockSchwabFetch.mockResolvedValueOnce(
    schwabOk({
      $VIX: schwabQuote(vix, VIX_TRADE_MS),
      $VIX3M: schwabQuote(vix3m, VIX3M_TRADE_MS),
    }),
  );
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  mockSchwabFetch.mockReset();
  mockUwFetch.mockReset();
  mockRedisGet.mockReset().mockResolvedValue(null);
  mockRedisSet.mockReset().mockResolvedValue('OK');
  process.env = { ...ORIGINAL_ENV, UW_API_KEY: 'test-uw-key' };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.useRealTimers();
});

// ── Pure helpers ────────────────────────────────────────────

describe('vixRatio', () => {
  it.each([
    [16.39, 18.58, 0.882],
    [18, 18, 1],
    [30, 25, 1.2],
  ])('vixRatio(%s, %s) = %s', (vix, vix3m, expected) => {
    expect(vixRatio(vix, vix3m)).toBe(expected);
  });

  it.each([
    [null, 18],
    [16, undefined],
    [0, 18],
    [16, 0],
    [-1, 18],
    [Number.NaN, 18],
    [16, Number.POSITIVE_INFINITY],
  ])('returns null for unusable inputs (%s, %s)', (vix, vix3m) => {
    expect(vixRatio(vix, vix3m)).toBeNull();
  });
});

describe('classifyVixRatio', () => {
  it.each([
    [0.8, 'CONTANGO'],
    [0.9, 'CONTANGO'], // ≤ 0.90 boundary is CONTANGO
    [0.901, 'FLAT'],
    [0.999, 'FLAT'],
    [1.0, 'BACKWARDATION'], // ≥ 1.00 boundary is BACKWARDATION
    [1.25, 'BACKWARDATION'],
  ] as const)('classifies %s as %s', (ratio, band) => {
    expect(classifyVixRatio(ratio)).toBe(band);
  });
});

describe('parseVixFuturesRegime', () => {
  it.each([
    ['contango', 'CONTANGO'],
    ['flat', 'FLAT'],
    ['backwardation', 'BACKWARDATION'],
    ['  Backwardation ', 'BACKWARDATION'],
  ] as const)('maps %j to %s', (label, band) => {
    expect(parseVixFuturesRegime(label)).toBe(band);
  });

  it.each(['inverted', 'super_contango', ''])(
    'returns null for unknown label %j',
    (label) => {
      expect(parseVixFuturesRegime(label)).toBeNull();
    },
  );
});

// ── fetchVixTermStructure ───────────────────────────────────

describe('fetchVixTermStructure', () => {
  it('combines the live Schwab ratio with the UW close and label, and caches the UW result for 30 min', async () => {
    liveQuotes(16.5, 18.6);
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result).toEqual({
      live: {
        vix: 16.5,
        vix3m: 18.6,
        ratio: 0.887,
        band: 'CONTANGO',
        // The older of the two trade times, so a lagging VIX3M shows.
        asOf: new Date(VIX3M_TRADE_MS).toISOString(),
      },
      lastClose: { vix: 16.39, vix3m: 18.58, ratio: 0.882, band: 'CONTANGO' },
      futuresRegime: 'CONTANGO',
    });
    expect(mockSchwabFetch).toHaveBeenCalledWith(
      '/quotes?symbols=%24VIX%2C%24VIX3M&fields=quote',
    );
    expect(mockUwFetch).toHaveBeenCalledWith(
      'test-uw-key',
      '/stock/SPX/volatility/context',
      expect.any(Function),
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      CACHE_KEY,
      {
        ok: true,
        lastClose: {
          vix: 16.39,
          vix3m: 18.58,
          ratio: 0.882,
          band: 'CONTANGO',
        },
        futuresRegime: 'CONTANGO',
      },
      { ex: 1800 },
    );
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  // ── Live (Schwab) failure modes ───────────────────────────

  it('falls back to the UW close when Schwab omits $VIX3M (partial response), keeping $VIX intact', async () => {
    mockSchwabFetch.mockResolvedValueOnce(
      schwabOk({
        $VIX: schwabQuote(16.5, VIX_TRADE_MS),
        errors: { invalidSymbols: ['$VIX3M'] },
      }),
    );
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result.live).toBeNull();
    expect(result.lastClose?.ratio).toBe(0.882);
    expect(result.futuresRegime).toBe('CONTANGO');
    expect(metrics.increment).toHaveBeenCalledWith(
      'vix_term.vix3m_quote_missing',
    );
    expect(metrics.increment).not.toHaveBeenCalledWith(
      'vix_term.live_unavailable',
    );
  });

  it('treats a $VIX3M entry with no lastPrice as missing', async () => {
    mockSchwabFetch.mockResolvedValueOnce(
      schwabOk({
        $VIX: schwabQuote(16.5, VIX_TRADE_MS),
        $VIX3M: { quote: {} },
      }),
    );
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result.live).toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith(
      'vix_term.vix3m_quote_missing',
    );
  });

  it('reports live_unavailable when the Schwab call fails', async () => {
    mockSchwabFetch.mockResolvedValueOnce({
      ok: false,
      error: '[SCHWAB_TOKEN_EXPIRED] re-auth',
      status: 401,
      code: 'SCHWAB_TOKEN_EXPIRED',
    });
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result.live).toBeNull();
    expect(result.lastClose).not.toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.live_unavailable');
  });

  it('reports live_unavailable when $VIX itself is missing', async () => {
    mockSchwabFetch.mockResolvedValueOnce(
      schwabOk({ $VIX3M: schwabQuote(18.6, VIX3M_TRADE_MS) }),
    );
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result.live).toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.live_unavailable');
    expect(metrics.increment).not.toHaveBeenCalledWith(
      'vix_term.vix3m_quote_missing',
    );
  });

  it('reports live_unavailable and captures when the Schwab fetch throws', async () => {
    const err = new SyntaxError('Unexpected token < in JSON');
    mockSchwabFetch.mockRejectedValueOnce(err);
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result.live).toBeNull();
    expect(result.lastClose).not.toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.live_unavailable');
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('stamps the live reading with the fetch time when a quote has no trade time', async () => {
    mockSchwabFetch.mockResolvedValueOnce(
      schwabOk({
        $VIX: schwabQuote(16.5),
        $VIX3M: schwabQuote(18.6, VIX3M_TRADE_MS),
      }),
    );
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result.live?.asOf).toBe(NOW.toISOString());
  });

  it('classifies a live inversion as BACKWARDATION', async () => {
    liveQuotes(28, 25);
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(result.live).toMatchObject({ ratio: 1.12, band: 'BACKWARDATION' });
  });

  // ── UW failure modes ──────────────────────────────────────

  it('reports uw_error and negative-caches for 5 min when UW returns non-200', async () => {
    liveQuotes();
    mockUwFetch.mockRejectedValueOnce(
      new Error('UW API 403: {"reason":"route_not_permitted"}'),
    );

    const result = await fetchVixTermStructure();

    expect(result.lastClose).toBeNull();
    expect(result.futuresRegime).toBeNull();
    expect(result.live).not.toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_error');
    expect(mockRedisSet).toHaveBeenCalledWith(
      CACHE_KEY,
      { ok: false },
      { ex: 300 },
    );
  });

  it('reports uw_error without calling UW when UW_API_KEY is unset', async () => {
    delete process.env.UW_API_KEY;
    liveQuotes();

    const result = await fetchVixTermStructure();

    expect(result.lastClose).toBeNull();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_error');
  });

  it('accepts the unwrapped body shape the OpenAPI spec documents', async () => {
    liveQuotes();
    uwReturns({ date: '2026-10-01', ticker: 'SPX', market: UW_MARKET });

    const result = await fetchVixTermStructure();

    expect(result.lastClose?.ratio).toBe(0.882);
    expect(result.futuresRegime).toBe('CONTANGO');
    expect(metrics.increment).not.toHaveBeenCalledWith('vix_term.uw_malformed');
  });

  it('reports uw_malformed for a wrapped body whose market block is the wrong type', async () => {
    liveQuotes();
    uwReturns({ data: { ticker: 'SPX', market: 'unavailable' } });

    const result = await fetchVixTermStructure();

    expect(result.lastClose).toBeNull();
    expect(result.futuresRegime).toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_malformed');
    expect(mockRedisSet).toHaveBeenCalledWith(
      CACHE_KEY,
      { ok: false },
      { ex: 300 },
    );
  });

  it('reports uw_malformed for an unwrapped body with no market block', async () => {
    liveQuotes();
    uwReturns({ ticker: 'SPX', iv30: 0.138 });

    const result = await fetchVixTermStructure();

    expect(result.lastClose).toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_malformed');
  });

  it('reports uw_malformed when a market value has the wrong type', async () => {
    liveQuotes();
    uwReturns(uwWrapped({ ...UW_MARKET, vix: '16.39' }));

    const result = await fetchVixTermStructure();

    expect(result.lastClose).toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_malformed');
  });

  it('reports null UW values as uw_empty (not malformed) and caches the gap for only 5 min', async () => {
    liveQuotes();
    uwReturns(
      uwWrapped({
        vix: null,
        vix3m: 18.58,
        vix_curve_inverted: null,
        vix_futures_regime: null,
      }),
    );

    const result = await fetchVixTermStructure();

    expect(result.lastClose).toBeNull();
    expect(result.futuresRegime).toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_empty');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'vix term: UW market block empty',
      'warning',
    );
    expect(metrics.increment).not.toHaveBeenCalledWith('vix_term.uw_malformed');
    expect(mockRedisSet).toHaveBeenCalledWith(
      CACHE_KEY,
      { ok: true, lastClose: null, futuresRegime: null },
      { ex: 300 },
    );
  });

  it('reports a zero VIX3M close as uw_empty', async () => {
    liveQuotes();
    uwReturns(uwWrapped({ ...UW_MARKET, vix3m: 0 }));

    const result = await fetchVixTermStructure();

    expect(result.lastClose).toBeNull();
    expect(result.futuresRegime).toBe('CONTANGO');
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_empty');
  });

  it('keeps the close ratio but reports uw_empty when only the regime label is missing', async () => {
    liveQuotes();
    uwReturns(uwWrapped({ ...UW_MARKET, vix_futures_regime: null }));

    const result = await fetchVixTermStructure();

    expect(result.lastClose?.ratio).toBe(0.882);
    expect(result.futuresRegime).toBeNull();
    expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_empty');
    expect(mockRedisSet).toHaveBeenCalledWith(
      CACHE_KEY,
      expect.objectContaining({ ok: true, futuresRegime: null }),
      { ex: 300 },
    );
  });

  it('reports regime_unrecognized for an unknown label but keeps the close ratio', async () => {
    liveQuotes();
    uwReturns(uwWrapped({ ...UW_MARKET, vix_futures_regime: 'steep' }));

    const result = await fetchVixTermStructure();

    expect(result.futuresRegime).toBeNull();
    expect(result.lastClose?.ratio).toBe(0.882);
    expect(metrics.increment).toHaveBeenCalledWith(
      'vix_term.regime_unrecognized',
    );
  });

  // ── Redis cache ───────────────────────────────────────────

  it('serves a cached UW result without calling UW', async () => {
    liveQuotes();
    mockRedisGet.mockResolvedValueOnce({
      ok: true,
      lastClose: { vix: 20, vix3m: 21, ratio: 0.952, band: 'FLAT' },
      futuresRegime: 'FLAT',
    });

    const result = await fetchVixTermStructure();

    expect(mockRedisGet).toHaveBeenCalledWith(CACHE_KEY);
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(result.lastClose).toEqual({
      vix: 20,
      vix3m: 21,
      ratio: 0.952,
      band: 'FLAT',
    });
    expect(result.futuresRegime).toBe('FLAT');
  });

  it('serves a cached failure as nulls without calling UW', async () => {
    liveQuotes();
    mockRedisGet.mockResolvedValueOnce({ ok: false });

    const result = await fetchVixTermStructure();

    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(result.lastClose).toBeNull();
    expect(result.futuresRegime).toBeNull();
    expect(result.live).not.toBeNull();
  });

  it('refetches when the cached value no longer matches the schema', async () => {
    liveQuotes();
    mockRedisGet.mockResolvedValueOnce({ vix: 16.39 });
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(result.lastClose?.ratio).toBe(0.882);
  });

  it('still returns the UW close when Redis is down (read and write fail)', async () => {
    liveQuotes();
    mockRedisGet.mockRejectedValueOnce(new Error('fetch failed'));
    mockRedisSet.mockRejectedValueOnce(new Error('fetch failed'));
    uwReturns(uwWrapped(UW_MARKET));

    const result = await fetchVixTermStructure();

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(result.lastClose?.ratio).toBe(0.882);
    expect(result.futuresRegime).toBe('CONTANGO');
    expect(result.live).not.toBeNull();
    expect(
      vi
        .mocked(metrics.increment)
        .mock.calls.filter(([name]) => name === 'redis.error'),
    ).toHaveLength(2);
  });

  // ── Per-source deadline ───────────────────────────────────

  describe('per-source deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(NOW);
    });

    it('gives up on a hung Schwab call after 4 s and still returns the UW close', async () => {
      mockSchwabFetch.mockReturnValueOnce(new Promise(() => {}));
      uwReturns(uwWrapped(UW_MARKET));

      const pending = fetchVixTermStructure();
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await pending;

      expect(result.live).toBeNull();
      expect(result.lastClose?.ratio).toBe(0.882);
      expect(metrics.increment).toHaveBeenCalledWith(
        'vix_term.live_unavailable',
      );
    });

    it('gives up on a hung UW call after 4 s without negative-caching it', async () => {
      liveQuotes();
      mockUwFetch.mockReturnValueOnce(new Promise(() => {}));

      const pending = fetchVixTermStructure();
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await pending;

      expect(result.live).not.toBeNull();
      expect(result.lastClose).toBeNull();
      expect(result.futuresRegime).toBeNull();
      expect(metrics.increment).toHaveBeenCalledWith('vix_term.uw_error');
      // The abandoned call may still finish and fill the cache itself.
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('keeps a source that settles just inside the deadline', async () => {
      mockSchwabFetch.mockReturnValueOnce(
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                schwabOk({
                  $VIX: schwabQuote(16.5, VIX_TRADE_MS),
                  $VIX3M: schwabQuote(18.6, VIX3M_TRADE_MS),
                }),
              ),
            3_999,
          );
        }),
      );
      uwReturns(uwWrapped(UW_MARKET));

      const pending = fetchVixTermStructure();
      await vi.advanceTimersByTimeAsync(3_999);
      const result = await pending;

      expect(result.live?.ratio).toBe(0.887);
      expect(metrics.increment).not.toHaveBeenCalled();
    });
  });
});
