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
 *   - Check-in ORDERING vs the response (2026-10-02): every check-in either
 *     settles before the response is written or is handed to waitUntil.
 *     The earlier tests only asserted that fetch was called, which is how
 *     the post-response skip check-in shipped.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import { isCronAuthenticated } from '../_lib/cron-instrumentation.js';
import type * as CronHelpers from '../_lib/cron-helpers.js';

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
    // Malformed config: assertValidTimezone throws while the check-in
    // payload is built — the one throw sentryCheckInDirect does not
    // swallow.
    'bad-tz-job': {
      schedule: '*/5 * * * *',
      checkinMargin: 2,
      maxRuntime: 5,
      timezone: 'America/New_Yrok',
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
  deriveCronStatus,
  _resetDsnCacheForTest,
} from '../_lib/cron-instrumentation.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { waitUntil } from '@vercel/functions';

const guardOk = { apiKey: 'KEY', today: '2026-05-02' };

// The REAL cronGuard, for tests that must exercise the deferred-skip
// contract between cron-helpers and the wrapper rather than a mock's
// restatement of it. api-helpers stays mocked for every other test.
let realCronGuard: typeof CronHelpers.cronGuard;
beforeAll(async () => {
  ({ cronGuard: realCronGuard } = await vi.importActual<typeof CronHelpers>(
    '../_lib/cron-helpers.js',
  ));
});

const TEST_CRON_SECRET = 'test-cron-secret';
const authedCronReq = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });

/** Route the wrapper through the real cronGuard (auth must then be real). */
function useRealCronGuard(): void {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  vi.mocked(cronGuard).mockImplementation(realCronGuard);
}

/** Status field of a Sentry check-in POST body. */
function checkInStatus(init: RequestInit | undefined): string {
  return (JSON.parse(String(init?.body)) as { status: string }).status;
}

/**
 * Ordering log. Each Sentry fetch records when it starts and when it
 * settles (keyed by check-in status) and the response records when it is
 * written, so a test can assert the check-in landed BEFORE the response —
 * the property the post-response skip check-in violated.
 */
function trackOrdering(res: ReturnType<typeof mockResponse>): string[] {
  const events: string[] = [];
  fetchMock.mockImplementation(async (_url, init) => {
    const status = checkInStatus(init);
    events.push(`fetch:start:${status}`);
    await Promise.resolve();
    events.push(`fetch:done:${status}`);
    return new Response('', { status: 202 });
  });
  const writeJson = res.json.bind(res);
  vi.spyOn(res, 'json').mockImplementation((body: unknown) => {
    events.push('res.json');
    return writeJson(body);
  });
  return events;
}

/**
 * A fetch that never answers but honours its AbortSignal the way the real
 * fetch does — the shape of a hung Sentry ingest. Only the 5 s abort in
 * sentryCheckInDirect (or the skip budget) can end it.
 */
