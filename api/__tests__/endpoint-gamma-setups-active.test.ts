// @vitest-environment node

/**
 * HTTP-level tests for GET /api/gamma-setups/active.
 *
 * Covers method guard, owner-or-guest gate, happy path with NUMERIC
 * coercion + ISO-date shaping, the floor/ceiling derivation from the
 * latest 1-min bar, and DB error → 500.
 *
 * The sibling `gamma-detector.test.ts` covers the pure library
 * functions; this file mocks them and focuses on the request shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
const { TransientDbError } = vi.hoisted(() => {
  class TransientDbError extends Error {
    constructor(cause?: unknown) {
      super('db attempt timeout');
      this.name = 'TransientDbError';
      this.cause = cause;
    }
  }
  return { TransientDbError };
});
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// The gamma-detector module is exercised by its own test file. Here we
// stub the load helpers and pure predicates so the handler shape is the
// only thing under test.
vi.mock('../_lib/gamma-detector.js', () => ({
  loadDayContext: vi.fn(),
  loadPositiveGammaNodes: vi.fn(),
  loadRecentBars: vi.fn(),
  findNearestFloorBelow: vi.fn(),
  findNearestCeilingAbove: vi.fn(),
  getConfidenceTier: vi.fn(),
  getDowLabel: vi.fn(),
}));

// Pin the ET-date helper so tests don't depend on wall-clock time.
vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-21'),
}));

import handler from '../gamma-setups/active.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import {
  loadDayContext,
  loadPositiveGammaNodes,
  loadRecentBars,
  findNearestFloorBelow,
  findNearestCeilingAbove,
  getConfidenceTier,
  getDowLabel,
} from '../_lib/gamma-detector.js';

// ── Fixtures ──────────────────────────────────────────────

function defaultDayContext() {
  return {
    today: '2026-05-21',
    dow_label: 'Thursday' as const,
    day_open: 7400,
    prior_close: 7390,
    open_gap_pct: 0.135,
    prior_5d_ret: 0.004,
    prior_iv_rank: 18,
    pre_day_filter_fires: false,
    is_fomc_day: false,
    is_dom_1_5: false,
    is_dom_16_20: false,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/gamma-setups/active', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(loadDayContext).mockReset();
    vi.mocked(loadPositiveGammaNodes).mockReset();
    vi.mocked(loadRecentBars).mockReset();
    vi.mocked(findNearestFloorBelow).mockReset();
    vi.mocked(findNearestCeilingAbove).mockReset();
    vi.mocked(getConfidenceTier).mockReset();
    vi.mocked(getDowLabel).mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when the owner-or-guest guard rejects', async () => {
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
    expect(vi.mocked(loadDayContext)).not.toHaveBeenCalled();
  });

  it('returns empty fires + null floor/ceiling when no bars exist', async () => {
    vi.mocked(getDowLabel).mockReturnValue('Thursday');
    vi.mocked(getConfidenceTier).mockReturnValue('MEDIUM');
    vi.mocked(loadDayContext).mockResolvedValue(defaultDayContext());
    vi.mocked(loadPositiveGammaNodes).mockResolvedValue([]);
    vi.mocked(loadRecentBars).mockResolvedValue([]);
    mockSql.mockResolvedValueOnce([]); // fires query

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      today: string;
      dow_label: string | null;
      confidence_tier: string | null;
      fires: unknown[];
      nearest_floor: unknown;
      nearest_ceiling: unknown;
    };
    expect(body.today).toBe('2026-05-21');
    expect(body.dow_label).toBe('Thursday');
    expect(body.confidence_tier).toBe('MEDIUM');
    expect(body.fires).toEqual([]);
    expect(body.nearest_floor).toBeNull();
    expect(body.nearest_ceiling).toBeNull();
    expect(findNearestFloorBelow).not.toHaveBeenCalled();
    expect(findNearestCeilingAbove).not.toHaveBeenCalled();
  });

  it('coerces NUMERIC strings to numbers and Date to ISO on the happy path', async () => {
    vi.mocked(getDowLabel).mockReturnValue('Monday');
    vi.mocked(getConfidenceTier).mockReturnValue('MAXIMUM');
    vi.mocked(loadDayContext).mockResolvedValue({
      ...defaultDayContext(),
      dow_label: 'Monday',
      pre_day_filter_fires: true,
      is_fomc_day: true,
    });
    vi.mocked(loadPositiveGammaNodes).mockResolvedValue([
      { strike: 7390, value: 250_000 },
      { strike: 7415, value: 400_000 },
    ]);
    vi.mocked(loadRecentBars).mockResolvedValue([
      {
        timestamp: new Date('2026-05-21T18:00:00Z'),
        open: 7398,
        high: 7405,
        low: 7397,
        close: 7402,
      },
    ]);
    vi.mocked(findNearestFloorBelow).mockReturnValue({
      strike: 7390,
      value: 250_000,
    });
    vi.mocked(findNearestCeilingAbove).mockReturnValue({
      strike: 7415,
      value: 400_000,
    });

    // The fires query returns Neon-shaped rows (NUMERIC → strings,
    // timestamp → Date). The handler must coerce both.
    mockSql.mockResolvedValueOnce([
      {
        id: '7',
        fired_at: new Date('2026-05-21T14:30:00Z'),
        signal_type: 'e1_long_call',
        dow_label: 'Monday',
        confidence_tier: 'MAXIMUM',
        spot_at_fire: '7401.25',
        node_strike: 7400,
        node_gex: '300000',
        bar_open: '7395.5',
        bar_high: '7402.0',
        bar_low: '7394.0',
        bar_close: '7401.25',
        bar_range: '8.0',
        es_basis_change_5m: '0.5',
        ret_15m: null,
        ret_30m: '0.0012',
        ret_60m: null,
        ret_eod: null,
        trade_taken: false,
        trade_pnl_dollars: null,
      },
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      confidence_tier: string;
      pre_day_filter_fires: boolean;
      anti_filters: {
        is_fomc_day: boolean;
        is_dom_1_5: boolean;
        is_dom_16_20: boolean;
      };
      nearest_floor: { strike: number; gex: number } | null;
      nearest_ceiling: { strike: number; gex: number } | null;
      fires: Array<{
        id: number;
        fired_at: string;
        spot_at_fire: number;
        node_gex: number;
        bar_open: number;
        es_basis_change_5m: number | null;
        ret_15m: number | null;
        ret_30m: number | null;
        trade_pnl_dollars: number | null;
      }>;
    };

    expect(body.confidence_tier).toBe('MAXIMUM');
    expect(body.pre_day_filter_fires).toBe(true);
    expect(body.anti_filters.is_fomc_day).toBe(true);
    expect(body.nearest_floor).toEqual({ strike: 7390, gex: 250_000 });
    expect(body.nearest_ceiling).toEqual({ strike: 7415, gex: 400_000 });

    expect(body.fires).toHaveLength(1);
    const fire = body.fires[0]!;
    expect(typeof fire.id).toBe('number');
    expect(fire.id).toBe(7);
    expect(fire.fired_at).toBe('2026-05-21T14:30:00.000Z');
    expect(fire.spot_at_fire).toBe(7401.25);
    expect(fire.node_gex).toBe(300_000);
    expect(fire.bar_open).toBe(7395.5);
    expect(fire.es_basis_change_5m).toBe(0.5);
    expect(fire.ret_15m).toBeNull();
    expect(fire.ret_30m).toBeCloseTo(0.0012, 6);
    expect(fire.trade_pnl_dollars).toBeNull();

    // The handler used the latest bar's close to derive floor/ceiling.
    const floorCall = vi.mocked(findNearestFloorBelow).mock.calls[0];
    expect(floorCall?.[1]).toBe(7402);
    const ceilCall = vi.mocked(findNearestCeilingAbove).mock.calls[0];
    expect(ceilCall?.[1]).toBe(7402);
  });

  it('returns null confidence_tier on weekends (no DOW)', async () => {
    vi.mocked(getDowLabel).mockReturnValue(null);
    vi.mocked(loadDayContext).mockResolvedValue({
      ...defaultDayContext(),
      dow_label: null,
    });
    vi.mocked(loadPositiveGammaNodes).mockResolvedValue([]);
    vi.mocked(loadRecentBars).mockResolvedValue([]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      dow_label: string | null;
      confidence_tier: string | null;
    };
    expect(body.dow_label).toBeNull();
    expect(body.confidence_tier).toBeNull();
    expect(getConfidenceTier).not.toHaveBeenCalled();
  });

  it('returns 500 and captures exception on DB error', async () => {
    vi.mocked(getDowLabel).mockReturnValue('Tuesday');
    vi.mocked(loadDayContext).mockRejectedValueOnce(
      new Error('connection refused'),
    );
    vi.mocked(loadPositiveGammaNodes).mockResolvedValue([]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('returns 503 + Retry-After on a transient DB error', async () => {
    vi.mocked(getDowLabel).mockReturnValue('Tuesday');
    vi.mocked(loadDayContext).mockRejectedValueOnce(new TransientDbError());
    vi.mocked(loadPositiveGammaNodes).mockResolvedValue([]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(503);
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
    expect(res._headers['Retry-After']).toBe('5');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
