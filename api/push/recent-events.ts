/**
 * GET /api/push/recent-events
 *
 * Returns the last N rows of `regime_events` (newest first) so the
 * FuturesGammaPlaybook history strip can render a compact timeline of
 * server-fired alerts without a fresh websocket. The cron
 * (`monitor-regime-events`) appends to `regime_events` on every edge it
 * detects, so this is purely a read window onto that history.
 *
 * Query params:
 *   ?limit=N — 1..100 (default 20)
 *
 * Response:
 *   { events: Array<{
 *       id, ts, type, severity, title, body, delivered_count
 *     }>}
 *
 * Owner-gated + botid-protected (the payloads include alert titles and
 * bodies which reference the owner's intraday trading context). Edge
 * cache: 30s while the market is open, 300s otherwise — matches the
 * spot-gex-history pattern.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  guardOwnerEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { PushRecentEventsQuerySchema } from '../_lib/validation.js';

const DEFAULT_LIMIT = 20;

export interface RecentEventRow {
  id: number;
  ts: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  delivered_count: number;
}

export interface RecentEventsResponse {
  events: RecentEventRow[];
}

interface RawRow {
  id: number;
  ts: string | Date;
  type: string;
  severity: string;
  title: string;
  body: string;
  delivered_count: number | string | null;
}

/**
 * Normalize a Postgres TIMESTAMPTZ value to an ISO 8601 UTC string.
 * The Neon serverless driver returns these as JS Date objects when
 * using the SQL template tag; keep the response canonical so the
 * frontend's `new Date(ts)` parses consistently.
 */
function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/push/recent-events');
    const done = metrics.request('/api/push/recent-events');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerEndpoint(req, res, done)) return;

    const parsed = PushRecentEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      done({ status: 400 });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    const limit = parsed.data.limit ?? DEFAULT_LIMIT;

    try {
      const sql = getDb();
      const rows = (await sql`
        SELECT id, ts, type, severity, title, body, delivered_count
        FROM regime_events
        ORDER BY ts DESC
        LIMIT ${limit}
      `) as RawRow[];

      const events: RecentEventRow[] = rows.map((r) => ({
        id: r.id,
        ts: toIso(r.ts),
        type: r.type,
        severity: r.severity,
        title: r.title,
        body: r.body,
        delivered_count:
          r.delivered_count == null
            ? 0
            : typeof r.delivered_count === 'number'
              ? r.delivered_count
              : Number.parseInt(String(r.delivered_count), 10) || 0,
      }));

      const response: RecentEventsResponse = { events };
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'push/recent-events error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
