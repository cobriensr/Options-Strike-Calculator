/**
 * GET /api/opening-flow-signal
 *
 * Live evaluation of the V4 opening-flow rule for SPY and QQQ.
 * Reads `ws_option_trades` (streamed in real-time by the
 * uw-stream Railway service) for the 09:30–09:40 ET window and
 * returns:
 *   - the slice-1 ticket breakdown ($1M+ premium aggregates)
 *   - the slice-2 bias-side share
 *   - whether the V4 signal fires
 *   - the contract to trade (highest-volume bias-side ticket)
 *
 * The endpoint is window-aware: before 09:30 ET it returns
 * `windowStatus='before_open'` and an empty per-ticker payload;
 * during slice 1 it reports partial slice-1 results; after 09:40 ET
 * it returns the locked-in signal decision.
 *
 * Phase 2 of opening-flow-signal-historical-persistence-2026-05-19
 * extracted the actual evaluation into `evaluateOpeningFlow()` in
 * `_lib/opening-flow-evaluator.ts` so the same code path serves both
 * this endpoint and the capture cron. The handler is now a thin
 * wrapper: parse query → validate auth → invoke evaluator → JSON.
 *
 * Auth: owner-or-guest, same gating as lottery-contract-tape.
 *
 * Spec: docs/superpowers/specs/opening-flow-signal-2026-05-14.md
 *       docs/superpowers/specs/opening-flow-signal-historical-persistence-2026-05-19.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { openingFlowSignalQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';
import {
  evaluateOpeningFlow,
  InvalidTradingDateError,
} from './_lib/opening-flow-evaluator.js';
import { readOpeningFlowSnapshot } from './_lib/opening-flow-store.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = openingFlowSignalQuerySchema.safeParse(req.query);
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

    const requestedDate = parsed.data.date;
    const now = new Date();
    const today = getETDateStr(now);
    const targetDate = requestedDate ?? today;
    const isLive = !requestedDate || requestedDate === today;

    try {
      // Today / live → re-compute from raw trades so partial slice
      // progress and just-arrived prints are reflected. Historical →
      // read the cron-captured snapshot; fall back to live compute
      // only if the row is missing (date predates the capture cron
      // or a transient cron miss). The fallback may return an empty
      // payload once `ws_option_trades` has aged out past T+2, which
      // is the documented limit of the data path.
      let payload;
      if (isLive) {
        payload = await evaluateOpeningFlow(targetDate, { now });
      } else {
        const stored = await readOpeningFlowSnapshot(targetDate);
        payload = stored ?? (await evaluateOpeningFlow(targetDate, { now }));
      }
      // 15s CDN cache. Live data is fast-moving but the endpoint is
      // hot during the polling window — brief reuse keeps cost down.
      setCacheHeaders(res, 15, 15);
      res.status(200).json(payload);
    } catch (err) {
      if (err instanceof InvalidTradingDateError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'opening-flow-signal error');
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
