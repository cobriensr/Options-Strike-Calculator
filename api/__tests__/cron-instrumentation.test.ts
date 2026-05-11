// @vitest-environment node

/**
 * Unit tests for api/_lib/cron-instrumentation.ts (Phase 1a).
 *
 * Covers:
 *   - Guard rejection (cronGuard returns null) → handler is never called.
 *   - Success path: reportCronRun called with status passthrough + duration.
 *   - Exception path: Sentry.captureException + reportCronRun status='error'.
 *   - Status passthrough for 'success' / 'partial' / 'skipped' / 'error'.
 *   - Sentry tag scoping (cron.job set once).
 *   - reportCronRun failure does NOT crash the response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { waitUntilCalls } = vi.hoisted(() => ({
  waitUntilCalls: [] as Promise<unknown>[],
}));

vi.mock('@vercel/functions', () => ({
  // The wrapper registers Sentry.flush() with Vercel via waitUntil so
  // the flush can drain after the response is sent. Tests assert the
  // promise was handed to waitUntil — the captured list lets the order
  // of operations be inspected per-test.
  waitUntil: vi.fn((p: Promise<unknown>) => {
    waitUntilCalls.push(p);
  }),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    // Default pass-through so existing tests that don't supply a
    // SCHEDULE_MAP entry behave identically — handler runs unmodified.
    withMonitor: vi.fn(async (...args: unknown[]): Promise<unknown> => {
      const cb = args[1] as () => Promise<unknown>;
      return cb();
    }),
    captureCheckIn: vi.fn(() => 'mock-checkin-id'),
    flush: vi.fn().mockResolvedValue(true),
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/cron-schedules.js', () => ({
  SCHEDULE_MAP: {
    'monitored-job': {
      schedule: '*/5 * * * *',
      checkinMargin: 2,
      maxRuntime: 5,
    },
    'checkin-job': {
      schedule: '*/15 * * * *',
      checkinMargin: 2,
      maxRuntime: 5,
    },
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  withCronInstrumentation,
  withCronCheckin,
} from '../_lib/cron-instrumentation.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { waitUntil } from '@vercel/functions';

const guardOk = { apiKey: 'KEY', today: '2026-05-02' };

