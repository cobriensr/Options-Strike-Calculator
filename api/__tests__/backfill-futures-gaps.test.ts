// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────

const mockSql = vi.fn().mockResolvedValue([]);
(mockSql as unknown as Record<string, unknown>).query = vi
  .fn()
  .mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
  checkDataQuality: vi.fn().mockResolvedValue(undefined),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import handler from '../cron/backfill-futures-gaps.js';
import { cronGuard, checkDataQuality } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function makeNdjsonResponse(records: Array<Record<string, unknown>>): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

function makeOhlcvRecord(
  overrides: Partial<{
    ts_event: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }> = {},
) {
  return {
    hd: { ts_event: overrides.ts_event ?? '1775001600000000000' },
    open: overrides.open ?? '5700000000000',
    high: overrides.high ?? '5710000000000',
    low: overrides.low ?? '5690000000000',
    close: overrides.close ?? '5705000000000',
    volume: overrides.volume ?? '500',
  };
}

/**
 * Stub fetch so only the first symbol (ES — first entry in SYMBOLS order)
 * returns real NDJSON. All other symbols get an empty response. This
 * isolates per-symbol rejection assertions from the 7-symbol fan-out.
 *
 * BRITTLENESS NOTE: this helper depends on ES being iterated FIRST in
 * `Object.entries(SYMBOLS)` in the handler. If a future edit reorders
 * SYMBOLS in `backfill-futures-gaps.ts`, every test that uses this helper
 * will silently attribute ES's records to whichever symbol comes first.
 * Keep ES as the first key in SYMBOLS, or switch this helper to match on
 * the request URL (which embeds the symbol code).
 */
function stubEsOnly(records: Array<Record<string, unknown>>): void {
  let call = 0;
  mockFetch.mockImplementation(() => {
    call += 1;
    return Promise.resolve({
      ok: true,
      text: () =>
        Promise.resolve(call === 1 ? makeNdjsonResponse(records) : ''),
    });
  });
}

// ── Test suite ────────────────────────────────────────────

