// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryMessage, mockSentryException } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockSentryMessage: vi.fn(),
  mockSentryException: vi.fn(),
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
    captureException: mockSentryException,
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

  it('skips outside the GexBot live window (cronGuard auto-gates via isGexbotLiveCt)', async () => {
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

  it('skips after the cash close (16:30 ET) without querying or warning', async () => {
    // 20:30 UTC = 16:30 ET (15:30 CT). GexBot's snapshot is frozen at the
    // 16:00 ET close, so the upstream fetch crons stop at 16:01 ET — a
    // populate run here would only find stale rows and warn "no fresh row".
    vi.setSystemTime(new Date('2026-05-27T20:30:00.000Z'));
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSentryMessage).not.toHaveBeenCalled();
  });

  it('treats an all-panels miss in the first minutes after the open as a skipped warm-up, not a Sentry warning', async () => {
    // 13:31 UTC = 09:31 ET. The 09:30 populate run races the same-minute
    // strikes insert, so no row falls inside the 5-min staleness window
    // (D9: daily "3 panel(s) failed" at 13:30:16 UTC).
    vi.setSystemTime(new Date('2026-05-27T13:31:00.000Z'));
    mockSql.mockResolvedValue([]); // every panel SELECT: no fresh row
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      rows: 0,
      panelsWritten: 0,
    });
    expect(mockSql).toHaveBeenCalledTimes(3); // 3 SELECTs, no INSERTs
    expect(mockSentryMessage).not.toHaveBeenCalled();
  });

  it('warns again once the warm-up ends (all-panels miss at 09:33 ET)', async () => {
    // Boundary: the warm-up covers 09:30–09:32 ET only (sinceOpen < 3).
    vi.setSystemTime(new Date('2026-05-27T13:33:00.000Z')); // 09:33 ET
    mockSql.mockResolvedValue([]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'partial', panelsWritten: 0 });
    expect(mockSentryMessage).toHaveBeenCalledWith(
      'populate-periscope-from-gexbot: 3 panel(s) failed',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('still warns on an all-panels miss mid-session (11:00 ET)', async () => {
    vi.setSystemTime(new Date('2026-05-27T15:00:00.000Z')); // 11:00 ET
    mockSql.mockResolvedValue([]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'partial', panelsWritten: 0 });
    expect(mockSentryMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryMessage).toHaveBeenCalledWith(
      'populate-periscope-from-gexbot: 3 panel(s) failed',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('still warns on a partial miss during the open warm-up', async () => {
    // Only an ALL-panels miss is the open race; one stale panel at 09:31
    // ET while the others are fresh is a real gap and must page as before.
    vi.setSystemTime(new Date('2026-05-27T13:31:00.000Z'));
    const fresh = new Date(Date.now() - 30_000);
    const payload = { mini_contracts: [[7435, 0, 0, 100, [], 0, null]] };
    mockSql
      .mockResolvedValueOnce([{ captured_at: fresh, raw_response: payload }])
      .mockResolvedValueOnce([{ strike: 7435 }])
      .mockResolvedValueOnce([]) // charm: no fresh row
      .mockResolvedValueOnce([{ captured_at: fresh, raw_response: payload }])
      .mockResolvedValueOnce([{ strike: 7435 }]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'partial', panelsWritten: 2 });
    expect(mockSentryMessage).toHaveBeenCalledWith(
      'populate-periscope-from-gexbot: 1 panel(s) failed',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('returns 500 and reports to Sentry when the periscope_snapshots INSERT rejects', async () => {
    const fresh = new Date(MARKET_TIME.getTime() - 60_000);
    mockSql
      .mockResolvedValueOnce([
        {
          captured_at: fresh,
          raw_response: { mini_contracts: [[7435, 0, 0, 100, [], 0, null]] },
        },
      ])
      .mockRejectedValueOnce(new Error('neon: connection terminated'));
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(mockSentryException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'neon: connection terminated' }),
    );
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
