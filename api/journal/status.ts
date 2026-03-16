/**
 * GET /api/journal/status
 *
 * Diagnostic endpoint: tests DB connection and reports table row counts.
 * Owner-gated.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  try {
    const sql = getDb();

    // Test connection
    const timeResult = await sql`SELECT NOW() as now`;

    // Check if tables exist and get counts
    const snapshots =
      await sql`SELECT COUNT(*)::int as count FROM market_snapshots`;
    const analyses = await sql`SELECT COUNT(*)::int as count FROM analyses`;
    const outcomes = await sql`SELECT COUNT(*)::int as count FROM outcomes`;

    // Positions table may not exist yet — handle gracefully
    let positionsCount = 0;
    try {
      const positions = await sql`SELECT COUNT(*)::int as count FROM positions`;
      positionsCount = positions[0]?.count ?? 0;
    } catch {
      // Table doesn't exist yet — that's fine
    }

    // Check which env vars are set (names only, not values)
    const envVars = [
      'DATABASE_URL',
      'POSTGRES_URL',
      'POSTGRES_PRISMA_URL',
      'POSTGRES_URL_NON_POOLING',
      'NEON_DATABASE_URL',
    ].filter((key) => !!process.env[key]);

    return res.status(200).json({
      connected: true,
      serverTime: timeResult[0]?.now,
      envVarsFound: envVars,
      tables: {
        market_snapshots: snapshots[0]?.count,
        analyses: analyses[0]?.count,
        outcomes: outcomes[0]?.count,
        positions: positionsCount,
      },
    });
  } catch (err) {
    return res.status(500).json({
      connected: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      envVarsFound: [
        'DATABASE_URL',
        'POSTGRES_URL',
        'POSTGRES_PRISMA_URL',
        'NEON_DATABASE_URL',
      ].filter((key) => !!process.env[key]),
    });
  }
}
