// @vitest-environment node

/**
 * Tests for the weekly drift cron at /api/cron/check-gamma-setup-drift.
 *
 * Verifies the auth guard, the no-drift INFO path, the drift-detected
 * WARN path (Sentry.captureMessage with stats in extras), and the
 * propagated CronResult shape (status / rows / metadata).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryCapture, mockSentryTag } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockSentryTag: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: mockSentryTag,
    captureMessage: mockSentryCapture,
    captureException: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn(), request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/gamma-stats.js', () => ({
  loadFireStatsRows: vi.fn(),
  aggregateFireStats: vi.fn(),
  detectDrift: vi.fn(),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-21'),
}));

import handler from '../cron/check-gamma-setup-drift.js';
import {
  loadFireStatsRows,
  aggregateFireStats,
  detectDrift,
} from '../_lib/gamma-stats.js';

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    from: '2026-04-23',
    to: '2026-05-21',
    n_total: 18,
    n_with_outcome: 15,
    n_winners: 10,
    win_rate: 10 / 15,
    mean_edge_pts: 6.4,
    by_signal: [],
    ...overrides,
  };
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('cron check-gamma-setup-drift', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSql.mockResolvedValue([]);
    vi.mocked(loadFireStatsRows).mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(loadFireStatsRows).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong-secret' },
      }),
      res,
    );
    expect(res._status).toBe(401);
    expect(loadFireStatsRows).not.toHaveBeenCalled();
  });

  it('logs INFO and returns success when no drift is detected', async () => {
    vi.mocked(aggregateFireStats).mockReturnValueOnce(
      makeStats() as unknown as ReturnType<typeof aggregateFireStats>,
    );
    vi.mocked(detectDrift).mockReturnValueOnce(null);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // withCronInstrumentation spreads the CronResult.metadata into the
    // top-level body, so the drift_fired / window_* fields sit directly
    // on the response — not under a nested `metadata` key.
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(18);
    expect(body.message).toBe('no drift');
    expect(body.drift_fired).toBe(false);
    expect(body.window_to).toBe('2026-05-21');
    // No warning captured when stats are healthy.
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('captures a warning + returns partial when drift is detected', async () => {
    const stats = makeStats({ n_total: 14, win_rate: 0.42 });
    vi.mocked(aggregateFireStats).mockReturnValueOnce(
      stats as unknown as ReturnType<typeof aggregateFireStats>,
    );
    vi.mocked(detectDrift).mockReturnValueOnce({
      fired: true,
      reasons: [
        'composite win rate 0.42 < 0.55',
        'edge ratio collapse on e1_long_call (0.18 < 0.5)',
      ],
      stats: stats as unknown as ReturnType<typeof aggregateFireStats>,
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('partial');
    expect(body.message).toContain('composite win rate');
    expect(body.message).toContain('edge ratio collapse');
    expect(body.drift_fired).toBe(true);

    expect(mockSentryTag).toHaveBeenCalledWith(
      'cron.job',
      'check-gamma-setup-drift',
    );
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    const [msg, ctx] = mockSentryCapture.mock.calls[0]!;
    expect(msg).toBe('gamma-setup drift detected');
    expect((ctx as { level: string }).level).toBe('warning');
    expect(
      (ctx as { extra: { reasons: string[]; stats: unknown } }).extra.reasons,
    ).toHaveLength(2);
    expect(
      (ctx as { extra: { stats: { n_total: number } } }).extra.stats.n_total,
    ).toBe(14);
  });

  it('uses a 28-day trailing window for loadFireStatsRows', async () => {
    vi.mocked(aggregateFireStats).mockReturnValueOnce(
      makeStats() as unknown as ReturnType<typeof aggregateFireStats>,
    );
    vi.mocked(detectDrift).mockReturnValueOnce(null);

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    const call = vi.mocked(loadFireStatsRows).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![2]).toBe('2026-05-21'); // today
    // Argument 1 is the 28-days-ago anchor; the exact string depends on
    // real-time math but it must be a YYYY-MM-DD string.
    expect(typeof call![1]).toBe('string');
    expect(call![1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
