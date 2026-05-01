// @vitest-environment node

/**
 * Unit tests for api/_lib/bulk-upsert.ts (Phase 1b).
 *
 * Covers:
 *   - Empty rows → no-op.
 *   - Single row → one statement, correct SQL shape + params.
 *   - Multi-row → single statement with all rows.
 *   - Multi-chunk → multiple statements when rows.length > chunkSize.
 *   - Default `conflictUpdateColumns` derives from `conflictTarget`.
 *   - Explicit `conflictUpdateColumns: []` → DO NOTHING.
 *   - Failure on empty columns / non-positive chunk size.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bulkUpsert,
  BULK_UPSERT_DEFAULT_CHUNK_SIZE,
} from '../_lib/bulk-upsert.js';
import type { NeonQueryFunction } from '@neondatabase/serverless';

type Row = {
  date: string;
  ticker: string;
  price: number;
} & Record<string, unknown>;

function makeMockSql() {
  const query = vi.fn().mockResolvedValue([]);
  return {
    sql: { query } as unknown as NeonQueryFunction<false, false>,
    queryMock: query,
  };
}

describe('bulkUpsert', () => {
  let sql: NeonQueryFunction<false, false>;
  let queryMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = makeMockSql();
    sql = mock.sql;
    queryMock = mock.queryMock;
  });

  it('returns { rows: 0 } for empty input without calling the DB', async () => {
    const result = await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows: [],
      conflictTarget: '(date, ticker)',
    });
    expect(result).toEqual({ rows: 0 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('throws when columns is empty', async () => {
    await expect(
      bulkUpsert<Row>({
        sql,
        table: 'demo',
        columns: [] as never,
        rows: [{ date: '2026-05-02', ticker: 'SPX', price: 1 }],
        conflictTarget: '(date)',
      }),
    ).rejects.toThrow(/columns/);
  });

  it('throws when chunkSize <= 0', async () => {
    await expect(
      bulkUpsert<Row>({
        sql,
        table: 'demo',
        columns: ['date', 'ticker', 'price'],
        rows: [{ date: '2026-05-02', ticker: 'SPX', price: 1 }],
        conflictTarget: '(date)',
        chunkSize: 0,
      }),
    ).rejects.toThrow(/chunkSize/);
  });

  it('single row: one query call with $1,$2,$3 placeholders', async () => {
    const result = await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows: [{ date: '2026-05-02', ticker: 'SPX', price: 5800 }],
      conflictTarget: '(date, ticker)',
    });

    expect(result).toEqual({ rows: 1 });
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [stmt, params] = queryMock.mock.calls[0]!;
    expect(stmt).toContain('INSERT INTO demo');
    expect(stmt).toContain('(date, ticker, price)');
    expect(stmt).toContain('($1,$2,$3)');
    expect(stmt).toContain('ON CONFLICT (date, ticker) DO UPDATE SET');
    expect(stmt).toContain('price = EXCLUDED.price');
    // Conflict-target columns must NOT appear in the update list.
    expect(stmt).not.toContain('date = EXCLUDED.date');
    expect(stmt).not.toContain('ticker = EXCLUDED.ticker');
    expect(params).toEqual(['2026-05-02', 'SPX', 5800]);
  });

  it('multi-row (under chunk size): one query, contiguous placeholders', async () => {
    const rows: Row[] = [
      { date: '2026-05-02', ticker: 'SPX', price: 5800 },
      { date: '2026-05-02', ticker: 'NDX', price: 19000 },
      { date: '2026-05-02', ticker: 'RUT', price: 2200 },
    ];
    const result = await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows,
      conflictTarget: '(date, ticker)',
    });

    expect(result).toEqual({ rows: 3 });
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [stmt, params] = queryMock.mock.calls[0]!;
    expect(stmt).toContain('($1,$2,$3),($4,$5,$6),($7,$8,$9)');
    expect(params).toEqual([
      '2026-05-02',
      'SPX',
      5800,
      '2026-05-02',
      'NDX',
      19000,
      '2026-05-02',
      'RUT',
      2200,
    ]);
  });

  it('multi-chunk: splits into multiple statements when rows > chunkSize', async () => {
    const rows: Row[] = Array.from({ length: 7 }, (_, i) => ({
      date: '2026-05-02',
      ticker: `T${i}`,
      price: i,
    }));
    const result = await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows,
      conflictTarget: '(date, ticker)',
      chunkSize: 3,
    });

    expect(result).toEqual({ rows: 7 });
    // 7 rows / 3 per chunk → 3 chunks (3 + 3 + 1).
    expect(queryMock).toHaveBeenCalledTimes(3);

    // Each chunk's params reset to $1 (parameter index is per-statement).
    for (const call of queryMock.mock.calls) {
      const stmt: string = call[0];
      expect(stmt).toMatch(/\(\$1,\$2,\$3\)/);
    }

    // Last chunk holds 1 row, so its params length is 3 (one tuple worth).
    const lastParams: unknown[] = queryMock.mock.calls[2]![1];
    expect(lastParams).toHaveLength(3);
  });

  it('default conflictUpdateColumns excludes every column inside conflictTarget', async () => {
    await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows: [{ date: '2026-05-02', ticker: 'SPX', price: 1 }],
      // Both `date` and `ticker` should be excluded from the SET list.
      conflictTarget: '(Date, Ticker)',
    });

    const stmt = queryMock.mock.calls[0]![0] as string;
    expect(stmt).not.toContain('date = EXCLUDED.date');
    expect(stmt).not.toContain('ticker = EXCLUDED.ticker');
    expect(stmt).toContain('price = EXCLUDED.price');
  });

  it('explicit empty conflictUpdateColumns → DO NOTHING', async () => {
    await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows: [{ date: '2026-05-02', ticker: 'SPX', price: 1 }],
      conflictTarget: '(date, ticker)',
      conflictUpdateColumns: [],
    });

    const stmt = queryMock.mock.calls[0]![0] as string;
    expect(stmt).toContain('ON CONFLICT (date, ticker) DO NOTHING');
    expect(stmt).not.toContain('DO UPDATE');
  });

  it('explicit conflictUpdateColumns is honored verbatim', async () => {
    await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows: [{ date: '2026-05-02', ticker: 'SPX', price: 1 }],
      conflictTarget: '(date, ticker)',
      conflictUpdateColumns: ['price'],
    });

    const stmt = queryMock.mock.calls[0]![0] as string;
    expect(stmt).toContain('price = EXCLUDED.price');
  });

  it('exposes BULK_UPSERT_DEFAULT_CHUNK_SIZE = 500', () => {
    expect(BULK_UPSERT_DEFAULT_CHUNK_SIZE).toBe(500);
  });
});
