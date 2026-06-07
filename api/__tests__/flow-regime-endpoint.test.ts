// @vitest-environment node

/**
 * Tests for GET /api/flow-regime (Flow Regime Recognition badge read
 * endpoint).
 *
 * Covers:
 *   - Auth guard: when guardOwnerOrGuestEndpoint rejects, the handler
 *     returns immediately and never queries the DB.
 *   - Response shape: { date, slots, latest } with NUMERIC-as-string
 *     coercion and slot-ascending ordering; latest = the highest slot.
 *   - Empty day: no captured rows → empty series + null latest.
 *   - 400 on an invalid date query.
 *
 * Phase 2 of docs/superpowers/specs/flow-regime-badge-2026-06-06.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGuard, mockSetCache } = vi.hoisted(() => ({
  mockGuard: vi.fn(),
  mockSetCache: vi.fn(),
}));
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: mockSetCache,
}));

import handler from '../flow-regime.js';

const DATE = '2026-06-05';

/** One flow_regime_snapshots row as Neon returns it (NUMERIC → string). */
function snapRow(slot: number, regime: string, color: string) {
  return {
    date: DATE,
    slot,
    computed_at: '2026-06-05T14:05:00.000Z',
    nd_tilt: '-0.1234',
    idx0dte_put_share: '0.4567',
    nd_percentile: '8.5',
    idxput_percentile: '92.1',
    regime,
    color,
    n_trades: 1234,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue(false);
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

describe('flow-regime endpoint', () => {
  it('early-exits (no DB, no cache header) when the guard rejects', async () => {
    mockGuard.mockResolvedValue(true); // rejected — response already sent

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('returns the slot series + latest snapshot with coerced numbers', async () => {
    mockSql.mockResolvedValueOnce([
      snapRow(0, 'normal', 'gray'),
      snapRow(1, 'caution', 'amber'),
      snapRow(2, 'bearish', 'red'),
    ]);

    const req = mockRequest({ method: 'GET', query: { date: DATE } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      slots: Array<{
        slot: number;
        ndTilt: number | null;
        idxputPercentile: number | null;
        regime: string;
      }>;
      latest: { slot: number; regime: string } | null;
    };
    expect(body.date).toBe(DATE);
    expect(body.slots).toHaveLength(3);
    // NUMERIC string '-0.1234' coerced to number.
    expect(body.slots[0]?.ndTilt).toBe(-0.1234);
    expect(typeof body.slots[0]?.ndTilt).toBe('number');
    expect(body.slots[2]?.idxputPercentile).toBe(92.1);
    // latest = highest slot (2 → bearish).
    expect(body.latest?.slot).toBe(2);
    expect(body.latest?.regime).toBe('bearish');
    // 15s edge + 15s SWR cache header set.
    expect(mockSetCache).toHaveBeenCalledWith(res, 15, 15);
  });

  it('returns an empty series + null latest when no rows are captured', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: DATE } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      slots: unknown[];
      latest: unknown;
    };
    expect(body.slots).toEqual([]);
    expect(body.latest).toBeNull();
  });

  it('returns 400 on an invalid date format', async () => {
    const req = mockRequest({ method: 'GET', query: { date: 'not-a-date' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = res._json as { error: string };
    expect(body.error).toBe('invalid query');
    expect(mockSql).not.toHaveBeenCalled();
  });
});
