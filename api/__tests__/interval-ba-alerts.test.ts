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

import getHandler, { _internal } from '../interval-ba-alerts.js';
import ackHandler from '../interval-ba-alerts-ack.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// Single raw row matching the migration #144 column shape — NUMERIC
// columns arrive from Neon as strings, dates as Date instances. The
// endpoint coerces both into JS-native values before responding.
const RAW_ROW = {
  id: 42,
  option_chain: 'SPXW260512C07360000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: '7360.000',
  expiry: new Date('2026-05-12T00:00:00Z'),
  bucket_start: new Date('2026-05-12T17:05:00Z'),
  bucket_end: new Date('2026-05-12T17:10:00Z'),
  fired_at: new Date('2026-05-12T17:06:24Z'),
  ratio_pct: '71.23',
  ask_premium: '950000.00',
  total_premium: '1330000.00',
  trade_count: 5,
  top_trade_premium: '408480.00',
  top_trade_size: 888,
  top_trade_executed_at: new Date('2026-05-12T17:06:23Z'),
  top_trade_is_sweep: true,
  top_trade_is_floor: false,
  underlying_price: '7355.00',
  acknowledged: false,
};

describe('GET /api/interval-ba-alerts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await getHandler(mockRequest({ method: 'POST' }), res);
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
    await getHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 for non-owner (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await getHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns shaped alerts for today when no since param', async () => {
    mockSql.mockResolvedValue([RAW_ROW]);

    const res = mockResponse();
    await getHandler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { alerts: Record<string, unknown>[] };
    expect(body.alerts).toHaveLength(1);
    const alert = body.alerts[0]!;
    // NUMERIC columns coerced to JS numbers.
    expect(alert.strike).toBe(7360);
    expect(alert.ratio_pct).toBe(71.23);
    expect(alert.ask_premium).toBe(950000);
    expect(alert.total_premium).toBe(1330000);
    expect(alert.top_trade_premium).toBe(408480);
    expect(alert.underlying_price).toBe(7355);
    // Date columns ISO-stringified.
    expect(alert.bucket_start).toBe('2026-05-12T17:05:00.000Z');
    expect(alert.expiry).toBe('2026-05-12');
    // Severity derived from total_premium >= $1M → extreme.
    expect(alert.severity).toBe('extreme');
    // Identity fields pass through.
    expect(alert.option_chain).toBe('SPXW260512C07360000');
    expect(alert.option_type).toBe('C');
    expect(alert.top_trade_is_sweep).toBe(true);
  });

  it('uses ?since= branch when timestamp provided', async () => {
    mockSql.mockResolvedValue([]);
    const since = '2026-05-12T17:00:00Z';

    const res = mockResponse();
    await getHandler(mockRequest({ method: 'GET', query: { since } }), res);

    expect(res._status).toBe(200);
    // The SQL tag receives the raw template — we just assert it was called
    // (one call to sql for the query). Branch selection is exercised by
    // not crashing on the alt path.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await getHandler(mockRequest({ method: 'GET' }), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns { alerts: [] } when no rows', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await getHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ alerts: [] });
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);
    const res = mockResponse();
    await getHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('preserves null top_trade_* and underlying_price', async () => {
    mockSql.mockResolvedValue([
      {
        ...RAW_ROW,
        top_trade_premium: null,
        top_trade_size: null,
        top_trade_executed_at: null,
        top_trade_is_sweep: null,
        top_trade_is_floor: null,
        underlying_price: null,
      },
    ]);
    const res = mockResponse();
    await getHandler(mockRequest({ method: 'GET' }), res);
    const body = res._json as { alerts: Record<string, unknown>[] };
    const alert = body.alerts[0]!;
    expect(alert.top_trade_premium).toBeNull();
    expect(alert.top_trade_size).toBeNull();
    expect(alert.top_trade_executed_at).toBeNull();
    expect(alert.underlying_price).toBeNull();
  });
});

describe('severity derivation', () => {
  it('< $500K → warning', () => {
    expect(_internal.deriveSeverity(250_000)).toBe('warning');
    expect(_internal.deriveSeverity(499_999)).toBe('warning');
  });

  it('$500K <= total < $1M → critical', () => {
    expect(_internal.deriveSeverity(500_000)).toBe('critical');
    expect(_internal.deriveSeverity(999_999)).toBe('critical');
  });

  it('>= $1M → extreme', () => {
    expect(_internal.deriveSeverity(1_000_000)).toBe('extreme');
    expect(_internal.deriveSeverity(5_000_000)).toBe('extreme');
  });
});

describe('POST /api/interval-ba-alerts-ack', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 401 for non-owner-and-non-guest (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', body: { id: 1 } }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid body (no id)', async () => {
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', body: {} }), res);
    expect(res._status).toBe(400);
    const body = res._json as { error: string; issues?: unknown };
    expect(body.error).toBe('Invalid request body');
    expect(body.issues).toBeDefined();
  });

  it('returns 400 for non-integer id', async () => {
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', body: { id: 1.5 } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for negative id', async () => {
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', body: { id: -1 } }), res);
    expect(res._status).toBe(400);
  });

  it('acknowledges and returns id when row exists', async () => {
    mockSql.mockResolvedValue([{ id: 42 }]);
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', body: { id: 42 } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ acknowledged: 42 });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 404 when row missing', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', body: { id: 999 } }), res);
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'Alert not found' });
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', body: { id: 1 } }), res);
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });
});
