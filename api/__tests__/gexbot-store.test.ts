// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import { insertCaptureRows } from '../_lib/gexbot-store.js';

describe('insertCaptureRows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
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
});
