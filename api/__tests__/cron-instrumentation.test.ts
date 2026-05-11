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

// Fixed DSN used in tests so the parsed ingest host / project id / public
// key are predictable. Matches the production DSN shape.
const TEST_DSN =
  'https://abcdef0123456789@o111111.ingest.us.sentry.io/4511060900642816';

const fetchMock = vi.fn<typeof fetch>(async () =>
  Promise.resolve(new Response('', { status: 202 })),
);
vi.stubGlobal('fetch', fetchMock);

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
    // Mirrors a high-frequency entry in production: every-minute schedule
    // with the elevated `failureIssueThreshold` that the direct-HTTP +
    // threshold fix relies on.
    'high-freq-job': {
      schedule: '* 13-21 * * 1-5',
      checkinMargin: 2,
      maxRuntime: 5,
      failureIssueThreshold: 3,
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
  _resetDsnCacheForTest,
} from '../_lib/cron-instrumentation.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { waitUntil } from '@vercel/functions';

const guardOk = { apiKey: 'KEY', today: '2026-05-02' };

/**
 * Inspect every fetch() call made during a test. Each entry is the
 * parsed URL + JSON body of one POST to Sentry's Crons ingest endpoint.
 * The new wrappers POST in_progress on entry and ok/error on exit, so
 * a normal successful run produces two entries per monitored job.
 */
