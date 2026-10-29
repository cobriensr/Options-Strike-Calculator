// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockCapture, mockException, mockReport, mockWarn, eod, zip } =
  vi.hoisted(() => ({
    mockCapture: vi.fn(),
    mockException: vi.fn(),
    mockReport: vi.fn(),
    mockWarn: vi.fn(),
    eod: {
      fetchEodTickers: vi.fn(),
      latestEligibleReportDate: vi.fn(),
      requestEodReport: vi.fn(),
      storeEodReport: vi.fn(),
      indexExistingObject: vi.fn(),
      listStoredTickers: vi.fn(),
    },
    zip: { validateEodZip: vi.fn() },
  }));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockException,
    captureMessage: mockCapture,
  },
  metrics: { uwRateLimit: vi.fn() },
}));
vi.mock('../_lib/axiom.js', () => ({ reportCronRun: mockReport }));
vi.mock('../_lib/gexbot-eod.js', () => eod);
vi.mock('../_lib/gexbot-eod-zip.js', async () => {
  class EodZipError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  }
  return { ...zip, EodZipError };
});

import { EodZipError } from '../_lib/gexbot-eod-zip.js';
import handler, { config } from '../cron/archive-gexbot-eod.js';

const AUTH = { authorization: 'Bearer test-secret' };
const EXPECTED = '2026-10-28';
const NOW = new Date('2026-10-29T02:00:00.000Z');

interface OkOpts {
  servedDate?: string;
  body?: Uint8Array;
  readBody?: () => Promise<Uint8Array>;
}

function ok(opts: OkOpts = {}) {
  const body = opts.body ?? new Uint8Array([1, 2, 3]);
  return {
    kind: 'ok' as const,
    servedDate: opts.servedDate ?? EXPECTED,
    contentLength: body.length,
    readBody: opts.readBody ?? vi.fn(async () => body),
    discard: vi.fn(async () => undefined),
  };
}

async function run() {
  const res = mockResponse();
  const p = handler(mockRequest({ method: 'GET', headers: AUTH }), res);
  await vi.runAllTimersAsync();
  await p;
  return res;
}

type Json = Record<string, any>;

const FAILED_FP = ['gexbot-eod', 'capture-failed'];

function failureCaptures() {
  return mockCapture.mock.calls.filter(
    ([, o]) =>
      JSON.stringify((o as { fingerprint?: string[] }).fingerprint) ===
      JSON.stringify(FAILED_FP),
  );
}

function setTickers(tickers: string[], rejected: string[] = []) {
  eod.fetchEodTickers.mockResolvedValue({ tickers, rejected });
}

