/**
 * Parquet helpers for the GEXBot trial-capture archive cron.
 *
 * Builds Snappy-compressed Parquet files from streaming row inputs
 * via @dsnp/parquetjs (the maintained fork of parquetjs-lite). Two
 * exported schemas mirror the column layouts of `gexbot_snapshots`
 * and `gexbot_api_capture`; both store `raw_response` as a UTF8 JSON
 * string because Parquet has no native JSONB type.
 *
 * Writes go to `/tmp` (Vercel function scratch space) since the
 * @dsnp/parquetjs writer expects a file handle and we want the
 * resulting bytes back as a Buffer for `@vercel/blob` upload.
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 */

import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as parquet from '@dsnp/parquetjs';

export interface ParquetResult {
  /** Encoded Parquet bytes ready for Blob upload. */
  buffer: Buffer;
  /** Byte length — pass to `head()` for size-match verification. */
  bytes: number;
  /** Hex-encoded SHA-256 of `buffer` — written to gexbot_archive_audit. */
  sha256: string;
  /** Number of rows actually appended. */
  rowCount: number;
}

/**
 * Encode rows into a Snappy-compressed Parquet file and return the
 * full byte buffer + hash + count. `fileName` is the basename used
 * under /tmp during writing — must be unique per concurrent run, so
 * the cron passes `${table}_${date}.parquet`.
 */
export async function writeRowsToParquet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any,
  rows: AsyncIterable<Record<string, unknown>>,
  fileName: string,
): Promise<ParquetResult> {
  const tmpPath = join(tmpdir(), fileName);

  // ParquetWriter.openFile creates / overwrites tmpPath. Compression
  // is set per-field on the schema (@dsnp/parquetjs has no
  // writer-level compression option) — see buildSnapshotSchema /
  // buildCaptureSchema which mark `raw_response` SNAPPY.
  const writer = await parquet.ParquetWriter.openFile(schema, tmpPath, {
    rowGroupSize: 50_000,
  });

  let rowCount = 0;
  try {
    for await (const row of rows) {
      await writer.appendRow(row);
      rowCount += 1;
    }
  } finally {
    await writer.close();
  }

  const buffer = await readFile(tmpPath);
  // Best-effort cleanup; failure to unlink is non-fatal (next cron run
  // will overwrite via openFile).
  await unlink(tmpPath).catch(() => {
    /* ignore */
  });

  return {
    buffer,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    rowCount,
  };
}

/**
 * Parquet schema mirroring the gexbot_snapshots column layout.
 * Numeric columns are `DOUBLE optional` (Postgres NUMERIC → JS number
 * through the Neon serverless driver, with `null` for absent fields).
 * BIGINT columns use `INT64`. raw_response is a UTF8 JSON string.
 */
export function buildSnapshotSchema(): unknown {
  return new parquet.ParquetSchema({
    id: { type: 'INT64' },
    captured_at: { type: 'TIMESTAMP_MILLIS' },
    ticker: { type: 'UTF8' },
    source_timestamp: { type: 'INT64', optional: true },
    spot: { type: 'DOUBLE', optional: true },
    zero_gamma: { type: 'DOUBLE', optional: true },
    z_mlgamma: { type: 'DOUBLE', optional: true },
    z_msgamma: { type: 'DOUBLE', optional: true },
    zero_mcall: { type: 'DOUBLE', optional: true },
    zero_mput: { type: 'DOUBLE', optional: true },
    zcvr: { type: 'DOUBLE', optional: true },
    zgr: { type: 'DOUBLE', optional: true },
    zvanna: { type: 'DOUBLE', optional: true },
    zcharm: { type: 'DOUBLE', optional: true },
    o_mlgamma: { type: 'DOUBLE', optional: true },
    o_msgamma: { type: 'DOUBLE', optional: true },
    one_mcall: { type: 'DOUBLE', optional: true },
    one_mput: { type: 'DOUBLE', optional: true },
    ocvr: { type: 'DOUBLE', optional: true },
    ogr: { type: 'DOUBLE', optional: true },
    ovanna: { type: 'DOUBLE', optional: true },
    ocharm: { type: 'DOUBLE', optional: true },
    agg_dex: { type: 'DOUBLE', optional: true },
    one_agg_dex: { type: 'DOUBLE', optional: true },
    agg_call_dex: { type: 'DOUBLE', optional: true },
    one_agg_call_dex: { type: 'DOUBLE', optional: true },
    agg_put_dex: { type: 'DOUBLE', optional: true },
    one_agg_put_dex: { type: 'DOUBLE', optional: true },
    net_dex: { type: 'DOUBLE', optional: true },
    one_net_dex: { type: 'DOUBLE', optional: true },
    net_call_dex: { type: 'DOUBLE', optional: true },
    one_net_call_dex: { type: 'DOUBLE', optional: true },
    net_put_dex: { type: 'DOUBLE', optional: true },
    one_net_put_dex: { type: 'DOUBLE', optional: true },
    dexoflow: { type: 'DOUBLE', optional: true },
    gexoflow: { type: 'DOUBLE', optional: true },
    cvroflow: { type: 'DOUBLE', optional: true },
    one_dexoflow: { type: 'DOUBLE', optional: true },
    one_gexoflow: { type: 'DOUBLE', optional: true },
    one_cvroflow: { type: 'DOUBLE', optional: true },
    sum_gex_vol: { type: 'DOUBLE', optional: true },
    sum_gex_oi: { type: 'DOUBLE', optional: true },
    major_pos_vol: { type: 'DOUBLE', optional: true },
    major_pos_oi: { type: 'DOUBLE', optional: true },
    major_neg_vol: { type: 'DOUBLE', optional: true },
    major_neg_oi: { type: 'DOUBLE', optional: true },
    delta_risk_reversal: { type: 'DOUBLE', optional: true },
    min_dte: { type: 'INT32', optional: true },
    sec_min_dte: { type: 'INT32', optional: true },
    raw_response: { type: 'UTF8', compression: 'SNAPPY' },
  });
}

/**
 * Parquet schema mirroring the gexbot_api_capture column layout.
 * Six small columns + the raw JSONB blob as UTF8.
 */
export function buildCaptureSchema(): unknown {
  return new parquet.ParquetSchema({
    id: { type: 'INT64' },
    captured_at: { type: 'TIMESTAMP_MILLIS' },
    ticker: { type: 'UTF8' },
    endpoint: { type: 'UTF8' },
    category: { type: 'UTF8' },
    source_timestamp: { type: 'INT64', optional: true },
    raw_response: { type: 'UTF8', compression: 'SNAPPY' },
  });
}
