/**
 * GET /api/journal/status
 *
 * Diagnostic endpoint: tests DB connection and reports table row counts.
 * Owner-or-guest.
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import logger from '../_lib/logger.js';

// Public diagnostic surface — list every table whose row count is safe
// to expose to a guest cookie. Anything not on this list gets dropped
// from the response so the endpoint can't be used to enumerate the full
// schema (per the api/ folder review MED-9 finding).
const DIAGNOSTIC_TABLE_ALLOWLIST = new Set<string>([
  'analyses',
  'current_day_snapshot',
  'dark_pool_prints',
  'day_embeddings',
  'day_features',
  'economic_events',
  'etf_candles_1m',
  'flow_alerts',
  'futures_bars',
  'gex_strike_0dte',
  'gex_target_features',
  'greek_exposure',
  'greek_exposure_strike',
  'iv_monitor',
  'lesson_reports',
  'lessons',
  'market_alerts',
  'market_snapshots',
  'ml_findings',
  'ml_plot_analyses',
  'oi_changes',
  'outcomes',
  'positions',
  'predictions',
  'schema_migrations',
  'spot_exposures',
  'index_candles_1m',
  'strike_iv_snapshots',
  'theta_option_eod',
  'trace_live_analyses',
  'trace_predictions',
  'training_features',
  'vega_spike_events',
  'vol_term_structure',
  'zero_gamma_levels',
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/journal/status');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  try {
    const sql = getDb();

    // Test connection
    const timeResult = await withDbRetry(
      () => sql`SELECT NOW() as now`,
      2,
      10_000,
    );

    // Get row counts for all tables via a single query against pg_stat_user_tables.
    // This uses PostgreSQL's statistics (updated by autovacuum) — fast and avoids
    // 16 separate COUNT(*) queries. Values are approximate but good for diagnostics.
    const tableRows = await withDbRetry(
      () => sql`
        SELECT relname AS name, n_live_tup::int AS count
        FROM pg_stat_user_tables
        ORDER BY relname
      `,
      2,
      10_000,
    );
    const tables: Record<string, number> = {};
    for (const row of tableRows) {
      const name = row.name as string;
      if (DIAGNOSTIC_TABLE_ALLOWLIST.has(name)) {
        tables[name] = row.count as number;
      }
    }

    // Latest applied migration
    let latestMigration: number | null = null;
    try {
      const migRows = await withDbRetry(
        () => sql`SELECT MAX(id)::int as latest FROM schema_migrations`,
        2,
        10_000,
      );
      latestMigration = migRows[0]?.latest ?? null;
    } catch {
      // schema_migrations doesn't exist yet
    }

    // Check which env vars are set (names only, not values)
    const envVars = [
      'DATABASE_URL',
      'POSTGRES_URL',
      'POSTGRES_PRISMA_URL',
      'POSTGRES_URL_NON_POOLING',
      'NEON_DATABASE_URL',
    ].filter((key) => !!process.env[key]);

    done({ status: 200 });
    return res.status(200).json({
      connected: true,
      serverTime: timeResult[0]?.now,
      latestMigration,
      envVarsFound: envVars,
      tables,
    });
  } catch (err) {
    // Health/diagnostic endpoint: must report DB-down state explicitly via
    // `connected: false`, NOT soft-degrade to a 503 that drops that field.
    // A transient blip and a genuine failure both mean "DB unreachable
    // right now" for a health check — surface both as a hard 500.
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'journal status check failed');
    return res.status(500).json({
      connected: false,
      error: 'Database connection failed',
    });
  }
}
