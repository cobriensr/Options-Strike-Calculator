/**
 * GET /api/periscope-map
 *
 * Deterministic Periscope "trader's map" served directly from
 * `gexbot_api_capture` at 1-min cadence. No Claude. No scraper.
 *
 * Replaces the Claude auto-playbook pipeline for the live MM Exposure
 * panel. The historical lookup path (`/api/periscope-exposure?date=...`)
 * stays — periscope_snapshots has the full ~6-month history that
 * GEXBot capture only covers from 2026-05-16 forward.
 *
 * Pipeline:
 *   1. Read latest gexbot_api_capture rows for SPX state/{gamma,charm,vanna}_zero
 *   2. Read prior captures from ~10 min before latest (for sign-flip detection
 *      and per-strike delta semantics in the existing view-builder)
 *   3. Decode mini_contracts -> PeriscopeRow[]
 *   4. Build PeriscopeSlot for latest + prior
 *   5. fetchSpxSpot(today) for the spot anchor
 *   6. fetchConeLevels + fetchConeBreaches (nullable; cone may not exist yet)
 *   7. computePeriscopeView() — same pure builder the analyze prompt uses
 *   8. Return { marketOpen, asOf, data, reason, availableSlots: [] }
 *
 * Response shape matches /api/periscope-exposure so the existing
 * usePeriscopeExposure hook can swap source URLs without further changes.
 *
 * Auth: owner or guest (same as /api/periscope-exposure — Periscope data
 * is not Anthropic-gated).
 *
 * Spec: docs/superpowers/specs/periscope-analyzer-build-2026-05-21.md
 *   — this is the MVP of that build. Full analyzer + structure
 *   recommendations are a follow-up.
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setCacheHeaders, isMarketOpen } from './_lib/api-helpers.js';
import { guardOwnerOrGuestEndpoint } from './_lib/guest-auth.js';
import { getDb, withDbRetry } from './_lib/db.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import {
  computePeriscopeView,
  fetchConeLevels,
  fetchConeBreaches,
  type PeriscopeSlot,
  type PeriscopeRow,
  type PeriscopeView,
} from './_lib/periscope-format.js';
import { fetchAvailableSlots, fetchSpxSpot } from './_lib/periscope-query.js';
import { getETDateStr } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';
import {
  PANELS,
  PANEL_TO_CATEGORY,
  PRIOR_LOOKBACK_FLOOR_MIN,
  PRIOR_LOOKBACK_MIN,
  STALENESS_CUTOFF_MS,
  TICKER,
  decodeStrikes,
  type GexbotStatePayload,
  type PanelName,
} from './_lib/periscope-gexbot.js';

/**
 * Fetch the latest gexbot_api_capture row per panel within the
 * staleness window. Returns null when any panel has no fresh row.
 */
async function fetchLatestGexbotSlot(
  date: string,
): Promise<PeriscopeSlot | null> {
  const sql = getDb();
  const stalenessCutoff = new Date(
    Date.now() - STALENESS_CUTOFF_MS,
  ).toISOString();

  const panelRows: Record<PanelName, PeriscopeRow[] | null> = {
    gamma: null,
    charm: null,
    vanna: null,
  };
  let latestCapturedAt: Date | null = null;

  for (const panel of PANELS) {
    const category = PANEL_TO_CATEGORY[panel];
    const rows = (await withDbRetry(
      () => sql`
        SELECT captured_at, raw_response
        FROM gexbot_api_capture
        WHERE ticker = ${TICKER}
          AND endpoint = 'state'
          AND category = ${category}
          AND captured_at >= ${stalenessCutoff}
        ORDER BY captured_at DESC
        LIMIT 1
      `,
    )) as { captured_at: Date | string; raw_response: unknown }[];

    if (rows.length === 0) {
      // Surface which panel was stale so on-call can find the gap fast.
      logger.warn(
        { panel, ticker: TICKER, stalenessCutoff },
        'periscope-map: no fresh gexbot row for panel — returning no_slot',
      );
      return null;
    }
    const row = rows[0]!;
    const ts = new Date(row.captured_at);
    if (latestCapturedAt == null || ts > latestCapturedAt) {
      latestCapturedAt = ts;
    }
    panelRows[panel] = decodeStrikes(row.raw_response as GexbotStatePayload);
  }

  if (
    latestCapturedAt == null ||
    panelRows.gamma == null ||
    panelRows.charm == null ||
    panelRows.vanna == null
  ) {
    return null;
  }

  return {
    capturedAt: latestCapturedAt.toISOString(),
    expiry: date,
    gamma: panelRows.gamma,
    charm: panelRows.charm,
    vanna: panelRows.vanna,
  };
}

