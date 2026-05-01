// @vitest-environment node

/**
 * Unit tests for api/_lib/uw-fetch-paged.ts (Phase 1e).
 *
 * Mocks the global `fetch` (which uwFetch calls) so the helper is
 * exercised end-to-end through the rate-gate path. uwFetch's gate is
 * a no-op when KV_REST_API_URL is not set (Vitest environment), so
 * tests don't need to stub Upstash.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const mockSentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
    uwRateLimit: vi.fn(),
  },
}));

import {
  uwFetchPaged,
  UW_PAGED_DEFAULT_MAX_PAGES,
} from '../_lib/uw-fetch-paged.js';

interface Row {
  id: number;
}

function jsonResponse(rows: Row[]): Response {
  return {
    ok: true,
    json: () => Promise.resolve({ data: rows }),
  } as unknown as Response;
}

describe('uwFetchPaged', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('exports UW_PAGED_DEFAULT_MAX_PAGES = 50', () => {
    expect(UW_PAGED_DEFAULT_MAX_PAGES).toBe(50);
  });

  it('throws when maxPages <= 0', async () => {
    await expect(
      uwFetchPaged<Row>({
        apiKey: 'k',
        buildPath: () => '/foo',
        maxPages: 0,
      }),
    ).rejects.toThrow(/maxPages/);
  });

  it('single page then empty: 2 fetch calls, returns first batch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }]))
      .mockResolvedValueOnce(jsonResponse([])); // ends pagination
    vi.stubGlobal('fetch', fetchMock);

    const result = await uwFetchPaged<Row>({
      apiKey: 'k',
      buildPath: () => '/foo',
    });
    // Helper does not auto-stop on size; caller must signal done via
    // onPage or return an empty batch.
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.pagesFetched).toBe(2);
  });

  it('walks until empty page returns', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }, { id: 2 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 3 }]))
      .mockResolvedValueOnce(jsonResponse([])); // end
    vi.stubGlobal('fetch', fetchMock);

    const result = await uwFetchPaged<Row>({
      apiKey: 'k',
      buildPath: (p) => `/foo?page=${p}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(result.pagesFetched).toBe(3);
    expect(result.reachedPageCap).toBe(false);
  });

  it('onPage(done: true) stops pagination immediately', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }, { id: 2 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 3 }, { id: 4 }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await uwFetchPaged<Row>({
      apiKey: 'k',
      buildPath: () => '/foo',
      onPage: (rows) => ({ done: rows.length < 5 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.pagesFetched).toBe(1);
    expect(result.reachedPageCap).toBe(false);
  });

  it('honors maxPages cap and surfaces reachedPageCap=true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: 1 }, { id: 2 }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await uwFetchPaged<Row>({
      apiKey: 'k',
      buildPath: (p) => `/foo?p=${p}`,
      maxPages: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.pagesFetched).toBe(3);
    expect(result.reachedPageCap).toBe(true);
    expect(result.rows).toHaveLength(6);
  });

  it('aborts mid-loop when signal fires before next iteration', async () => {
    const ctrl = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }]))
      .mockImplementation(() => {
        // Cancel before the next page is requested.
        ctrl.abort();
        return Promise.resolve(jsonResponse([{ id: 2 }]));
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uwFetchPaged<Row>({
      apiKey: 'k',
      buildPath: () => '/foo',
      signal: ctrl.signal,
      maxPages: 5,
    });

    // Two pages fetched; abort kicks in BEFORE the 3rd iteration.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('passes prevRows to buildPath so callers can derive cursors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 10 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 20 }]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    // `prev` is the live accumulator (uwFetchPaged passes it by
    // reference for zero-copy efficiency on hot UW paths); snapshot
    // length + tail at each call so assertions are stable across the
    // loop's mutations.
    const snapshots: { page: number; prevLen: number; prevLast: Row | null }[] =
      [];
    const buildPath = (page: number, prev: readonly Row[]): string => {
      snapshots.push({
        page,
        prevLen: prev.length,
        prevLast: prev.at(-1) ?? null,
      });
      return `/foo?page=${page}`;
    };

    await uwFetchPaged<Row>({ apiKey: 'k', buildPath });

    expect(snapshots).toEqual([
      { page: 0, prevLen: 0, prevLast: null },
      { page: 1, prevLen: 1, prevLast: { id: 10 } },
      { page: 2, prevLen: 2, prevLast: { id: 20 } },
    ]);
  });

  it('forwards apiKey to fetch via Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await uwFetchPaged<Row>({
      apiKey: 'TEST_KEY',
      buildPath: () => '/foo',
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer TEST_KEY',
    );
  });
});
