/**
 * GET /api/max-pain-current
 *
 * Returns the current SPX max-pain strike for the `FuturesGammaPlaybook`.
 *
 * Two modes, decided server-side based on the `date` query param:
 *   - LIVE (no date, or date == today ET) — wraps the UW max-pain endpoint
 *     (`api/_lib/max-pain.ts::fetchMaxPain`) which returns the 0DTE-or-
 *     nearest monthly attractor used by the analyze-context pipeline.
 *   - HISTORICAL (date != today ET) — computes max-pain from raw per-strike
 *     OI rows in the `oi_per_strike` table. Those rows are populated by
 *     `api/cron/fetch-oi-per-strike.ts` with real contract counts, so the
 *     pure `computeMaxPain` helper from `src/utils/max-pain.ts` produces a
 *     meaningful value. (The gamma-weighted `gex_strike_0dte` columns are
 *     not valid max-pain inputs — they encode dealer gamma exposure, not
 *     raw contract counts.)
 *
 * Response:
 *   { ticker: string, maxPain: number | null, asOf: string,
 *     source: 'live' | 'historical' | 'historical-empty' }
 *
 * Max pain is a nice-to-have signal, not a critical-path input — upstream
 * failures (UW outage, DB error, missing rows) degrade to `maxPain: null`
 * with status 200 rather than 500. Failures are still logged to Sentry.
 *
 * Owner-gated — max_pain derives from UW API data (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry } from './_lib/sentry.js';
import {
  checkBot,
  isMarketOpen,
  rejectIfNotOwner,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { fetchMaxPain } from './_lib/max-pain.js';
import { getDb } from './_lib/db.js';
import { maxPainCurrentQuerySchema } from './_lib/validation.js';
import { computeMaxPain } from '../src/utils/max-pain.js';
import { getETDateStr } from '../src/utils/timezone.js';

const TICKER = 'SPX';

export type MaxPainCurrentSource = 'live' | 'historical' | 'historical-empty';

export interface MaxPainCurrentResponse {
  ticker: string;
  maxPain: number | null;
  asOf: string;
  source: MaxPainCurrentSource;
}

interface OiPerStrikeRow {
  strike: string | number;
  call_oi: string | number;
  put_oi: string | number;
}

/**
 * Resolve the 0DTE-or-nearest entry from a list of UW max-pain entries.
 * Mirrors the selection rule in `max-pain.ts::formatMaxPainForClaude`:
 * exact match on the analysis date wins, otherwise the nearest expiry
 * on or after that date is the dominant gravitational anchor.
 */
function resolveMaxPainStrike(
  entries: Array<{ expiry: string; max_pain: string }>,
  analysisDate: string,
): number | null {
  if (entries.length === 0) return null;

  const chosen =
    entries.find((e) => e.expiry === analysisDate) ??
    entries
      .filter((e) => e.expiry >= analysisDate)
      .sort((a, b) => a.expiry.localeCompare(b.expiry))[0];

  if (!chosen) return null;

  const strike = Number.parseFloat(chosen.max_pain);
  return Number.isNaN(strike) ? null : strike;
}

/**
 * Historical max-pain path. Pulls raw per-strike OI for the given date
 * from `oi_per_strike` and runs the pure `computeMaxPain` helper.
 *
 * Returns `null` when the table has no rows for the date (an expected
 * case for backfill gaps or pre-cron dates) or when the DB call fails
 * (logged + captured, but we degrade to null rather than 500).
 */
async function computeHistoricalMaxPain(
  date: string,
): Promise<{ maxPain: number | null; source: MaxPainCurrentSource }> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT strike, call_oi, put_oi
      FROM oi_per_strike
      WHERE date = ${date}
    `) as OiPerStrikeRow[];

    if (rows.length === 0) {
      return { maxPain: null, source: 'historical-empty' };
    }

    const strikes = rows.map((r) => ({
      strike: Number.parseFloat(String(r.strike)),
      callOi: Number.parseInt(String(r.call_oi), 10) || 0,
      putOi: Number.parseInt(String(r.put_oi), 10) || 0,
    }));

    const maxPain = computeMaxPain(strikes);
    return { maxPain, source: 'historical' };
  } catch (err) {
    // Max-pain is advisory — never throw. Log + capture so the gap is
    // visible, but the hook still gets a well-shaped 200 response.
    Sentry.captureException(err);
    logger.warn({ err, date }, 'max-pain-current: historical DB query failed');
    return { maxPain: null, source: 'historical' };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/max-pain-current');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwner(req, res)) return;

    const parsed = maxPainCurrentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }
    const { date: requestedDate } = parsed.data;

    const asOf = new Date().toISOString();
    const today = getETDateStr(new Date());
    const isHistorical = requestedDate !== undefined && requestedDate !== today;

    try {
      if (isHistorical) {
        const { maxPain, source } =
          await computeHistoricalMaxPain(requestedDate);
        const response: MaxPainCurrentResponse = {
          ticker: TICKER,
          maxPain,
          asOf,
          source,
        };
        setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
        return res.status(200).json(response);
      }

      // Live path (no date or date == today).
      const apiKey = process.env.UW_API_KEY ?? '';
      const outcome = await fetchMaxPain(apiKey, today);

      let maxPain: number | null = null;
      if (outcome.kind === 'ok') {
        maxPain = resolveMaxPainStrike(outcome.data, today);
      } else if (outcome.kind === 'error') {
        // fetchMaxPain already logged + captured the error; we just
        // degrade to null so the frontend can render its empty state.
        logger.warn(
          { reason: outcome.reason },
          'max-pain-current: upstream UW fetch failed',
        );
      }

      const response: MaxPainCurrentResponse = {
        ticker: TICKER,
        maxPain,
        asOf,
        source: 'live',
      };
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      return res.status(200).json(response);
    } catch (err) {
      // Unexpected failure (out-of-band from fetchMaxPain / DB helper).
      // Preserve the never-throw contract: log to Sentry, return null.
      Sentry.captureException(err);
      logger.error({ err }, 'max-pain-current unexpected error');
      const fallback: MaxPainCurrentResponse = {
        ticker: TICKER,
        maxPain: null,
        asOf,
        source: isHistorical ? 'historical' : 'live',
      };
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      return res.status(200).json(fallback);
    }
  });
}
