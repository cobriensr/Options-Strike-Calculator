/**
 * GET /api/regime-0dte
 *
 * Live intraday SPX 0DTE "gamma regime" read. Reads three existing Neon
 * tables for the target CT trading day — `gex_strike_0dte` (latest-minute net
 * GEX by strike + spot), `strike_iv_snapshots` (SPXW 0DTE nearest-ATM put IV
 * series), and `index_candles_1m` (30-min SPX candles) — and feeds them to the
 * pure evaluator `evaluateRegime0dte()`. Returns the graded gamma gate plus the
 * three down-only triggers (mostly-red, IV-surface-break, midday deep-neg).
 *
 * The handler is a thin orchestrator: guard → Zod-parse `?date?` (default CT
 * today) → read tables via `regime-0dte-queries` → derive `nowCtMin` from the
 * current CT wall clock and `openSpot` from the first candle/gex minute →
 * evaluate → JSON. All I/O lives in `regime-0dte-queries`; all logic in the
 * pure evaluator. Mirrors `api/opening-flow-signal.ts`.
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

    // Minutes from CT midnight for the live "as of" clock. For a replayed
    // historical date we still grade against the current wall clock so the
    // triggers' time-window gates (persistence at 11:00, IV-break window,
    // midday) behave as they would have intraday on that day.
    const { hour, minute } = getCTTime(now);
    const nowCtMin = hour * 60 + minute;

    const [gex, putIv, candles30] = await Promise.all([
      getGexStrikes(dateIso),
      getPutIvSeries(dateIso),
      getCandles30(dateIso),
    ]);

    // openSpot anchors the at-open GEX read and the flip-vs-open distance.
    // Prefer the first regular-session candle's open; fall back to the latest
    // gex-minute spot when candles haven't landed yet (early in the session).
    const firstCandle = candles30[0];
    const openSpot = firstCandle ? firstCandle.open : gex.spot;
    const spot = gex.spot ?? openSpot ?? 0;

    const state = evaluateRegime0dte({
      nowCtMin,
      spot,
      openSpot,
      gexStrikes: gex.strikes,
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
      gexStrikes: gex.strikes,
      spot: gex.spot,
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
