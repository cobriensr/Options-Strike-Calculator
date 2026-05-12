/**
 * GET /api/periscope-exposure
 *
 * Returns the UW Periscope MM-attributed exposure slot for the picked
 * (date, time) — defaulting to today's latest — plus straddle cone
 * bounds, breach events, and the list of available slot timestamps for
 * that date. Same data the analyze endpoint injects into Claude's
 * prompt, exposed as JSON for the frontend panel.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  CT trading date. Defaults to today's CT date.
 *   ?time=HH:MM       CT wall clock. With date, resolves to the latest
 *                     slot at-or-before (date, time). Omitted = latest
 *                     known slot for the date.
 *   ?spot=...         Optional fresher SPX spot override.
 *
 * Cache:
 *   Live (no date/time params): 30s edge + 30s SWR during RTH,
 *                               300s + 60s after hours.
 *   Picked slot: 300s + 60s — historical, immutable.
 *
 * Response shape:
 * {
 *   marketOpen: boolean,
 *   asOf: string (ISO),
 *   data: PeriscopeView | null,
 *   reason?: 'no_spot' | 'no_slot',
 *   availableSlots: string[],     // ISO captured_at, ascending
 * }
 *
 * Auth: owner OR guest (read-only data, same policy as /api/quotes
 * and /api/spy-darkpool-levels — Periscope data is not Anthropic-gated).
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  setCacheHeaders,
  isMarketOpen,
  guardOwnerOrGuestEndpoint,
} from './_lib/api-helpers.js';
import { buildPeriscopeView } from './_lib/periscope-format.js';
import type { PeriscopeView } from './_lib/periscope-format.js';
import {
  DATE_RE,
  TIME_RE,
  endOfMinute,
  fetchAvailableSlots,
  fetchSpxSpot,
} from './_lib/periscope-query.js';
import { getETDateStr, ctWallClockToUtcIso } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/periscope-exposure');
    const done = metrics.request('/api/periscope-exposure');
    try {
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const marketOpen = isMarketOpen();

      // Parse + validate optional date/time params.
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
        // HH:MM:48.478Z is INCLUDED when the user picks HH:MM. Without
        // this the at-or-before query skips the slot the user intended
        // and returns the prior one — which breaks the prev/next
        // stepper round-trip (HH:MM truncates seconds).
        asOf = endOfMinute(iso);
      } else if (dateParam !== '') {
        // Date without time → end-of-day for that CT date so the slot
        // resolution lands on the last slot of the day.
        const iso = ctWallClockToUtcIso(date, 23 * 60 + 59);
        if (iso == null) {
          done({ status: 400, error: 'bad_date' });
          return res.status(400).json({ error: 'could not resolve date' });
        }
        asOf = endOfMinute(iso);
      }

      // Cache: live reads get the short window; historical reads are
      // immutable so cache aggressively.
      if (isHistoricalRead) {
        setCacheHeaders(res, 300, 60);
      } else {
        setCacheHeaders(res, marketOpen ? 30 : 300, marketOpen ? 30 : 60);
      }

      // Spot can come from query param (when frontend has a fresher
      // value than the DB) or fall back to index_candles_1m, capped at
      // asOf so historical reads don't leak future spot.
      const spotParam = (req.query.spot as string | undefined) ?? '';
      const spotFromQuery = Number.parseFloat(spotParam);
      const spot: number | null =
        Number.isFinite(spotFromQuery) && spotFromQuery > 0
          ? spotFromQuery
          : await fetchSpxSpot(date, asOf);

      const availableSlots = await fetchAvailableSlots(date);

      if (spot == null) {
        // No spot at all — can't rank levels. Return marketOpen + null
        // data so the panel can show "waiting for SPX spot".
        done({ status: 200 });
        return res.status(200).json({
          marketOpen,
          asOf: new Date().toISOString(),
          data: null,
          reason: 'no_spot',
          availableSlots,
        });
      }

      const viewWithFormatterArgs = await buildPeriscopeView({
        date,
        expiry: date,
        spot,
        ...(asOf != null ? { asOf } : {}),
      });

      // Strip the internal _formatterArgs before serializing — those
      // carry the full per-strike row arrays which the panel doesn't
      // need (it only renders the ranked top-N already in the view).
      let data: PeriscopeView | null = null;
      if (viewWithFormatterArgs != null) {
        const view: PeriscopeView = {
          capturedAt: viewWithFormatterArgs.capturedAt,
          priorCapturedAt: viewWithFormatterArgs.priorCapturedAt,
          expiry: viewWithFormatterArgs.expiry,
          spot: viewWithFormatterArgs.spot,
          gamma: viewWithFormatterArgs.gamma,
          charm: viewWithFormatterArgs.charm,
          vanna: viewWithFormatterArgs.vanna,
          signFlips: viewWithFormatterArgs.signFlips,
          cone: viewWithFormatterArgs.cone,
          breaches: viewWithFormatterArgs.breaches,
        };
        data = view;
      }

      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data,
        reason: data == null ? 'no_slot' : undefined,
        availableSlots,
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      logger.error({ err: error }, '/api/periscope-exposure handler failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
