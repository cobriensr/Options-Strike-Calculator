// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  classifyGexbotError,
  fetchClassicBasic,
  fetchMaxchange,
  fetchOrderflow,
  fetchStateMaxchange,
  fetchStatePerStrike,
  GexbotHttpError,
  GEXBOT_TICKERS,
  MAXCHANGE_CATEGORIES,
  STATE_CATEGORIES,
  STATE_MAXCHANGE_CATEGORIES,
} from '../_lib/gexbot-client.js';

describe('gexbot-client', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Constant exports ────────────────────────────────────

  describe('exported constants', () => {
    it('GEXBOT_TICKERS contains the 16 paid tier-eligible tickers', () => {
      expect(GEXBOT_TICKERS).toHaveLength(16);
      // Spot-check both Index and ETF buckets.
      expect(GEXBOT_TICKERS).toContain('SPX');
      expect(GEXBOT_TICKERS).toContain('ES_SPX');
      expect(GEXBOT_TICKERS).toContain('NQ_NDX');
      expect(GEXBOT_TICKERS).toContain('VIX');
      expect(GEXBOT_TICKERS).toContain('SPY');
      expect(GEXBOT_TICKERS).toContain('UVXY');
    });

    it('STATE_CATEGORIES covers the 4 Greeks × 2 DTE buckets = 8', () => {
      expect(STATE_CATEGORIES).toHaveLength(8);
      for (const greek of ['gamma', 'delta', 'vanna', 'charm']) {
        expect(STATE_CATEGORIES).toContain(`${greek}_zero`);
        expect(STATE_CATEGORIES).toContain(`${greek}_one`);
      }
    });

    it('STATE_MAXCHANGE_CATEGORIES mirrors MAXCHANGE_CATEGORIES (state/maxchange only accepts the 3 DTE buckets, not Greek×DTE)', () => {
      expect(STATE_MAXCHANGE_CATEGORIES).toBe(MAXCHANGE_CATEGORIES);
    });

    it('MAXCHANGE_CATEGORIES covers all 3 DTE buckets', () => {
      expect([...MAXCHANGE_CATEGORIES]).toEqual([
        'gex_zero',
        'gex_one',
        'gex_full',
      ]);
    });
  });

  // ── Auth header construction ───────────────────────────

  describe('auth header', () => {
    it('prepends the gexbot_custom_ prefix when caller passes the secret alone', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ticker: 'SPX' }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      await fetchOrderflow('mysecret', 'SPX');
      const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer gexbot_custom_mysecret');
    });

    it('does not double-prefix when caller already includes gexbot_custom_', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ticker: 'SPX' }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      await fetchOrderflow('gexbot_custom_alreadyprefixed', 'SPX');
      const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        'Bearer gexbot_custom_alreadyprefixed',
      );
    });

    it('sets Accept and User-Agent headers per AGENTS.md contract', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ticker: 'SPX' }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      await fetchOrderflow('s', 'SPX');
      const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Accept).toBe('application/json');
      expect(headers['User-Agent']).toMatch(/strike-calculator/);
    });
  });

  // ── URL construction ───────────────────────────────────

  describe('URL paths', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({}),
        })),
      );
    });

    it('fetchOrderflow hits /{ticker}/orderflow/orderflow', async () => {
      await fetchOrderflow('s', 'SPX');
      const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(url).toBe('https://api.gex.bot/v2/SPX/orderflow/orderflow');
    });

    it('fetchStatePerStrike hits /{ticker}/state/{category}', async () => {
      await fetchStatePerStrike('s', 'SPX', 'gamma_zero');
      const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(url).toBe('https://api.gex.bot/v2/SPX/state/gamma_zero');
    });

    it('fetchMaxchange hits /{ticker}/classic/{category}/maxchange', async () => {
      await fetchMaxchange('s', 'SPX', 'gex_one');
      const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(url).toBe('https://api.gex.bot/v2/SPX/classic/gex_one/maxchange');
    });

    it('fetchStateMaxchange hits /{ticker}/state/{category}/maxchange', async () => {
      await fetchStateMaxchange('s', 'SPX', 'gex_zero');
      const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(url).toBe('https://api.gex.bot/v2/SPX/state/gex_zero/maxchange');
    });

    it('fetchClassicBasic hits /{ticker}/classic/{category} (no /maxchange suffix)', async () => {
      // The basic (non-maxchange) classic endpoint — the only live source
      // for zero_gamma / sum_gex_* / major_* / delta_risk_reversal. The
      // /orderflow payload omits them despite the spec listing them.
      await fetchClassicBasic('s', 'SPX', 'gex_zero');
      const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(url).toBe('https://api.gex.bot/v2/SPX/classic/gex_zero');
    });
  });

  // ── Error handling ─────────────────────────────────────

  describe('error handling', () => {
    it('throws a status-tagged error on non-2xx', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 429,
          text: async () => 'rate limit exceeded',
        })),
      );
      await expect(fetchOrderflow('s', 'SPX')).rejects.toThrow(
        /GEXBot 429 \/SPX\/orderflow\/orderflow: rate limit/,
      );
    });

    it('throws a typed GexbotHttpError carrying status and path, message unchanged', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 403,
          text: async () => 'x'.repeat(300),
        })),
      );
      const err = await fetchOrderflow('s', 'SPX').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GexbotHttpError);
      expect(err).toBeInstanceOf(Error);
      const http = err as GexbotHttpError;
      expect(http.name).toBe('GexbotHttpError');
      expect(http.status).toBe(403);
      expect(http.path).toBe('/SPX/orderflow/orderflow');
      expect(http.message).toBe(
        `GEXBot 403 /SPX/orderflow/orderflow: ${'x'.repeat(200)}`,
      );
    });

    it('throws when response body is not an object', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => 'not-an-object',
        })),
      );
      await expect(fetchOrderflow('s', 'SPX')).rejects.toThrow(
        /expected object body/,
      );
    });

    it('throws when response body is an array', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => [],
        })),
      );
      await expect(fetchOrderflow('s', 'SPX')).rejects.toThrow(
        /expected object body/,
      );
    });

    it('throws when response body is null', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => null,
        })),
      );
      await expect(fetchOrderflow('s', 'SPX')).rejects.toThrow(
        /expected object body/,
      );
    });
  });

  // ── Failure classification (Sentry fingerprint + tag) ──

  describe('classifyGexbotError', () => {
    const http = (status: number) =>
      new GexbotHttpError(status, '/SPX/orderflow/orderflow', 'body');

    it.each([
      [429, 'http-429'],
      [400, 'http-4xx'],
      [401, 'http-4xx'],
      [403, 'http-4xx'],
      [404, 'http-4xx'],
      [500, 'http-5xx'],
      [503, 'http-5xx'],
    ])('maps HTTP %i to %s and tags the numeric status', (status, cls) => {
      expect(classifyGexbotError(http(status))).toEqual({
        statusClass: cls,
        statusTag: String(status),
      });
    });

    it.each([
      ['/SPX/classic/gex_zero/maxchange', 404, ''],
      ['/SPX/state/gex_one/maxchange', 404, 'not found'],
      [
        '/SPX/orderflow/orderflow',
        500,
        'Failed to get redis chart data: null or zero length',
      ],
    ])(
      'maps the vendor "no snapshot yet" answer %s %i to no-data',
      (path, status, body) => {
        expect(
          classifyGexbotError(new GexbotHttpError(status, path, body)),
        ).toEqual({ statusClass: 'no-data', statusTag: String(status) });
      },
    );

    it('keeps a 404 off maxchange and a plain 500 in their HTTP classes', () => {
      expect(
        classifyGexbotError(
          new GexbotHttpError(404, '/SPX/orderflow/orderflow', ''),
        ).statusClass,
      ).toBe('http-4xx');
      expect(
        classifyGexbotError(
          new GexbotHttpError(500, '/SPX/orderflow/orderflow', 'boom'),
        ).statusClass,
      ).toBe('http-5xx');
    });

    it('maps a non-error HTTP status to other', () => {
      expect(
        classifyGexbotError(new GexbotHttpError(302, '/SPX/x', '')),
      ).toEqual({ statusClass: 'other', statusTag: '302' });
    });

    it('maps a TimeoutError DOMException to timeout', () => {
      const err = new DOMException('timed out', 'TimeoutError');
      expect(classifyGexbotError(err)).toEqual({
        statusClass: 'timeout',
        statusTag: 'timeout',
      });
    });

    it('maps an AbortError to timeout', () => {
      const err = new DOMException('aborted', 'AbortError');
      expect(classifyGexbotError(err).statusClass).toBe('timeout');
    });

    it.each([
      new SyntaxError('Unexpected token'),
      new Error('fetch failed'),
      'a string',
      null,
    ])('maps %s to other', (err) => {
      expect(classifyGexbotError(err)).toEqual({
        statusClass: 'other',
        statusTag: 'other',
      });
    });
  });
});
