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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

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
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { withCronInstrumentation } from '../_lib/cron-instrumentation.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

const guardOk = { apiKey: 'KEY', today: '2026-05-02' };

describe('withCronInstrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
