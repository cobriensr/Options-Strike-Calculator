// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryMessage } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockSentryMessage: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: mockSentryMessage,
  },
  metrics: {},
}));

import handler, {
  decodeStrikes,
} from '../cron/populate-periscope-from-gexbot.js';

// Pick a Wednesday during RTH so isMarketHours() passes.
const MARKET_TIME = new Date('2026-05-27T18:00:00.000Z'); // 1pm CT Wed
const WEEKEND_TIME = new Date('2026-05-30T18:00:00.000Z'); // Sat

describe('decodeStrikes', () => {
  it('extracts strike + position-3 value from each mini_contract row', () => {
    const payload = {
      spot: 7513.32,
      mini_contracts: [
        [7375, 0, 0, 55.75, [75.14, 78.34, 77.22], 0, null],
        [7435, 1.158, 1.633, 6500.28, [3655.85, 2920.21, 1216.2], 0, null],
        [7290, 0, 0, -1295.76, [-3509.44, -2211.96, 286.84], 0, null],
      ],
    };
    const out = decodeStrikes(payload);
    expect(out).toEqual([
      { strike: 7375, value: 55.75 },
      { strike: 7435, value: 6500.28 },
      { strike: 7290, value: -1295.76 },
    ]);
  });

  it('rounds non-integer strikes (defensive, GEXBot uses integers)', () => {
    const out = decodeStrikes({
      mini_contracts: [[7435.4, 0, 0, 42, [], 0, null]],
    });
    expect(out).toEqual([{ strike: 7435, value: 42 }]);
  });

  it('drops rows where strike or value is non-finite', () => {
    const out = decodeStrikes({
      mini_contracts: [
        [7435, 0, 0, NaN, [], 0, null],
        [null, 0, 0, 100, [], 0, null],
        [7290, 0, 0, 100, [], 0, null],
      ],
    });
    expect(out).toEqual([{ strike: 7290, value: 100 }]);
  });

  it('returns empty array on missing or non-array mini_contracts', () => {
    expect(decodeStrikes({})).toEqual([]);
    expect(decodeStrikes({ mini_contracts: undefined })).toEqual([]);
    expect(decodeStrikes({ mini_contracts: 'oops' as unknown as [] })).toEqual(
      [],
    );
  });

  it('drops rows shorter than 4 elements', () => {
    const out = decodeStrikes({
      mini_contracts: [
        [7435, 0, 0], // too short
        [7290, 0, 0, 100, []],
      ],
    });
    expect(out).toEqual([{ strike: 7290, value: 100 }]);
  });
});

describe('populate-periscope-from-gexbot handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it('skips outside market hours (cronGuard auto-gates)', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  it('rejects without CRON_SECRET', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('writes 3 panels when all GEXBot captures are fresh', async () => {
    const freshTimestamp = new Date(MARKET_TIME.getTime() - 60_000); // 1 min ago
    const samplePayload = {
      spot: 7513.32,
      mini_contracts: [
        [7375, 0, 0, 55.75, [], 0, null],
        [7435, 1.16, 1.63, 6500.28, [], 0, null],
      ],
    };
    // SELECT returns one row per panel; INSERT RETURNING returns inserted strikes.
    mockSql
      .mockResolvedValueOnce([
        { captured_at: freshTimestamp, raw_response: samplePayload },
      ]) // SELECT gamma_zero
      .mockResolvedValueOnce([{ strike: 7375 }, { strike: 7435 }]) // INSERT gamma
      .mockResolvedValueOnce([
        { captured_at: freshTimestamp, raw_response: samplePayload },
      ])
      .mockResolvedValueOnce([{ strike: 7375 }, { strike: 7435 }])
      .mockResolvedValueOnce([
        { captured_at: freshTimestamp, raw_response: samplePayload },
      ])
      .mockResolvedValueOnce([{ strike: 7375 }, { strike: 7435 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 6,
      panelsWritten: 3,
    });
    // 3 SELECTs + 3 INSERTs = 6 SQL calls
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('reports partial status when some panels missing fresh data', async () => {
    const freshTimestamp = new Date(MARKET_TIME.getTime() - 60_000);
    const samplePayload = {
      mini_contracts: [[7435, 0, 0, 100, [], 0, null]],
    };
    mockSql
      .mockResolvedValueOnce([
        { captured_at: freshTimestamp, raw_response: samplePayload },
      ])
      .mockResolvedValueOnce([{ strike: 7435 }])
      .mockResolvedValueOnce([]) // charm: no fresh row
      .mockResolvedValueOnce([
        { captured_at: freshTimestamp, raw_response: samplePayload },
      ])
      .mockResolvedValueOnce([{ strike: 7435 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'partial', panelsWritten: 2 });
    expect(mockSentryMessage).toHaveBeenCalled();
  });
});
