/**
 * GET /api/gex-landscape
 *
 * Per-strike MM gamma / charm / vanna rows served straight from
 * `gexbot_api_capture` at 1-min cadence, with each row carrying its own
 * `[t-1m, t-5m, t-10m]` prior values (extracted from position-4 of the
 * GEXBot `mini_contracts` payload — see `decodeStrikesWithHistory`).
 *
 * Replaces the 10-min `usePeriscopeStrikes` path the legacy GexLandscape
 * hook used. Phase 1 of the rebuild spec:
 *   docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md
 *
 * Pipeline:
 *   1. Resolve scrub `?at=ISO` → captured-at-or-before; malformed → fall
 *      back to "latest" (matches the project's permissive query handling).
 *   2. Read the latest gexbot row per panel (gamma_zero / charm_zero /
 *      vanna_zero) for SPX within STALENESS_CUTOFF_MS.
 *   3. Decode each panel via `decodeStrikesWithHistory()`.
 *   4. Join the three panels by strike. Missing scalar values default
 *      to 0 so client arithmetic doesn't have to null-guard; missing
 *      prev values stay null (source-of-truth).
 *   5. `fetchSpxSpot(date, capturedAt)` → spot anchor; null returns
 *      `data: null, reason: 'no_spot'`.
 *   6. Distinct minutes for SPX gamma_zero today → `availableMinutes`
 *      for the scrub stepper (one panel is enough — same cron writes all
 *      three at the same minute mark).
 *
 * Auth: owner OR guest (read-only). Identical to /api/periscope-map.
 * Cache: edge 30s live / 300s after-hours, SWR 30s live / 60s after-hours.
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setCacheHeaders, isMarketOpen } from './_lib/api-helpers.js';
import { guardOwnerOrGuestEndpoint } from './_lib/guest-auth.js';
import { getDb, withDbRetry } from './_lib/db.js';
import { DB_RETRY_ATTEMPTS, DB_RETRY_TIMEOUT_MS } from './_lib/constants.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import { fetchSpxSpot } from './_lib/periscope-query.js';
import { getETDateStr } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';
import {
  PANELS,
  PANEL_TO_CATEGORY,
  STALENESS_CUTOFF_MS,
  TICKER,
  decodeStrikesWithHistory,
  type DecodedStrikeWithHistory,
  type GexbotStatePayload,
  type PanelName,
} from './_lib/periscope-gexbot.js';

interface GexLandscapeStrike {
  strike: number;
  gamma: number;
  charm: number;
  vanna: number;
  gammaPrev1m: number | null;
  gammaPrev5m: number | null;
  gammaPrev10m: number | null;
  charmPrev1m: number | null;
  charmPrev5m: number | null;
  charmPrev10m: number | null;
  vannaPrev1m: number | null;
  vannaPrev5m: number | null;
  vannaPrev10m: number | null;
}

interface PanelSlot {
  capturedAt: Date;
  rows: DecodedStrikeWithHistory[];
}

/**
 * Try parsing `at` into an ISO timestamp. Returns null when the value
 * is missing, not a string, or `new Date(at)` yields Invalid Date.
 * Matches the project's permissive convention — we don't 400 on bad
 * scrub input, we fall back to "latest".
 */
