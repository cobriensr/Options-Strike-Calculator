/**
 * GET /api/gex-per-strike
 *
 * Returns 0DTE per-strike GEX (gamma exposure) data for the dashboard.
 * Data is populated by the backfill-gex-0dte script. A dedicated cron
 * for live intraday population is planned (currently fetch-strike-exposure
 * writes to the separate strike_exposures table at 5-min intervals).
 * The frontend polls this every 60 seconds.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  — return data for a specific date (default: today ET)
 *
 * Returns the latest available snapshot for the given date, with all
 * strikes sorted ascending. Each strike includes OI-based and
 * directionalized gamma, charm, delta, and vanna exposure.
 *
 * Owner-gated — Greek exposure derives from UW API (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { rejectIfNotOwner } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gex-per-strike');

    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'GET only' });
      }

      if (rejectIfNotOwner(req, res)) return;

      const sql = getDb();

      const dateParam = req.query.date as string | undefined;
      const date =
        dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
          ? dateParam
          : new Date().toLocaleDateString('en-CA', {
              timeZone: 'America/New_York',
            });

      // Optional time filter: "HH:MM" in CT → find closest snapshot at/before
      const timeParam = req.query.time as string | undefined;
      const hasTime = timeParam && /^\d{2}:\d{2}$/.test(timeParam);

      let tsRows;
      if (hasTime) {
        // Convert CT time to UTC via Postgres timezone conversion
        const localTs = `${date} ${timeParam}:00`;
        tsRows = await sql`
          SELECT MAX(timestamp) AS latest_ts
          FROM gex_strike_0dte
          WHERE date = ${date}
            AND timestamp <= (${localTs}::timestamp AT TIME ZONE 'America/Chicago')
        `;
      }

      // Fall back to latest snapshot if time filter matched nothing (e.g. backfill has one snapshot/day)
      if (!tsRows?.[0]?.latest_ts) {
        tsRows = await sql`
          SELECT MAX(timestamp) AS latest_ts
          FROM gex_strike_0dte
          WHERE date = ${date}
        `;
      }

      const latestTs = tsRows[0]?.latest_ts;
      if (!latestTs) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ strikes: [], date, timestamp: null });
      }

      // Fetch all strikes at that timestamp
      const rows = await sql`
        SELECT strike, price,
               call_gamma_oi, put_gamma_oi,
               call_gamma_vol, put_gamma_vol,
               call_gamma_ask, call_gamma_bid,
               put_gamma_ask, put_gamma_bid,
               call_charm_oi, put_charm_oi,
               call_charm_vol, put_charm_vol,
               call_delta_oi, put_delta_oi,
               call_vanna_oi, put_vanna_oi,
               call_vanna_vol, put_vanna_vol,
               timestamp
        FROM gex_strike_0dte
        WHERE date = ${date} AND timestamp = ${latestTs}
        ORDER BY strike ASC
      `;

      const n = (v: unknown) => Number(v) || 0;

      const strikes = rows.map((r) => {
        const callGammaOi = n(r.call_gamma_oi);
        const putGammaOi = n(r.put_gamma_oi);
        const callGammaVol = n(r.call_gamma_vol);
        const putGammaVol = n(r.put_gamma_vol);
        const netGammaOi = callGammaOi + putGammaOi;
        const netGammaVol = callGammaVol + putGammaVol;
        const callCharmOi = n(r.call_charm_oi);
        const putCharmOi = n(r.put_charm_oi);
        const callCharmVol = n(r.call_charm_vol);
        const putCharmVol = n(r.put_charm_vol);
        const callVannaOi = n(r.call_vanna_oi);
        const putVannaOi = n(r.put_vanna_oi);
        const callVannaVol = n(r.call_vanna_vol);
        const putVannaVol = n(r.put_vanna_vol);

        // Vol vs OI reinforcement: same sign = today's flow supports the level
        let volReinforcement: 'reinforcing' | 'opposing' | 'neutral' =
          'neutral';
        if (netGammaOi !== 0 && netGammaVol !== 0) {
          const sameSign =
            (netGammaOi > 0 && netGammaVol > 0) ||
            (netGammaOi < 0 && netGammaVol < 0);
          volReinforcement = sameSign ? 'reinforcing' : 'opposing';
        }

        return {
          strike: Number(r.strike),
          price: Number(r.price),
          // Gamma — OI
          callGammaOi,
          putGammaOi,
          netGamma: netGammaOi,
          // Gamma — volume
          callGammaVol,
          putGammaVol,
          netGammaVol,
          volReinforcement,
          // Gamma — directionalized (bid/ask)
          callGammaAsk: n(r.call_gamma_ask),
          callGammaBid: n(r.call_gamma_bid),
          putGammaAsk: n(r.put_gamma_ask),
          putGammaBid: n(r.put_gamma_bid),
          // Charm — OI
          callCharmOi,
          putCharmOi,
          netCharm: callCharmOi + putCharmOi,
          // Charm — volume
          callCharmVol,
          putCharmVol,
          netCharmVol: callCharmVol + putCharmVol,
          // Delta (OI only — no vol variant from UW)
          callDeltaOi: n(r.call_delta_oi),
          putDeltaOi: n(r.put_delta_oi),
          netDelta: n(r.call_delta_oi) + n(r.put_delta_oi),
          // Vanna — OI
          callVannaOi,
          putVannaOi,
          netVanna: callVannaOi + putVannaOi,
          // Vanna — volume
          callVannaVol,
          putVannaVol,
          netVannaVol: callVannaVol + putVannaVol,
        };
      });

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ strikes, date, timestamp: latestTs });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'gex-per-strike fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