function getCheckInCalls(): Array<{
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> {
  return fetchMock.mock.calls.map(([url, init]) => {
    const initObj = init as
      | { body?: string; headers?: Record<string, string> }
      | undefined;
    const rawBody = initObj?.body;
    return {
      url: String(url),
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      headers: initObj?.headers ?? {},
    };
  });
}

describe('withCronInstrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilCalls.length = 0;
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response('', { status: 202 }));
    process.env.SENTRY_DSN = TEST_DSN;
    _resetDsnCacheForTest();
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

  it('intentional skip (200) sends ok check-in via direct HTTP when SCHEDULE_MAP has entry', async () => {
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
    const calls = getCheckInCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://o111111.ingest.us.sentry.io/api/4511060900642816/cron/monitored-job/abcdef0123456789/',
    );
    expect(calls[0]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'ok',
      monitor_config: {
        schedule: { type: 'crontab', value: '*/5 * * * *' },
        timezone: 'UTC',
      },
    });
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

  // ── Sentry cron monitor wrapping (direct HTTP) ──────────────
  // The wrapper used to call `Sentry.withMonitor()` which fires two
  // fire-and-forget `captureCheckIn` calls — the completion lost ~30%
  // of the time on Vercel Fluid Compute. Now the wrapper hits Sentry's
  // Crons ingest endpoint directly via `await fetch()` so the response
  // is actually awaited before the function exits. Deterministic.

  it('sends in_progress + ok check-ins via direct HTTP when SCHEDULE_MAP has entry', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('monitored-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    // Same Sentry Crons ingest URL for both check-ins (only `status` and
    // body differ per call).
    expect(calls[0]!.url).toBe(
      'https://o111111.ingest.us.sentry.io/api/4511060900642816/cron/monitored-job/abcdef0123456789/',
    );
    expect(calls[0]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'in_progress',
      monitor_config: {
        schedule: { type: 'crontab', value: '*/5 * * * *' },
        checkin_margin: 2,
        max_runtime: 5,
        failure_issue_threshold: 1,
        recovery_threshold: 1,
        timezone: 'UTC',
      },
    });
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'ok',
      check_in_id: calls[0]!.body.check_in_id, // same id pairs the run
    });
    expect(typeof calls[1]!.body.duration).toBe('number');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
  });

  it('skips direct HTTP check-ins when no SCHEDULE_MAP entry', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('not-in-map', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    expect(getCheckInCalls()).toHaveLength(0);
    // Handler still ran via the unwrapped path — wrapper stays safe for
    // jobs that haven't yet been added to the schedule map.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
  });

  it('sends in_progress + error check-ins when handler throws', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const boom = new Error('handler exploded');
    const handler = vi.fn().mockRejectedValue(boom);
    const wrapped = withCronInstrumentation('monitored-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.status).toBe('in_progress');
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'error',
      check_in_id: calls[0]!.body.check_in_id,
    });
    // The Sentry exception path is unchanged — captureException is still
    // called for the thrown error and feeds Sentry's issues stream
    // (separate from the cron monitor signal).
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
    expect(res._status).toBe(500);
  });

  // ── flushSentry still drains captureException via waitUntil ──
  // The cron check-in path is now direct HTTP, but captureException
  // (only fired on the catch path) still goes through the Sentry SDK
  // queue and needs the waitUntil(flush) pattern to actually reach
  // Sentry's wire on Vercel Fluid Compute.

  it('hands Sentry.flush() to waitUntil on the happy path (drains other Sentry signals)', async () => {
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

  it('hands Sentry.flush() to waitUntil on the exception path (drains captureException)', async () => {
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

  it('intentional skip sends a single direct-HTTP ok check-in (no captureCheckIn / flush dance)', async () => {
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler);

    await wrapped(mockRequest(), mockResponse());

    expect(handler).not.toHaveBeenCalled();
    const calls = getCheckInCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'ok',
    });
    // The SDK queue/flush dance is irrelevant on the intentional-skip
    // path — no SDK-side events are emitted, so we don't expect a flush.
    expect(Sentry.flush).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
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
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response('', { status: 202 }));
    process.env = {
      ...ORIGINAL_ENV,
      CRON_SECRET: 'test-secret',
      SENTRY_DSN: TEST_DSN,
    };
    _resetDsnCacheForTest();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('runs the inner handler and POSTs in_progress + ok via direct HTTP on 2xx', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(inner).toHaveBeenCalledTimes(1);
    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      'https://o111111.ingest.us.sentry.io/api/4511060900642816/cron/checkin-job/abcdef0123456789/',
    );
    expect(calls[0]!.body).toMatchObject({
      monitor_slug: 'checkin-job',
      status: 'in_progress',
      monitor_config: {
        schedule: { type: 'crontab', value: '*/15 * * * *' },
        checkin_margin: 2,
        max_runtime: 5,
        timezone: 'UTC',
      },
    });
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'checkin-job',
      status: 'ok',
      check_in_id: calls[0]!.body.check_in_id,
    });
    expect(typeof calls[1]!.body.duration).toBe('number');
  });

  it('POSTs an error completion when handler responds 5xx without throwing', async () => {
    const inner = vi.fn(async (_req, res) => {
      res.status(500).json({ error: 'oops' });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'checkin-job',
      status: 'error',
      check_in_id: calls[0]!.body.check_in_id,
    });
  });

  it('POSTs an error completion and re-throws when inner throws', async () => {
    const boom = new Error('inner exploded');
    const inner = vi.fn(async () => {
      throw boom;
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await expect(wrapped(authedReq(), res)).rejects.toThrow('inner exploded');

    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'checkin-job',
      status: 'error',
      check_in_id: calls[0]!.body.check_in_id,
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
    expect(getCheckInCalls()).toHaveLength(0);
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
    expect(getCheckInCalls()).toHaveLength(0);
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
    expect(getCheckInCalls()).toHaveLength(0);
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
    expect(getCheckInCalls()).toHaveLength(0);
  });

  it('swallows fetch failures so the response is not crashed', async () => {
    // The direct HTTP path catches errors internally — observability
    // paths must never crash the response. Sentry being unreachable
    // for the check-in must not propagate up.
    fetchMock.mockRejectedValue(new Error('Sentry unreachable'));
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    // No throw — wrapper resolves cleanly even though Sentry's endpoint
    // is unavailable.
    await wrapped(authedReq(), res);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
    // We did try to hit Sentry — once for in_progress, once for ok.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs a warning when Sentry returns non-2xx for a check-in', async () => {
    // 403 simulates a bad-DSN / project-mismatch scenario where the
    // POST is shaped right but Sentry refuses it. The wrapper must not
    // crash, but it MUST log so the next "why are timeouts firing?"
    // debug session has a clear breadcrumb.
    fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }));
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    expect(res._status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        monitorSlug: 'checkin-job',
        httpStatus: 403,
      }),
      'sentry check-in rejected',
    );
  });

  it('serializes failureIssueThreshold and sends Connection:close on every POST', async () => {
    // Two production hardening pieces ship together: a higher
    // failureIssueThreshold on high-frequency monitors silences
    // single-blip noise, and `Connection: close` forces a fresh TCP
    // per check-in to avoid undici's keep-alive pool serving stale
    // sockets. Both are wire-level details and must be locked in by a
    // test so future refactors don't quietly drop them.
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('high-freq-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    // The first check-in (in_progress) carries the monitor_config
    // upsert — that's where Sentry reads our failure-issue threshold.
    expect(calls[0]!.body).toMatchObject({
      status: 'in_progress',
      monitor_config: { failure_issue_threshold: 3 },
    });
    // Every check-in (both in_progress and completion) forces a fresh
    // TCP connection — undici won't reuse pooled sockets here.
    for (const c of calls) {
      expect(c.headers).toMatchObject({
        'Content-Type': 'application/json',
        Connection: 'close',
      });
    }
  });

  it('does not POST when SENTRY_DSN is unset (degrades gracefully)', async () => {
    delete process.env.SENTRY_DSN;
    _resetDsnCacheForTest();
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const res = mockResponse();
    await wrapped(authedReq(), res);

    // Handler still ran; Sentry just doesn't get a check-in this round.
    expect(inner).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
