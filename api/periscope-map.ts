/**
 * GET /api/periscope-map
 *
 * Deterministic Periscope "trader's map" served directly from
 * `gexbot_api_capture` at 1-min cadence. No Claude. No scraper.
 *
 * Replaces the Claude auto-playbook pipeline for the live Periscope
 * Exposure panel. The historical lookup path (`/api/periscope-exposure?date=...`)
 * stays — periscope_snapshots has the full ~6-month history that
 * GEXBot capture only covers from 2026-05-16 forward.
 *
 * Pipeline:
 *   1. Pick the session and the bound on each panel read. Every read stays
 *      inside one session, so a row from another session never shows under
 *      this one's label.
 *      - Market closed: the session is the one `getClosedSpxBound` reads off
 *        the newest capture (a weekend, a holiday and the pre-open all read
 *        the last session). A panel's row is the newest at or before the SPX
 *        anchor, its last real capture of the session, and after ET midnight.
 *        No SPX anchor, or an empty table, is `no_slot`.
 *      - Market open: today, and the newest row within STALENESS_CUTOFF_MS.
 *      A bounded read ends after its upper bound's whole millisecond
 *      (`< upper + 1 ms`): `captured_at` is `now()` and keeps microseconds
 *      while the bound travels as a millisecond ISO string.
 *   2. Read the row per panel for SPX state/{gamma,charm,vanna}_zero
 *   3. Read prior captures from ~10 min before latest (for sign-flip detection
 *      and per-strike delta semantics in the existing view-builder)
 *   4. Decode mini_contracts -> PeriscopeRow[], in GEXBot's own
 *      taker-side sign (never negated: owner decision D1 revised). Not
 *      market-maker positions, unlike the UW-scraper slices that
 *      /api/periscope-exposure still replays from before 2026-05-26
 *   5. Build PeriscopeSlot for latest + prior
 *   6. fetchSpxSpot(session date, capture time) for the spot anchor
 *   7. fetchConeLevels + fetchConeBreaches on the session date (nullable;
 *      cone may not exist yet)
 *   8. computePeriscopeView() — same pure builder the analyze prompt uses
 *   9. Return { marketOpen, asOf, data, reason, availableSlots }
 *
 * Every date the reads use is the session date: the slot list, the `expiry`
 * stamp, the spot, the cone and its breaches.
 *
 * `asOf` is a capture time on every path: the freshest panel's `captured_at`
 * for a reply with data or `no_spot`, and null for `no_slot` (no capture backs
 * it).
 *
 * Response shape matches /api/periscope-exposure so the existing
 * usePeriscopeExposure hook can swap source URLs without further changes.
 *
 * Auth: owner or guest (same as /api/periscope-exposure — Periscope data
 * is not Anthropic-gated).
 *
 * Cache, chosen per response once its kind is known (an error sets none):
 *   - market closed (any body): `setClosedReadCache`
 *     (`_lib/live-read-cache.ts`). Nothing new lands after the close, so the
 *     response lives as long as is safe: it ends before the client's final
 *     fetch (close + 3 min) and before the next open.
 *   - market open: `setLiveReadCache` (same file, shared with the other
 *     Periscope readers): 10 s edge, no stale reuse.
 *
 * Spec: docs/superpowers/specs/periscope-analyzer-build-2026-05-21.md
 *   — this is the MVP of that build. Full analyzer + structure
 *   recommendations are a follow-up.
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isMarketOpen } from './_lib/api-helpers.js';
import {
  setClosedReadCache,
  setLiveReadCache,
} from './_lib/live-read-cache.js';
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
import {
  getClosedSpxBound,
  readPanelRowInBound,
  type CaptureRow,
  type PanelBound,
} from './_lib/closed-spx-bound.js';
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
 * Fetch the latest gexbot_api_capture row per panel: the newest inside
 * `bound` (the closed market's last session, up to the SPX anchor), or the
 * newest within the staleness window when `bound` is null (in session).
 * `date` is the session date the slot is stamped with. Returns null when any
 * panel has no qualifying row.
 *
 * A bounded read has no staleness floor (a closed market's last capture is
 * hours old); its lower bound, ET midnight of the session, is what keeps an
 * earlier session's row from showing under this session's label.
 */
