/**
 * GET /api/cron/archive-gexbot[?date=YYYY-MM-DD]
 *
 * Daily Parquet export of the GEXBot capture tables to Vercel Blob.
 * Bridges the gap between live DB (kept short by `cleanup-gexbot`)
 * and the historical archive — GEXBot has no daily download files
 * of its own, so we are the archive of record during the trial.
 *
 * Catch-up semantics: each run archives EVERY un-archived session, oldest
 * first, not just yesterday. A session is un-archived for a table when the
 * table has live rows on that day and `gexbot_archive_audit` has no row for
 * it (`listUnarchivedDates`). A half-archived day re-archives only the
 * table that is missing. An outage therefore self-heals on the next run
 * instead of leaving a permanent gap.
 *
 * Day boundaries: UTC calendar days. The date helper and `streamRows` both
 * use `d::timestamptz` under Neon's UTC session time zone. GexBot sessions
 * run 13:30-20:01 UTC and never straddle UTC midnight, so the UTC day is the
 * ET session date. `ctx.today` (ET) is the exclusive upper bound, so a run
 * never touches the current day.
 *
 * Manual re-run: `GET /api/cron/archive-gexbot?date=2026-09-08` with the
 * CRON_SECRET bearer archives that one date for BOTH tables regardless of
 * audit state. It is idempotent (Blob `allowOverwrite: true`, audit
 * `ON CONFLICT ... DO UPDATE`) and writes a `row_count = 0` audit row for an
 * empty day. A malformed `date` throws, which the wrapper turns into a 500.
 *
 * Time budget: the first date always runs. Another pending date starts only
 * if fewer than MAX_DATES_PER_RUN are done and the time left in the function
 * exceeds NEXT_DATE_SAFETY_FACTOR times the previous date's wall time plus
 * NEXT_DATE_MARGIN_MS. Leftover dates are reported as `remainingDates`
 * (with `stopReason`) and picked up by the next scheduled run.
 *
 * For each table and date:
 *   1. Page through the day's rows via id-cursor pagination
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
import {
  GEXBOT_ARCHIVE_TABLES,
  listUnarchivedDates,
  type GexbotArchiveTable,
} from '../_lib/gexbot-archive-dates.js';
import { Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 300 };

/** Function time limit in ms, derived from `config` so the two never drift. */
const MAX_DURATION_MS = config.maxDuration * 1000;

/** Time left must exceed this multiple of the last date's wall time. */
const NEXT_DATE_SAFETY_FACTOR = 1.5;

/** Fixed slack added on top of the scaled estimate for the next date. */
const NEXT_DATE_MARGIN_MS = 15_000;

/** Hard cap on dates per run so one run cannot monopolize the DB. */
const MAX_DATES_PER_RUN = 5;

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Keyset-pagination page size — small enough to stay well under
 *  Vercel function memory ceilings even for the heavy state-per-strike
 *  table whose rows include ~30 KB JSONB payloads. */
const PAGE_SIZE = 5_000;

type SchemaBuilder = () => unknown;

interface TableSpec {
  name: GexbotArchiveTable;
  buildSchema: SchemaBuilder;
}

const TABLE_SPECS: Record<GexbotArchiveTable, TableSpec> = {
  gexbot_snapshots: {
    name: 'gexbot_snapshots',
    buildSchema: buildSnapshotSchema,
  },
  gexbot_api_capture: {
    name: 'gexbot_api_capture',
    buildSchema: buildCaptureSchema,
  },
};

/**
 * Async generator that paginates one date's rows from `tableName`
 * using keyset pagination on the BIGSERIAL `id` column. Single
 * archive date is read-only mid-cron (writes stop at 21:00 UTC,
 * archive runs at 21:30), so OFFSET-style pagination would also
 * work — keyset is just faster and never skips rows under churn.
 */
async function* streamRows(
  tableName: GexbotArchiveTable,
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

type StopReason = 'drained' | 'budget' | 'max_dates';

interface DatePlan {
  date: string;
  tables: readonly GexbotArchiveTable[];
}

/**
 * Which (date, tables) to archive. `?date=` forces both tables for one day;
 * otherwise the ascending union of each table's pending dates, each date
 * carrying only the tables that are actually missing it.
 */
async function buildPlan(
  dateParam: unknown,
  today: string,
): Promise<DatePlan[]> {
  if (typeof dateParam === 'string') {
    if (!DATE_PARAM_RE.test(dateParam)) {
      throw new Error('archive-gexbot: invalid date param');
    }
    return [{ date: dateParam, tables: GEXBOT_ARCHIVE_TABLES }];
  }

  const sql = getDb();
  const pendingByDate = new Map<string, GexbotArchiveTable[]>();
  for (const table of GEXBOT_ARCHIVE_TABLES) {
    for (const date of await listUnarchivedDates(sql, table, today)) {
      pendingByDate.set(date, [...(pendingByDate.get(date) ?? []), table]);
    }
  }
  return [...pendingByDate.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([date, tables]) => ({ date, tables }));
}

export default withCronInstrumentation(
  'archive-gexbot',
  async (ctx): Promise<CronResult> => {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
    }

    const plan = await buildPlan(ctx.req?.query.date, ctx.today);
    const summaries: ArchiveSummary[] = [];
    const archivedDates: string[] = [];
    let failed = 0;
    let stopReason: StopReason = 'drained';

    for (const [index, { date, tables }] of plan.entries()) {
      // Wall time of this date: before its first table to after its last.
      const dateStartMs = Date.now();
      for (const name of tables) {
        try {
          summaries.push(await archiveOneTable(TABLE_SPECS[name], date));
        } catch (err) {
          failed += 1;
          Sentry.captureException(err, {
            tags: {
              'gexbot.cron': 'archive',
              'gexbot.table': name,
              'gexbot.archive_date': date,
            },
          });
          ctx.logger.error(
            { err, table: name, archiveDate: date },
            'archive-gexbot table failed',
          );
        }
      }
      archivedDates.push(date);
      const lastDateMs = Date.now() - dateStartMs;

      if (index === plan.length - 1) break;
      if (archivedDates.length >= MAX_DATES_PER_RUN) {
        stopReason = 'max_dates';
        break;
      }
      const remainingMs = MAX_DURATION_MS - (Date.now() - ctx.startTimeMs);
      if (
        remainingMs <=
        NEXT_DATE_SAFETY_FACTOR * lastDateMs + NEXT_DATE_MARGIN_MS
      ) {
        stopReason = 'budget';
        break;
      }
    }

    const remainingDates = plan.length - archivedDates.length;
    if (remainingDates > 0) {
      ctx.logger.warn(
        { remainingDates, stopReason },
        'archive-gexbot backlog remains',
      );
    }
    ctx.logger.info(
      { dates: archivedDates, summaries, failed, remainingDates, stopReason },
      'archive-gexbot completed',
    );

    return {
      status: failed === 0 ? 'success' : 'partial',
      rows: summaries.reduce((sum, s) => sum + s.rowCount, 0),
      metadata: {
        dates: archivedDates,
        summaries,
        failed,
        remainingDates,
        stopReason,
      },
    };
  },
  { marketHours: false, requireApiKey: false, passReq: true },
);
