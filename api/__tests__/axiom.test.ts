// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────
// vi.hoisted runs before import hoisting, so the mock factories can
// reference these before the module is loaded.

const { mockIngest, constructorSpy, mockOptionalEnv, mockCaptureMessage } =
  vi.hoisted(() => ({
    mockIngest: vi.fn(),
    constructorSpy: vi.fn(),
    mockOptionalEnv: vi.fn<(key: string) => string | undefined>(),
    mockCaptureMessage: vi.fn(),
  }));

vi.mock('@axiomhq/js', () => ({
  AxiomWithoutBatching: class {
    ingest = mockIngest;
    constructor(opts: { token: string; onError?: (error: Error) => void }) {
      constructorSpy(opts);
    }
  },
}));

vi.mock('../_lib/env.js', () => ({
  optionalEnv: mockOptionalEnv,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: mockCaptureMessage,
    setTag: vi.fn(),
  },
  metrics: {},
}));

import { reportCronRun, _resetClient } from '../_lib/axiom.js';
import { AXIOM_TOP_LEVEL_KEYS } from '../_lib/axiom-fields.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────────

const API_KEY = 'xapt-test-key';
const DATASET = 'cron-metrics';
const JOB = 'archive-gexbot';

/** What the SDK resolves on success. */
const ACCEPTED = { ingested: 1, failed: 0 };
/** What the SDK resolves after catching an HTTP error (it never rejects). */
const REJECTED = { ingested: 0, failed: 0 };

/** Mirrors MAX_META_CHARS in api/_lib/axiom.ts (kept private there). */
const MAX_META_CHARS = 16_000;

function withBothEnvs() {
  mockOptionalEnv.mockImplementation((key) => {
    if (key === 'AXIOM_API_KEY') return API_KEY;
    if (key === 'AXIOM_DATASET') return DATASET;
    return undefined;
  });
}

/** The event object passed to the nth `ingest` call. */
function sentEvent(call = 0): Record<string, unknown> {
  const args = mockIngest.mock.calls[call];
  if (!args) throw new Error(`ingest call ${call} was not made`);
  return args[1] as Record<string, unknown>;
}

beforeEach(() => {
  _resetClient();
  mockIngest.mockReset();
  mockIngest.mockResolvedValue(ACCEPTED);
  constructorSpy.mockClear();
  mockOptionalEnv.mockReset();
  vi.mocked(logger.warn).mockClear();
  mockCaptureMessage.mockClear();
});

// ── Allowlist snapshot ────────────────────────────────────────

describe('AXIOM_TOP_LEVEL_KEYS', () => {
  it('matches the 2026-10-25 schema snapshot of existing columns', () => {
    expect(AXIOM_TOP_LEVEL_KEYS.size).toBe(111);
    for (const name of [
      'status',
      'rows',
      'message',
      'durationMs',
      'stored',
      'skipped',
    ]) {
      expect(AXIOM_TOP_LEVEL_KEYS.has(name)).toBe(true);
    }
    for (const name of ['job', '_time', 'meta']) {
      expect(AXIOM_TOP_LEVEL_KEYS.has(name)).toBe(false);
    }
  });
});

// ── 1. No-op paths ────────────────────────────────────────────

