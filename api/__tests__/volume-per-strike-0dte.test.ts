// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
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
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../volume-per-strike-0dte.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeDbRow(
  overrides: {
    strike?: string;
    timestamp?: string;
    call_volume?: string;
    put_volume?: string;
    call_oi?: string;
    put_oi?: string;
  } = {},
) {
  return {
    strike: '6800.00',
    timestamp: '2026-04-08T15:00:00Z',
    call_volume: '118509',
    put_volume: '5500',
    call_oi: '4864',
    put_oi: '200',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/volume-per-strike-0dte', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
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

  it('returns empty snapshots when date has no data', async () => {
    mockSql
      .mockResolvedValueOnce([{ latest_ts: null }]) // MAX(timestamp)
      .mockResolvedValueOnce([]); // actual rows (not reached)

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-08' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ snapshots: [], date: '2026-04-08' });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('groups rows by timestamp and normalizes numeric fields', async () => {
    const rows = [
      makeDbRow({
        timestamp: '2026-04-08T15:00:00Z',
        strike: '6800',
        call_volume: '118509',
        put_volume: '5500',
      }),
      makeDbRow({
        timestamp: '2026-04-08T15:00:00Z',
        strike: '6750',
        call_volume: '12400',
        put_volume: '65786',
      }),
      makeDbRow({
        timestamp: '2026-04-08T15:01:00Z',
        strike: '6800',
        call_volume: '120000',
        put_volume: '5800',
      }),
      makeDbRow({
        timestamp: '2026-04-08T15:01:00Z',
        strike: '6750',
        call_volume: '12600',
        put_volume: '66100',
      }),
    ];

    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-04-08T15:01:00Z' }])
      .mockResolvedValueOnce(rows);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      snapshots: Array<{
        timestamp: string;
        strikes: Array<{
          strike: number;
          callVolume: number;
          putVolume: number;
          callOi: number;
          putOi: number;
        }>;
      }>;
      date: string;
    };

    expect(body.snapshots).toHaveLength(2);
    expect(body.snapshots[0]!.strikes).toHaveLength(2);

    // Numeric coercion: strings from Postgres → JS numbers
    const firstStrike = body.snapshots[0]!.strikes[0]!;
    expect(typeof firstStrike.strike).toBe('number');
    expect(typeof firstStrike.callVolume).toBe('number');
    expect(typeof firstStrike.putVolume).toBe('number');
    expect(firstStrike.strike).toBe(6800);
    expect(firstStrike.callVolume).toBe(118509);
    expect(firstStrike.putVolume).toBe(5500);
  });

  it('sorts snapshots oldest to newest', async () => {
    const rows = [
      makeDbRow({ timestamp: '2026-04-08T15:02:00Z' }),
      makeDbRow({ timestamp: '2026-04-08T15:00:00Z' }),
      makeDbRow({ timestamp: '2026-04-08T15:01:00Z' }),
    ];

    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-04-08T15:02:00Z' }])
      .mockResolvedValueOnce(rows);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const body = res._json as {
      snapshots: Array<{ timestamp: string }>;
    };
    expect(body.snapshots).toHaveLength(3);
    const timestamps = body.snapshots.map((s) => s.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
  });

  it('uses today ET date when no date param provided', async () => {
    mockSql
      .mockResolvedValueOnce([{ latest_ts: null }])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects malformed date param (falls back to today)', async () => {
    mockSql
      .mockResolvedValueOnce([{ latest_ts: null }])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026/04/08' } }),
      res,
    );
    const body = res._json as { date: string };
    expect(body.date).not.toBe('2026/04/08');
  });

  it('returns 500 on DB error and logs it', async () => {
    mockSql.mockRejectedValue(new Error('DB connection lost'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