function hangUntilAborted(
  _url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

/**
 * Whether `p` has settled, checked after draining pending microtasks. Used
 * only to prove a promise is still PENDING (the instance is being kept
 * alive); a positive result is always asserted by awaiting `p` itself.
 */
async function hasSettled(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  p.then(markSettled, markSettled);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return settled;
}

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
    // clearAllMocks keeps implementations; useRealCronGuard() must not leak.
    vi.mocked(cronGuard).mockReset();
    waitUntilCalls.length = 0;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('', { status: 202 }));
    process.env.SENTRY_DSN = TEST_DSN;
    _resetDsnCacheForTest();
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    vi.useRealTimers();
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

    // deferSkipResponse is always forwarded: the wrapper owns the skip
    // response so it can check in first.
    expect(cronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { requireApiKey: false, deferSkipResponse: true },
    );
  });

  it('intentional skip: the in_progress + ok pair settles BEFORE the skip response is written', async () => {
    // Real cronGuard, closed window. The 2026-10-02 bug: cronGuard had
    // already sent the 200 when the wrapper started the check-ins, so on
    // Vercel the instance froze with both POSTs in flight (evaluate-round-
    // trip's 16:10–16:50 ET ticks were `missed` every day).
    useRealCronGuard();
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler, {
      timeCheck: () => false,
    });
    const res = mockResponse();
    const events = trackOrdering(res);

    await wrapped(authedCronReq(), res);

    expect(events).toEqual([
      'fetch:start:in_progress',
      'fetch:done:in_progress',
      'fetch:start:ok',
      'fetch:done:ok',
      'res.json',
    ]);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('intentional skip sends the in_progress + ok PAIR via direct HTTP (satisfies the tick)', async () => {
    // The skip path emits the SAME two-step lifecycle a live run does —
    // in_progress (with monitor_config upsert) immediately followed by a
    // terminal ok carrying that check-in's id + duration 0 — instead of a
    // lone heartbeat ok. This unambiguously marks the served-but-skipped
    // tick OK in Sentry (the 2026-06-08 Layer-1 fix).
    useRealCronGuard();
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler, {
      timeCheck: () => false,
    });

    await wrapped(authedCronReq(), mockResponse());

    expect(handler).not.toHaveBeenCalled();
    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      'https://o111111.ingest.us.sentry.io/api/4511060900642816/cron/monitored-job/abcdef0123456789/',
    );
    // Step 1: in_progress carries the monitor_config upsert.
    expect(calls[0]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'in_progress',
      monitor_config: {
        schedule: { type: 'crontab', value: '*/5 * * * *' },
        timezone: 'UTC',
      },
    });
    // Step 2: terminal ok pairs by check_in_id, duration 0 (no work).
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'ok',
      check_in_id: calls[0]!.body.check_in_id,
      duration: 0,
    });
  });

  it('intentional skip on job without SCHEDULE_MAP entry does NOT send check-in', async () => {
    useRealCronGuard();
    const handler = vi.fn();
    // 'unregistered-job' is not in the SCHEDULE_MAP mock above.
    const wrapped = withCronInstrumentation('unregistered-job', handler, {
      timeCheck: () => false,
    });
    const res = mockResponse();

    await wrapped(authedCronReq(), res);

    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    // The skip response is still written.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  it('auth failure (401) does NOT send check-in (real failures still alert)', async () => {
    // Real cronGuard, wrong Bearer: it responds 401 itself and returns null.
    useRealCronGuard();
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler, {
      timeCheck: () => false,
    });
    const res = mockResponse();

    await wrapped(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer not-the-secret' },
      }),
      res,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    // No check-in — this is a real failure, the missed-checkin signal
    // should still alert.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('intentional skip: a rejecting check-in fetch still writes the skip response', async () => {
    useRealCronGuard();
    fetchMock.mockRejectedValue(new Error('Sentry unreachable'));
    const wrapped = withCronInstrumentation('monitored-job', vi.fn(), {
      timeCheck: () => false,
    });
    const res = mockResponse();

    // Resolves — the swallowed network error never reaches the cron.
    await wrapped(authedCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    // Both halves of the pair were still attempted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('intentional skip: a malformed monitor config is logged by name and the skip response still goes out', async () => {
    // assertValidTimezone throws while the in_progress payload is built —
    // outside sentryCheckInDirect's try. The skip response is written
    // after the check-in now, so that throw must not cost the cron it.
    useRealCronGuard();
    const wrapped = withCronInstrumentation('bad-tz-job', vi.fn(), {
      timeCheck: () => false,
    });
    const res = mockResponse();

    await wrapped(authedCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ monitorSlug: 'bad-tz-job' }),
      'sentry skip check-in failed',
    );
  });

  it('intentional skip: a hung Sentry holds the skip response for at most the 3 s budget, then waitUntil carries the rest', async () => {
    vi.useFakeTimers();
    useRealCronGuard();
    fetchMock.mockImplementation(hangUntilAborted);
    const wrapped = withCronInstrumentation('monitored-job', vi.fn(), {
      timeCheck: () => false,
    });
    const res = mockResponse();

    const run = wrapped(authedCronReq(), res);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(res._json).toBeNull(); // still inside the budget

    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ monitorSlug: 'monitored-job', budgetMs: 3000 }),
      'sentry skip check-in exceeded budget; responding, delivery continues under waitUntil',
    );

    // The in-flight pair was registered with waitUntil up front, so the
    // instance stays alive until the 5 s fetch aborts end it.
    expect(waitUntilCalls).toHaveLength(1);
    const delivery = waitUntilCalls[0]!;
    expect(await hasSettled(delivery)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(delivery).resolves.toBeUndefined();
    // Budget timer and both 5 s abort timers all cleared — nothing leaks.
    expect(vi.getTimerCount()).toBe(0);
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
    // Sleep 25ms with an assertion at >=5ms so Node's setTimeout
    // imprecision (callbacks can fire ~1ms early on fast/loaded CI
    // runners) can't undershoot the bound.
    const handler = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
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

  it('sends an ERROR check-in when the handler RETURNS status:error (no throw)', async () => {
    // FIX #2: a caller-returned status:'error' (the handler chose to land
    // its side effects but signal a genuine failure — e.g.
    // detect-silent-boom's genuine-macro-error contract) must turn the
    // success-path check-in red. Previously hardcoded 'ok', which left a
    // real failure green on the cron monitor.
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'error' as const });
    const wrapped = withCronInstrumentation('monitored-job', handler);

    const res = mockResponse();
    await wrapped(mockRequest(), res);

    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ status: 'in_progress' });
    // The completion check-in reflects the returned error status.
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'error',
      check_in_id: calls[0]!.body.check_in_id,
    });
    // Handler did NOT throw → response is still 200 with status:'error'.
    expect(res._status).toBe(200);
    expect((res._json as { status: string }).status).toBe('error');
  });

  it.each(['partial', 'skipped'] as const)(
    'maps a returned status:%s to an OK check-in (only error goes red)',
    async (status) => {
      // Sentry Crons has no 'degraded' state — 'partial'/'skipped' are not
      // failures, so they stay 'ok'. Only a returned 'error' goes red.
      vi.mocked(cronGuard).mockReturnValue(guardOk);
      const handler = vi.fn().mockResolvedValue({ status });
      const wrapped = withCronInstrumentation('monitored-job', handler);

      const res = mockResponse();
      await wrapped(mockRequest(), res);

      const calls = getCheckInCalls();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body).toMatchObject({ status: 'ok' });
      expect(res._status).toBe(200);
    },
  );

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

  it('intentional skip uses direct-HTTP in_progress+ok (no captureCheckIn / flush dance)', async () => {
    useRealCronGuard();
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler, {
      timeCheck: () => false,
    });

    await wrapped(authedCronReq(), mockResponse());

    expect(handler).not.toHaveBeenCalled();
    const calls = getCheckInCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.status).toBe('in_progress');
    expect(calls[1]!.body).toMatchObject({
      monitor_slug: 'monitored-job',
      status: 'ok',
      duration: 0,
    });
    // The SDK queue/flush dance is irrelevant on the intentional-skip
    // path — no SDK-side events are emitted, so we don't expect a flush.
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
    // The only waitUntil hand-off is the check-in delivery itself (the
    // safety net for a delivery that outlives the skip budget); it has
    // already settled here.
    expect(waitUntilCalls).toHaveLength(1);
    await expect(waitUntilCalls[0]).resolves.toBeUndefined();
  });

  it('live run: the ok completion check-in settles BEFORE res.json', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('monitored-job', handler);
    const res = mockResponse();
    const events = trackOrdering(res);

    await wrapped(mockRequest(), res);

    expect(events).toEqual([
      'fetch:start:in_progress',
      'fetch:done:in_progress',
      'fetch:start:ok',
      'fetch:done:ok',
      'res.json',
    ]);
    expect(res._status).toBe(200);
  });

  it('live run (handler throws): the error check-in settles BEFORE the 500', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const wrapped = withCronInstrumentation('monitored-job', handler);
    const res = mockResponse();
    const events = trackOrdering(res);

    await wrapped(mockRequest(), res);

    expect(events).toEqual([
      'fetch:start:in_progress',
      'fetch:done:in_progress',
      'fetch:start:error',
      'fetch:done:error',
      'res.json',
    ]);
    expect(res._status).toBe(500);
  });

  it('live run: a hung completion check-in is bounded by the 5 s fetch abort', async () => {
    vi.useFakeTimers();
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 202 })) // in_progress
      .mockImplementationOnce(hangUntilAborted); // completion hangs
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('monitored-job', handler);
    const res = mockResponse();

    const run = wrapped(mockRequest(), res);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(res._json).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(res._status).toBe(200);
    expect((res._json as { status: string }).status).toBe('success');
  });

  it('live run: a rejecting completion check-in still responds 200', async () => {
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 202 })) // in_progress
      .mockRejectedValueOnce(new Error('Sentry unreachable')); // completion
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('monitored-job', handler);
    const res = mockResponse();

    await wrapped(mockRequest(), res);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('live run: a res.json throw after the ok check-in sends NO second (error) check-in for the same id', async () => {
    // The ok completion already closed this check-in id. If writing the
    // response then throws (e.g. unserializable metadata), the catch arm
    // must not send a conflicting second terminal check-in.
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn().mockResolvedValue({ status: 'success' as const });
    const wrapped = withCronInstrumentation('monitored-job', handler);
    const res = mockResponse();
    const serializeError = new Error('cannot serialize BigInt');
    const writeJson = res.json.bind(res);
    vi.spyOn(res, 'json')
      .mockImplementationOnce(() => {
        throw serializeError;
      })
      .mockImplementation((body: unknown) => writeJson(body));

    await wrapped(mockRequest(), res);

    const calls = getCheckInCalls();
    expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'ok']);
    // The failure still surfaces by name: Sentry issue + 500 response.
    expect(Sentry.captureException).toHaveBeenCalledWith(serializeError);
    expect(res._status).toBe(500);
  });

  it('dynamicTimeCheck skip: sends the in_progress + ok pair BEFORE the skip response', async () => {
    // The off-regime slot of a dual-slot DST schedule skips here, not in
    // cronGuard. It used to send no check-in at all → `missed` daily.
    vi.mocked(cronGuard).mockReturnValue(guardOk);
    const handler = vi.fn();
    const wrapped = withCronInstrumentation('monitored-job', handler, {
      dynamicTimeCheck: () => ({ run: false, reason: 'Outside time window' }),
    });
    const res = mockResponse();
    const events = trackOrdering(res);

    await wrapped(mockRequest(), res);

    expect(handler).not.toHaveBeenCalled();
    expect(events).toEqual([
      'fetch:start:in_progress',
      'fetch:done:in_progress',
      'fetch:start:ok',
      'fetch:done:ok',
      'res.json',
    ]);
    expect(res._json).toMatchObject({ status: 'skipped', skipped: true });
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

  it('config failure (500, UW_API_KEY missing) does NOT send check-in', async () => {
    // Real cronGuard with an OPEN window and no UW key: a genuine config
    // outage, so it must stay a `missed` tick in Sentry.
    useRealCronGuard();
    const saved = process.env.UW_API_KEY;
    delete process.env.UW_API_KEY;
    try {
      const wrapped = withCronInstrumentation('monitored-job', vi.fn(), {
        timeCheck: () => true,
      });
      const res = mockResponse();

      await wrapped(authedCronReq(), res);

      expect(res._status).toBe(500);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.UW_API_KEY = saved;
    }
  });
});

