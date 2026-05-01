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
        message: 'handler exploded',
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
});
