// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as parquet from '@dsnp/parquetjs';

import {
  writeRowsToParquet,
  buildSnapshotSchema,
  buildCaptureSchema,
} from '../_lib/gexbot-parquet.js';

// Sentry mock — the cleanup-unlink catch path captures here. We don't
// surface a real DSN in tests; keep it inert so the writer succeeds
// silently when unlink does run.
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

async function* yieldRows<T>(rows: T[]): AsyncGenerator<T> {
  for (const r of rows) yield r;
}

describe('buildSnapshotSchema', () => {
  it('returns a ParquetSchema with the expected field set', () => {
    const schema = buildSnapshotSchema() as InstanceType<
      typeof parquet.ParquetSchema
    >;
    expect(schema).toBeInstanceOf(parquet.ParquetSchema);
    // Spot-check a few representative fields from each layout group
    expect(schema.fields).toHaveProperty('id');
    expect(schema.fields).toHaveProperty('captured_at');
    expect(schema.fields).toHaveProperty('ticker');
    expect(schema.fields).toHaveProperty('zero_gamma');
    expect(schema.fields).toHaveProperty('agg_dex');
    expect(schema.fields).toHaveProperty('sum_gex_vol');
    expect(schema.fields).toHaveProperty('min_dte');
    expect(schema.fields).toHaveProperty('raw_response');
  });

  it('marks raw_response as SNAPPY-compressed UTF8', () => {
    const schema = buildSnapshotSchema() as InstanceType<
      typeof parquet.ParquetSchema
    >;
    const rawField = schema.fields.raw_response as {
      compression: string;
      primitiveType: string;
    };
    expect(rawField.compression).toBe('SNAPPY');
    expect(rawField.primitiveType).toBe('BYTE_ARRAY');
  });
});

describe('buildCaptureSchema', () => {
  it('returns a 6-column ParquetSchema mirroring gexbot_api_capture', () => {
    const schema = buildCaptureSchema() as InstanceType<
      typeof parquet.ParquetSchema
    >;
    expect(schema).toBeInstanceOf(parquet.ParquetSchema);
    expect(Object.keys(schema.fields).sort()).toEqual(
      [
        'captured_at',
        'category',
        'endpoint',
        'id',
        'raw_response',
        'source_timestamp',
        'ticker',
      ].sort(),
    );
  });
});

describe('writeRowsToParquet', () => {
  it('writes 3 rows and returns a non-empty buffer + correct rowCount + sha256', async () => {
    const schema = buildCaptureSchema() as InstanceType<
      typeof parquet.ParquetSchema
    >;
    const rows = yieldRows([
      {
        id: 1n,
        captured_at: new Date('2026-05-15T18:00:00Z'),
        ticker: 'NVDA',
        endpoint: 'snapshot',
        category: 'zero',
        source_timestamp: 1_715_796_000n,
        raw_response: '{"zg":1.2}',
      },
      {
        id: 2n,
        captured_at: new Date('2026-05-15T18:01:00Z'),
        ticker: 'TSLA',
        endpoint: 'snapshot',
        category: 'one',
        source_timestamp: 1_715_796_060n,
        raw_response: '{"og":2.5}',
      },
      {
        id: 3n,
        captured_at: new Date('2026-05-15T18:02:00Z'),
        ticker: 'AAPL',
        endpoint: 'snapshot',
        category: 'agg',
        source_timestamp: null,
        raw_response: '{}',
      },
    ]);

    const result = await writeRowsToParquet(
      schema,
      rows,
      `gexbot-test-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.parquet`,
    );
    expect(result.rowCount).toBe(3);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.buffer.length).toBe(result.bytes);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('round-trips through ParquetReader (rows we wrote come back equal)', async () => {
    const schema = buildCaptureSchema() as InstanceType<
      typeof parquet.ParquetSchema
    >;
    const inputs = [
      {
        id: 99n,
        captured_at: new Date('2026-05-15T18:00:00Z'),
        ticker: 'SPY',
        endpoint: 'snapshot',
        category: 'zero',
        source_timestamp: 1_715_796_000n,
        raw_response: '{"hello":"world"}',
      },
    ];
    const fileName = `gexbot-rt-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.parquet`;
    const result = await writeRowsToParquet(schema, yieldRows(inputs), fileName);

    // Drop the round-trip file under tmp/ to read back
    const tmpPath = join(tmpdir(), 'gexbot-rt-readback.parquet');
    await (await import('node:fs/promises')).writeFile(tmpPath, result.buffer);
    const reader = await parquet.ParquetReader.openFile(tmpPath);
    const cursor = reader.getCursor();
    const row = (await cursor.next()) as Record<string, unknown>;
    await reader.close();
    await unlink(tmpPath);

    expect(row).toMatchObject({
      ticker: 'SPY',
      endpoint: 'snapshot',
      category: 'zero',
      raw_response: '{"hello":"world"}',
    });
  });

  it('produces an empty file (rowCount=0) when the async iterable yields nothing', async () => {
    const schema = buildCaptureSchema() as InstanceType<
      typeof parquet.ParquetSchema
    >;
    const result = await writeRowsToParquet(
      schema,
      yieldRows([]),
      `gexbot-empty-${String(Date.now())}.parquet`,
    );
    expect(result.rowCount).toBe(0);
    expect(result.bytes).toBeGreaterThan(0); // header + footer still written
  });

  // Cleanup-branch (the .catch on the post-write `unlink`) intentionally
  // not tested in unit form — ESM module-namespace properties aren't
  // configurable, so spying on `fs/promises.unlink` throws
  // "Cannot redefine property". The branch is one Sentry log line; any
  // real cleanup failure on the Vercel runtime FS would surface via the
  // Sentry dashboard regardless.
});
