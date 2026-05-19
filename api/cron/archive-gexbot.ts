/**
 * GET /api/cron/archive-gexbot
 *
 * Daily Parquet export of the GEXBot capture tables to Vercel Blob.
 * Bridges the gap between live DB (kept short by `cleanup-gexbot`)
 * and the historical archive — GEXBot has no daily download files
 * of its own, so we are the archive of record during the trial.
 *
 * For each of `gexbot_snapshots` and `gexbot_api_capture`:
 *   1. Page through yesterday's rows (ET date) via id-cursor pagination
 *   2. Encode as Snappy Parquet to /tmp
 *   3. PUT to Vercel Blob at gexbot/{table}/{yyyy-mm-dd}.parquet
 *   4. HEAD-verify size match
 *   5. UPSERT a gexbot_archive_audit row (cleanup uses this as the
 *      go/no-go signal)
 *
 * Schedule: 21:30 UTC Tue–Sat (covering Mon–Fri trading sessions).
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 *
 * Environment: BLOB_READ_WRITE_TOKEN, CRON_SECRET, DATABASE_URL
 */

import { head, put } from '@vercel/blob';

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  buildCaptureSchema,
  buildSnapshotSchema,
  writeRowsToParquet,
} from '../_lib/gexbot-parquet.js';
import { Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 300 };

/** Keyset-pagination page size — small enough to stay well under
 *  Vercel function memory ceilings even for the heavy state-per-strike
 *  table whose rows include ~30 KB JSONB payloads. */
const PAGE_SIZE = 5_000;

type SchemaBuilder = () => unknown;

interface TableSpec {
  name: 'gexbot_snapshots' | 'gexbot_api_capture';
  buildSchema: SchemaBuilder;
}

const TABLES: readonly TableSpec[] = [
  { name: 'gexbot_snapshots', buildSchema: buildSnapshotSchema },
  { name: 'gexbot_api_capture', buildSchema: buildCaptureSchema },
] as const;

/**
 * Compute the ET-local archive date (yesterday). We use ET because
 * fetch crons key their date column on ET sessions; aligning archive
 * dates with the cleanup cutoff prevents a single fetched row from
 * straddling two archive files.
 */
function getArchiveDate(now: Date = new Date()): string {
  const offsetMs = 24 * 60 * 60 * 1000;
  const yesterday = new Date(now.getTime() - offsetMs);
  // Render in ET via Intl, then reformat to yyyy-mm-dd
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(yesterday); // en-CA gives yyyy-mm-dd
}

/**
 * Async generator that paginates one date's rows from `tableName`
 * using keyset pagination on the BIGSERIAL `id` column. Single
 * archive date is read-only mid-cron (writes stop at 21:00 UTC,
 * archive runs at 21:30), so OFFSET-style pagination would also
 * work — keyset is just faster and never skips rows under churn.
 */
async function* streamRows(
  tableName: 'gexbot_snapshots' | 'gexbot_api_capture',
  archiveDate: string,
): AsyncIterable<Record<string, unknown>> {
  const sql = getDb();
  let lastId = 0;
  while (true) {
    const page =
      tableName === 'gexbot_snapshots'
        ? ((await withDbRetry(
            () => sql`
              SELECT * FROM gexbot_snapshots
              WHERE captured_at >= ${archiveDate}::timestamptz
                AND captured_at <  (${archiveDate}::date + 1)::timestamptz
                AND id > ${lastId}
              ORDER BY id
              LIMIT ${PAGE_SIZE}
            `,
            2,
            10_000,
          )) as Array<Record<string, unknown>>)
        : ((await withDbRetry(
            () => sql`
              SELECT * FROM gexbot_api_capture
              WHERE captured_at >= ${archiveDate}::timestamptz
                AND captured_at <  (${archiveDate}::date + 1)::timestamptz
                AND id > ${lastId}
              ORDER BY id
              LIMIT ${PAGE_SIZE}
            `,
            2,
            10_000,
          )) as Array<Record<string, unknown>>);
    if (page.length === 0) return;
    for (const row of page) {
      // Normalize row shape for Parquet: JSONB → string, Date → ms
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (key === 'raw_response') {
          out[key] = typeof value === 'string' ? value : JSON.stringify(value);
        } else if (value instanceof Date) {
          out[key] = value.getTime();
        } else if (typeof value === 'bigint') {
          out[key] = Number(value);
        } else {
          out[key] = value;
        }
      }
      yield out;
    }
    const lastRow = page.at(-1);
    if (!lastRow) return;
    lastId = Number(lastRow.id);
  }
}

