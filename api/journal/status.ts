/**
 * GET /api/journal/status
 *
 * Diagnostic endpoint: tests DB connection and reports table row counts.
 * Owner-gated.
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/journal/status');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    done({ status: 403 });
    return res.status(403).json({ error: 'Access denied' });
  }

  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) {
    done({ status: 401 });
    return ownerCheck;
  }

  try {
    const sql = getDb();

    // Test connection
    const timeResult = await sql`SELECT NOW() as now`;

    // Get row counts for all tables via a single query against pg_stat_user_tables.
    // This uses PostgreSQL's statistics (updated by autovacuum) — fast and avoids
    // 16 separate COUNT(*) queries. Values are approximate but good for diagnostics.
    const tableRows = await sql`
      SELECT relname AS name, n_live_tup::int AS count
      FROM pg_stat_user_tables
      ORDER BY relname
    `;
    const tables: Record<string, number> = {};
    for (const row of tableRows) {
      tables[row.name as string] = row.count as number;
    }

    // Latest applied migration
    let latestMigration: number | null = null;
    try {
      const migRows =
        await sql`SELECT MAX(id)::int as latest FROM schema_migrations`;
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
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    return res.status(500).json({
      connected: false,
      error: 'Database connection failed',
    });
  }
}
