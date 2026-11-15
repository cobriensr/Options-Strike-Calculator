/**
 * GET /api/regime-0dte
 *
 * Live intraday SPX 0DTE "gamma regime" read. Reads three existing Neon
 * tables for the target CT trading day — `gex_strike_0dte` (net GEX by strike
 * + spot, read at THREE anchor minutes: open / midday / latest),
 * `strike_iv_snapshots` (SPXW 0DTE nearest-ATM put IV series), and
 * `index_candles_1m` (30-min SPX candles) — and feeds them to the pure
 * evaluator `evaluateRegime0dte()`. Returns the graded gamma gate (anchored on
 * the OPEN profile — the stable morning regime) plus the three down-only
 * triggers (mostly-red, IV-surface-break, midday deep-neg). The per-strike viz
 * series is the CURRENT (latest-minute) profile.
 *
 * The handler is a thin orchestrator: Zod-parse `?date?` (default CT today)
 * → read the three anchored profiles + IV/candle series via
 * `regime-0dte-queries` → derive `nowCtMin` (live CT clock for today; cash
 * close for a replayed past date) → evaluate → JSON. All I/O lives in
 * `regime-0dte-queries`; all logic in the pure evaluator. Mirrors
 * `api/opening-flow-signal.ts`.
 *
 * Wrapped in `withDbReader`: the wrapper owns the Sentry scope, the request
 * metric, the 405 gate, the owner-or-guest + botid guard, and the error
 * mapping. The queries retry through `withDbRetry`, so a brief Neon outage
 * ends as a quiet 503 + `Retry-After` (no Sentry event) and only a genuine
 * error is a 500 that pages.
 *
 * Auth: owner-or-guest (no Anthropic spend), same gating as opening-flow-signal.
 *
 * Spec: docs/superpowers/specs/2026-06-07-regime-0dte-panel-design.md
 * Plan: docs/superpowers/plans/2026-06-07-regime-0dte-panel.md (Task 6)
 * Fix:  docs/superpowers/specs/2026-11-15-regime-0dte-polling-and-db-errors.md
 */

import { z } from 'zod';
import { setCacheHeaders } from './_lib/api-helpers.js';
import { withDbReader } from './_lib/request-scope.js';
import { getCTDateStr, getCTTime } from '../src/utils/timezone.js';
import { evaluateRegime0dte, REGIME_0DTE } from './_lib/regime-0dte.js';
import {
  getGexStrikes,
  getPutIvSeries,
  getCandles30,
} from './_lib/regime-0dte-queries.js';

const querySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export default withDbReader(
  '/api/regime-0dte',
  'regime_0dte',
  'owner-or-guest',
  async (req, res, done) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      done({ status: 400 });
      res.status(400).json({
        error: 'invalid query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const now = new Date();
    const today = getCTDateStr(now);
    const dateIso = parsed.data.date ?? today;

    // "As of" clock. For TODAY, grade against the live CT wall clock so the
    // triggers' time-window gates (persistence at 11:00, IV-break window,
    // midday) reflect where we are in the session. For a REPLAYED past date the
    // live clock is meaningless — evaluate as-of the cash close (15:00 CT) so
    // every trigger has seen the full session, matching the nightly scorecard.
    let nowCtMin: number;
    if (dateIso < today) {
      nowCtMin = REGIME_0DTE.CLOSE_MIN;
    } else {
      const { hour, minute } = getCTTime(now);
      nowCtMin = hour * 60 + minute;
    }

    // Three TIME-CORRECT profiles: the OPEN profile (gate anchor), the MIDDAY
    // profile (midday re-measure), and the CURRENT/latest profile (the live
    // gexNearSpot read + the per-strike viz). The 0DTE gamma profile migrates
    // with spot, so a single snapshot can't serve all three roles.
    const [openProfile, middayProfile, currentProfile, putIv, candles30] =
      await Promise.all([
        getGexStrikes(dateIso, 'open'),
        getGexStrikes(dateIso, 'midday'),
        getGexStrikes(dateIso, 'latest'),
        getPutIvSeries(dateIso),
        getCandles30(dateIso),
      ]);

    const state = evaluateRegime0dte({
      nowCtMin,
      openProfile,
      middayProfile,
      currentProfile,
      putIv,
      candles30,
    });

    // 30s edge cache — the GEX/IV feeds refresh per-minute and the panel polls
    // every 45s, so brief reuse keeps the endpoint cheap without going stale.
    setCacheHeaders(res, 30, 30);
    done({ status: 200 });
    // Spread the graded scalars plus the raw series the rich panel renders:
    // the per-strike gamma profile, the put-IV sparkline, and the 30-min
    // candle strip. `bandPct` / `persistEndCtMin` are the gate-band and
    // persistence-cutoff constants the visuals draw their markers from.
    res.status(200).json({
      date: dateIso,
      ...state,
      // Viz series come from the CURRENT profile — the per-strike gamma map the
      // panel renders is the live one, even though the GATE is open-anchored.
      gexStrikes: currentProfile.strikes,
      spot: currentProfile.spot,
      putIv,
      candles30,
      bandPct: REGIME_0DTE.GATE_BAND_PCT,
      persistEndCtMin: REGIME_0DTE.PERSIST_END_MIN,
    });
  },
  // Never leak raw exception text (can carry DB connection strings / query
  // internals); Sentry + pino retain full detail server-side.
  { serverErrorBody: { error: 'Internal server error' } },
);
