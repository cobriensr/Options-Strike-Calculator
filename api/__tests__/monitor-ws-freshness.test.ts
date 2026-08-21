// @vitest-environment node

/**
 * Tests for the WS-feed staleness monitor at /api/cron/monitor-ws-freshness.
 *
 * Born from the 2026-08-19 incident: the uw-stream Railway daemon died at
 * 16:22Z and ws_option_trades received nothing for a full session while
 * every detector cron kept returning success with 0 fires. This cron is the
 * server-side tripwire; these tests pin:
 *
 *   - the auth guard (missing/wrong CRON_SECRET → 401, no DB touched)
 *   - the market-hours gate (outside RTH → skipped, no DB touched)
 *   - the open-grace gate (before 09:35 ET → status skipped, no alert)
 *   - the fresh path (staleness ≤ threshold → success heartbeat, no alert)
 *   - the stale path (staleness > threshold → ONE Sentry.captureMessage at
 *     level 'error' with the staleness in extra, plus logger.error, plus
 *     the staleness in the CronResult metadata for Axiom)
 *   - the empty-window path (zero rows in the lookback → alert at the
 *     lookback floor)
 *   - the WS_STALE_ALERT_S env override
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import logger from '../_lib/logger.js';

const { mockSql, mockSentryCapture } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSentryCapture: vi.fn(),
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
    setTag: vi.fn(),
    captureMessage: mockSentryCapture,
    captureException: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn(), request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/monitor-ws-freshness.js';
import { reportCronRun } from '../_lib/axiom.js';

/** 2026-08-19 is a regular Wednesday session (EDT: cash open 13:30Z). */
const MID_SESSION = '2026-08-19T15:00:00Z'; // 11:00 ET

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('cron monitor-ws-freshness', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    delete process.env.WS_STALE_ALERT_S;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(MID_SESSION));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
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
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Time gates ────────────────────────────────────────────

  it('skips outside market hours without touching the DB', async () => {
    vi.setSystemTime(new Date('2026-08-19T02:00:00Z')); // 22:00 ET prior day
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('skips (no alert, no query) during the open grace window before 09:35 ET', async () => {
    // 13:32Z = 09:32 ET in EDT — past the 09:25 cronGuard buffer, inside
    // the 5-min post-open grace. A boot race here must not page.
    vi.setSystemTime(new Date('2026-08-19T13:32:00Z'));
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('skipped');
    expect(body.message).toMatch(/grace/i);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('runs (does not skip) at 09:35 ET exactly', async () => {
    vi.setSystemTime(new Date('2026-08-19T13:35:00Z'));
    mockSql.mockResolvedValueOnce([
      { last_executed_at: '2026-08-19T13:34:58.000Z' },
    ]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as Record<string, unknown>).status).toBe('success');
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Fresh path ────────────────────────────────────────────

  it('reports success with measured staleness and no alert when the feed is fresh', async () => {
    mockSql.mockResolvedValueOnce([
      { last_executed_at: '2026-08-19T14:59:55.000Z' }, // 5s ago
    ]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // withCronInstrumentation spreads CronResult.metadata into the
    // top-level body (and the Axiom payload).
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.stale).toBe(false);
    expect(body.stalenessSeconds).toBe(5);
    expect(body.thresholdSeconds).toBe(300);
    expect(mockSentryCapture).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    // Heartbeat metadata also lands in Axiom.
    expect(reportCronRun).toHaveBeenCalledWith(
      'monitor-ws-freshness',
      expect.objectContaining({
        status: 'success',
        stale: false,
        stalenessSeconds: 5,
      }),
    );
  });

  // ── Stale path ────────────────────────────────────────────

  it('captures ONE error-level Sentry message when staleness exceeds the threshold', async () => {
    mockSql.mockResolvedValueOnce([
      { last_executed_at: '2026-08-19T14:50:00.000Z' }, // 600s ago
    ]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledWith(
      'ws feed stale: no option trades for 600s',
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({
          stalenessSeconds: 600,
          thresholdSeconds: 300,
          lastExecutedAt: '2026-08-19T14:50:00.000Z',
        }),
      }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);

    // The cron itself succeeded — the feed is what's broken. Status stays
    // 'success' so the Sentry cron monitor doesn't conflate "monitor
    // didn't run" with "feed stale"; the captureMessage is the alert.
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.stale).toBe(true);
    expect(body.stalenessSeconds).toBe(600);
    expect(reportCronRun).toHaveBeenCalledWith(
      'monitor-ws-freshness',
      expect.objectContaining({ stale: true, stalenessSeconds: 600 }),
    );
  });

  it('alerts at the lookback floor when the window has zero rows', async () => {
    // max() over an empty window → one row with a NULL. 30-min lookback
    // floor = 1800s of provable staleness.
    mockSql.mockResolvedValueOnce([{ last_executed_at: null }]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledWith(
      'ws feed stale: no option trades for 1800s',
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({
          stalenessSeconds: 1800,
          lastExecutedAt: null,
        }),
      }),
    );
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.stale).toBe(true);
    expect(body.stalenessSeconds).toBe(1800);
  });

  // ── Threshold override ────────────────────────────────────

  it('respects the WS_STALE_ALERT_S env override', async () => {
    process.env.WS_STALE_ALERT_S = '900';
    mockSql.mockResolvedValueOnce([
      { last_executed_at: '2026-08-19T14:50:00.000Z' }, // 600s ago
    ]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSentryCapture).not.toHaveBeenCalled();
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.stale).toBe(false);
    expect(body.thresholdSeconds).toBe(900);
  });
});
