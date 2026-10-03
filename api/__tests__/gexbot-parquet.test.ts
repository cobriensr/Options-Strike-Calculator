// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as parquet from '@dsnp/parquetjs';

import {
  writeRowsToParquet,
  buildSnapshotSchema,
  buildCaptureSchema,
  sweepStaleTempFiles,
} from '../_lib/gexbot-parquet.js';

const { mockLoggerWarn, mockReaddir } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockReaddir: vi.fn(),
}));

// Real fs, with readdir routed through a mock so one test can make listing
// tmpdir fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  mockReaddir.mockImplementation(actual.readdir);
  return { ...actual, readdir: mockReaddir };
});

// Sentry mock — the cleanup-unlink catch path captures here. We don't
// surface a real DSN in tests; keep it inert so the writer succeeds
// silently when unlink does run.
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() },
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
    const result = await writeRowsToParquet(
      schema,
      yieldRows(inputs),
      fileName,
    );

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

  it('removes the temp file when the row stream throws mid-write', async () => {
    const schema = buildCaptureSchema() as InstanceType<
      typeof parquet.ParquetSchema
    >;
    const fileName = `gexbot-throw-${String(Date.now())}.parquet`;
    async function* failing(): AsyncGenerator<Record<string, unknown>> {
      yield {
        id: 1,
        captured_at: Date.now(),
        ticker: 'SPX',
        endpoint: 'zero',
        category: 'zero',
        raw_response: '{}',
      };
      await Promise.resolve();
      throw new Error('stream blew up');
    }

    await expect(
      writeRowsToParquet(schema, failing(), fileName),
    ).rejects.toThrow('stream blew up');
    await expect(access(join(tmpdir(), fileName))).rejects.toThrow(/ENOENT/);
  });

  // Cleanup-branch (the .catch on the post-write `unlink`) intentionally
  // not tested in unit form — ESM module-namespace properties aren't
  // configurable, so spying on `fs/promises.unlink` throws
  // "Cannot redefine property". The branch is one Sentry log line; any
  // real cleanup failure on the Vercel runtime FS would surface via the
  // Sentry dashboard regardless.
});

describe('sweepStaleTempFiles', () => {
  const MAX_AGE_MS = 300_000;
  const created: string[] = [];

  /** Creates `name` in tmpdir() with its mtime `ageMs` in the past. */
  async function makeEntry(
    name: string,
    ageMs: number,
    kind: 'file' | 'dir' = 'file',
  ): Promise<string> {
    const path = join(tmpdir(), name);
    if (kind === 'dir') await mkdir(path);
    else await writeFile(path, 'x');
    const at = new Date(Date.now() - ageMs);
    await utimes(path, at, at);
    created.push(path);
    return path;
  }

  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  beforeEach(() => {
    mockLoggerWarn.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      created.splice(0).map((p) => rm(p, { recursive: true, force: true })),
    );
  });

  it('removes only gexbot_*.parquet files older than maxAgeMs', async () => {
    const id = randomUUID();
    const old = await makeEntry(`gexbot_sweep_${id}_old.parquet`, 3_600_000);
    const fresh = await makeEntry(`gexbot_sweep_${id}_fresh.parquet`, 0);
    const otherPrefix = await makeEntry(`other_sweep_${id}.parquet`, 3_600_000);
    const otherSuffix = await makeEntry(`gexbot_sweep_${id}.txt`, 3_600_000);

    await sweepStaleTempFiles(MAX_AGE_MS);

    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(otherPrefix)).toBe(true);
    expect(await exists(otherSuffix)).toBe(true);
  });

  it('logs and continues when one stale entry cannot be removed', async () => {
    const id = randomUUID();
    // A directory with a matching name: unlink rejects (EPERM / EISDIR).
    const stuck = await makeEntry(
      `gexbot_sweep_${id}_dir.parquet`,
      3_600_000,
      'dir',
    );
    const old = await makeEntry(`gexbot_sweep_${id}_old.parquet`, 3_600_000);

    await expect(sweepStaleTempFiles(MAX_AGE_MS)).resolves.toBeUndefined();

    expect(await exists(old)).toBe(false);
    expect(await exists(stuck)).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: stuck }),
      'gexbot temp sweep: cannot remove file',
    );
  });

  it('logs without throwing when tmpdir cannot be listed', async () => {
    mockReaddir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

    await expect(sweepStaleTempFiles(MAX_AGE_MS)).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ dir: tmpdir() }),
      'gexbot temp sweep: cannot list tmpdir',
    );
  });
});
