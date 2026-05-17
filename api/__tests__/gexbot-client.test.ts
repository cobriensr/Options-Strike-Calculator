// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchMaxchange,
  fetchOrderflow,
  fetchStateMaxchange,
  fetchStatePerStrike,
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

    it('STATE_MAXCHANGE_CATEGORIES mirrors STATE_CATEGORIES exactly', () => {
      expect(STATE_MAXCHANGE_CATEGORIES).toBe(STATE_CATEGORIES);
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
      await fetchStateMaxchange('s', 'SPX', 'charm_zero');
      const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(url).toBe('https://api.gex.bot/v2/SPX/state/charm_zero/maxchange');
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
});
