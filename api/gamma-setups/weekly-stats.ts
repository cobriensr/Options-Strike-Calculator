/**
 * GET /api/gamma-setups/weekly-stats
 *
 * Returns aggregate Gamma-Node Composite Detector stats over a trailing
 * window. Drives the tile's rolling-stats bar (Phase 3b) and any
 * dashboards / Sentry investigations that want a single snapshot view.
 *
 * Owner-or-guest — derives entirely from the public-shaped
 * `ws_gamma_setup_fires` table, so guests get the same view as the owner.
 *
 * Query params:
 *   ?days=7|14|30|60|90  Window length in trading days. Default 30.
 *
 * Response: AggregateStats from api/_lib/gamma-stats.ts. NUMERIC columns
 * are already coerced to JS number at the aggregator layer.
 *
 * Spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { sendDbErrorResponse } from '../_lib/transient-db-response.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import {
  aggregateFireStats,
  loadFireStatsRows,
  type AggregateStats,
} from '../_lib/gamma-stats.js';
import { getETDateStr } from '../../src/utils/timezone.js';

const ALLOWED_DAYS = new Set([7, 14, 30, 60, 90]);
const DEFAULT_DAYS = 30;

function parseDaysParam(raw: unknown): number {
  if (typeof raw !== 'string') return DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && ALLOWED_DAYS.has(n) ? n : DEFAULT_DAYS;
}

function daysAgoEtDateStr(days: number): string {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return getETDateStr(past);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gamma-setups/weekly-stats');
    const done = metrics.request('/api/gamma-setups/weekly-stats');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        res.status(405).json({ error: 'GET only' });
        return;
      }
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const days = parseDaysParam(req.query.days);
      const today = getETDateStr(new Date());
      const from = daysAgoEtDateStr(days);

      const sql = getDb();
      // loadFireStatsRows already wraps its query in withDbRetry, so we
      // must NOT wrap it again — a double wrap multiplies the attempt count
      // (~9 attempts on a blip) since TransientDbError is itself retryable.
      const rows = await loadFireStatsRows(sql, from, today);
      const stats: AggregateStats = aggregateFireStats(rows, from, today);

      done({ status: 200 });
      // Browsers + tile poll every minute; a 30s edge-cache cuts ~95% of
      // DB hits during heavy intraday refresh without making the bar feel
      // stale relative to the underlying minute-cadence fires.
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.status(200).json(stats);
    } catch (err) {
      sendDbErrorResponse(res, err, {
        label: 'gamma_setups_weekly_stats',
        serverErrorBody: { error: 'Internal error' },
        done,
      });
    }
  });
}
