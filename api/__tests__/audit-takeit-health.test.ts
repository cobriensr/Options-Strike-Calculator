// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = Object.assign(vi.fn(), {
  unsafe: vi.fn((raw: string) => raw),
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
    withIsolationScope: vi.fn((cb: (scope: object) => unknown) =>
      cb({ setTransactionName: vi.fn() }),
    ),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

vi.mock('../_lib/cron-instrumentation.js', () => ({
  withCronCheckin: (_name: string, fn: unknown) => fn,
}));

import handler from '../cron/audit-takeit-health.js';
import { Sentry } from '../_lib/sentry.js';

const GUARD = { apiKey: '', today: '2026-05-27' };

beforeEach(() => {
  vi.clearAllMocks();
  mockCronGuard.mockReturnValue(GUARD);
  mockSql.unsafe.mockImplementation((raw: string) => raw);
  process.env.CRON_SECRET = 'test-secret';
});

describe('audit-takeit-health cron', () => {
  it('rejects requests when cronGuard returns null', async () => {
    mockCronGuard.mockImplementationOnce(
      (
        _req: unknown,
        res: { status: (code: number) => { json: (v: unknown) => unknown } },
      ) => {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
      },
    );
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('computes null_rate and percentiles, writes a row per metric per feed', async () => {
    // Handler runs ONE aggregate SELECT per feed (2 total), then a stream
    // of INSERT-with-ON-CONFLICT per metric per feed (7 metrics × 2 feeds =
    // 14 additional calls). We only mock the two aggregate queries; the
    // remaining calls fall through to the default vi.fn() return (undefined),
    // which is fine for INSERT paths.
    mockSql
      .mockResolvedValueOnce([
        {
          rows_scored: '1000',
          null_count: '30',
          prob_p10: '0.45',
          prob_p50: '0.71',
          prob_p90: '0.85',
          prob_p99: '0.93',
          bundle_versions_seen: '1',
        },
      ]) // lottery agg
      .mockResolvedValueOnce([
        {
          rows_scored: '200',
          null_count: '5',
          prob_p10: '0.55',
          prob_p50: '0.72',
          prob_p90: '0.83',
          prob_p99: '0.91',
          bundle_versions_seen: '1',
        },
      ]); // silent_boom agg

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      lottery: { rows_scored: number; null_rate_pct: number };
      silent_boom: { rows_scored: number; null_rate_pct: number };
    };
    expect(body.lottery).toMatchObject({ rows_scored: 1000, null_rate_pct: 3.0 });
    expect(body.silent_boom).toMatchObject({ rows_scored: 200, null_rate_pct: 2.5 });
  });

  it('fires Sentry captureMessage when null_rate exceeds threshold', async () => {
    // 60/1000 = 6% null rate, exceeds NULL_RATE_ALERT_PCT = 5%
    mockSql
      .mockResolvedValueOnce([
        {
          rows_scored: '1000',
          null_count: '60',
          prob_p10: '0.40',
          prob_p50: '0.65',
          prob_p90: '0.80',
          prob_p99: '0.90',
          bundle_versions_seen: '1',
        },
      ]) // lottery agg — breaches threshold
      .mockResolvedValueOnce([
        {
          rows_scored: '200',
          null_count: '2',
          prob_p10: '0.50',
          prob_p50: '0.70',
          prob_p90: '0.82',
          prob_p99: '0.90',
          bundle_versions_seen: '1',
        },
      ]); // silent_boom agg — healthy

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('lottery'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ 'takeit.feed': 'lottery' }),
      }),
    );
  });

  it('returns 500 and captures exception when DB query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('neon transient'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('emits an empty-trading-day warning when one feed has 0 rows on a weekday', async () => {
    // Pin Date.now() so yesterday is a known weekday (Wed 2026-05-27).
    // 2026-05-28 is a Thursday → yesterday-in-UTC = 2026-05-27 (Wed).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    try {
      mockSql
        .mockResolvedValueOnce([
          {
            rows_scored: '1000',
            null_count: '30',
            prob_p10: '0.45',
            prob_p50: '0.71',
            prob_p90: '0.85',
            prob_p99: '0.93',
            bundle_versions_seen: '1',
          },
        ]) // lottery — healthy
        .mockResolvedValueOnce([
          {
            rows_scored: '0',
            null_count: '0',
            prob_p10: null,
            prob_p50: null,
            prob_p90: null,
            prob_p99: null,
            bundle_versions_seen: '0',
          },
        ]); // silent_boom — empty, weekday → should alert

      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      // Only the silent_boom feed triggered captureMessage (lottery is healthy).
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('silent_boom'),
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({ 'takeit.feed': 'silent_boom' }),
        }),
      );
      // The message text mentions the rows_scored=0 trigger specifically.
      const messageArg = vi.mocked(Sentry.captureMessage).mock.calls[0]![0];
      expect(messageArg).toContain('rows_scored=0');
    } finally {
      vi.useRealTimers();
    }
  });
});