describe('archive-gexbot-eod', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    process.env.GEXBOT_API_KEY = 'key';
    eod.latestEligibleReportDate.mockReturnValue(EXPECTED);
    eod.listStoredTickers.mockResolvedValue(new Set());
    eod.indexExistingObject.mockResolvedValue('absent');
    eod.storeEodReport.mockImplementation(async (a: { body: Uint8Array }) => ({
      key: 'k',
      sha256: 's',
      bytes: a.body.length,
    }));
    zip.validateEodZip.mockReturnValue({ entryCount: 15, entryNames: [] });
    setTickers(['A', 'B']);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('exports an 800 s maxDuration', () => {
    expect(config.maxDuration).toBe(800);
  });

  it('401s without the CRON_SECRET bearer', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(eod.requestEodReport).not.toHaveBeenCalled();
  });

  it('stores two tickers on the happy path', async () => {
    eod.requestEodReport.mockImplementation(async () => ok());
    const res = await run();
    const json = res._json as Json;
    expect(res._status).toBe(200);
    expect(json.status).toBe('success');
    expect(json.storedCount).toBe(2);
    expect(json.bytes).toBe(6);
    expect(json.expectedDate).toBe(EXPECTED);
    expect(eod.storeEodReport).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'A', date: EXPECTED, entryCount: 15 }),
    );
    expect(mockCapture).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes no request when every ticker already has a row', async () => {
    eod.listStoredTickers.mockResolvedValue(new Set(['A', 'B']));
    const res = await run();
    expect(eod.requestEodReport).not.toHaveBeenCalled();
    expect(eod.indexExistingObject).not.toHaveBeenCalled();
    expect((res._json as Json).status).toBe('success');
  });

  it('indexes an object already in R2 without downloading', async () => {
    eod.indexExistingObject.mockResolvedValue('indexed');
    const res = await run();
    const json = res._json as Json;
    expect(json.indexedFromR2).toBe(2);
    expect(json.rows).toBe(2);
    expect(eod.requestEodReport).not.toHaveBeenCalled();
  });

  it('fails a ticker whose R2 object lacks metadata and continues', async () => {
    eod.indexExistingObject.mockImplementation(async (t: string) => {
      if (t === 'A') throw new Error('object_without_metadata');
      return 'absent';
    });
    eod.requestEodReport.mockImplementation(async () => ok());
    const res = await run();
    const json = res._json as Json;
    expect(json.status).toBe('partial');
    expect(json.failed).toEqual([
      { ticker: 'A', reason: 'object_without_metadata' },
    ]);
    expect(json.storedCount).toBe(1);
    expect(failureCaptures()).toHaveLength(1);
  });

  it('discards an older served date that already has a row', async () => {
    setTickers(['A']);
    eod.listStoredTickers.mockImplementation(async (d: string) =>
      d === '2026-10-27' ? new Set(['A']) : new Set(),
    );
    const r = ok({ servedDate: '2026-10-27' });
    eod.requestEodReport.mockResolvedValue(r);
    const res = await run();
    const json = res._json as Json;
    expect(r.discard).toHaveBeenCalledTimes(1);
    expect(json.notYetPublished).toBe(1);
    expect(json.status).toBe('partial');
    expect(json.storedCount).toBe(0);
    expect(eod.storeEodReport).not.toHaveBeenCalled();
  });

  it('keeps stored and skipped out of the shared Axiom columns', async () => {
    await run();
    const meta = mockReport.mock.calls[0]?.[1] as Json;
    expect(meta).toHaveProperty('storedCount');
    expect(meta).toHaveProperty('skippedCount');
    expect(meta).not.toHaveProperty('stored');
    expect(meta).not.toHaveProperty('skipped');
  });

  it('counts a served date equal to expected with a row as skipped', async () => {
    setTickers(['A']);
    // A concurrent run indexes the row after the ticker list was filtered.
    const r = ok();
    eod.requestEodReport.mockResolvedValue(r);
    const live = new Set<string>();
    eod.listStoredTickers.mockResolvedValue(live);
    eod.indexExistingObject.mockImplementation(async () => {
      live.add('A');
      return 'absent';
    });
    const res = await run();
    const json = res._json as Json;
    expect(r.discard).toHaveBeenCalledTimes(1);
    expect(json.skippedCount).toBe(1);
    expect(eod.storeEodReport).not.toHaveBeenCalled();
  });

  it('indexes a catch-up report already in R2 without reading the body', async () => {
    setTickers(['A']);
    const r = ok({ servedDate: '2026-10-27' });
    eod.requestEodReport.mockResolvedValue(r);
    eod.indexExistingObject.mockImplementation(async (_t: string, d: string) =>
      d === '2026-10-27' ? 'indexed' : 'absent',
    );
    const res = await run();
    const json = res._json as Json;
    expect(eod.indexExistingObject).toHaveBeenCalledWith('A', '2026-10-27');
    expect(r.discard).toHaveBeenCalledTimes(1);
    expect(r.readBody).not.toHaveBeenCalled();
    expect(eod.storeEodReport).not.toHaveBeenCalled();
    expect(json.caughtUp).toBe(1);
    expect(json.indexedFromR2).toBe(1);
    expect(json.storedCount).toBe(0);
    expect(json.status).toBe('partial');
  });

  it('fails a catch-up ticker whose R2 object lacks metadata and discards the body', async () => {
    setTickers(['A']);
    const r = ok({ servedDate: '2026-10-27' });
    eod.requestEodReport.mockResolvedValue(r);
    eod.indexExistingObject.mockImplementation(
      async (_t: string, d: string) => {
        if (d === '2026-10-27') throw new Error('object_without_metadata');
        return 'absent';
      },
    );
    const res = await run();
    const json = res._json as Json;
    expect(json.failed).toEqual([
      { ticker: 'A', reason: 'object_without_metadata' },
    ]);
    expect(json.caughtUp).toBe(0);
    expect(r.discard).toHaveBeenCalledTimes(1);
    expect(r.readBody).not.toHaveBeenCalled();
    expect(json.status).toBe('error');
  });

  it('stores an older served date with no row under that date (catch-up)', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue(ok({ servedDate: '2026-10-27' }));
    const res = await run();
    const json = res._json as Json;
    expect(json.storedCount).toBe(1);
    expect(json.caughtUp).toBe(1);
    expect(json.indexedFromR2).toBe(0);
    expect(json.status).toBe('partial');
    expect(eod.listStoredTickers).toHaveBeenCalledWith('2026-10-27');
    expect(eod.storeEodReport).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'A', date: '2026-10-27' }),
    );
  });

  it('stops on 429, leaving later tickers in leftover', async () => {
    setTickers(['A', 'B', 'C', 'D']);
    // concurrency 3 would start A,B,C together; make B the quota hit and
    // check D never starts and C is not requested after the flag is set.
    eod.requestEodReport.mockImplementation(async (_k: string, t: string) =>
      t === 'B' ? { kind: 'quota' } : ok(),
    );
    const res = await run();
    const json = res._json as Json;
    expect(json.stopReason).toBe('quota');
    expect(json.status).toBe('partial');
    expect(json.leftover).toContain('B');
    expect(json.leftover).toContain('D');
    // By design (Ruling 15): leftover-only runs rely on the audit cron.
    expect(failureCaptures()).toHaveLength(0);
    expect(eod.requestEodReport).not.toHaveBeenCalledWith(
      'key',
      'D',
      expect.anything(),
    );
  });

  it('records http_503 as failed', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue({ kind: 'http_error', status: 503 });
    const res = await run();
    const json = res._json as Json;
    expect(json.failed).toEqual([{ ticker: 'A', reason: 'http_503' }]);
    expect(json.status).toBe('error');
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        level: 'error',
        fingerprint: ['gexbot-eod', 'capture-failed'],
        extra: expect.objectContaining({ expectedDate: EXPECTED }),
      }),
    );
  });

  it('records a bad_response reason as failed', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue({
      kind: 'bad_response',
      reason: 'bad_disposition',
    });
    const res = await run();
    expect((res._json as Json).failed).toEqual([
      { ticker: 'A', reason: 'bad_disposition' },
    ]);
    expect(failureCaptures()).toHaveLength(1);
  });

  it('fails a truncated body and reports partial', async () => {
    eod.requestEodReport.mockImplementation(async (_k: string, t: string) =>
      t === 'A'
        ? ok({
            readBody: async () => {
              throw new Error('truncated: got 1 of 3 bytes');
            },
          })
        : ok(),
    );
    const res = await run();
    const json = res._json as Json;
    expect(json.status).toBe('partial');
    expect(json.failed).toEqual([{ ticker: 'A', reason: 'truncated' }]);
    expect(json.storedCount).toBe(1);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('stores nothing when the validator throws bad_crc', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue(ok());
    zip.validateEodZip.mockImplementation(() => {
      throw new EodZipError('bad_crc', 'crc mismatch');
    });
    const res = await run();
    expect((res._json as Json).failed).toEqual([
      { ticker: 'A', reason: 'zip_bad_crc' },
    ]);
    expect(failureCaptures()).toHaveLength(1);
    expect(eod.storeEodReport).not.toHaveBeenCalled();
  });

  it('fails a ticker when the R2 verify fails', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue(ok());
    eod.storeEodReport.mockRejectedValue(
      new Error('r2_verify_failed: etag mismatch'),
    );
    const res = await run();
    expect((res._json as Json).failed).toEqual([
      { ticker: 'A', reason: 'r2_verify_failed' },
    ]);
    expect(failureCaptures()).toHaveLength(1);
  });

  it('truncates unknown error messages to 120 chars', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockRejectedValue(new Error('x'.repeat(300)));
    const res = await run();
    const reason = (res._json as Json).failed[0].reason as string;
    expect(reason).toBe(`error: ${'x'.repeat(120)}`);
  });

  it('appends the undici cause code to a generic error reason', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockRejectedValue(
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
    );
    const res = await run();
    expect((res._json as Json).failed[0].reason).toBe(
      'error: fetch failed (ECONNRESET)',
    );
  });

  it('ignores a non-string cause code', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockRejectedValue(
      new TypeError('fetch failed', { cause: { code: 42 } }),
    );
    const res = await run();
    expect((res._json as Json).failed[0].reason).toBe('error: fetch failed');
  });

  it('reports error (not success) when the row lookup rejects', async () => {
    eod.listStoredTickers.mockRejectedValue(new Error('connection lost'));
    const res = await run();
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(mockException).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      'archive-gexbot-eod',
      expect.objectContaining({ status: 'error', message: 'connection lost' }),
    );
    expect(eod.requestEodReport).not.toHaveBeenCalled();
  });

  it('reports error when the ticker list fetch rejects', async () => {
    eod.fetchEodTickers.mockRejectedValue(
      new Error('gexbot_tickers_failed: implausible list (0 tickers)'),
    );
    const res = await run();
    expect(res._status).toBe(500);
    expect(mockException).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      'archive-gexbot-eod',
      expect.objectContaining({ status: 'error' }),
    );
    expect(eod.listStoredTickers).not.toHaveBeenCalled();
    expect(eod.requestEodReport).not.toHaveBeenCalled();
  });

  it('fails only that ticker when a lazy served-date lookup rejects', async () => {
    setTickers(['A', 'B']);
    eod.listStoredTickers.mockImplementation(async (d: string) => {
      if (d === '2026-10-27') throw new Error('blip');
      return new Set();
    });
    eod.requestEodReport.mockImplementation(async (_k: string, t: string) =>
      ok({ servedDate: t === 'A' ? '2026-10-27' : EXPECTED }),
    );
    const res = await run();
    const json = res._json as Json;
    expect(json.storedCount).toBe(1);
    expect(json.failed).toEqual([{ ticker: 'A', reason: 'error: blip' }]);
    expect(failureCaptures()).toHaveLength(1);
  });

  it('reports error when GEXBOT_API_KEY is missing', async () => {
    delete process.env.GEXBOT_API_KEY;
    const res = await run();
    expect(res._status).toBe(500);
    expect(eod.requestEodReport).not.toHaveBeenCalled();
  });

  it('stores an entryCount of 14 and lists it as a warning', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue(ok());
    zip.validateEodZip.mockReturnValue({ entryCount: 14, entryNames: [] });
    const res = await run();
    const json = res._json as Json;
    expect(json.storedCount).toBe(1);
    expect(json.entryCountWarnings).toEqual([{ ticker: 'A', entryCount: 14 }]);
    expect(json.status).toBe('success');
    expect(mockWarn).toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['gexbot-eod', 'entry-count'],
        extra: {
          expectedDate: EXPECTED,
          entryCountWarnings: [{ ticker: 'A', entryCount: 14 }],
        },
      }),
    );
  });

  it('warns about rejected tickers', async () => {
    setTickers(['A'], ['bad ticker']);
    eod.requestEodReport.mockResolvedValue(ok());
    const res = await run();
    expect((res._json as Json).rejectedTickers).toEqual(['bad ticker']);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('starts nothing new after 600 s (budget)', async () => {
    setTickers(['A', 'B', 'C', 'D']);
    eod.requestEodReport.mockImplementation(async () => {
      // A, B and C start at 0 and finish at 650 s, past the 600 s cutoff, so
      // D (still queued) must not start.
      await new Promise((r) => setTimeout(r, 650_000));
      return ok();
    });
    const res = await run();
    const json = res._json as Json;
    expect(json.stopReason).toBe('budget');
    expect(json.storedCount).toBe(3);
    expect(json.leftover).toEqual(['D']);
    expect(json.status).toBe('partial');
    expect(eod.requestEodReport).toHaveBeenCalledTimes(3);
    // By design (Ruling 15): leftover-only runs rely on the audit cron.
    expect(failureCaptures()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts in-flight downloads at 740 s into leftover, not failed', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockImplementation(
      (_k: string, _t: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const res = await run();
    const json = res._json as Json;
    expect(json.leftover).toEqual(['A']);
    expect(failureCaptures()).toHaveLength(0);
    expect(json.failed).toEqual([]);
    expect(json.status).toBe('partial');
    expect(mockCapture).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not request a ticker whose index lookup outlives a 429', async () => {
    setTickers(['A', 'B', 'C']);
    let releaseC: () => void = () => undefined;
    eod.indexExistingObject.mockImplementation((t: string) =>
      t === 'C'
        ? new Promise<'absent'>((resolve) => {
            releaseC = () => resolve('absent');
          })
        : Promise.resolve('absent' as const),
    );
    eod.requestEodReport.mockImplementation(async (_k: string, t: string) => {
      if (t === 'B') {
        setTimeout(() => releaseC(), 10);
        return { kind: 'quota' as const };
      }
      return ok();
    });
    const res = await run();
    const json = res._json as Json;
    expect(eod.requestEodReport).not.toHaveBeenCalledWith(
      'key',
      'C',
      expect.anything(),
    );
    expect(json.leftover).toContain('C');
    expect(json.stopReason).toBe('quota');
  });

  it('sends a post-abort store failure to failed, not leftover', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue(
      ok({
        readBody: async () => {
          await new Promise((r) => setTimeout(r, 745_000));
          return new Uint8Array([1]);
        },
      }),
    );
    eod.storeEodReport.mockRejectedValue(
      new Error('r2_verify_failed: etag mismatch'),
    );
    const res = await run();
    const json = res._json as Json;
    expect(json.failed).toEqual([{ ticker: 'A', reason: 'r2_verify_failed' }]);
    expect(json.leftover).toEqual([]);
    expect(failureCaptures()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs every failed ticker with its error', async () => {
    setTickers(['A']);
    eod.requestEodReport.mockResolvedValue({ kind: 'http_error', status: 503 });
    await run();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'A', reason: 'http_503' }),
      'gexbot-eod ticker failed',
    );
  });

  it('caps the Sentry failure list at 100 and reports the full count', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `T${i}`);
    setTickers(many);
    eod.requestEodReport.mockResolvedValue({ kind: 'http_error', status: 500 });
    await run();
    const [, opts] = failureCaptures()[0] as [
      string,
      { extra: { failed: unknown[]; failedCount: number } },
    ];
    expect(opts.extra.failed).toHaveLength(100);
    expect(opts.extra.failedCount).toBe(120);
  });
});
