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
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import handler from '../cron/backfill-futures-gaps.js';
import { cronGuard } from '../_lib/api-helpers.js';

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

function makeOhlcvRecord(overrides: Partial<{
  ts_event: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}> = {}) {
  return {
    hd: { ts_event: overrides.ts_event ?? '1775001600000000000' },
    open: overrides.open ?? '5700000000000',
    high: overrides.high ?? '5710000000000',
    low: overrides.low ?? '5690000000000',
    close: overrides.close ?? '5705000000000',
    volume: overrides.volume ?? '500',
  };
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
    expect(json.totalInserted).toBe(14); // 2 bars × 7 symbols
    expect(json.symbols).toHaveLength(7);
    // 7 symbols × 1 fetch each
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
    // Only 1 valid bar per symbol × 7 symbols
    expect(json.totalInserted).toBe(7);
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
        text: () =>
          Promise.resolve(makeNdjsonResponse([makeOhlcvRecord()])),
      });
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      totalInserted: number;
      errors: string[] | undefined;
    };
    // 6 symbols succeed with 1 bar each, 1 fails
    expect(json.totalInserted).toBe(6);
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
    const decoded = Buffer.from(
      headers.Authorization.replace('Basic ', ''),
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
});
