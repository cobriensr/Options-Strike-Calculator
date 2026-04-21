// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from '../helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn(async () => ({ isBot: false })),
  isMarketOpen: vi.fn(() => false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      res.setHeader('Vary', 'Cookie');
    },
  ),
}));

const mockSql = vi.fn();
vi.mock('../../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../../push/recent-events.js';
import { rejectIfNotOwner, checkBot } from '../../_lib/api-helpers.js';
import { Sentry } from '../../_lib/sentry.js';
import logger from '../../_lib/logger.js';

// ── Fixtures ─────────────────────────────────────────────

const SAMPLE_ROWS = [
  {
    id: 42,
    ts: new Date('2026-04-20T20:00:00.000Z'),
    type: 'REGIME_FLIP',
    severity: 'urgent',
    title: 'Regime flip: POSITIVE → NEGATIVE',
    body: 'Net GEX flipped negative — dealers amplify moves.',
    delivered_count: 2,
  },
  {
    id: 41,
    ts: new Date('2026-04-20T19:45:00.000Z'),
    type: 'LEVEL_BREACH',
    severity: 'urgent',
    title: 'call wall broken at 5830.00',
    body: 'ES 5832.00 has broken through the call wall (5830.00).',
    delivered_count: 2,
  },
];

// ── Tests ────────────────────────────────────────────────

describe('GET /api/push/recent-events', () => {
  beforeEach(() => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    mockSql.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 403 when botid detects a bot', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects non-numeric limit with 400', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { limit: 'abc' } }), res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects limit above 100 with 400', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { limit: '500' } }), res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects limit below 1 with 400', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { limit: '0' } }), res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns rows with ISO timestamps and numeric delivered_count (happy path)', async () => {
    mockSql.mockResolvedValueOnce(SAMPLE_ROWS);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);

    const payload = res._json as {
      events: Array<Record<string, unknown>>;
    };
    expect(payload.events).toHaveLength(2);
    expect(payload.events[0]).toMatchObject({
      id: 42,
      ts: '2026-04-20T20:00:00.000Z',
      type: 'REGIME_FLIP',
      severity: 'urgent',
      delivered_count: 2,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._headers['Cache-Control']).toContain('s-maxage=');
  });

  it('returns an empty array when the table is empty', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ events: [] });
  });

  it('coerces delivered_count strings to integers', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...SAMPLE_ROWS[0],
        delivered_count: '5',
      },
    ]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    const payload = res._json as {
      events: Array<{ delivered_count: number }>;
    };
    expect(payload.events[0]?.delivered_count).toBe(5);
  });

  it('returns 500 on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });
});
