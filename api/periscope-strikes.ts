/**
 * GET /api/periscope-strikes
 *
 * Returns raw per-strike MM-attributed gamma + charm values for the
 * picked (date, time) slot — used by the GEX Landscape panel after the
 * SPX-only MM-data swap (docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md).
 *
 * vs. /api/periscope-exposure: that endpoint returns the formatted Top-N
 * + cone + breaches for the analyze-prompt-shaped panel. This endpoint
 * returns the FULL per-strike grid the Landscape's ±50pt table needs,
 * joined gamma + charm per strike, plus the slot list for the scrub
 * controls.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  CT trading date. Defaults to today's CT date.
 *   ?time=HH:MM       CT wall clock. With date, resolves to the latest
 *                     slot at-or-before (date, time). Omitted = latest.
 *   ?spot=...         Optional fresher SPX spot override.
 *
 * Cache:
 *   Live (no date/time): 30s + 30s during RTH, 300s + 60s after hours
 *   Picked slot: 300s + 60s — historical, immutable
 *
 * Auth: owner OR guest — same policy as /api/periscope-exposure.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  setCacheHeaders,
  isMarketOpen,
  guardOwnerOrGuestEndpoint,
} from './_lib/api-helpers.js';
import {
  fetchLatestPeriscopeSlot,
  fetchPriorPeriscopeSlot,
  type PeriscopeRow,
} from './_lib/periscope-format.js';
import {
  DATE_RE,
  TIME_RE,
  endOfMinute,
  fetchAvailableSlots,
  fetchSpxSpot,
} from './_lib/periscope-query.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { ctWallClockToUtcIso, getETDateStr } from '../src/utils/timezone.js';

export interface PeriscopeStrikeRow {
  strike: number;
  gamma: number;
  charm: number;
}

/**
 * Merge gamma + charm arrays into per-strike rows. A strike present in
 * only one panel produces a row with 0 for the missing greek so the
 * consumer's table grid stays stable.
 */
export function mergeStrikes(
  gamma: ReadonlyArray<PeriscopeRow>,
  charm: ReadonlyArray<PeriscopeRow>,
): PeriscopeStrikeRow[] {
  const byStrike = new Map<number, PeriscopeStrikeRow>();
  for (const g of gamma) {
    byStrike.set(g.strike, { strike: g.strike, gamma: g.value, charm: 0 });
  }
  for (const c of charm) {
    const existing = byStrike.get(c.strike);
    if (existing) {
      existing.charm = c.value;
    } else {
      byStrike.set(c.strike, { strike: c.strike, gamma: 0, charm: c.value });
    }
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/periscope-strikes');
    const done = metrics.request('/api/periscope-strikes');
    try {
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const marketOpen = isMarketOpen();

      const dateParam = (req.query.date as string | undefined) ?? '';
      const timeParam = (req.query.time as string | undefined) ?? '';
      const isHistoricalRead = dateParam !== '' || timeParam !== '';

      let date: string;
      if (dateParam === '') {
        date = getETDateStr(new Date());
      } else if (DATE_RE.test(dateParam)) {
        date = dateParam;
      } else {
        done({ status: 400, error: 'bad_date' });
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }

      let asOf: string | undefined;
      if (timeParam !== '') {
        if (!TIME_RE.test(timeParam)) {
          done({ status: 400, error: 'bad_time' });
          return res.status(400).json({ error: 'time must be HH:MM (CT)' });
        }
        const [hStr, mStr] = timeParam.split(':');
        const minutes = Number(hStr) * 60 + Number(mStr);
        const iso = ctWallClockToUtcIso(date, minutes);
        if (iso == null) {
          done({ status: 400, error: 'bad_datetime' });
          return res
            .status(400)
            .json({ error: 'could not resolve date/time to UTC' });
        }
        // Round UP to end-of-minute so a slot whose captured_at is
        // HH:MM:48.478Z is INCLUDED when the user picks HH:MM. Mirrors
        // the periscope-exposure handler's behavior so the same scrub
        // semantics apply across both endpoints.
        asOf = endOfMinute(iso);
      } else if (dateParam !== '') {
        const iso = ctWallClockToUtcIso(date, 23 * 60 + 59);
        if (iso == null) {
          done({ status: 400, error: 'bad_date' });
          return res.status(400).json({ error: 'could not resolve date' });
        }
        asOf = endOfMinute(iso);
      }

      if (isHistoricalRead) {
        setCacheHeaders(res, 300, 60);
      } else {
        setCacheHeaders(res, marketOpen ? 30 : 300, marketOpen ? 30 : 60);
      }

      const spotParam = (req.query.spot as string | undefined) ?? '';
      const spotFromQuery = Number.parseFloat(spotParam);
      const spot: number | null =
        Number.isFinite(spotFromQuery) && spotFromQuery > 0
          ? spotFromQuery
          : await fetchSpxSpot(date, asOf);

      const availableSlots = await fetchAvailableSlots(date);

      const slot = await fetchLatestPeriscopeSlot(date, asOf);
      if (slot == null) {
        done({ status: 200 });
        return res.status(200).json({
          marketOpen,
          asOf: new Date().toISOString(),
          capturedAt: null,
          priorCapturedAt: null,
          spot,
          strikes: [],
          availableSlots,
        });
      }

      const prior = await fetchPriorPeriscopeSlot(date, slot.capturedAt);

      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        capturedAt: slot.capturedAt,
        priorCapturedAt: prior?.capturedAt ?? null,
        spot,
        strikes: mergeStrikes(slot.gamma, slot.charm),
        availableSlots,
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      logger.error({ err: error }, '/api/periscope-strikes handler failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
