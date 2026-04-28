/**
 * GET /api/cron/backup-tables
 *
 * Weekly logical backup of all database tables to Vercel Blob as JSONL.
 * Keeps a rolling 4-week retention window — deletes older backups automatically.
 *
 * Each run creates one JSONL file per table under:
 *   backups/{YYYY-MM-DD}/{table_name}.jsonl
 *
 * Designed to run weekly on Sundays at 5 AM UTC via Vercel Cron.
 *
 * Environment: CRON_SECRET, BLOB_READ_WRITE_TOKEN (auto-provisioned by Vercel Blob)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list, del } from '@vercel/blob';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';

export const config = { maxDuration: 300 };

// All tables in dependency order (parents before children)
const TABLES = [
  'market_snapshots',
  'analyses',
  'outcomes',
  'positions',
  'lessons',
  'lesson_reports',
  'flow_data',
  'greek_exposure',
  'spot_exposures',
  'strike_exposures',
  'training_features',
  'day_labels',
  'economic_events',
  'es_bars',
  'es_overnight_summaries',
  'schema_migrations',
] as const;

const RETENTION_WEEKS = 4;

/**
 * Export a single table as JSONL string.
 * Uses sql.unsafe() for dynamic table names (safe here — names are hardcoded constants).
 */
async function exportTable(
  tableName: string,
): Promise<{ jsonl: string; rowCount: number }> {
  const sql = getDb();
  const rows = (await sql`SELECT * FROM ${sql.unsafe(tableName)}`) as Record<
    string,
    unknown
  >[];
  const lines = rows.map((row) => JSON.stringify(row));
  return { jsonl: lines.join('\n'), rowCount: rows.length };
}

/**
 * Delete backup folders older than the retention window.
 */
async function pruneOldBackups(currentDate: string): Promise<string[]> {
  const cutoff = new Date(currentDate);
  cutoff.setDate(cutoff.getDate() - RETENTION_WEEKS * 7);

  const { blobs } = await list({ prefix: 'backups/' });
  const toDelete: string[] = [];

  for (const blob of blobs) {
    // Extract date from path: backups/2026-03-21/table.jsonl → 2026-03-21
    const datePattern = /^backups\/(\d{4}-\d{2}-\d{2})\//;
    const match = datePattern.exec(blob.pathname);
    if (!match) continue;

    const blobDate = new Date(match[1]!);
    if (blobDate < cutoff) {
      toDelete.push(blob.url);
    }
  }

  if (toDelete.length > 0) {
    await del(toDelete);
  }

  return toDelete;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;
  const startTime = Date.now();
  const results: Record<string, { rows: number; bytes: number }> = {};
  const errors: string[] = [];

  logger.info({ date: today, tables: TABLES.length }, 'Starting weekly backup');

  for (const table of TABLES) {
    try {
      const { jsonl, rowCount } = await exportTable(table);
      const path = `backups/${today}/${table}.jsonl`;

      await put(path, jsonl, {
        access: 'private',
        allowOverwrite: true,
        contentType: 'application/x-ndjson',
      });

      results[table] = { rows: rowCount, bytes: jsonl.length };
      logger.info(
        { table, rows: rowCount, bytes: jsonl.length },
        'Table backed up',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`${table}: ${msg}`);
      Sentry.setTag('cron.job', 'backup-tables');
      Sentry.captureException(err);
      logger.error({ table, err }, 'Table backup failed');
    }
  }

  // Prune old backups
  let pruned: string[] = [];
  try {
    pruned = await pruneOldBackups(today);
    if (pruned.length > 0) {
      logger.info({ count: pruned.length }, 'Pruned old backups');
    }
  } catch (err) {
    Sentry.setTag('cron.job', 'backup-tables');
    Sentry.captureException(err);
    logger.error({ err }, 'Backup pruning failed');
    errors.push(`pruning: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  const totalRows = Object.values(results).reduce((s, r) => s + r.rows, 0);
  const totalBytes = Object.values(results).reduce((s, r) => s + r.bytes, 0);

  logger.info(
    {
      tables: Object.keys(results).length,
      totalRows,
      totalBytes,
      errors: errors.length,
    },
    'Weekly backup complete',
  );

  await reportCronRun('backup-tables', {
    status: errors.length > 0 ? 'partial' : 'ok',
    date: today,
    tables: Object.keys(results).length,
    totalRows,
    totalBytes,
    pruned: pruned.length,
    errors: errors.length,
    durationMs: Date.now() - startTime,
  });

  return res.status(200).json({
    date: today,
    tables: results,
    totalRows,
    totalBytes,
    pruned: pruned.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
