// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  isMarketOpen: vi.fn(() => false),
  setCacheHeaders: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../gamma-squeezes.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';

// ── Helpers ───────────────────────────────────────────────

function makeSqueezeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    ticker: 'SPY',
    strike: '700',
    side: 'call',
    expiry: '2026-04-29',
    ts: '2026-04-28T19:30:00Z',
    spot_at_detect: '699.50',
    pct_from_strike: '0.0007',
    spot_trend_5m: '0.5',
    vol_oi_15m: '7.5',
    vol_oi_15m_prior: '2.0',
    vol_oi_acceleration: '0.4',
    vol_oi_total: '12000',
    net_gamma_sign: 'short',
    squeeze_phase: 'active',
    context_snapshot: null,
    spot_at_close: null,
    reached_strike: null,
    max_call_pnl_pct: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/gamma-squeezes', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('short-circuits when guard rejects (e.g. 401)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects invalid ticker with 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'BOGUS' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects malformed `at` with 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { at: 'not-a-timestamp' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('uses live (NOW() - 24h) SQL when `at` is omitted', async () => {
    mockSql.mockResolvedValue([makeSqueezeRow()]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'SPY' } }),
      res,
    );

    expect(res._status).toBe(200);
    // First arg of the tagged-template call is the strings array; pull out
    // the joined SQL to assert which branch ran.
    const firstCall = mockSql.mock.calls[0];
    const strings = firstCall![0] as TemplateStringsArray;
    const joined = strings.join('?');
    expect(joined).toContain("ts >= NOW() - INTERVAL '24 hours'");
    expect(joined).not.toContain('ts <= ');
  });

  it('uses replay-window SQL when `at` is provided', async () => {
    mockSql.mockResolvedValue([makeSqueezeRow()]);
    const res = mockResponse();
    const at = '2026-04-28T19:30:00.000Z';
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'SPY', at } }),
      res,
    );

    expect(res._status).toBe(200);
    const firstCall = mockSql.mock.calls[0];
    const strings = firstCall![0] as TemplateStringsArray;
    const joined = strings.join('?');
    expect(joined).toContain('ts <= ');
    expect(joined).toContain('ts >= ');
    expect(joined).not.toContain("NOW() - INTERVAL '24 hours'");

    // Bound parameters are the rest of the call's arguments — verify the
    // 24h floor is computed correctly (atFloor === at - 24h).
    const params = firstCall!.slice(1) as unknown[];
    const isoParams = params.filter(
      (p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p),
    ) as string[];
    expect(isoParams).toContain('2026-04-28T19:30:00.000Z');
    expect(isoParams).toContain('2026-04-27T19:30:00.000Z');
  });

  it('returns mode=list with ordered latest+history payload', async () => {
    const r1 = makeSqueezeRow({ id: 1, ts: '2026-04-28T19:30:00Z' });
    const r2 = makeSqueezeRow({ id: 2, ts: '2026-04-28T19:25:00Z' });
    mockSql.mockResolvedValue([r1, r2]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'SPY' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as {
      mode: string;
      latest: Record<string, unknown>;
      history: Record<string, unknown[]>;
    };
    expect(body.mode).toBe('list');
    // ticker filter narrows the bundles loop to a single SQL call;
    // path-shape lookup adds one more (lateral spot lookup) → 2 total.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(body.latest.SPY).toMatchObject({ id: 1 });
    expect(body.history.SPY).toHaveLength(2);
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValue(new Error('pg down'));

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'SPY' } }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });
});
