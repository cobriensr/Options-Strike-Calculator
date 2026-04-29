// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../institutional-program/strike-heatmap.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

// ── Helpers ───────────────────────────────────────────────

function makeStrikeRow(overrides: Record<string, unknown> = {}) {
  return {
    strike: 5800,
    option_type: 'call' as const,
    n_blocks: 4,
    total_contracts: 1200,
    total_premium: 850000,
    last_seen_date: '2026-04-25',
    active_days: 3,
    latest_expiry: '2026-05-16',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/institutional-program/strike-heatmap', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(Sentry.captureException).mockClear();
    mockSql.mockReset();
  });

  it('short-circuits when auth guard rejects (401) and never touches DB', async () => {
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

  it('returns 200 with spot, days, track, and rows on happy path', async () => {
    const row = makeStrikeRow();
    mockSql
      .mockResolvedValueOnce([row]) // strike rollup
      .mockResolvedValueOnce([{ spot: 5825.5 }]); // spot lookup

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { days: '60', track: 'ceiling' } }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      spot: 5825.5,
      days: 60,
      track: 'ceiling',
      rows: [row],
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns spot:null when spot lookup yields no rows', async () => {
    mockSql.mockResolvedValueOnce([makeStrikeRow()]).mockResolvedValueOnce([]); // empty spot result

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { spot: number | null };
    expect(body.spot).toBeNull();
  });

  it('clamps days to [1, 180] (above-range value collapses to 180)', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ spot: 5800 }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '999' } }), res);

    expect(res._status).toBe(200);
    const body = res._json as { days: number };
    expect(body.days).toBe(180);

    // The first SQL call is the strike rollup; its bound days param should be clamped.
    const firstCall = mockSql.mock.calls[0]!;
    const params = firstCall.slice(1);
    expect(params).toContain(180);
  });

  it('clamps non-finite days back to default 60', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ spot: null }]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { days: 'not-a-number' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { days: number };
    expect(body.days).toBe(60);
  });

  it('falls back to "ceiling" when track is invalid', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ spot: null }]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { track: 'bogus-track' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { track: string };
    expect(body.track).toBe('ceiling');

    const firstCall = mockSql.mock.calls[0]!;
    const params = firstCall.slice(1);
    expect(params).toContain('ceiling');
    expect(params).not.toContain('bogus-track');
  });

  it('accepts the alternate "opening_atm" track verbatim', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ spot: null }]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { track: 'opening_atm' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { track: string };
    expect(body.track).toBe('opening_atm');

    const firstCall = mockSql.mock.calls[0]!;
    const params = firstCall.slice(1);
    expect(params).toContain('opening_atm');
  });

  it('returns 500 and reports to Sentry on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('pg down'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
