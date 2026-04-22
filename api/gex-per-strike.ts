/**
 * GET /api/gex-per-strike
 *
 * Returns 0DTE per-strike GEX (gamma exposure) data for the dashboard.
 * Data is populated by the backfill-gex-0dte script and the
 * fetch-gex-0dte cron (1-minute cadence during market hours).
 * The frontend polls this every 60 seconds.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  — return data for a specific date (default: today ET)
 *   ?time=HH:MM       — return latest snapshot at/before this CT wall-clock time
 *   ?ts=<ISO>         — return the exact snapshot at this timestamp (used by
 *                       the frontend scrub controls). Takes precedence over
 *                       `time` when both are provided.
 *   ?window=<N>m      — additionally return every prior snapshot within the
 *                       last N minutes (1-15) as `windowSnapshots`. Powers
 *                       backtest-mode 5m Δ% computation in
 *                       `useFuturesGammaPlaybook` when scrubbed.
 *
 * Returns the strikes for the resolved snapshot plus `timestamps` — every
 * snapshot timestamp recorded for `date`, ascending. The frontend uses this
 * list to step backwards/forwards through snapshots without round-tripping
 * for a directory listing.
 *
 * Owner-gated — Greek exposure derives from UW API (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { rejectIfNotOwner } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

/** Clamp bounds for `?window=<N>m`. Matches spec futures-playbook-backtest-flow-2026-04-21.md. */
const WINDOW_MIN_MINUTES = 1;
const WINDOW_MAX_MINUTES = 15;

const WINDOW_PARAM_PATTERN = /^(\d+)m$/;

/**
 * Parse and clamp the `window` query param. Accepts strings like "5m";
 * returns the clamped integer minutes, or null when absent/malformed.
 * Out-of-range values are clamped rather than rejected — a trader asking
 * for 5h of history just gets WINDOW_MAX_MINUTES of history.
 */
function parseWindowMinutes(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const matched = WINDOW_PARAM_PATTERN.exec(raw);
  if (!matched) return null;
  const n = Number.parseInt(matched[1]!, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(WINDOW_MAX_MINUTES, Math.max(WINDOW_MIN_MINUTES, n));
}

/**
 * Shape a single `gex_strike_0dte` row into the client-facing per-strike
 * payload. Extracted so the primary-snapshot path and the optional
 * window-snapshots path (`?window=Nm`) emit identical field shapes and
 * stay in lockstep if the schema evolves.
 */
function mapRowToStrike(r: Record<string, unknown>) {
  const num = (v: unknown) => Number(v) || 0;
  const callGammaOi = num(r.call_gamma_oi);
  const putGammaOi = num(r.put_gamma_oi);
  const callGammaVol = num(r.call_gamma_vol);
  const putGammaVol = num(r.put_gamma_vol);
  const netGammaOi = callGammaOi + putGammaOi;
  const netGammaVol = callGammaVol + putGammaVol;
  const callCharmOi = num(r.call_charm_oi);
  const putCharmOi = num(r.put_charm_oi);
  const callCharmVol = num(r.call_charm_vol);
  const putCharmVol = num(r.put_charm_vol);
  const callVannaOi = num(r.call_vanna_oi);
  const putVannaOi = num(r.put_vanna_oi);
  const callVannaVol = num(r.call_vanna_vol);
  const putVannaVol = num(r.put_vanna_vol);

  // Vol vs OI reinforcement: same sign = today's flow supports the level
  let volReinforcement: 'reinforcing' | 'opposing' | 'neutral' = 'neutral';
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
    callGammaAsk: num(r.call_gamma_ask),
    callGammaBid: num(r.call_gamma_bid),
    putGammaAsk: num(r.put_gamma_ask),
    putGammaBid: num(r.put_gamma_bid),
    // Charm — OI
    callCharmOi,
    putCharmOi,
    netCharm: callCharmOi + putCharmOi,
    // Charm — volume
    callCharmVol,
    putCharmVol,
    netCharmVol: callCharmVol + putCharmVol,
    // Delta (OI only — no vol variant from UW)
    callDeltaOi: num(r.call_delta_oi),
    putDeltaOi: num(r.put_delta_oi),
    netDelta: num(r.call_delta_oi) + num(r.put_delta_oi),
    // Vanna — OI
    callVannaOi,
    putVannaOi,
    netVanna: callVannaOi + putVannaOi,
    // Vanna — volume
    callVannaVol,
    putVannaVol,
    netVannaVol: callVannaVol + putVannaVol,
  };
}

/**
 * Normalize a Postgres TIMESTAMPTZ value to an ISO 8601 string.
 *
 * The Neon serverless driver returns TIMESTAMPTZ columns as JavaScript Date
 * objects (when using the SQL template) or already-ISO strings (older paths).
 * Both forms must serialize identically across the response so the frontend
 * can compare `timestamp` against entries in `timestamps[]` for scrub navigation.
 */
