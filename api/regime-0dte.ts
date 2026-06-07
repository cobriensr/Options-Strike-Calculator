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
 * The handler is a thin orchestrator: guard → Zod-parse `?date?` (default CT
 * today) → read the three anchored profiles + IV/candle series via
 * `regime-0dte-queries` → derive `nowCtMin` (live CT clock for today; cash
 * close for a replayed past date) → evaluate → JSON. All I/O lives in
 * `regime-0dte-queries`; all logic in the pure evaluator. Mirrors
 * `api/opening-flow-signal.ts`.
 *
 * Auth: owner-or-guest (no Anthropic spend), same gating as opening-flow-signal.
 *
 * Spec: docs/superpowers/specs/2026-06-07-regime-0dte-panel-design.md
 * Plan: docs/superpowers/plans/2026-06-07-regime-0dte-panel.md (Task 6)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
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
  } catch (err) {
    // Never leak raw exception text (can carry DB connection strings / query
    // internals); Sentry + pino retain full detail server-side.
    Sentry.captureException(err);
    logger.error({ err }, 'regime-0dte error');
    res.status(500).json({ error: 'Internal server error' });
  }
}