describe('backfill-futures-gaps handler', () => {
  const originalEnv = process.env.DATABENTO_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABENTO_API_KEY = 'db-test-key';
    vi.mocked(cronGuard).mockReturnValue({} as ReturnType<typeof cronGuard>);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DATABENTO_API_KEY = originalEnv;
    } else {
      delete process.env.DATABENTO_API_KEY;
    }
  });

  // ── Guard checks ──────────────────────────────────────

  it('returns early when cronGuard rejects', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 500 when DATABENTO_API_KEY is missing', async () => {
    delete process.env.DATABENTO_API_KEY;

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Missing DATABENTO_API_KEY' });
  });

  // ── Happy path ────────────────────────────────────────

  it('fetches and inserts bars for all symbols', async () => {
    const ndjson = makeNdjsonResponse([
      makeOhlcvRecord(),
      makeOhlcvRecord({ ts_event: '1775001660000000000' }),
    ]);

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(ndjson),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      job: string;
      totalInserted: number;
      symbols: Array<{ symbol: string; inserted: number }>;
    };
    expect(json.job).toBe('backfill-futures-gaps');
    // Mock price 5705 is in-bounds for ES, NQ, RTY, GC (4 symbols × 2 bars)
    // Out-of-bounds for ZN (50-200), CL (20-250), DX (70-150)
    expect(json.totalInserted).toBe(8);
    expect(json.symbols).toHaveLength(7);
    expect(mockFetch).toHaveBeenCalledTimes(7);
  });

  // ── Empty response ────────────────────────────────────

  it('handles empty API responses gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as { totalInserted: number };
    expect(json.totalInserted).toBe(0);
  });

  // ── API errors ────────────────────────────────────────

  it('handles Databento API errors without crashing', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('{"detail":"some error"}'),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as { totalInserted: number };
    expect(json.totalInserted).toBe(0);
  });

  // ── Overflow filtering ────────────────────────────────

  it('filters out bars with overflow prices (INT64_MAX sentinel)', async () => {
    const ndjson = makeNdjsonResponse([
      makeOhlcvRecord(), // valid
      makeOhlcvRecord({
        // INT64_MAX sentinel — should be filtered
        open: '9223372036854775807',
        high: '9223372036854775807',
        low: '9223372036854775807',
        close: '9223372036854775807',
      }),
    ]);

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(ndjson),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      totalInserted: number;
      symbols: Array<{ symbol: string; inserted: number }>;
    };
    // 1 valid bar per in-bounds symbol (ES, NQ, RTY, GC = 4)
    expect(json.totalInserted).toBe(4);
  });

  // ── Partial failures ──────────────────────────────────

  it('continues processing other symbols when one fetch throws', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Network timeout'));
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(makeNdjsonResponse([makeOhlcvRecord()])),
      });
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      totalInserted: number;
      errors: string[] | undefined;
    };
    // ES fails (network), 6 fetch. Of those, NQ/RTY/GC in-bounds = 3 bars
    expect(json.totalInserted).toBe(3);
    expect(json.errors).toHaveLength(1);
  });

  // ── Auth format ───────────────────────────────────────

  it('sends API key as Basic auth username', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const firstCall = mockFetch.mock.calls[0];
    const headers = firstCall?.[1]?.headers as Record<string, string>;
    const auth = headers.Authorization ?? '';
    const decoded = Buffer.from(
      auth.replace('Basic ', ''),
      'base64',
    ).toString();
    expect(decoded).toBe('db-test-key:');
  });

  // ── Response shape ────────────────────────────────────

  it('includes range and durationMs in response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      job: string;
      range: string;
      durationMs: number;
    };
    expect(json.job).toBe('backfill-futures-gaps');
    expect(json.range).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── BE-CRON-006: Rejection observability ──────────────

  it('keeps in-bounds bars and does not count them as rejected', async () => {
    // close = 5705, low = 5690 — in bounds for ES [1000, 20000]
    stubEsOnly([makeOhlcvRecord()]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      totalInserted: number;
      totalRejected: number;
      rejected: Record<string, number>;
    };
    expect(json.rejected.ES).toBe(0);
    expect(json.totalRejected).toBe(0);
    // ES inserted the single bar
    const esRow = (
      json as unknown as {
        symbols: Array<{ symbol: string; inserted: number }>;
      }
    ).symbols.find((s) => s.symbol === 'ES');
    expect(esRow?.inserted).toBe(1);
  });

  it('rejects a bar whose close exceeds the upper bound and logs the bounds', async () => {
    // close = 25000 > ES hi (20000)
    stubEsOnly([
      makeOhlcvRecord({
        close: '25000000000000',
        high: '25000000000000',
        low: '24990000000000',
        open: '24995000000000',
      }),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const json = res._json as {
      totalRejected: number;
      rejected: Record<string, number>;
    };
    expect(json.rejected.ES).toBe(1);

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const boundsRejection = warnCalls.find((call) => {
      const ctx = call[0] as { symbol?: string; bounds?: [number, number] };
      return ctx.symbol === 'ES' && Array.isArray(ctx.bounds);
    });
    expect(boundsRejection).toBeDefined();
    const ctx = boundsRejection![0] as {
      symbol: string;
      close: number;
      low: number;
      bounds: [number, number];
    };
    expect(ctx.close).toBe(25000);
    expect(ctx.bounds).toEqual([1000, 20000]);
  });

  it('rejects a bar whose low < lo * 0.5 and counts it', async () => {
    // ES lo = 1000, lo * 0.5 = 500. low = 400 < 500. close in bounds.
    stubEsOnly([
      makeOhlcvRecord({
        close: '5705000000000',
        high: '5710000000000',
        low: '400000000000', // 400 after nano conversion
        open: '5700000000000',
      }),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const json = res._json as {
      rejected: Record<string, number>;
      symbols: Array<{ symbol: string; inserted: number }>;
    };
    expect(json.rejected.ES).toBe(1);
    const esRow = json.symbols.find((s) => s.symbol === 'ES');
    expect(esRow?.inserted).toBe(0);

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const lowRejection = warnCalls.find((call) => {
      const ctx = call[0] as { symbol?: string; low?: number };
      return ctx.symbol === 'ES' && ctx.low === 400;
    });
    expect(lowRejection).toBeDefined();
  });

  it('mixed batch: 5 good + 2 bad yields stored=5, rejected=2, two warn calls', async () => {
    const good = (tsSuffix: string) =>
      makeOhlcvRecord({ ts_event: `17750016${tsSuffix}0000000` });
    const badHigh = (tsSuffix: string) =>
      makeOhlcvRecord({
        ts_event: `17750016${tsSuffix}0000000`,
        close: '25000000000000', // > ES hi
        high: '25000000000000',
        low: '24990000000000',
        open: '24995000000000',
      });
    const badLow = (tsSuffix: string) =>
      makeOhlcvRecord({
        ts_event: `17750016${tsSuffix}0000000`,
        close: '5705000000000',
        high: '5710000000000',
        low: '400000000000', // < ES lo * 0.5
        open: '5700000000000',
      });

    stubEsOnly([
      good('00'),
      good('60'),
      badHigh('70'),
      good('80'),
      good('90'),
      badLow('95'),
      good('99'),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const json = res._json as {
      rejected: Record<string, number>;
      symbols: Array<{ symbol: string; inserted: number }>;
    };
    expect(json.rejected.ES).toBe(2);
    const esRow = json.symbols.find((s) => s.symbol === 'ES');
    expect(esRow?.inserted).toBe(5);

    // Exactly two ES-scoped bounds-rejection warn calls
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const esBoundsWarns = warnCalls.filter((call) => {
      const ctx = call[0] as { symbol?: string; bounds?: unknown };
      return ctx.symbol === 'ES' && Array.isArray(ctx.bounds);
    });
    expect(esBoundsWarns).toHaveLength(2);
  });

  it('calls checkDataQuality with (total>0, nonzero=0) when every ES bar is rejected', async () => {
    // Two bars, both above the ES upper bound. All get rejected, so
    // bars.length === 0 after the filter and the handler enters the
    // all-rejected branch which fires checkDataQuality so Sentry can
    // warn on silent Databento drift.
    stubEsOnly([
      makeOhlcvRecord({
        close: '25000000000000',
        high: '25000000000000',
        low: '24990000000000',
        open: '24995000000000',
      }),
      makeOhlcvRecord({
        ts_event: '1775001660000000000',
        close: '26000000000000',
        high: '26000000000000',
        low: '25990000000000',
        open: '25995000000000',
      }),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const esCall = vi
      .mocked(checkDataQuality)
      .mock.calls.find(
        (c) => (c[0] as { sourceFilter?: string }).sourceFilter === 'symbol=ES',
      );
    expect(esCall).toBeDefined();
    const opts = esCall![0] as {
      job: string;
      table: string;
      sourceFilter: string;
      total: number;
      nonzero: number;
    };
    expect(opts).toMatchObject({
      job: 'backfill-futures-gaps',
      table: 'futures_bars',
      sourceFilter: 'symbol=ES',
      nonzero: 0,
    });
    expect(opts.total).toBeGreaterThanOrEqual(2);
  });

  it('does NOT call checkDataQuality when ES bars are successfully inserted', async () => {
    // Per BE-CRON-006 reviewer: the helper is only called on the
    // all-rejected path. When inserts land, checkDataQuality's Sentry
    // trigger (nonzero === 0) can never fire by construction, so the
    // call was dropped. Pin this behavior.
    stubEsOnly([makeOhlcvRecord()]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const esCalls = vi
      .mocked(checkDataQuality)
      .mock.calls.filter(
        (c) => (c[0] as { sourceFilter?: string }).sourceFilter === 'symbol=ES',
      );
    expect(esCalls).toHaveLength(0);
  });
});