function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  // Already a string from the driver — trust it but coerce a Date round-trip
  // when it parses, so Postgres-formatted "2026-04-07 19:54:00+00" gets
  // canonicalized to ISO 8601 too.
  const str = String(value);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString();
}

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

      // Optional exact-snapshot lookup (frontend scrub controls). ISO 8601
      // timestamps only — anything else is rejected so we never feed arbitrary
      // strings into the SQL parameter.
      const tsParam = req.query.ts as string | undefined;
      const hasTs =
        tsParam && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(tsParam);

      // Optional time filter: "HH:MM" in CT → find closest snapshot at/before
      const timeParam = req.query.time as string | undefined;
      const hasTime = timeParam && /^\d{2}:\d{2}$/.test(timeParam);

      let tsRows;
      if (hasTs) {
        // Verify the requested timestamp exists for this date so we never
        // return data from a mismatched session.
        tsRows = await sql`
          SELECT timestamp AS latest_ts
          FROM gex_strike_0dte
          WHERE date = ${date} AND timestamp = ${tsParam}
          LIMIT 1
        `;
      } else if (hasTime) {
        // Convert CT time to UTC via Postgres timezone conversion
        const localTs = `${date} ${timeParam}:00`;
        tsRows = await sql`
          SELECT MAX(timestamp) AS latest_ts
          FROM gex_strike_0dte
          WHERE date = ${date}
            AND timestamp <= (${localTs}::timestamp AT TIME ZONE 'America/Chicago')
        `;
      }

      // Fall back to latest snapshot if no filter matched (e.g. backfill has
      // one snapshot/day, or scrub ts no longer exists)
      if (!tsRows?.[0]?.latest_ts) {
        tsRows = await sql`
          SELECT MAX(timestamp) AS latest_ts
          FROM gex_strike_0dte
          WHERE date = ${date}
        `;
      }

      // List of every snapshot timestamp for the day — powers scrub navigation.
      // Cheap query; even a 1-min cron over an 8h session is ~480 rows.
      const timestampRows = await sql`
        SELECT DISTINCT timestamp
        FROM gex_strike_0dte
        WHERE date = ${date}
        ORDER BY timestamp ASC
      `;
      // Normalize to ISO 8601. Neon's serverless driver returns TIMESTAMPTZ
      // columns as JavaScript Date objects; `String(date)` produces a localized
      // string while JSON.stringify produces ISO 8601. The frontend uses
      // `timestamps.indexOf(timestamp)` to compute scrub bounds, so the two
      // payload fields must use identical formatting or the scrub controls
      // silently disable themselves.
      const timestamps = timestampRows
        .map((r) => toIso(r.timestamp))
        .filter((s): s is string => s != null);

      const latestTs = toIso(tsRows[0]?.latest_ts);
      if (!latestTs) {
        res.setHeader('Cache-Control', 'no-store');
        // Empty-day response shape must include `windowSnapshots: []` so
        // the frontend TypeScript type stays uniform across branches —
        // otherwise the happy-path renders a `WindowSnapshot[]` and the
        // empty-day branch renders `undefined`, forcing consumers to add
        // defensive `?? []` everywhere.
        return res.status(200).json({
          strikes: [],
          date,
          timestamp: null,
          timestamps,
          windowSnapshots: [],
        });
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

      const strikes = rows.map(mapRowToStrike);

      // Optional `?window=Nm` — fetch every prior snapshot within the window
      // before the target ts. Enables scrub-mode backtesting of per-strike
      // Δ% signals without maintaining a client-side rolling buffer (the
      // buffer is pruned on scrub by design; see the spec).
      const windowMinutes = parseWindowMinutes(req.query.window);
      let windowSnapshots: Array<{
        timestamp: string;
        strikes: ReturnType<typeof mapRowToStrike>[];
      }> = [];
      if (windowMinutes !== null) {
        const lowerBoundMs =
          new Date(latestTs).getTime() - windowMinutes * 60_000;
        const lowerBound = new Date(lowerBoundMs).toISOString();
        const windowRows = await sql`
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
          WHERE date = ${date}
            AND timestamp >= ${lowerBound}
            AND timestamp < ${latestTs}
          ORDER BY timestamp ASC, strike ASC
        `;
        // Group by timestamp preserving chronological order.
        const grouped = new Map<string, ReturnType<typeof mapRowToStrike>[]>();
        for (const r of windowRows) {
          const tsIso = toIso(r.timestamp);
          if (tsIso === null) continue;
          const mapped = mapRowToStrike(r);
          const existing = grouped.get(tsIso);
          if (existing) existing.push(mapped);
          else grouped.set(tsIso, [mapped]);
        }
        windowSnapshots = Array.from(grouped.entries()).map(
          ([timestamp, strikesAtTs]) => ({ timestamp, strikes: strikesAtTs }),
        );
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        strikes,
        date,
        timestamp: latestTs,
        timestamps,
        windowSnapshots,
      });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'gex-per-strike fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