async function fetchLatestGexbotSlot(
  date: string,
  bound: PanelBound | null,
): Promise<PeriscopeSlot | null> {
  const sql = getDb();
  // Only an in-session read has a staleness floor (see the doc above).
  const stalenessCutoff =
    bound == null
      ? new Date(Date.now() - STALENESS_CUTOFF_MS).toISOString()
      : null;

  const panelRows: Record<PanelName, PeriscopeRow[] | null> = {
    gamma: null,
    charm: null,
    vanna: null,
  };
  let latestCapturedAt: Date | null = null;

  for (const panel of PANELS) {
    let row: CaptureRow | undefined;
    if (bound != null) {
      row = await readPanelRowInBound(panel, bound);
    } else {
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
      )) as CaptureRow[];
      row = rows[0];
    }

    if (row === undefined) {
      // Surface which panel had no row so on-call can find the gap fast.
      logger.warn(
        {
          panel,
          ticker: TICKER,
          ...(bound != null ? { bound } : { stalenessCutoff }),
        },
        'periscope-map: no qualifying gexbot row for panel — returning no_slot',
      );
      return null;
    }
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
 *
 * The window is 10 to 30 minutes before `latestCapturedAt`
 * (PRIOR_LOOKBACK_MIN to PRIOR_LOOKBACK_FLOOR_MIN) and has no ET-midnight lower
 * bound of its own. It cannot reach the previous session only because captures
 * land in regular trading hours: a latest capture is hours past midnight, so
 * the whole window stays inside the same ET day. A capture stamped within 30
 * minutes of ET midnight would pull in the evening before.
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
    )) as CaptureRow[];

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

/**
 * What a request reads: the session date, and how its panels are bounded.
 * `closed` (the market is closed) picks the cache rule.
 */
type ReadPlan =
  | {
      closed: boolean;
      kind: 'read';
      date: string;
      /** null: a live in-session read, held to the staleness window. */
      bound: PanelBound | null;
    }
  // The market is closed and there is no SPX anchor to read up to. `date` is
  // the session the table's newest row is on, or null when the table is empty.
  | { closed: true; kind: 'no_slot'; date: string | null };

/**
 * Decide the session a request reads and how each panel read is bounded: today
 * in session, the last session's SPX anchor when the market is closed. See the
 * pipeline notes in the file header.
 */
async function planRead(marketOpen: boolean, now: Date): Promise<ReadPlan> {
  if (marketOpen) {
    return {
      closed: false,
      kind: 'read',
      date: getETDateStr(now),
      bound: null,
    };
  }
  return { closed: true, ...(await getClosedSpxBound('periscope-map')) };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const done = metrics.request('/api/periscope-map');

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  try {
    Sentry.setTag('route', '/api/periscope-map');
    // One clock reading per request, handed to the closed cache rule so its
    // close and open checks see a single instant. `isMarketOpen()` takes no
    // date and reads its own clock a moment later.
    const now = new Date();
    const marketOpen = isMarketOpen();

    const plan = await planRead(marketOpen, now);

    // Cache headers are set on each success path below, not up front, so an
    // error reply carries none.
    const setCache = (hasData: boolean): void => {
      if (plan.closed) {
        setClosedReadCache(res, now);
      } else {
        setLiveReadCache(res, { historical: false, hasData, marketOpen });
      }
    };

    // Available slots backs the prev/next stepper. The stepper is meant
    // for historical replay (date picker active) — for live mode we still
    // return the day's slots so the user can step back into history without
    // first manually changing the date selector. With no session date (a
    // closed market with an empty table) there are none to list.
    const availableSlots =
      plan.date === null ? [] : await fetchAvailableSlots(plan.date);

    // With no SPX anchor there is nothing to read up to, so no panel is read.
    const latest =
      plan.kind === 'read'
        ? await fetchLatestGexbotSlot(plan.date, plan.bound)
        : null;
    if (plan.kind !== 'read' || latest == null) {
      setCache(false);
      done({ status: 200 });
      // No capture backs this reply, so `asOf` is null.
      res.status(200).json({
        marketOpen,
        asOf: null,
        data: null,
        reason: 'no_slot',
        availableSlots,
      });
      return;
    }

    const spot = await fetchSpxSpot(plan.date, latest.capturedAt);
    if (spot == null) {
      setCache(false);
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: latest.capturedAt,
        data: null,
        reason: 'no_spot',
        availableSlots,
      });
      return;
    }

    const prior = await fetchPriorGexbotSlot(plan.date, latest.capturedAt);
    const cone = await fetchConeLevels(plan.date);
    const breaches = cone ? await fetchConeBreaches(plan.date) : [];

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

    setCache(true);
    done({ status: 200 });
    res.status(200).json({
      marketOpen,
      asOf: latest.capturedAt,
      data: view,
      ageSec,
      priorAvailable: prior != null,
      availableSlots,
    });
  } catch (error) {
    sendDbErrorResponse(res, error, {
      label: 'periscope_map',
      serverErrorBody: { error: 'Internal server error' },
      done,
    });
  }
}
