/**
 * GET /api/vega-spikes
 *
 * Returns recent Dir Vega Spike Monitor events from the
 * `vega_spike_events` table. Polled by the frontend feed UI to surface
 * directional vega flow regime breaks (z-score and vs-prior-max breakouts)
 * detected by the `monitor-vega-spike` cron.
 *
 * Owner-or-guest — spike events are derived from public market data, no
 * OPRA / Schwab content surfaced here.
 *
 * Query params:
 *   ?range=today  — events for the current US/Eastern date (default)
 *   ?range=7d     — events from the last 7 days
 *   ?range=30d    — events from the last 30 days
 *
 * Data freshness:
 *   The cron writes new rows during market hours roughly every 5 min.
 *   `fwd_return_*` columns are populated later by a Phase 5 enrichment
 *   cron — until then they are NULL on most rows. Response uses
 *   `Cache-Control: no-store` so the UI's poll loop always hits fresh DB.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { rejectIfNotOwnerOrGuest } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

type Range = 'today' | '7d' | '30d';

// Numeric columns come back from @neondatabase/serverless as strings;
// nullable forward-return columns may be null.
type Numeric = number | string;
type NullableNumeric = Numeric | null;

interface VegaSpikeRow {
  id: Numeric;
  ticker: string;
  date: string;
  timestamp: string;
  dir_vega_flow: Numeric;
  z_score: Numeric;
  vs_prior_max: Numeric;
  prior_max: Numeric;
  baseline_mad: Numeric;
  bars_elapsed: Numeric;
  confluence: boolean;
  fwd_return_5m: NullableNumeric;
  fwd_return_15m: NullableNumeric;
  fwd_return_30m: NullableNumeric;
  inserted_at: string;
}

function toNumber(v: Numeric): number {
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

function toNullableNumber(v: NullableNumeric): number | null {
  if (v === null) return null;
  return toNumber(v);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/vega-spikes');

    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'GET only' });
      }

      if (rejectIfNotOwnerOrGuest(req, res)) return;

      const rangeParam = (req.query.range as string | undefined) ?? 'today';
      if (
        rangeParam !== 'today' &&
        rangeParam !== '7d' &&
        rangeParam !== '30d'
      ) {
        return res.status(400).json({ error: 'invalid range' });
      }
      const range: Range = rangeParam;

      const sql = getDb();

      const today = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });

      let rows: VegaSpikeRow[];
      if (range === 'today') {
        rows = (await sql`
          SELECT
            id, ticker, date, timestamp,
            dir_vega_flow, z_score, vs_prior_max,
            prior_max, baseline_mad, bars_elapsed,
            confluence,
            fwd_return_5m, fwd_return_15m, fwd_return_30m,
            inserted_at
          FROM vega_spike_events
          WHERE date = ${today}
          ORDER BY timestamp DESC
          LIMIT 100
        `) as VegaSpikeRow[];
      } else if (range === '7d') {
        rows = (await sql`
          SELECT
            id, ticker, date, timestamp,
            dir_vega_flow, z_score, vs_prior_max,
            prior_max, baseline_mad, bars_elapsed,
            confluence,
            fwd_return_5m, fwd_return_15m, fwd_return_30m,
            inserted_at
          FROM vega_spike_events
          WHERE date >= CURRENT_DATE - INTERVAL '7 days'
          ORDER BY timestamp DESC
          LIMIT 100
        `) as VegaSpikeRow[];
      } else {
        rows = (await sql`
          SELECT
            id, ticker, date, timestamp,
            dir_vega_flow, z_score, vs_prior_max,
            prior_max, baseline_mad, bars_elapsed,
            confluence,
            fwd_return_5m, fwd_return_15m, fwd_return_30m,
            inserted_at
          FROM vega_spike_events
          WHERE date >= CURRENT_DATE - INTERVAL '30 days'
          ORDER BY timestamp DESC
          LIMIT 100
        `) as VegaSpikeRow[];
      }

      const spikes = rows.map((row) => ({
        id: toNumber(row.id),
        ticker: row.ticker,
        date: row.date,
        timestamp: row.timestamp,
        dirVegaFlow: toNumber(row.dir_vega_flow),
        zScore: toNumber(row.z_score),
        vsPriorMax: toNumber(row.vs_prior_max),
        priorMax: toNumber(row.prior_max),
        baselineMad: toNumber(row.baseline_mad),
        barsElapsed: toNumber(row.bars_elapsed),
        confluence: row.confluence,
        fwdReturn5m: toNullableNumber(row.fwd_return_5m),
        fwdReturn15m: toNullableNumber(row.fwd_return_15m),
        fwdReturn30m: toNullableNumber(row.fwd_return_30m),
        insertedAt: row.inserted_at,
      }));

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ spikes, range });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'vega-spikes fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
