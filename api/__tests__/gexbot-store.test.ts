// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, mockWithDbRetry } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockWithDbRetry: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: mockWithDbRetry,
}));

import { insertCaptureRows } from '../_lib/gexbot-store.js';

describe('insertCaptureRows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockWithDbRetry.mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

  it('returns early without calling sql when rows is empty', async () => {
    await insertCaptureRows([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('issues a single sql call regardless of row count (batched UNNEST)', async () => {
    const rows = Array.from({ length: 128 }, (_, i) => ({
      ticker: 'SPX',
      endpoint: 'state',
      category: `gamma_zero`,
      sourceTimestamp: i,
      rawJson: `{"i":${i}}`,
    }));
    await insertCaptureRows(rows);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('spreads per-column arrays in column-aligned order', async () => {
    const rows = [
      {
        ticker: 'SPX',
        endpoint: 'classic',
        category: 'gex_zero/maxchange',
        sourceTimestamp: 1_700_000_000,
        rawJson: '{"current":[5950,1.2]}',
      },
      {
        ticker: 'QQQ',
        endpoint: 'state',
        category: 'gamma_zero',
        sourceTimestamp: 1_700_000_001,
        rawJson: '{"spot":540}',
      },
    ];
    await insertCaptureRows(rows);

    // The sql tagged-template call receives the args interleaved
    // with the literal string segments. Pull the arrays from the
    // mock call and assert they're in row order.
    const callArgs = mockSql.mock.calls[0] as unknown[];
    // sql`...${tickers}::text[]${endpoints}::text[]...` — the dynamic
    // args follow the strings array at index 0.
    const dynamicArgs = callArgs.slice(1);
    // Match by expected shape: arrays of length === rows.length
    const arrays = dynamicArgs.filter(
      (a): a is unknown[] => Array.isArray(a) && a.length === rows.length,
    );
    // We expect 5 spread arrays: tickers, endpoints, categories,
    // sourceTs, rawJsons.
    expect(arrays.length).toBe(5);
    const [tickers, endpoints, categories, sourceTs, rawJsons] = arrays as [
      string[],
      string[],
      string[],
      Array<number | null>,
      string[],
    ];
    expect(tickers).toEqual(['SPX', 'QQQ']);
    expect(endpoints).toEqual(['classic', 'state']);
    expect(categories).toEqual(['gex_zero/maxchange', 'gamma_zero']);
    expect(sourceTs).toEqual([1_700_000_000, 1_700_000_001]);
    expect(rawJsons).toEqual(['{"current":[5950,1.2]}', '{"spot":540}']);
  });

  it('skips duplicate rows with ON CONFLICT DO NOTHING', async () => {
    await insertCaptureRows([
      {
        ticker: 'SPX',
        endpoint: 'state',
        category: 'gamma_zero',
        sourceTimestamp: 1_700_000_000,
        rawJson: '{}',
      },
    ]);
    const strings = (mockSql.mock.calls[0] as unknown[])[0] as string[];
    expect(strings.join('')).toContain('ON CONFLICT DO NOTHING');
  });

  it('preserves null sourceTimestamp without coercing to a number', async () => {
    await insertCaptureRows([
      {
        ticker: 'SPX',
        endpoint: 'state',
        category: 'gamma_zero',
        sourceTimestamp: null,
        rawJson: '{}',
      },
    ]);
    const callArgs = mockSql.mock.calls[0] as unknown[];
    const dynamicArgs = callArgs.slice(1);
    // sourceTs array is the 4th spread array (after ticker/endpoint/category)
    const tsArr = dynamicArgs.find(
      (a): a is Array<number | null> =>
        Array.isArray(a) &&
        a.length === 1 &&
        (a[0] === null || typeof a[0] === 'number'),
    );
    expect(tsArr).toEqual([null]);
  });

  const ONE_ROW = [
    {
      ticker: 'SPX',
      endpoint: 'state',
      category: 'gamma_zero',
      sourceTimestamp: 1,
      rawJson: '{}',
    },
  ];

  it('wraps the INSERT in withDbRetry(fn, 2, 10_000) so a Neon blip is retried', async () => {
    await insertCaptureRows(ONE_ROW);
    expect(mockWithDbRetry).toHaveBeenCalledTimes(1);
    expect(mockWithDbRetry).toHaveBeenCalledWith(
      expect.any(Function),
      2,
      10_000,
    );
  });

  it('succeeds when the first INSERT attempt hits a transient error and the retry lands', async () => {
    // Real withDbRetry: a retryable Neon error backs off 1 s, then retries.
    const actual =
      await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
    mockWithDbRetry.mockImplementation(actual.withDbRetry);
    mockSql
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce([]);
    vi.useFakeTimers();
    try {
      const pending = insertCaptureRows(ONE_ROW);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('propagates the error when the INSERT keeps failing', async () => {
    mockSql.mockRejectedValue(new Error('neon: connection terminated'));
    await expect(insertCaptureRows(ONE_ROW)).rejects.toThrow(
      'neon: connection terminated',
    );
  });
});
