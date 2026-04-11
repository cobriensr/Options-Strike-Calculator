// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn(),
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

import handler from '../greek-exposure-strike.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Fixture ──────────────────────────────────────────────────────────

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    strike: '6800',
    dte: '0',
    call_gex: '6105.14',
    put_gex: '-699.92',
    call_delta: '394699.33',
    put_delta: '-75428.08',
    call_charm: '-1025514.46',
    put_charm: '-117569.10',
    call_vanna: '165653.14',
    put_vanna: '18991.20',
    net_gex: '5405.22',
    net_delta: '319271.25',
    net_charm: '-1143083.56',
    net_vanna: '184644.34',
    abs_gex: '6805.06',
    call_gex_fraction: '0.8972',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('GET /api/greek-exposure-strike', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    mockSql.mockReset();
  });

  // ── Method guard ──────────────────────────────────────────────────

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Bot check ─────────────────────────────────────────────────────

  it('returns 403 when checkBot identifies a bot', async () => {
    vi.mocked(checkBot).mockResolvedValue({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Auth guard ────────────────────────────────────────────────────

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

  // ── Query param parsing ───────────────────────────────────────────

  it('uses a valid date query param', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-10' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect((res._json as { date: string }).date).toBe('2026-04-10');
  });

  it('falls back to today ET when date format is invalid', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'not-a-date' } }),
      res,
    );
    expect(res._status).toBe(200);
    const { date } = res._json as { date: string };
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(date).not.toBe('not-a-date');
  });

  it('uses a valid expiry query param separate from date', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-04-10', expiry: '2026-04-17' },
      }),
      res,
    );
    const body = res._json as { date: string; expiry: string };
    expect(body.date).toBe('2026-04-10');
    expect(body.expiry).toBe('2026-04-17');
  });

  it('defaults expiry to date when expiry param is omitted', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-10' } }),
      res,
    );
    const body = res._json as { date: string; expiry: string };
    expect(body.expiry).toBe('2026-04-10');
  });

  it('defaults expiry to date when expiry format is invalid', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-04-10', expiry: 'bad-expiry' },
      }),
      res,
    );
    expect((res._json as { expiry: string }).expiry).toBe('2026-04-10');
  });

  // ── Empty result ──────────────────────────────────────────────────

  it('returns 200 with empty strikes array when no rows found', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { strikes: unknown[] };
    expect(body.strikes).toEqual([]);
  });

  // ── Row mapping ───────────────────────────────────────────────────

  it('maps DB columns to camelCase and converts string values to numbers', async () => {
    mockSql.mockResolvedValueOnce([makeDbRow()]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-10' } }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as { strikes: Array<Record<string, unknown>> };
    expect(body.strikes).toHaveLength(1);
    const s = body.strikes[0]!;

    expect(s.strike).toBe(6800);
    expect(s.dte).toBe(0);
    expect(typeof s.callGex).toBe('number');
    expect(typeof s.putGex).toBe('number');
    expect(typeof s.callDelta).toBe('number');
    expect(typeof s.putDelta).toBe('number');
    expect(typeof s.callCharm).toBe('number');
    expect(typeof s.putCharm).toBe('number');
    expect(typeof s.callVanna).toBe('number');
    expect(typeof s.putVanna).toBe('number');
    expect(typeof s.netGex).toBe('number');
    expect(typeof s.netDelta).toBe('number');
    expect(typeof s.netCharm).toBe('number');
    expect(typeof s.netVanna).toBe('number');
    expect(typeof s.absGex).toBe('number');
    expect(typeof s.callGexFraction).toBe('number');
  });

  it('maps null DB values to null via parseNum', async () => {
    mockSql.mockResolvedValueOnce([
      makeDbRow({ call_gex: null, call_gex_fraction: null }),
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-10' } }),
      res,
    );
    const s = (res._json as { strikes: Array<Record<string, unknown>> })
      .strikes[0]!;
    expect(s.callGex).toBeNull();
    expect(s.callGexFraction).toBeNull();
  });

  it('returns correct numeric values for a known DB row', async () => {
    mockSql.mockResolvedValueOnce([makeDbRow()]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-10' } }),
      res,
    );
    const s = (res._json as { strikes: Array<Record<string, unknown>> })
      .strikes[0]!;
    expect(s.strike).toBe(6800);
    expect(s.callGex).toBeCloseTo(6105.14);
    expect(s.putGex).toBeCloseTo(-699.92);
    expect(s.netGex).toBeCloseTo(5405.22);
    expect(s.callGexFraction).toBeCloseTo(0.8972);
  });

  it('returns multiple rows ordered as received from DB', async () => {
    mockSql.mockResolvedValueOnce([
      makeDbRow({ strike: '5800' }),
      makeDbRow({ strike: '5900' }),
      makeDbRow({ strike: '6000' }),
    ]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    const strikes = (res._json as { strikes: Array<{ strike: number }> })
      .strikes;
    expect(strikes).toHaveLength(3);
    expect(strikes.map((s) => s.strike)).toEqual([5800, 5900, 6000]);
  });

  // ── Response headers ──────────────────────────────────────────────

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  // ── Error handling ────────────────────────────────────────────────

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

  // ── Sentry scope ──────────────────────────────────────────────────

  it('sets transaction name on Sentry scope', async () => {
    const setTransactionName = vi.fn();
    (
      Sentry.withIsolationScope as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(
      (cb: (scope: { setTransactionName: typeof setTransactionName }) => unknown) =>
        cb({ setTransactionName }),
    );
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(setTransactionName).toHaveBeenCalledWith(
      'GET /api/greek-exposure-strike',
    );
  });
});
