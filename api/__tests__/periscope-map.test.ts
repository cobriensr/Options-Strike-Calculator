// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryCapture, TransientDbError } = vi.hoisted(() => {
  class TransientDbError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TransientDbError';
    }
  }
  return {
    mockSql: vi.fn(),
    mockSentryCapture: vi.fn(),
    TransientDbError,
  };
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockSentryCapture,
    captureMessage: vi.fn(),
    withScope: (fn: (s: { setTransactionName: () => void }) => unknown) =>
      fn({ setTransactionName: vi.fn() }),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn(async () => false),
}));

vi.mock('../_lib/api-helpers.js', async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    setCacheHeaders: vi.fn(),
    isMarketOpen: vi.fn(() => true),
  };
});

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-26'),
}));

import handler from '../periscope-map.js';

const PAYLOAD = {
  mini_contracts: [
    [7510, 0, 0, 500_000, [], 0, null],
    [7520, 1, 1, 1_250_000, [], 0, null],
    [7505, 0, 0, -800_000, [], 0, null],
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = 'test-secret';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/api/periscope-map', () => {
  it('returns reason:no_slot + empty data when no fresh gexbot row', async () => {
    // 1 SELECT per panel (gamma/charm/vanna) — all return []. Then a
    // SELECT for fetchAvailableSlots — returns []. ALL must be mocked
    // because handler returns early after panel-1 miss but the
    // availableSlots SELECT was already issued.
    mockSql.mockResolvedValue([]); // catches every call
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      data: null,
      reason: 'no_slot',
      availableSlots: [],
    });
  });

  it('returns reason:no_spot when fresh gexbot exists but no SPX candle', async () => {
    const capturedAt = new Date(Date.now() - 60_000);
    // mockSql is queried in this order:
    //   1) fetchAvailableSlots SELECT (returns [])
    //   2-4) latest gexbot per panel × 3
    //   5) fetchSpxSpot SELECT (returns [])
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ]) // gamma
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ]) // charm
      .mockResolvedValueOnce([
        { captured_at: capturedAt, raw_response: PAYLOAD },
      ]) // vanna
      .mockResolvedValueOnce([]); // SPX spot
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ data: null, reason: 'no_spot' });
  });

  it('returns populated data + ageSec + priorAvailable on a complete fetch', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000); // 30s ago
    const priorAt = new Date(Date.now() - 12 * 60 * 1000); // 12 min ago
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }]) // gamma latest
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }]) // charm latest
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }]) // vanna latest
      .mockResolvedValueOnce([{ close: '7515' }]) // SPX spot
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }]) // gamma prior
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }]) // charm prior
      .mockResolvedValueOnce([{ captured_at: priorAt, raw_response: PAYLOAD }]) // vanna prior
      .mockResolvedValueOnce([]) // cone levels
      // no cone => no cone-breaches query issued
      .mockResolvedValueOnce([]); // (fallthrough for safety)
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.data).not.toBeNull();
    expect(typeof body.ageSec).toBe('number');
    expect(body.ageSec).toBeGreaterThanOrEqual(0);
    expect(body.priorAvailable).toBe(true);
  });

  it('returns 503 + Retry-After on a transient DB error', async () => {
    mockSql.mockRejectedValue(new TransientDbError('db attempt timeout'));
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    const body = res._json as { transient?: boolean };
    expect(body.transient).toBe(true);
  });

  it('returns 500 on a generic DB error', async () => {
    mockSql.mockRejectedValue(new Error('Neon pool exhausted'));
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('sets priorAvailable=false when no qualifying prior slice exists', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    mockSql
      .mockResolvedValueOnce([]) // availableSlots
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ captured_at: latestAt, raw_response: PAYLOAD }])
      .mockResolvedValueOnce([{ close: '7515' }])
      .mockResolvedValueOnce([]) // prior gamma — no row in 10-30 min window
      .mockResolvedValue([]); // every remaining call → []
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.priorAvailable).toBe(false);
  });
});
