/**
 * GET /api/market-internals/history
 *
 * Returns today's 1-minute OHLC bars for the NYSE market internals
 * ($TICK, $ADD, $VOLD, $TRIN) from the `market_internals` table.
 *
 * Public read-only endpoint (like /api/nope-intraday) — no owner cookie
 * required. Bot-protected via checkBot().
 *
 * Query:
 *   ?since=<ISO timestamp>  Optional. Return only bars with ts > since.
 *                           Used by the frontend hook for incremental polls.
 *                           If omitted, returns all bars from today's ET
 *                           calendar date.
 *
 * Cache:
 *   30s edge + 30s SWR — we poll every 60s on the client, so cached
 *   responses will usually be 0-30s stale.
 *
 * Response:
 *   {
 *     bars: InternalBar[]           // sorted by ts ASC
 *     asOf: string                  // ISO timestamp (response time)
 *     marketOpen: boolean
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  checkBot,
  isMarketOpen,
  setCacheHeaders,
} from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { getDb } from '../_lib/db.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import type {
  InternalBar,
  InternalSymbol,
} from '../../src/types/market-internals.js';

// ── Query validation ────────────────────────────────────────

const querySchema = z.object({
  since: z.string().datetime().optional(),
});

// Neon returns NUMERIC as string; normalize to number once at the edge.
interface RawBarRow {
  ts: string;
  symbol: InternalSymbol;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

function toBar(row: RawBarRow): InternalBar {
  return {
    ts: new Date(row.ts).toISOString(),
    symbol: row.symbol,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/market-internals/history');
    const done = metrics.request('/api/market-internals/history');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        return res.status(403).json({ error: 'Access denied' });
      }

      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'Invalid query',
          details: parsed.error.flatten(),
        });
      }

      const { since } = parsed.data;
      const sql = getDb();
      const today = getETDateStr(new Date());

      const rawRows = since
        ? await sql`
            SELECT ts, symbol, open, high, low, close
            FROM market_internals
            WHERE ts > ${since}
            ORDER BY ts ASC
          `
        : await sql`
            SELECT ts, symbol, open, high, low, close
            FROM market_internals
            WHERE ts::date = ${today}::date
            ORDER BY ts ASC
          `;
      const rows = rawRows as unknown as RawBarRow[];

      const bars = rows.map(toBar);
      const marketOpen = isMarketOpen();

      setCacheHeaders(res, 30, 30);
      done({ status: 200 });
      return res.status(200).json({
        bars,
        asOf: new Date().toISOString(),
        marketOpen,
      });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'market-internals/history error');
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