function parseScrubAt(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Fetch one panel's latest capture under the staleness window, OR the
 * latest capture at-or-before `scrubAt` when scrubbing. Returns null
 * when no row qualifies (panel stale / cron gap / scrub before start).
 */
async function fetchPanelSlot(
  panel: PanelName,
  scrubAt: string | null,
): Promise<PanelSlot | null> {
  const sql = getDb();
  const category = PANEL_TO_CATEGORY[panel];

  let rows: { captured_at: Date | string; raw_response: unknown }[];
  if (scrubAt != null) {
    // Scrub mode: at-or-before the requested minute. No staleness floor
    // (scrubbing back into history is the whole point of the param).
    rows = (await withDbRetry(
      () => sql`
        SELECT captured_at, raw_response
        FROM gexbot_api_capture
        WHERE ticker = ${TICKER}
          AND endpoint = 'state'
          AND category = ${category}
          AND captured_at <= ${scrubAt}
        ORDER BY captured_at DESC
        LIMIT 1
      `,
    )) as { captured_at: Date | string; raw_response: unknown }[];
  } else {
    // Live mode: enforce the staleness window so we don't render a
    // multi-hour-old slice from a stalled cron as if it were "now".
    const stalenessCutoff = new Date(
      Date.now() - STALENESS_CUTOFF_MS,
    ).toISOString();
    rows = (await withDbRetry(
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
  }

  if (rows.length === 0) {
    logger.warn(
      { panel, ticker: TICKER, scrubAt },
      'gex-landscape: no qualifying gexbot row for panel — returning no_slot',
    );
    return null;
  }

  const row = rows[0]!;
  const decoded = decodeStrikesWithHistory(
    row.raw_response as GexbotStatePayload,
  );
  return {
    capturedAt: new Date(row.captured_at),
    rows: decoded,
  };
}

/**
 * Distinct minute-truncated capture timestamps for the day. Anchored on
 * gamma_zero since the populate-periscope-from-gexbot cron writes all
 * three panels at the same minute mark.
 */
async function fetchAvailableMinutes(date: string): Promise<string[]> {
  const sql = getDb();
  // Wrap in withDbRetry so a transient blip on this secondary read surfaces
  // as a TransientDbError (→ soft 503) instead of a raw NeonDbError that
  // hard-500s the whole endpoint.
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT date_trunc('minute', captured_at) AS minute
      FROM gexbot_api_capture
      WHERE ticker = ${TICKER}
        AND endpoint = 'state'
        AND category = 'gamma_zero'
        AND captured_at::date = ${date}::date
      ORDER BY minute ASC
    `,
    DB_RETRY_ATTEMPTS,
    DB_RETRY_TIMEOUT_MS,
  )) as Array<{ minute: Date | string }>;
  return rows.map((r) =>
    r.minute instanceof Date ? r.minute.toISOString() : r.minute,
  );
}

/**
 * Join the three panel decodes by strike. A strike present in one panel
 * but missing in another gets 0 for the scalar fields (so the frontend
 * can compute Δ without null-guarding arithmetic), but null for the
 * corresponding prev fields (source-of-truth — we don't fabricate
 * history we don't have).
 */
function joinPanelsByStrike(
  gamma: DecodedStrikeWithHistory[],
  charm: DecodedStrikeWithHistory[],
  vanna: DecodedStrikeWithHistory[],
): GexLandscapeStrike[] {
  const byStrike = new Map<number, GexLandscapeStrike>();

  const ensure = (strike: number): GexLandscapeStrike => {
    const existing = byStrike.get(strike);
    if (existing) return existing;
    const fresh: GexLandscapeStrike = {
      strike,
      gamma: 0,
      charm: 0,
      vanna: 0,
      gammaPrev1m: null,
      gammaPrev5m: null,
      gammaPrev10m: null,
      charmPrev1m: null,
      charmPrev5m: null,
      charmPrev10m: null,
      vannaPrev1m: null,
      vannaPrev5m: null,
      vannaPrev10m: null,
    };
    byStrike.set(strike, fresh);
    return fresh;
  };

  for (const row of gamma) {
    const target = ensure(row.strike);
    target.gamma = row.value;
    target.gammaPrev1m = row.prev1m;
    target.gammaPrev5m = row.prev5m;
    target.gammaPrev10m = row.prev10m;
  }
  for (const row of charm) {
    const target = ensure(row.strike);
    target.charm = row.value;
    target.charmPrev1m = row.prev1m;
    target.charmPrev5m = row.prev5m;
    target.charmPrev10m = row.prev10m;
  }
  for (const row of vanna) {
    const target = ensure(row.strike);
    target.vanna = row.value;
    target.vannaPrev1m = row.prev1m;
    target.vannaPrev5m = row.prev5m;
    target.vannaPrev10m = row.prev10m;
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const done = metrics.request('/api/gex-landscape');

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  try {
    Sentry.setTag('route', '/api/gex-landscape');
    const marketOpen = isMarketOpen();
    const date = getETDateStr(new Date()); // today CT

    // Edge TTL 30s live / 300s after-hours; SWR 30s live / 60s after-hours.
    // Mirrors /api/periscope-map — same gexbot cadence on both endpoints.
    setCacheHeaders(res, marketOpen ? 30 : 300, marketOpen ? 30 : 60);

    const scrubAt = parseScrubAt(req.query.at);

    // Available minutes is small (~390 rows max for a full session) and
    // backs the scrub stepper — fetch unconditionally so the panel can
    // step backward even when the live slot is missing.
    const availableMinutes = await fetchAvailableMinutes(date);

    // Fetch all three panels in parallel — independent reads.
    const panelSlots = await Promise.all(
      PANELS.map((panel) => fetchPanelSlot(panel, scrubAt)),
    );
    const [gammaSlot, charmSlot, vannaSlot] = panelSlots;

    if (gammaSlot == null || charmSlot == null || vannaSlot == null) {
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data: null,
        reason: 'no_slot',
        availableMinutes,
      });
      return;
    }

    // Anchor `asOf` on the freshest panel timestamp — they should agree
    // to the minute but capture jitter can put them off by a few seconds.
    const latestCapturedAt = new Date(
      Math.max(
        gammaSlot.capturedAt.getTime(),
        charmSlot.capturedAt.getTime(),
        vannaSlot.capturedAt.getTime(),
      ),
    );

    const spot = await fetchSpxSpot(date, latestCapturedAt.toISOString());
    if (spot == null) {
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data: null,
        reason: 'no_spot',
        availableMinutes,
      });
      return;
    }

    const strikes = joinPanelsByStrike(
      gammaSlot.rows,
      charmSlot.rows,
      vannaSlot.rows,
    );

    const ageSec = Math.round((Date.now() - latestCapturedAt.getTime()) / 1000);

    done({ status: 200 });
    res.status(200).json({
      marketOpen,
      asOf: latestCapturedAt.toISOString(),
      data: { strikes, spot },
      ageSec,
      availableMinutes,
    });
  } catch (error) {
    sendDbErrorResponse(res, error, {
      label: 'gex_landscape',
      serverErrorBody: { error: 'Internal server error' },
      done,
    });
  }
}
