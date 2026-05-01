// @vitest-environment node

/**
 * Unit tests for api/_lib/bulk-upsert.ts (Phase 1b).
 *
 * Covers:
 *   - Empty rows → no-op.
 *   - Single row → one statement, correct SQL shape + params.
 *   - Multi-row → single statement with all rows.
 *   - Multi-chunk → wrapped in sql.transaction (atomic across chunks).
 *   - Multi-chunk transaction rollback on mid-chunk failure.
 *   - Default `conflictUpdateColumns` derives from `conflictTarget`.
 *   - Explicit `conflictUpdateColumns: []` → DO NOTHING.
 *   - Three-column composite key default derivation.
 *   - Chunk boundary at exactly rows.length === chunkSize.
 *   - Null / undefined values in row fields preserved verbatim.
 *   - ON CONSTRAINT name form requires explicit conflictUpdateColumns.
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
  // The transaction implementation calls the user-provided callback with a
  // `txn` proxy that exposes `.query(stmt, params)`. We capture each
  // (stmt, params) the callback queues and resolve a Promise that mirrors
  // sql.query's return so callers' `await sql.transaction(...)` works.
  // If `transactionShouldFailOn` is set, we reject when the matching chunk
  // index is queued, simulating a mid-chunk failure.
  const txnQueryCalls: Array<[string, unknown[]]> = [];
  let transactionShouldFailOn: number | null = null;
  const transaction = vi.fn(
    async (
      cb: (
        txn: { query: (stmt: string, params?: unknown[]) => Promise<unknown> },
      ) => unknown[],
    ) => {
      const queued: Array<{ stmt: string; params: unknown[] }> = [];
      cb({
        query: (stmt, params = []) => {
          queued.push({ stmt, params });
          return Promise.resolve([]);
        },
      });
      // Mirror Neon: queries inside a transaction execute in order; the
      // first failure aborts and rolls back. We surface that by rejecting
      // before recording any of the calls when `transactionShouldFailOn` is
      // set to a chunk index <= queued.length.
      if (
        transactionShouldFailOn != null &&
        transactionShouldFailOn < queued.length
      ) {
        // Record only chunks that "succeeded" (up to but not including the
        // failed one) so the test can assert no later chunks committed.
        for (let i = 0; i < transactionShouldFailOn; i++) {
          txnQueryCalls.push([queued[i]!.stmt, queued[i]!.params]);
        }
        throw new Error('simulated mid-chunk failure');
      }
      for (const { stmt, params } of queued) {
        txnQueryCalls.push([stmt, params]);
      }
      return queued.map(() => []);
    },
  );

  return {
    sql: { query, transaction } as unknown as NeonQueryFunction<false, false>,
    queryMock: query,
    transactionMock: transaction,
    txnQueryCalls,
    setTransactionFailOn: (idx: number | null) => {
      transactionShouldFailOn = idx;
    },
  };
}

describe('bulkUpsert', () => {
  let sql: NeonQueryFunction<false, false>;
  let queryMock: ReturnType<typeof vi.fn>;
  let transactionMock: ReturnType<typeof vi.fn>;
  let txnQueryCalls: Array<[string, unknown[]]>;
  let setTransactionFailOn: (idx: number | null) => void;

  beforeEach(() => {
    const mock = makeMockSql();
    sql = mock.sql;
    queryMock = mock.queryMock;
    transactionMock = mock.transactionMock;
    txnQueryCalls = mock.txnQueryCalls;
    setTransactionFailOn = mock.setTransactionFailOn;
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

  it('multi-chunk: wraps every chunk in a single sql.transaction', async () => {
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
    // Multi-chunk path runs ONE transaction, not N separate sql.query calls.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();

    // 7 rows / 3 per chunk → 3 chunks (3 + 3 + 1) queued inside the txn.
    expect(txnQueryCalls).toHaveLength(3);

    // Each chunk's params reset to $1 (parameter index is per-statement).
    for (const [stmt] of txnQueryCalls) {
      expect(stmt).toMatch(/\(\$1,\$2,\$3\)/);
    }

    // Last chunk holds 1 row, so its params length is 3 (one tuple worth).
    const lastParams = txnQueryCalls[2]![1];
    expect(lastParams).toHaveLength(3);
  });

  it('multi-chunk: rolls back when an inner chunk fails', async () => {
    // Tell the mock to throw when the SECOND chunk is queued (index 1).
    // After the throw, only chunks 0..0 are recorded as "committed" by the
    // mock — verifies bulkUpsert surfaced the rejection without partial
    // state leaking past the rollback boundary.
    setTransactionFailOn(1);

    const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({
      date: '2026-05-02',
      ticker: `T${i}`,
      price: i,
    }));

    await expect(
      bulkUpsert<Row>({
        sql,
        table: 'demo',
        columns: ['date', 'ticker', 'price'],
        rows,
        conflictTarget: '(date, ticker)',
        chunkSize: 3,
      }),
    ).rejects.toThrow(/simulated mid-chunk failure/);

    // Single transaction call (the entire multi-chunk run).
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // The mock recorded only the first "successful" chunk before the
    // simulated rollback. Real Neon would never persist any of them — the
    // contract being verified is "all chunks share one transaction".
    expect(txnQueryCalls).toHaveLength(1);
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

  it('three-column composite conflict key: default update list excludes all three', async () => {
    type WideRow = {
      date: string;
      ticker: string;
      strike: number;
      price: number;
      iv: number;
    } & Record<string, unknown>;

    await bulkUpsert<WideRow>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'strike', 'price', 'iv'],
      rows: [
        {
          date: '2026-05-02',
          ticker: 'SPX',
          strike: 5800,
          price: 12.5,
          iv: 0.18,
        },
      ],
      conflictTarget: '(date, ticker, strike)',
    });

    const stmt = queryMock.mock.calls[0]![0] as string;
    // None of the three conflict columns should appear in the SET list.
    expect(stmt).not.toContain('date = EXCLUDED.date');
    expect(stmt).not.toContain('ticker = EXCLUDED.ticker');
    expect(stmt).not.toContain('strike = EXCLUDED.strike');
    // The remaining columns should.
    expect(stmt).toContain('price = EXCLUDED.price');
    expect(stmt).toContain('iv = EXCLUDED.iv');
  });

  it('chunk boundary: rows.length exactly equals chunkSize → single-chunk fast path', async () => {
    // When rows.length === chunkSize, the fast path applies (no transaction
    // overhead). Confirms the boundary is `<=` not `<`.
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      date: '2026-05-02',
      ticker: `T${i}`,
      price: i,
    }));

    await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows,
      conflictTarget: '(date, ticker)',
      chunkSize: 5,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).not.toHaveBeenCalled();

    const params: unknown[] = queryMock.mock.calls[0]![1];
    // 5 rows × 3 cols = 15 params.
    expect(params).toHaveLength(15);
  });

  it('chunk boundary: rows.length === chunkSize + 1 → multi-chunk transaction path', async () => {
    // One row over the boundary forces the transactional path. Two chunks:
    // chunkSize rows in chunk 0, 1 row in chunk 1.
    const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({
      date: '2026-05-02',
      ticker: `T${i}`,
      price: i,
    }));

    await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows,
      conflictTarget: '(date, ticker)',
      chunkSize: 5,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
    expect(txnQueryCalls).toHaveLength(2);
  });

  it('null and undefined row field values are passed through verbatim', async () => {
    // bulkUpsert must not coerce nulls into undefined or strings — Neon's
    // driver treats null as SQL NULL and we rely on that for nullable
    // columns (e.g. cron rows where some fields may be missing).
    type NullableRow = {
      date: string;
      ticker: string;
      price: number | null;
      note: string | undefined;
    } & Record<string, unknown>;

    await bulkUpsert<NullableRow>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price', 'note'],
      rows: [
        {
          date: '2026-05-02',
          ticker: 'SPX',
          price: null,
          note: undefined,
        },
      ],
      conflictTarget: '(date, ticker)',
    });

    const params: unknown[] = queryMock.mock.calls[0]![1];
    // Order matches column order. null stays null; undefined is preserved
    // as-is so the driver handles it the same as when callers write
    // sql`... ${undefined} ...`.
    expect(params[0]).toBe('2026-05-02');
    expect(params[1]).toBe('SPX');
    expect(params[2]).toBeNull();
    expect(params[3]).toBeUndefined();
  });

  it('ON CONSTRAINT name form: rejects when conflictUpdateColumns omitted', async () => {
    await expect(
      bulkUpsert<Row>({
        sql,
        table: 'demo',
        columns: ['date', 'ticker', 'price'],
        rows: [{ date: '2026-05-02', ticker: 'SPX', price: 1 }],
        // ON CONSTRAINT form has no inline columns to derive from — we
        // refuse to silently default to "update every column".
        conflictTarget: 'ON CONSTRAINT demo_uniq',
      }),
    ).rejects.toThrow(/ON CONSTRAINT form requires explicit conflictUpdateColumns/);
  });

  it('ON CONSTRAINT name form: works when conflictUpdateColumns provided', async () => {
    await bulkUpsert<Row>({
      sql,
      table: 'demo',
      columns: ['date', 'ticker', 'price'],
      rows: [{ date: '2026-05-02', ticker: 'SPX', price: 5800 }],
      conflictTarget: 'ON CONSTRAINT demo_uniq',
      conflictUpdateColumns: ['price'],
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const stmt = queryMock.mock.calls[0]![0] as string;
    expect(stmt).toContain('ON CONFLICT ON CONSTRAINT demo_uniq DO UPDATE SET');
    expect(stmt).toContain('price = EXCLUDED.price');
  });

  it('exposes BULK_UPSERT_DEFAULT_CHUNK_SIZE = 500', () => {
    expect(BULK_UPSERT_DEFAULT_CHUNK_SIZE).toBe(500);
  });
});