describe('withCronInstrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilCalls.length = 0;
  });

  it('returns early when cronGuard rejects (no handler call, no axiom event)', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('test-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(handler).not.toHaveBeenCalled();
    expect(reportCronRun).not.toHaveBeenCalled();
  });

  it('forwards options to cronGuard (requireApiKey: false)', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('test-job', handler, {
      requireApiKey: false,
    });

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(cronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { requireApiKey: false },
    );
  });

  it('intentional skip (200) sends ok check-in to Sentry when SCHEDULE_MAP has entry', async () => {
    // Simulate cronGuard's outside-time-window path: it sets status 200
    // with `{ skipped: true, reason: 'Outside time window' }`, then
    // returns null.
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler);

    await wrapped(mockRequest(), mockResponse());

    expect(handler).not.toHaveBeenCalled();
    expect(Sentry.captureCheckIn).toHaveBeenCalledWith(
      { monitorSlug: 'monitored-job', status: 'ok' },
      expect.objectContaining({
        schedule: { type: 'crontab', value: '*/5 * * * *' },
        timezone: 'UTC',
      }),
    );
  });

  it('intentional skip on job without SCHEDULE_MAP entry does NOT send check-in', async () => {
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const handler = vi.fn();
    // 'unregistered-job' is not in the SCHEDULE_MAP mock above.
    const wrapped = withCronInstrumentation('unregistered-job', handler);

    await wrapped(mockRequest(), mockResponse());

    expect(handler).not.toHaveBeenCalled();
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it('auth failure (401) does NOT send check-in (real failures still alert)', async () => {
    // cronGuard's auth-failure path: status 401, then returns null.
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler);

    await wrapped(mockRequest(), mockResponse());

    expect(handler).not.toHaveBeenCalled();
    // No check-in — this is a real failure, the missed-checkin signal
    // should still alert.
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it('happy path: success result reports + responds 200 with durationMs', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({
      status: 'success' as const,
      rows: 7,
      message: 'all good',
      metadata: { source: 'unit-test' },
    });
    const wrapped = withCronInstrumentation('demo-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    // Sentry tag scoped to job name.
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'demo-job');

    // Handler received the right context shape.
    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(handler).mock.calls[0]![0];
    expect(ctx.today).toBe('2026-05-02');
    expect(ctx.apiKey).toBe('KEY');
    expect(typeof ctx.startTimeMs).toBe('number');
    expect(ctx.logger).toBe(logger);

    // Axiom event matches CronResult passthrough + duration.
    expect(reportCronRun).toHaveBeenCalledTimes(1);
    const [name, payload] = vi.mocked(reportCronRun).mock.calls[0]!;
    expect(name).toBe('demo-job');
    expect(payload).toMatchObject({
      status: 'success',
      rows: 7,
      message: 'all good',
      source: 'unit-test',
    });
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);

    // Response shape mirrors the Axiom payload.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'demo-job',
      status: 'success',
      rows: 7,
      message: 'all good',
      source: 'unit-test',
    });
  });

  it.each(['success', 'partial', 'skipped', 'error'] as const)(
    'passes status="%s" through to axiom + response',
    async (status) => {
      vi.mocked(cronGuard).mockReturnValue(guardOk);
      const handler = vi.fn().mockResolvedValue({ status });
      const wrapped = withCronInstrumentation('s-job', handler);

      const res = mockResponse();
      await wrapped(mockRequest(), res);

      expect(reportCronRun).toHaveBeenCalledWith(
        's-job',
        expect.objectContaining({ status }),
      );
      expect((res._json as { status: string }).status).toBe(status);
    },
  );

  it('exception path: captures, reports error status, sends 500', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const boom = new Error('handler exploded');
    const handler = vi.fn().mockRejectedValue(boom);
    const wrapped = withCronInstrumentation('boom-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
    expect(logger.error).toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'boom-job',
      expect.objectContaining({
        status: 'error',
        // Both `message` (new wrapper field) and `error` (legacy field
        // pre-Phase-3a) are emitted so existing Axiom dashboards keyed on
        // either key keep working post-adoption.
        message: 'handler exploded',
        error: 'handler exploded',
      }),
    );
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ job: 'boom-job', error: 'Internal error' });
  });

  it('exception path tolerates a failing reportCronRun (response still sent)', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    vi.mocked(reportCronRun).mockRejectedValueOnce(
      new Error('axiom unreachable'),
    );
    const handler = vi.fn().mockRejectedValue(new Error('handler broke'));
    const wrapped = withCronInstrumentation('fragile-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(res._status).toBe(500);
  });

  it('measures duration as monotonic non-negative ms', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { status: 'success' as const };
    });
    const wrapped = withCronInstrumentation('time-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
    expect(payload.durationMs).toBeGreaterThanOrEqual(5);
    expect(typeof (res._json as { durationMs: number }).durationMs).toBe(
      'number',
    );
  });

  // ── Wave 2/3 enabler extensions ─────────────────────────────

  it('errorPayload: handler-customized 500 body replaces the default', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockRejectedValue(new Error('upstream offline'));
    const wrapped = withCronInstrumentation('payload-job', handler, {
      errorPayload: (err) => ({
        error: 'All sources failed',
        detail: err instanceof Error ? err.message : String(err),
      }),
    });

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({
      error: 'All sources failed',
      detail: 'upstream offline',
    });
    // Axiom side keeps the legacy `error` field even when the response
    // body is overridden — observability is never sacrificed for a body
    // shape change.
    expect(reportCronRun).toHaveBeenCalledWith(
      'payload-job',
      expect.objectContaining({
        status: 'error',
        message: 'upstream offline',
        error: 'upstream offline',
      }),
    );
  });

  it('errorPayload: empty-object return falls back to the legacy default', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockRejectedValue(new Error('bad input'));
    const wrapped = withCronInstrumentation('fallback-job', handler, {
      errorPayload: () => ({}),
    });

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({
      job: 'fallback-job',
      error: 'Internal error',
    });
  });

  it('errorStatus: returns 502 instead of the default 500', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockRejectedValue(new Error('upstream offline'));
    const wrapped = withCronInstrumentation('upstream-job', handler, {
      errorStatus: () => 502,
    });

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({
      job: 'upstream-job',
      error: 'Internal error',
    });
  });

  it('errorPayload + errorStatus: both overrides apply together', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockRejectedValue(new Error('UW down'));
    const wrapped = withCronInstrumentation('combo-job', handler, {
      errorStatus: () => 502,
      errorPayload: (err) => ({
        job: 'combo-job',
        error: 'UW API error',
        reason: err instanceof Error ? err.message : String(err),
      }),
    });

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({
      job: 'combo-job',
      error: 'UW API error',
      reason: 'UW down',
    });
  });

  it('dynamicTimeCheck: { run: true } runs the handler normally', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('dyn-ok-job', handler, {
      dynamicTimeCheck: () => ({ run: true, reason: 'force=true' }),
    });

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
    expect((res._json as { status: string }).status).toBe('success');
  });

  it('dynamicTimeCheck: { run: false } skips with 200 + structured body', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('dyn-skip-job', handler, {
      dynamicTimeCheck: () => ({ run: false, reason: 'force not set' }),
    });

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(handler).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'dyn-skip-job',
      status: 'skipped',
      message: 'force not set',
      skipped: true,
      reason: 'force not set',
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'dyn-skip-job',
      expect.objectContaining({
        status: 'skipped',
        message: 'force not set',
      }),
    );
  });

  it('passReq: true exposes the raw VercelRequest on ctx.req', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('passreq-job', handler, {
      passReq: true,
    });

    const req = mockRequest({
      query: { backfill: 'true', date: '2026-04-07' },
    });
    const res = mockResponse();
    await wrapped(req, res);

    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(handler).mock.calls[0]![0];
    // The same request object cronGuard saw is forwarded — handlers can
    // read query params, headers, etc. without a module-scoped ref.
    expect(ctx.req).toBe(req);
    expect(ctx.req?.query).toEqual({ backfill: 'true', date: '2026-04-07' });
  });

  it('passReq: omitted leaves ctx.req undefined (default surface stays narrow)', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('no-passreq-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest({ query: { backfill: 'true' } }), res);

    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(handler).mock.calls[0]![0];
    expect(ctx.req).toBeUndefined();
  });

  it('dynamicTimeCheck: receives the request so handlers can read query params', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    // VercelRequest's `query` is a string-or-array map; the wrapper hands
    // back the same request object cronGuard saw. Cast to a narrower
    // shape just inside the predicate so the test reads cleanly.
    const dynamicTimeCheck = vi.fn(
      (req: import('@vercel/node').VercelRequest) => {
        const force = req.query?.force === 'true';
        return { run: force, reason: 'force=true required' };
      },
    );
    const wrapped = withCronInstrumentation('dyn-req-job', handler, {
      dynamicTimeCheck,
    });

    // Without ?force=true → skipped.
    const res1 = mockResponse();
    await wrapped(mockRequest({ query: {} }), res1);
    expect(handler).not.toHaveBeenCalled();
    expect((res1._json as { skipped: boolean }).skipped).toBe(true);
    expect(dynamicTimeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ query: {} }),
    );

    // With ?force=true → runs.
    const res2 = mockResponse();
    await wrapped(mockRequest({ query: { force: 'true' } }), res2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res2._status).toBe(200);
    expect((res2._json as { status: string }).status).toBe('success');
  });

  // ── Sentry cron monitor wrapping ────────────────────────────

  it('Sentry.withMonitor: wraps when SCHEDULE_MAP entry exists', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('monitored-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(Sentry.withMonitor).toHaveBeenCalledTimes(1);
    const [slug, , opts] = vi.mocked(Sentry.withMonitor).mock.calls[0]!;
    expect(slug).toBe('monitored-job');
    expect(opts).toMatchObject({
      schedule: { type: 'crontab', value: '*/5 * * * *' },
      checkinMargin: 2,
      maxRuntime: 5,
      failureIssueThreshold: 1,
      recoveryThreshold: 1,
      timezone: 'UTC',
    });
    // Handler still ran (mocked withMonitor invokes its callback).
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
  });

  it('Sentry.withMonitor: skipped when no SCHEDULE_MAP entry', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('not-in-map', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(Sentry.withMonitor).not.toHaveBeenCalled();
    // Handler still ran via the unwrapped path — wrapper stays safe for
    // jobs that haven't yet been added to the schedule map.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
  });

  it('Sentry.withMonitor: thrown errors propagate to existing catch', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const boom = new Error('handler exploded');
    const handler = vi.fn().mockRejectedValue(boom);
    const wrapped = withCronInstrumentation('monitored-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    // withMonitor was still called — Sentry records the error check-in
    // before re-throwing.
    expect(Sentry.withMonitor).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
    expect(res._status).toBe(500);
  });

  // ── Sentry.flush via waitUntil before function exit ───────────
  // Sentry.withMonitor does NOT flush internally (verified against
  // @sentry/core source). On Vercel Fluid Compute, the captureCheckIn
  // HTTP request gets killed when the function exits even with
  // `await Sentry.flush()` (verified empirically — commit 449fa949 had
  // no effect on the monitor incidents). The wrapper must hand the
  // flush promise to `waitUntil()` so Vercel keeps the runtime alive
  // long enough to drain it.

  it('hands Sentry.flush() to waitUntil after the happy-path response', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi
      .fn()
      .mockResolvedValue({ status: 'success' as const, rows: 1 });
    const wrapped = withCronInstrumentation('monitored-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('hands Sentry.flush() to waitUntil after the exception path response', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const wrapped = withCronInstrumentation('monitored-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(res._status).toBe(500);
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('hands Sentry.flush() to waitUntil after sendIntentionalSkipCheckin (status 200 skip)', async () => {
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler);

    await wrapped(mockRequest(), mockResponse());

    expect(handler).not.toHaveBeenCalled();
    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(1); // the skip check-in
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('does NOT flush or call waitUntil on auth-failure (cronGuard rejects with statusCode !== 200)', async () => {
    // No check-in is sent on real auth/config failures — so no flush
    // either. Keeps the missed-checkin signal accurate for genuine
    // outages and avoids waiting on a flush that has nothing to drain.
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const wrapped = withCronInstrumentation('monitored-job', vi.fn());

    await wrapped(mockRequest(), mockResponse());

    expect(Sentry.flush).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe('withCronCheckin', () => {
  const ORIGINAL_ENV = process.env;
  const authedReq = () =>
    mockRequest({ headers: { authorization: 'Bearer test-secret' } });

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilCalls.length = 0;
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'test-secret' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('runs the inner handler and emits in_progress + ok check-ins on 2xx', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = vi.mocked(Sentry.captureCheckIn).mock.calls;
    expect(firstCall![0]).toEqual({
      monitorSlug: 'checkin-job',
      status: 'in_progress',
    });
    expect(firstCall![1]).toMatchObject({
      schedule: { type: 'crontab', value: '*/15 * * * *' },
      checkinMargin: 2,
      maxRuntime: 5,
      timezone: 'UTC',
    });
    expect(secondCall![0]).toMatchObject({
      checkInId: 'mock-checkin-id',
      monitorSlug: 'checkin-job',
      status: 'ok',
    });
  });

  it('emits error check-in when handler responds 5xx without throwing', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(500).json({ error: 'oops' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(Sentry.captureCheckIn).mock.calls[1]!;
    expect(secondCall[0]).toMatchObject({
      checkInId: 'mock-checkin-id',
      status: 'error',
    });
  });

  it('emits error check-in and re-throws when inner throws', async () => {
    const boom = new Error('inner exploded');
    const inner = vi.fn(async () => {
      throw boom;
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await expect(wrapped(authedReq(), res)).rejects.toThrow('inner exploded');

    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(Sentry.captureCheckIn).mock.calls[1]!;
    expect(secondCall[0]).toMatchObject({
      checkInId: 'mock-checkin-id',
      status: 'error',
    });
  });

  it('skips Sentry calls entirely when no SCHEDULE_MAP entry exists', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('not-in-map-checkin', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
  });

  it('preserves the original response status code (does not mutate)', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(502).json({ error: 'upstream' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: 'upstream' });
  });

  it('skips check-ins entirely when Authorization header is missing (unauthenticated traffic)', async () => {
    // Bot scans / misrouted requests hit /api/cron/<job> without a Bearer
    // header. cronGuard inside the handler returns 401, but the wrapper
    // must NOT register the request as a cron run — otherwise the
    // statusCode-based completion would send `status: 'error'` and
    // create a false-positive Sentry monitor incident.
    const inner = vi.fn(async (_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(mockRequest(), res); // no Authorization header

    expect(inner).toHaveBeenCalledTimes(1);
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it('skips check-ins when Authorization header is wrong', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(
      mockRequest({ headers: { authorization: 'Bearer wrong-secret' } }),
      res,
    );

    expect(inner).toHaveBeenCalledTimes(1);
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it('skips check-ins when CRON_SECRET env is unset', async () => {
    delete process.env.CRON_SECRET;
    const inner = vi.fn(async (_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(
      mockRequest({ headers: { authorization: 'Bearer anything' } }),
      res,
    );

    expect(inner).toHaveBeenCalledTimes(1);
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it('hands Sentry.flush() to waitUntil after the ok completion check-in', async () => {
    // Without waitUntil the completion HTTP request gets killed when
    // Vercel's Fluid Compute exits the function, leaving Sentry with
    // only the in_progress signal and firing a false "timeout check-in
    // detected" issue after maxRuntime expires. `await Sentry.flush()`
    // alone is insufficient — verified in production: commit 449fa949
    // had zero effect on the monitor incidents.
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
    // The flush promise must be registered with Vercel's waitUntil so
    // the runtime keeps the function alive long enough to drain it.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntilCalls).toHaveLength(1);
    // Order matters: completion check-in must be enqueued before flush.
    const flushOrder = vi.mocked(Sentry.flush).mock.invocationCallOrder[0]!;
    const completionOrder = vi.mocked(Sentry.captureCheckIn).mock
      .invocationCallOrder[1]!;
    expect(flushOrder).toBeGreaterThan(completionOrder);
  });

  it('hands Sentry.flush() to waitUntil after the error completion check-in on 5xx', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(500).json({ error: 'oops' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('hands Sentry.flush() to waitUntil when inner throws (before re-throw)', async () => {
    const boom = new Error('inner exploded');
    const inner = vi.fn(async () => {
      throw boom;
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await expect(wrapped(authedReq(), res)).rejects.toThrow('inner exploded');

    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('does not call Sentry.flush or waitUntil when the auth gate skips check-ins', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(mockRequest(), res); // no Authorization header

    expect(Sentry.flush).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('swallows a Sentry.flush() rejection so waitUntil never sees it', async () => {
    // .catch() on the flush promise inside flushSentry() means waitUntil
    // always receives a resolving promise even if Sentry's transport
    // throws — observability paths must never crash the response.
    vi.mocked(Sentry.flush).mockRejectedValueOnce(new Error('transport down'));
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    // The registered promise resolves cleanly — never rejects.
    await expect(waitUntilCalls[0]).resolves.toBeUndefined();
  });
});