/**
 * Fetch the most recent gexbot row per panel at-or-before
 * (latest - PRIOR_LOOKBACK_MIN). Used as the "prior slice" for
 * sign-flip detection. Returns null if no qualifying rows exist
 * (e.g. cron just started for the day).
 */
async function fetchPriorGexbotSlot(
  date: string,
  latestCapturedAt: string,
): Promise<PeriscopeSlot | null> {
  const sql = getDb();
  const latestMs = new Date(latestCapturedAt).getTime();
  const priorCutoff = new Date(
    latestMs - PRIOR_LOOKBACK_MIN * 60_000,
  ).toISOString();
  const priorFloor = new Date(
    latestMs - PRIOR_LOOKBACK_FLOOR_MIN * 60_000,
  ).toISOString();

  const panelRows: Record<PanelName, PeriscopeRow[] | null> = {
    gamma: null,
    charm: null,
    vanna: null,
  };
  let priorCapturedAt: Date | null = null;

  for (const panel of PANELS) {
    const category = PANEL_TO_CATEGORY[panel];
    const rows = (await withDbRetry(
      () => sql`
        SELECT captured_at, raw_response
        FROM gexbot_api_capture
        WHERE ticker = ${TICKER}
          AND endpoint = 'state'
          AND category = ${category}
          AND captured_at <= ${priorCutoff}
          AND captured_at >= ${priorFloor}
        ORDER BY captured_at DESC
        LIMIT 1
      `,
    )) as { captured_at: Date | string; raw_response: unknown }[];

    if (rows.length === 0) return null;
    const row = rows[0]!;
    const ts = new Date(row.captured_at);
    if (priorCapturedAt == null || ts > priorCapturedAt) {
      priorCapturedAt = ts;
    }
    panelRows[panel] = decodeStrikes(row.raw_response as GexbotStatePayload);
  }

  if (
    priorCapturedAt == null ||
    panelRows.gamma == null ||
    panelRows.charm == null ||
    panelRows.vanna == null
  ) {
    return null;
  }

  return {
    capturedAt: priorCapturedAt.toISOString(),
    expiry: date,
    gamma: panelRows.gamma,
    charm: panelRows.charm,
    vanna: panelRows.vanna,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const done = metrics.request('/api/periscope-map');

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  try {
    Sentry.setTag('route', '/api/periscope-map');
    const marketOpen = isMarketOpen();
    const date = getETDateStr(new Date()); // today CT

    // Cache: edge 30s live / 300s after-hours, SWR 30s live / 60s after-hours.
    // Panel polls at POLL_INTERVALS.PERISCOPE (60s) so the cache + SWR keeps
    // the worst-case rendered staleness around 30-90s even with the cache layer.
    setCacheHeaders(res, marketOpen ? 30 : 300, marketOpen ? 30 : 60);

    // Available slots backs the prev/next stepper. The stepper is meant
    // for historical replay (date picker active) — for live mode we still
    // return the day's slots so the user can step back into history without
    // first manually changing the date selector.
    const availableSlots = await fetchAvailableSlots(date);

    const latest = await fetchLatestGexbotSlot(date);
    if (latest == null) {
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data: null,
        reason: 'no_slot',
        availableSlots,
      });
      return;
    }

    const spot = await fetchSpxSpot(date, latest.capturedAt);
    if (spot == null) {
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data: null,
        reason: 'no_spot',
        availableSlots,
      });
      return;
    }

    const prior = await fetchPriorGexbotSlot(date, latest.capturedAt);
    const cone = await fetchConeLevels(date);
    const breaches = cone ? await fetchConeBreaches(date) : [];

    const view: PeriscopeView = computePeriscopeView({
      latest,
      prior,
      spot,
      cone,
      breaches,
    });

    // Staleness signal — `ageSec` is the gap between the gexbot capture
    // timestamp and now. The panel can render a "stale" badge once this
    // exceeds ~90s. `priorAvailable` tells the panel whether sign-flip
    // detection had a valid prior slice (false during the first ~10
    // minutes of session).
    const ageSec = Math.round(
      (Date.now() - new Date(latest.capturedAt).getTime()) / 1000,
    );

    done({ status: 200 });
    res.status(200).json({
      marketOpen,
      asOf: new Date().toISOString(),
      data: view,
      ageSec,
      priorAvailable: prior != null,
      availableSlots,
    });
  } catch (error) {
    done({ status: 500, error: 'unhandled' });
    sendDbErrorResponse(res, error, {
      label: 'periscope_map',
      serverErrorBody: { error: 'Internal server error' },
    });
  }
}
