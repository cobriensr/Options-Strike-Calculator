// @vitest-environment node

/**
 * api/_lib/strike-all-fetch.ts: the windowed, paged `/spot-exposures/strike`
 * walk that fetch-strike-all and scripts/backfill-strike-all.ts share.
 * Stubs the global fetch (uwFetch runs for real, as in uw-fetch-paged.test.ts)
 * and mocks logger and sentry at their module boundaries (R3).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: {
    increment: vi.fn(),
    uwRateLimit: vi.fn(),
    uwBudget: vi.fn(),
  },
}));

import {
  STRIKE_ALL_ATM_RANGE,
  fetchStrikeAllLadder,
} from '../_lib/strike-all-fetch.js';

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ strike: String(i) }));

/** Answer /strike pages from `pages` by their `page` param, 0 rows past the end. */
function stubPages(pages: unknown[][]) {
  const fetchMock = vi.fn(async (input: string) => {
    const page = Number(new URL(input).searchParams.get('page'));
    return { ok: true, json: async () => ({ data: pages[page] ?? [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const urls = (fetchMock: ReturnType<typeof stubPages>) =>
  (fetchMock.mock.calls as unknown[][]).map((c) => new URL(String(c[0])));

describe('fetchStrikeAllLadder', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the stored range at 200', () => {
    expect(STRIKE_ALL_ATM_RANGE).toBe(200);
  });

  it('requests the all-expiry strike endpoint windowed around spot, page 0, limit 500', async () => {
    const fetchMock = stubPages([rowsOf(3)]);

    const rows = await fetchStrikeAllLadder('key', 7385.5);

    const [url] = urls(fetchMock);
    expect(url!.pathname).toBe('/api/stock/SPX/spot-exposures/strike');
    expect(url!.searchParams.get('min_strike')).toBe('7185');
    expect(url!.searchParams.get('max_strike')).toBe('7586');
    expect(url!.searchParams.get('limit')).toBe('500');
    expect(url!.searchParams.get('page')).toBe('0');
    expect(url!.searchParams.has('date')).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it('asks for a past date when given one (the backfill)', async () => {
    const fetchMock = stubPages([rowsOf(3)]);

    await fetchStrikeAllLadder('key', 7385, '2026-10-22');

    expect(urls(fetchMock)[0]!.searchParams.get('date')).toBe('2026-10-22');
  });

  it('walks to the next page after exactly 500 rows and stops on the short one', async () => {
    const fetchMock = stubPages([rowsOf(500), rowsOf(38)]);

    const rows = await fetchStrikeAllLadder('key', 7385);

    expect(urls(fetchMock).map((u) => u.searchParams.get('page'))).toEqual([
      '0',
      '1',
    ]);
    expect(rows).toHaveLength(538);
  });

  it('asks once more after exactly 500 rows and ends on the empty page', async () => {
    const fetchMock = stubPages([rowsOf(500), []]);

    const rows = await fetchStrikeAllLadder('key', 7385);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(500);
  });

  it('does not ask for a second page after a short page', async () => {
    const fetchMock = stubPages([rowsOf(499), rowsOf(5)]);

    await fetchStrikeAllLadder('key', 7385);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws after 10 full pages instead of returning a ladder that may be cut off', async () => {
    const full = rowsOf(500);
    const fetchMock = stubPages(Array.from({ length: 12 }, () => full));

    await expect(fetchStrikeAllLadder('key', 7385)).rejects.toThrow(
      /10 full pages of 500 strikes/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('lets a UW error on a later page propagate, with no partial ladder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).searchParams.get('page') === '0'
          ? { ok: true, json: async () => ({ data: rowsOf(500) }) }
          : { ok: false, status: 422, text: async () => 'bad page' },
      ),
    );

    await expect(fetchStrikeAllLadder('key', 7385)).rejects.toThrow(
      'UW API 422',
    );
  });
});
