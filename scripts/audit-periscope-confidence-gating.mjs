#!/usr/bin/env node
/**
 * One-off audit: re-grades historical HIGH-confidence Periscope reads
 * under the Phase 4 confidence gate (periscope-flow-hallucination-fix-2026-05-16).
 *
 * For each `periscope_analyses` row with `confidence='high'` and `mode='intraday'`:
 *   1. Look up the flow-context window the model would have seen
 *      (last 15 min × ±10 pts of spot, SPXW only).
 *   2. Count alerts in window. If zero → the read was issued on an empty
 *      window and the Phase 4 gate would FORBID `high` going forward.
 *   3. Report a downgrade recommendation (high → medium) for each
 *      empty-window row. NO writes — read-only audit.
 *
 * Usage:
 *   node scripts/audit-periscope-confidence-gating.mjs
 *
 * Expected output (per the 2026-05-16 audit referenced in the spec):
 *   3 of 19 HIGH reads issued on empty windows — should downgrade to medium.
 *
 * To actually apply downgrades (separate operation, not done by this
 * script): see the spec's Phase 4 acceptance criteria.
 */

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: '.env.local' });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL not set — run `vercel env pull .env.local` first',
  );
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const INTRADAY_WINDOW_MINUTES = 15;
const SPOT_PROXIMITY_PTS = 10;

async function main() {
  const highReads = await sql`
    SELECT id, trading_date, read_time, spot_at_read_time, bias, regime_tag
    FROM periscope_analyses
    WHERE confidence = 'high'
      AND mode = 'intraday'
    ORDER BY trading_date, read_time
  `;

  console.log(
    `Auditing ${highReads.length} HIGH-confidence intraday reads against the Phase 4 gate.\n`,
  );

  const downgrades = [];
  for (const row of highReads) {
    const readTime = new Date(row.read_time);
    const windowStart = new Date(
      readTime.getTime() - INTRADAY_WINDOW_MINUTES * 60_000,
    );
    const strikeLo = Number(row.spot_at_read_time) - SPOT_PROXIMITY_PTS;
    const strikeHi = Number(row.spot_at_read_time) + SPOT_PROXIMITY_PTS;

    const [{ alerts_in_window }] = await sql`
      SELECT COUNT(*)::int AS alerts_in_window
      FROM flow_alerts
      WHERE ticker = 'SPXW'
        AND created_at >= ${windowStart.toISOString()}::timestamptz
        AND created_at <  ${readTime.toISOString()}::timestamptz
        AND strike BETWEEN ${strikeLo} AND ${strikeHi}
    `;

    if (alerts_in_window === 0) {
      downgrades.push({
        id: row.id,
        trading_date: row.trading_date,
        read_time_ct: readTime.toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        spot: Number(row.spot_at_read_time).toFixed(2),
        bias: row.bias,
        regime: row.regime_tag,
      });
    }
  }

  if (downgrades.length === 0) {
    console.log(
      '  No HIGH reads had empty flow windows — Phase 4 gate is a no-op for history.',
    );
    return;
  }

  console.log(
    `Phase 4 gate would DOWNGRADE ${downgrades.length} HIGH read${downgrades.length === 1 ? '' : 's'} → MEDIUM:\n`,
  );
  console.table(downgrades);
  console.log(
    '\nNo writes performed. To apply, run a separate UPDATE statement after review.',
  );
}

main().catch((err) => {
  console.error('audit failed:', err);
  process.exit(1);
});
