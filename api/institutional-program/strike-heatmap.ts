/**
 * GET /api/institutional-program/strike-heatmap?days=60&track=ceiling
 *
 * Cumulative institutional notional per strike over a rolling window.
 * Answers: "where has the big money been building positions?"
 *
 * Query params:
 *   ?days=60          1-180, default 60
 *   ?track=ceiling    'ceiling' | 'opening_atm', default 'ceiling'
 *
 * Response:
 *   {
 *     spot:  number | null,     // latest observed underlying_price
 *     rows:  StrikeCell[]       // top 40 strikes by cumulative premium
 *   }
 *
 * Source spec: docs/institutional-program-tracker.md (v2, Implication 2).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';

interface StrikeCell {
  strike: number;
  option_type: 'call' | 'put';
  n_blocks: number;
  total_contracts: number;
  total_premium: number;
  last_seen_date: string;
  active_days: number;
  latest_expiry: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/institutional-program/strike-heatmap');

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const daysRaw = Number.parseInt(String(req.query.days ?? '60'), 10);
  const days = Math.min(
    Math.max(Number.isFinite(daysRaw) ? daysRaw : 60, 1),
    180,
  );
  const trackRaw = String(req.query.track ?? 'ceiling');
  const track =
    trackRaw === 'opening_atm' || trackRaw === 'ceiling' ? trackRaw : 'ceiling';

  try {
    const sql = getDb();

    const rows = (await sql`
      SELECT
        strike,
        option_type,
        COUNT(*)::INTEGER AS n_blocks,
        SUM(size)::INTEGER AS total_contracts,
        SUM(premium)::DOUBLE PRECISION AS total_premium,
        MAX(CAST(executed_at AS DATE))::TEXT AS last_seen_date,
        COUNT(DISTINCT CAST(executed_at AS DATE))::INTEGER AS active_days,
        MAX(expiry)::TEXT AS latest_expiry
      FROM institutional_blocks
      WHERE program_track = ${track}
        AND executed_at >= NOW() - (${days}::TEXT || ' days')::INTERVAL
      GROUP BY strike, option_type
      HAVING SUM(premium) > 100000
      ORDER BY total_premium DESC
      LIMIT 40
    `) as StrikeCell[];

    // Latest underlying_price across the same window gives us a spot
    // reference for the chart overlay.
    const spotRows = (await sql`
      SELECT underlying_price::DOUBLE PRECISION AS spot
      FROM institutional_blocks
      WHERE program_track = ${track}
      ORDER BY executed_at DESC
      LIMIT 1
    `) as Array<{ spot: number | null }>;
    const spotRow = spotRows[0];

    done({ status: 200 });
    res.status(200).json({
      spot: spotRow?.spot ?? null,
      days,
      track,
      rows,
    });
  } catch (err) {
    done({ status: 500 });
    Sentry.captureException(err);
    res.status(500).json({ error: 'Internal error' });
  }
}