describe('withCronCheckin', () => {
  const ORIGINAL_ENV = process.env;
  const authedReq = () =>
    mockRequest({ headers: { authorization: 'Bearer test-secret' } });

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilCalls.length = 0;
    fetchMock.mockReset();
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
    // The waitUntil hold resolves rather than rejecting, so waitUntil
    // never sees a rejection.
    expect(waitUntilCalls).toHaveLength(1);
    await expect(waitUntilCalls[0]).resolves.toBeUndefined();
  });

  it('registers the waitUntil hold BEFORE inner() runs, so post-response work cannot outrun it', async () => {
    // inner() owns the response. If the hold were registered only after
    // inner settles, a handler that kept awaiting after res.json would let
    // the runtime finish the invocation first. Registering up front removes
    // any dependence on when the runtime notices the response.
    let holdsWhenInnerStarts = -1;
    let releasePostResponseWork!: () => void;
    const inner = vi.fn(async (_req, res) => {
      holdsWhenInnerStarts = waitUntilCalls.length;
      res.status(200).json({ ok: true });
      await new Promise<void>((resolve) => {
        releasePostResponseWork = resolve;
      });
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    const run = wrapped(authedReq(), mockResponse());
    await vi.waitFor(() => {
      expect(inner).toHaveBeenCalledTimes(1);
    });
    expect(holdsWhenInnerStarts).toBe(1);
    // Response written, handler still working: the hold must be pending.
    expect(await hasSettled(waitUntilCalls[0]!)).toBe(false);

    releasePostResponseWork();
    await run;
    await expect(waitUntilCalls[0]).resolves.toBeUndefined();
    expect(getCheckInCalls()[1]!.body).toMatchObject({ status: 'ok' });
  });

  it('completion check-in is covered by waitUntil until the POST lands', async () => {
    // inner() has already responded when it settles, so an awaited fetch
    // here would race the freeze (fetch-zero-dte-flow et al.). The
    // waitUntil hold must stay pending until the completion POST itself
    // has landed.
    let releaseCompletion!: () => void;
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 202 })) // in_progress
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseCompletion = () => {
              resolve(new Response('', { status: 202 }));
            };
          }),
      );
    const inner = vi.fn(async (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const wrapped = withCronCheckin('checkin-job', inner);
    const res = mockResponse();

    // Returns without waiting on Sentry.
    await wrapped(authedReq(), res);

    expect(res._status).toBe(200);
    expect(getCheckInCalls()[1]!.body).toMatchObject({ status: 'ok' });
    expect(waitUntilCalls).toHaveLength(1);
    const completion = waitUntilCalls[0]!;
    expect(await hasSettled(completion)).toBe(false);

    releaseCompletion();
    await expect(completion).resolves.toBeUndefined();
  });

  it('cronGuard skip inside inner: the ok completion still reaches waitUntil (market-closed ticks)', async () => {
    // The real cronGuard writes its 200 skip inside inner(); the wrapper's
    // completion runs after that response, so it must be kept alive.
    const inner = vi.fn(async (req, res) => {
      const guard = realCronGuard(req, res, { timeCheck: () => false });
      if (!guard) return;
    });
    const wrapped = withCronCheckin('checkin-job', inner);
    const res = mockResponse();
    const events = trackOrdering(res);

    await wrapped(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(waitUntilCalls).toHaveLength(1);
    await waitUntilCalls[0];
    expect(events).toEqual([
      'fetch:start:in_progress',
      'fetch:done:in_progress',
      'res.json',
      'fetch:start:ok',
      'fetch:done:ok',
    ]);
  });

  it('error completion for a throwing inner is covered by waitUntil and the error re-thrown', async () => {
    const inner = vi.fn(async () => {
      throw new Error('inner exploded');
    });
    const wrapped = withCronCheckin('checkin-job', inner);

    await expect(wrapped(authedReq(), mockResponse())).rejects.toThrow(
      'inner exploded',
    );

    expect(waitUntilCalls).toHaveLength(1);
    await expect(waitUntilCalls[0]).resolves.toBeUndefined();
    expect(getCheckInCalls()[1]!.body).toMatchObject({ status: 'error' });
  });

  it('throw arm: the error check-in settles BEFORE the wrapper promise rejects', async () => {
    // A throwing inner() usually has not responded; Vercel's 500 only goes
    // out once this promise rejects. Awaiting the error POST first makes
    // its delivery deterministic instead of relying on the waitUntil hold.
    let releaseErrorPost!: () => void;
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 202 })) // in_progress
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseErrorPost = () => {
              resolve(new Response('', { status: 202 }));
            };
          }),
      );
    const wrapped = withCronCheckin(
      'checkin-job',
      vi.fn(async () => {
        throw new Error('inner exploded');
      }),
    );

    const run = wrapped(authedReq(), mockResponse());
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(getCheckInCalls()[1]!.body).toMatchObject({ status: 'error' });
    // The error POST is in flight, so the rejection must still be pending.
    expect(await hasSettled(run)).toBe(false);

    releaseErrorPost();
    await expect(run).rejects.toThrow('inner exploded');
  });

  it('a hung completion check-in is bounded by the 5 s fetch abort', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 202 })) // in_progress
        .mockImplementationOnce(hangUntilAborted); // completion hangs
      const inner = vi.fn(async (_req, res) => {
        res.status(200).json({ ok: true });
      });
      const wrapped = withCronCheckin('checkin-job', inner);

      await wrapped(authedReq(), mockResponse());
      const completion = waitUntilCalls[0]!;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(await hasSettled(completion)).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(completion).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
    // The completion is under waitUntil; let it land before asserting.
    await Promise.all(waitUntilCalls);

    expect(res._status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        monitorSlug: 'checkin-job',
        httpStatus: 403,
      }),
      'sentry check-in rejected',
    );
  });

  it('serializes failureIssueThreshold on monitor_config upsert', async () => {
    // High-frequency monitors carry an elevated failureIssueThreshold
    // in the monitor_config block so Sentry waits for 3 consecutive
    // misses before opening an issue. This silences transient noise
    // (~5% miss rate from stale keep-alive sockets) while still
    // detecting real outages (3 consecutive misses on every-minute
    // crons = 3min of no completions).
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
    // We send default keep-alive headers (no Connection: close).
    // Verified by negative-assertion to lock the revert from
    // commit 62365e9e in place; Sentry's edge rejects fresh
    // TLS sessions under burst, producing 100% miss rate.
    for (const c of calls) {
      expect(c.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(c.headers).not.toHaveProperty('Connection');
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

// ============================================================
// isCronAuthenticated — constant-time header check
// ============================================================
//
// Direct unit tests for the auth primitive used by withCronCheckin.
// The wrapper's path was exercised indirectly via 'auth failure (401)'
// above, but those used the cronGuard mock; the actual header parsing
// and timingSafeEqual call was never under test.
describe('isCronAuthenticated', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret-32-chars-padding';
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('returns true with matching Bearer header', () => {
    const req = mockRequest({
      headers: { authorization: 'Bearer test-cron-secret-32-chars-padding' },
    });
    expect(isCronAuthenticated(req)).toBe(true);
  });

  it('returns false with wrong secret of the same length', () => {
    const req = mockRequest({
      headers: { authorization: 'Bearer WRONG-cron-secret-32-chars-padding' },
    });
    expect(isCronAuthenticated(req)).toBe(false);
  });

  it('returns false when secret length differs (timingSafeEqual prereq)', () => {
    const req = mockRequest({
      headers: { authorization: 'Bearer short' },
    });
    expect(isCronAuthenticated(req)).toBe(false);
  });

  it('returns false when Authorization header is missing', () => {
    const req = mockRequest({ headers: {} });
    expect(isCronAuthenticated(req)).toBe(false);
  });

  it('returns false when CRON_SECRET env is unset', () => {
    delete process.env.CRON_SECRET;
    const req = mockRequest({
      headers: { authorization: 'Bearer anything' },
    });
    expect(isCronAuthenticated(req)).toBe(false);
  });

  it('returns false when CRON_SECRET is empty string', () => {
    process.env.CRON_SECRET = '';
    const req = mockRequest({
      headers: { authorization: 'Bearer ' },
    });
    expect(isCronAuthenticated(req)).toBe(false);
  });
});

describe('deriveCronStatus', () => {
  it('returns success when there is no work to do (0 / 0)', () => {
    expect(deriveCronStatus(0, 0)).toBe('success');
  });

  it('returns error when every attempted leg failed (2 / 2)', () => {
    expect(deriveCronStatus(2, 2)).toBe('error');
  });

  it('returns partial when some legs failed (1 / 3)', () => {
    expect(deriveCronStatus(1, 3)).toBe('partial');
  });

  it('returns success when no legs failed (0 / 3)', () => {
    expect(deriveCronStatus(0, 3)).toBe('success');
  });

  it('returns error when failed exceeds total (guard against over-count)', () => {
    expect(deriveCronStatus(4, 2)).toBe('error');
  });

  it('returns error for a single attempted leg that failed (1 / 1)', () => {
    expect(deriveCronStatus(1, 1)).toBe('error');
  });

  it('treats failed > 0 with total 0 as success (no work overrides)', () => {
    // total === 0 short-circuits first: an empty run is never a failure
    // even if a caller passes a stray non-zero failure count.
    expect(deriveCronStatus(3, 0)).toBe('success');
  });
});
