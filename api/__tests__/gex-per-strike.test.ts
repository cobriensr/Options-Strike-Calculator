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

import handler from '../gex-per-strike.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeDbRow(overrides = {}) {
  return {
    strike: '5800.00',
    price: '5795.00',
    call_gamma_oi: '500000000000',
    put_gamma_oi: '-300000000000',
    call_gamma_vol: '100000000000',
    put_gamma_vol: '-50000000000',
    call_gamma_ask: '-100000000',
    call_gamma_bid: '200000000',
    put_gamma_ask: '50000000',
    put_gamma_bid: '-150000000',
    call_charm_oi: '1000000000',
    put_charm_oi: '-800000000',
    call_charm_vol: '500000000',
    put_charm_vol: '-400000000',
    call_delta_oi: '5000000000',
    put_delta_oi: '-3000000000',
    call_vanna_oi: '100000000',
    put_vanna_oi: '-60000000',
    call_vanna_vol: '50000000',
    put_vanna_vol: '-30000000',
    timestamp: '2026-04-02T15:00:00Z',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/gex-per-strike', () => {
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

  it('uses date query param when provided', async () => {
    mockSql.mockResolvedValueOnce([
      { latest_ts: '2026-03-28T15:00:00Z' },
    ]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-28' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toBe('2026-03-28');
  });

  it('rejects invalid date format', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'not-a-date' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    // Falls back to today ET
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty strikes when no data for date', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: unknown[];
      timestamp: unknown;
    };
    expect(body.strikes).toEqual([]);
    expect(body.timestamp).toBeNull();
  });

  it('returns strikes with computed netGamma and netCharm', async () => {
    mockSql.mockResolvedValueOnce([
      { latest_ts: '2026-04-02T15:00:00Z' },
    ]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<Record<string, unknown>>;
      timestamp: string;
    };
    expect(body.strikes).toHaveLength(1);
    expect(body.timestamp).toBe('2026-04-02T15:00:00Z');

    const strike = body.strikes[0]!;
    expect(strike.strike).toBe(5800);
    expect(strike.price).toBe(5795);
    expect(strike.callGammaOi).toBe(500_000_000_000);
    expect(strike.putGammaOi).toBe(-300_000_000_000);
    // netGamma = callGammaOi + putGammaOi
    expect(strike.netGamma).toBe(200_000_000_000);
    // netCharm = callCharmOi + putCharmOi
    expect(strike.netCharm).toBe(200_000_000);
    // Vol fields
    expect(strike.callGammaVol).toBe(100_000_000_000);
    expect(strike.netGammaVol).toBe(50_000_000_000);
    // Vol reinforcement: OI net=+200B, vol net=+50B → same sign → reinforcing
    expect(strike.volReinforcement).toBe('reinforcing');
    // DEX
    expect(strike.netDelta).toBe(2_000_000_000);
    // Vanna
    expect(strike.netVanna).toBe(40_000_000);
  });

  it('converts string DB values to numbers', async () => {
    mockSql.mockResolvedValueOnce([
      { latest_ts: '2026-04-02T15:00:00Z' },
    ]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const strike = (
      res._json as { strikes: Array<Record<string, unknown>> }
    ).strikes[0]!;
    expect(typeof strike.strike).toBe('number');
    expect(typeof strike.price).toBe('number');
    expect(typeof strike.callGammaOi).toBe('number');
    expect(typeof strike.putGammaOi).toBe('number');
    expect(typeof strike.netGamma).toBe('number');
    expect(typeof strike.callCharmOi).toBe('number');
    expect(typeof strike.netCharm).toBe('number');
    expect(typeof strike.netDelta).toBe('number');
    expect(typeof strike.netVanna).toBe('number');
    expect(typeof strike.netGammaVol).toBe('number');
    expect(typeof strike.volReinforcement).toBe('string');
  });

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('calls scope.setTransactionName', async () => {
    const setTransactionName = vi.fn();
    (
      Sentry.withIsolationScope as ReturnType<typeof vi.fn>
    ).mockImplementation(
      (
        cb: (scope: {
          setTransactionName: typeof setTransactionName;
        }) => unknown,
      ) => cb({ setTransactionName }),
    );
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(setTransactionName).toHaveBeenCalledWith(
      'GET /api/gex-per-strike',
    );
  });
});