describe('reportCronRun: no-op when env vars absent', () => {
  it('skips ingest when AXIOM_API_KEY is not set', async () => {
    mockOptionalEnv.mockReturnValue(undefined);

    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('skips ingest when AXIOM_DATASET is not set', async () => {
    mockOptionalEnv.mockImplementation((key) =>
      key === 'AXIOM_API_KEY' ? API_KEY : undefined,
    );

    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('does not throw in either no-op case', async () => {
    mockOptionalEnv.mockReturnValue(undefined);
    await expect(
      reportCronRun('fetch-darkpool', { status: 'ok' }),
    ).resolves.toBeUndefined();
  });
});

// ── 2–8. Event shape ──────────────────────────────────────────

describe('reportCronRun: envelope and meta', () => {
  beforeEach(withBothEnvs);

  it('keeps allowed scalars top-level and moves everything else into meta', async () => {
    await reportCronRun(JOB, {
      status: 'success',
      rows: 10,
      failed: 0,
      dates: ['2026-09-08'],
      summaries: [{ table: 't', rowCount: 1 }],
      remainingDates: 0,
      stopReason: 'drained',
      durationMs: 5,
    });

    expect(mockIngest).toHaveBeenCalledOnce();
    // `dates` is an allowed name but an array, so it goes to meta too.
    // JSON.stringify keeps string-key insertion order, and the overflow
    // object is filled in payload order, so this literal is deterministic.
    expect(mockIngest).toHaveBeenCalledWith(DATASET, {
      job: JOB,
      status: 'success',
      rows: 10,
      failed: 0,
      durationMs: 5,
      meta: '{"dates":["2026-09-08"],"summaries":[{"table":"t","rowCount":1}],"remainingDates":0,"stopReason":"drained"}',
    });
  });

  it('moves a non-primitive value under an allowed name into meta', async () => {
    await reportCronRun(JOB, {
      status: 'ok',
      skipped: { a: 1 },
      date: ['x'],
    });

    expect(sentEvent()).toStrictEqual({
      job: JOB,
      status: 'ok',
      meta: '{"skipped":{"a":1},"date":["x"]}',
    });
  });

  it('moves a primitive under a name that is not an existing column into meta', async () => {
    await reportCronRun(JOB, {
      stored: 5,
      today: '2026-10-25',
      error: 'boom',
    });

    expect(sentEvent()).toStrictEqual({
      job: JOB,
      stored: 5,
      meta: '{"today":"2026-10-25","error":"boom"}',
    });
  });

  it('drops undefined values and keeps null under an allowed name', async () => {
    await reportCronRun(JOB, {
      status: 'ok',
      rows: undefined,
      perTicker: undefined,
      reason: null,
    });

    expect(sentEvent()).toStrictEqual({
      job: JOB,
      status: 'ok',
      reason: null,
    });
  });

  it('never lets a payload job key override the job argument', async () => {
    await reportCronRun(JOB, { job: 'spoofed', status: 'ok' });

    expect(sentEvent()).toStrictEqual({ job: JOB, status: 'ok' });
  });

  it('replaces meta longer than MAX_META_CHARS with a truncation marker', async () => {
    const overflow = {
      perTicker: 'x'.repeat(MAX_META_CHARS + 1),
      stopReason: 'drained',
    };
    const fullChars = JSON.stringify(overflow).length;

    await reportCronRun(JOB, { status: 'ok', ...overflow });

    const event = sentEvent();
    expect(event).toStrictEqual({
      job: JOB,
      status: 'ok',
      meta: JSON.stringify({
        truncated: true,
        chars: fullChars,
        keys: ['perTicker', 'stopReason'],
      }),
    });
    expect((event.meta as string).length).toBeLessThan(100);
  });

  it('keeps meta that is exactly MAX_META_CHARS long', async () => {
    // '{"perTicker":""}' is 16 chars, so this value makes meta exactly
    // MAX_META_CHARS: the limit is inclusive.
    const perTicker = 'x'.repeat(MAX_META_CHARS - 16);

    await reportCronRun(JOB, { status: 'ok', perTicker });

    const meta = sentEvent().meta as string;
    expect(meta).toHaveLength(MAX_META_CHARS);
    expect(JSON.parse(meta)).toStrictEqual({ perTicker });
  });

  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;

  it.each([
    ['a BigInt', { count: BigInt(10) }],
    ['a BigInt under an allowed name', { rows: BigInt(5) }],
    ['a circular object', { graph: circular }],
  ])(
    'replaces %s with the unserializable marker without throwing',
    async (_label, extra) => {
      await expect(
        reportCronRun(JOB, { status: 'ok', ...extra }),
      ).resolves.toBeUndefined();

      expect(sentEvent()).toStrictEqual({
        job: JOB,
        status: 'ok',
        meta: JSON.stringify({
          unserializable: true,
          keys: Object.keys(extra),
        }),
      });
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('adds no meta key when nothing overflows', async () => {
    const allAllowed = {
      status: 'success',
      rows: 3,
      stored: 1,
      skipped: 0,
      message: 'm',
      durationMs: 1,
    };

    await reportCronRun(JOB, allAllowed);

    expect(sentEvent()).toStrictEqual({ job: JOB, ...allAllowed });
  });
});

// ── 13. Client construction ───────────────────────────────────

describe('reportCronRun: client', () => {
  beforeEach(withBothEnvs);

  it('routes SDK errors to pino through onError', async () => {
    await reportCronRun(JOB, { status: 'ok' });

    expect(constructorSpy).toHaveBeenCalledOnce();
    expect(constructorSpy).toHaveBeenCalledWith({
      token: API_KEY,
      onError: expect.any(Function),
    });

    const opts = constructorSpy.mock.calls[0]?.[0] as {
      onError: (error: Error) => void;
    };
    const err = new Error('x');
    opts.onError(err);

    expect(logger.warn).toHaveBeenCalledWith({ err }, 'axiom: ingest error');
  });

  it('reuses the singleton across runs', async () => {
    await reportCronRun('job-a', { status: 'ok' });
    await reportCronRun('job-b', { status: 'skipped' });

    expect(constructorSpy).toHaveBeenCalledOnce();
    expect(mockIngest).toHaveBeenCalledTimes(2);
  });
});

// ── 9–11, 14. Rejection detection ─────────────────────────────
// Tests 9 and 11 each expect a fresh Sentry report, which only holds
// because the top-level beforeEach calls _resetClient.

describe('reportCronRun: rejected ingest (ingested === 0)', () => {
  beforeEach(withBothEnvs);

  const payload = {
    status: 'success',
    rows: 3,
    perTicker: { SPY: 1 },
    stopReason: 'drained',
  };
  const envelope = { job: JOB, status: 'success', rows: 3 };
  const overflowKeys = ['perTicker', 'stopReason'];

  it('retries without meta, logs the overflow keys and warns Sentry once', async () => {
    mockIngest.mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(REJECTED);

    await expect(reportCronRun(JOB, payload)).resolves.toBeUndefined();

    expect(mockIngest).toHaveBeenCalledTimes(2);
    expect(mockIngest.mock.calls[0]).toStrictEqual([
      DATASET,
      { ...envelope, meta: '{"perTicker":{"SPY":1},"stopReason":"drained"}' },
    ]);
    expect(mockIngest.mock.calls[1]).toStrictEqual([DATASET, envelope]);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        job: JOB,
        overflowKeys,
        retryIngested: 0,
        failed: 0,
        failureSample: undefined,
      },
      'axiom: event rejected; retried without meta',
    );

    expect(mockCaptureMessage).toHaveBeenCalledOnce();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Axiom rejected cron event',
      {
        level: 'warning',
        tags: { job: JOB, 'axiom.retried': 'true' },
        extra: { overflowKeys, failed: 0, failureSample: undefined },
        fingerprint: ['axiom-ingest-rejected'],
      },
    );
  });

  it('carries a truncated SDK failure reason into the warning and Sentry', async () => {
    const error = `adding meta would exceed the column limit of 257 ${'x'.repeat(300)}`;
    const sample = error.slice(0, 200);
    mockIngest
      .mockResolvedValueOnce({
        ingested: 0,
        failed: 1,
        failures: [{ error, timestamp: '2026-10-25T00:00:00Z' }],
      })
      .mockResolvedValueOnce(ACCEPTED);

    await reportCronRun(JOB, payload);

    expect(logger.warn).toHaveBeenCalledWith(
      {
        job: JOB,
        overflowKeys,
        retryIngested: 1,
        failed: 1,
        failureSample: sample,
      },
      'axiom: event rejected; retried without meta',
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Axiom rejected cron event',
      expect.objectContaining({
        extra: { overflowKeys, failed: 1, failureSample: sample },
      }),
    );
  });

  it('logs every later rejection on the instance but reports to Sentry only once', async () => {
    mockIngest
      .mockResolvedValueOnce(REJECTED) // JOB, first attempt
      .mockResolvedValueOnce(REJECTED) // JOB, retry without meta
      .mockResolvedValueOnce(REJECTED) // JOB again, first attempt
      .mockResolvedValueOnce(ACCEPTED) // JOB again, retry lands
      .mockResolvedValueOnce(REJECTED); // other job, no meta → no retry

    await reportCronRun(JOB, payload);
    await reportCronRun(JOB, payload);
    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(mockIngest).toHaveBeenCalledTimes(5);
    expect(mockIngest.mock.calls[3]).toStrictEqual([DATASET, envelope]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      {
        job: JOB,
        overflowKeys,
        retryIngested: 1,
        failed: 0,
        failureSample: undefined,
      },
      'axiom: event rejected; retried without meta',
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      3,
      { job: 'fetch-darkpool', failed: 0, failureSample: undefined },
      'axiom: event rejected',
    );
    expect(mockCaptureMessage).toHaveBeenCalledOnce();
  });

  it('does not retry when the rejected event had no meta', async () => {
    mockIngest.mockResolvedValueOnce(REJECTED);

    await reportCronRun(JOB, { status: 'ok', rows: 1 });

    expect(mockIngest).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      { job: JOB, failed: 0, failureSample: undefined },
      'axiom: event rejected',
    );
    expect(mockCaptureMessage).toHaveBeenCalledOnce();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Axiom rejected cron event',
      {
        level: 'warning',
        tags: { job: JOB, 'axiom.retried': 'false' },
        extra: { overflowKeys: [], failed: 0, failureSample: undefined },
        fingerprint: ['axiom-ingest-rejected'],
      },
    );
  });

  it('reports to Sentry again after _resetClient', async () => {
    mockIngest.mockResolvedValue(REJECTED);

    await reportCronRun(JOB, { status: 'ok' });
    await reportCronRun(JOB, { status: 'ok' });
    expect(mockCaptureMessage).toHaveBeenCalledOnce();

    _resetClient();
    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    expect(mockCaptureMessage).toHaveBeenLastCalledWith(
      'Axiom rejected cron event',
      expect.objectContaining({
        tags: { job: 'fetch-darkpool', 'axiom.retried': 'false' },
      }),
    );
  });
});

// ── 12. Unexpected failure ────────────────────────────────────

describe('reportCronRun: ingest promise rejects', () => {
  beforeEach(withBothEnvs);

  it('swallows the error, logs it and resolves', async () => {
    const err = new Error('network timeout');
    mockIngest.mockRejectedValueOnce(err);

    await expect(
      reportCronRun(JOB, { status: 'ok', perTicker: { SPY: 1 } }),
    ).resolves.toBeUndefined();

    expect(mockIngest).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      { err },
      'axiom: reportCronRun failed',
    );
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
