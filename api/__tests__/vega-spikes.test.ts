// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
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

import handler from '../vega-spikes.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Sample Row ────────────────────────────────────────────────
// Numeric columns come back from @neondatabase/serverless as strings;
// nullable forward-return columns may be null. Booleans and text remain
// natively typed.
const stringRow = {
  id: '1',
  ticker: 'SPY',
  date: '2026-04-27',
  timestamp: '2026-04-27T17:00:00.000Z',
  dir_vega_flow: '5620000',
  z_score: '28.4',
  vs_prior_max: '4.8',
  prior_max: '1170000',
  baseline_mad: '198000',
  bars_elapsed: '210',
  confluence: false,
  fwd_return_5m: null,
  fwd_return_15m: null,
  fwd_return_30m: null,
  inserted_at: '2026-04-27T17:00:18.412Z',
};

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/vega-spikes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 403 when bot detected (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('blocks unauthenticated callers via guard', async () => {
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

  it('returns spikes for today range when no range param given', async () => {
    mockSql.mockResolvedValue([stringRow]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    // First argument is the tagged-template strings array; assert its joined
    // text contains the today filter clause.
    const call = mockSql.mock.calls[0]!;
    const strings = call[0] as string[];
    const joined = strings.join('?');
    expect(joined).toContain('WHERE date = ');
    // Today value passed as interpolation arg
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    expect(call.slice(1)).toContain(today);
    const body = res._json as { range: string };
    expect(body.range).toBe('today');
  });

  it('returns spikes for ?range=7d', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { range: '7d' } }), res);

    expect(res._status).toBe(200);
    const strings = mockSql.mock.calls[0]![0] as string[];
    expect(strings.join('?')).toContain("INTERVAL '7 days'");
    expect((res._json as { range: string }).range).toBe('7d');
  });

  it('returns spikes for ?range=30d', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { range: '30d' } }), res);

    expect(res._status).toBe(200);
    const strings = mockSql.mock.calls[0]![0] as string[];
    expect(strings.join('?')).toContain("INTERVAL '30 days'");
    expect((res._json as { range: string }).range).toBe('30d');
  });

  it('returns 400 for invalid range param', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { range: 'bogus' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'invalid range' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('coerces numeric DB columns to numbers in response', async () => {
    mockSql.mockResolvedValue([stringRow]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const body = res._json as { spikes: Record<string, unknown>[] };
    const spike = body.spikes[0]!;
    expect(typeof spike.id).toBe('number');
    expect(spike.id).toBe(1);
    expect(typeof spike.dirVegaFlow).toBe('number');
    expect(spike.dirVegaFlow).toBe(5620000);
    expect(typeof spike.zScore).toBe('number');
    expect(spike.zScore).toBe(28.4);
    expect(typeof spike.vsPriorMax).toBe('number');
    expect(spike.vsPriorMax).toBe(4.8);
    expect(typeof spike.priorMax).toBe('number');
    expect(spike.priorMax).toBe(1170000);
    expect(typeof spike.baselineMad).toBe('number');
    expect(spike.baselineMad).toBe(198000);
    expect(typeof spike.barsElapsed).toBe('number');
    expect(spike.barsElapsed).toBe(210);
  });

  it('preserves null forward-return columns', async () => {
    mockSql.mockResolvedValue([stringRow]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const body = res._json as { spikes: Record<string, unknown>[] };
    const spike = body.spikes[0]!;
    expect(spike.fwdReturn5m).toBeNull();
    expect(spike.fwdReturn15m).toBeNull();
    expect(spike.fwdReturn30m).toBeNull();
  });

  it('coerces non-null forward-return values to numbers', async () => {
    const enrichedRow = {
      ...stringRow,
      fwd_return_5m: '0.0042',
      fwd_return_15m: '-0.0011',
      fwd_return_30m: '0',
    };
    mockSql.mockResolvedValue([enrichedRow]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const body = res._json as { spikes: Record<string, unknown>[] };
    const spike = body.spikes[0]!;
    expect(typeof spike.fwdReturn5m).toBe('number');
    expect(spike.fwdReturn5m).toBe(0.0042);
    expect(spike.fwdReturn15m).toBe(-0.0011);
    expect(spike.fwdReturn30m).toBe(0);
  });

  it('transforms snake_case DB columns to camelCase response keys', async () => {
    mockSql.mockResolvedValue([stringRow]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const body = res._json as { spikes: Record<string, unknown>[] };
    const spike = body.spikes[0]!;
    expect(Object.keys(spike).sort()).toEqual(
      [
        'id',
        'ticker',
        'date',
        'timestamp',
        'dirVegaFlow',
        'zScore',
        'vsPriorMax',
        'priorMax',
        'baselineMad',
        'barsElapsed',
        'confluence',
        'fwdReturn5m',
        'fwdReturn15m',
        'fwdReturn30m',
        'insertedAt',
      ].sort(),
    );
    // Confirm snake_case keys are NOT leaked through
    expect(spike).not.toHaveProperty('dir_vega_flow');
    expect(spike).not.toHaveProperty('z_score');
    expect(spike).not.toHaveProperty('vs_prior_max');
    expect(spike).not.toHaveProperty('inserted_at');
  });

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 with generic message when SQL throws', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns empty array when DB has no matching rows', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ spikes: [], range: 'today' });
  });
});