async function recordAudit(
  tableName: string,
  archiveDate: string,
  rowCount: number,
  blobUrl: string,
  bytes: number,
  sha256: string,
): Promise<void> {
  const sql = getDb();
  await withDbRetry(
    () => sql`
      INSERT INTO gexbot_archive_audit (
        table_name, archive_date, row_count, blob_url, blob_size_bytes, sha256
      ) VALUES (
        ${tableName}, ${archiveDate}, ${rowCount}, ${blobUrl}, ${bytes}, ${sha256}
      )
      ON CONFLICT (table_name, archive_date) DO UPDATE SET
        row_count       = EXCLUDED.row_count,
        blob_url        = EXCLUDED.blob_url,
        blob_size_bytes = EXCLUDED.blob_size_bytes,
        sha256          = EXCLUDED.sha256,
        archived_at     = now()
    `,
    2,
    10_000,
  );
}

interface ArchiveSummary {
  table: string;
  archiveDate: string;
  rowCount: number;
  blobUrl: string;
  bytes: number;
  sha256: string;
}

async function archiveOneTable(
  spec: TableSpec,
  archiveDate: string,
): Promise<ArchiveSummary> {
  const schema = spec.buildSchema();
  const fileName = `${spec.name}_${archiveDate}.parquet`;

  const result = await writeRowsToParquet(
    schema,
    streamRows(spec.name, archiveDate),
    fileName,
  );

  // Empty days are valid (e.g. Friday-after-holiday) — we still write
  // the audit row so cleanup knows the date is "accounted for".
  const blob = await put(
    `gexbot/${spec.name}/${archiveDate}.parquet`,
    result.buffer,
    {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/vnd.apache.parquet',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    },
  );

  const meta = await head(blob.url, {
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  if (meta.size !== result.bytes) {
    throw new Error(
      `Blob size mismatch for ${spec.name} ${archiveDate}: ` +
        `expected ${result.bytes}, got ${meta.size}`,
    );
  }

  await recordAudit(
    spec.name,
    archiveDate,
    result.rowCount,
    blob.url,
    result.bytes,
    result.sha256,
  );

  return {
    table: spec.name,
    archiveDate,
    rowCount: result.rowCount,
    blobUrl: blob.url,
    bytes: result.bytes,
    sha256: result.sha256,
  };
}

export default withCronInstrumentation(
  'archive-gexbot',
  async (ctx): Promise<CronResult> => {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
    }

    const archiveDate = getArchiveDate();
    const summaries: ArchiveSummary[] = [];
    let failed = 0;

    for (const spec of TABLES) {
      try {
        summaries.push(await archiveOneTable(spec, archiveDate));
      } catch (err) {
        failed += 1;
        Sentry.captureException(err, {
          tags: {
            'gexbot.cron': 'archive',
            'gexbot.table': spec.name,
            'gexbot.archive_date': archiveDate,
          },
        });
        ctx.logger.error(
          { err, table: spec.name, archiveDate },
          'archive-gexbot table failed',
        );
      }
    }

    ctx.logger.info(
      { archiveDate, summaries, failed },
      'archive-gexbot completed',
    );

    return {
      status: failed === 0 ? 'success' : 'partial',
      rows: summaries.reduce((sum, s) => sum + s.rowCount, 0),
      metadata: { archiveDate, summaries, failed },
    };
  },
  { marketHours: false, requireApiKey: false },
);
