/**
 * GET /api/pin-setup-status
 *
 * Owner-or-guest read endpoint backing the Pin-Setup Tile in
 * PreTradeSignals (Phase 1 of
 * docs/superpowers/specs/pin-setup-widget-2026-05-14.md).
 *
 * Classifies the current 0DTE SPX session as:
 *   ARMED          — all 3 conditions met (high-prob pin day)
 *   WATCH          — exactly 2 of 3 met (borderline)
 *   NOT_TRIGGERED  — <= 1 met (no structural wall today)
 *
 * Conditions:
 *   1. Net gamma at dominant strike >= 20,000 M
 *   2. That strike is a multiple of 50
 *   3. |spot - strike| <= 15 SPX points
 *
 * Owner-or-guest tier — same access category as `/api/dealer-regime`
 * and `/api/gex-strike-expiry`, since the data derives from UW
 * (OPRA-licensed) spot exposures.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { pinSetupQuerySchema } from './_lib/validation.js';
import { getLatestPinSetup } from './_lib/db-pin-setup.js';

const NET_GAMMA_THRESHOLD_M = 20_000;
const DISTANCE_THRESHOLD = 15;
const ROUND_NUMBER_STEP = 50;
const BIAS_NEUTRAL_BAND = 3;
const TRAJECTORY_LIMIT = 200;

export type PinSetupState = 'ARMED' | 'WATCH' | 'NOT_TRIGGERED';
export type PinSetupBias = 'fade-rips' | 'fade-dips' | 'full-pin' | 'no-signal';

export interface PinSetupOutcome {
  /** Final cash-session close (SPX). */
  settle: number;
  /** Signed delta (settle - magnet). Positive = closed above magnet. */
  settleVsMagnet: number;
}

export interface PinSetupStatusResponse {
  evaluatedAt: string;
  /** Echoes the `date` query param when in historical mode; else null. */
  date: string | null;
  /** Mode label for the frontend ('live' or 'historical'). */
  mode: 'live' | 'historical';
  /** ISO timestamp of the snapshot the response is computed from. */
  snapshotTs: string | null;
  /**
   * Age of the snapshot in whole minutes vs. `evaluatedAt`. Always
   * populated (0 in historical mode for the matched snapshot day, or
   * the real age if the historical pull is stale). Frontend uses this
   * to render a "STALE" badge in live mode if > ~30 min during market.
   */
  staleMinutes: number | null;
  state: PinSetupState;
  conditions: {
    netGammaAtMagnetM: number;
    netGammaThresholdM: number;
    netGammaMet: boolean;
    magnetStrike: number | null;
    isRound50: boolean;
    distanceToMagnet: number | null;
    distanceThreshold: number;
    distanceMet: boolean;
  };
  spot: number | null;
  bias: PinSetupBias;
  recommendedTradeTypes: string[];
  avoidedTradeTypes: string[];
  trajectory: Array<{ ts: string; gammaDirM: number; spot: number | null }>;
  /** Populated only in historical mode when a settle is available. */
  outcome: PinSetupOutcome | null;
  asOf: string;
}

function classifyBias(
  state: PinSetupState,
  spot: number | null,
  magnet: number | null,
): PinSetupBias {
  if (state === 'NOT_TRIGGERED' || spot == null || magnet == null) {
    return 'no-signal';
  }
  const delta = spot - magnet;
  if (Math.abs(delta) <= BIAS_NEUTRAL_BAND) return 'full-pin';
  return delta > 0 ? 'fade-rips' : 'fade-dips';
}

function tradeTypesFor(bias: PinSetupBias): {
  recommended: string[];
  avoided: string[];
} {
  switch (bias) {
    case 'full-pin':
      return {
        recommended: ['iron_condor', 'iron_butterfly', 'broken_wing_butterfly'],
        avoided: [
          'directional_long_call',
          'directional_long_put',
          'debit_call_spread',
          'debit_put_spread',
        ],
      };
    case 'fade-rips':
      return {
        recommended: ['credit_call_spread', 'iron_condor'],
        avoided: ['directional_long_call', 'debit_call_spread'],
      };
    case 'fade-dips':
      return {
        recommended: ['credit_put_spread', 'iron_condor'],
        avoided: ['directional_long_put', 'debit_put_spread'],
      };
    case 'no-signal':
      return {
        recommended: ['directional_long_call', 'directional_long_put'],
        avoided: [],
      };
  }
}

function formatCtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function staleMinutesFrom(snapshotIso: string | null, nowIso: string): number {
  if (snapshotIso == null) return 0;
  const snapMs = Date.parse(snapshotIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(snapMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - snapMs) / 60_000));
}

/**
 * Build the response shape used when no usable magnet can be identified
 * (empty data OR every top-25 strike has non-positive net γ). The
 * recommended trade types still default to directional per the spec
 * table — NOT_TRIGGERED is the regime where directionals have room.
 */
function noSignalResponse(
  evaluatedAt: string,
  date: string | null,
  mode: 'live' | 'historical',
  snapshotTs: string | null,
  spot: number | null,
): PinSetupStatusResponse {
  const { recommended, avoided } = tradeTypesFor('no-signal');
  return {
    evaluatedAt,
    date,
    mode,
    snapshotTs,
    staleMinutes: staleMinutesFrom(snapshotTs, evaluatedAt),
    state: 'NOT_TRIGGERED',
    conditions: {
      netGammaAtMagnetM: 0,
      netGammaThresholdM: NET_GAMMA_THRESHOLD_M,
      netGammaMet: false,
      magnetStrike: null,
      isRound50: false,
      distanceToMagnet: null,
      distanceThreshold: DISTANCE_THRESHOLD,
      distanceMet: false,
    },
    spot,
    bias: 'no-signal',
    recommendedTradeTypes: recommended,
    avoidedTradeTypes: avoided,
    trajectory: [],
    outcome: null,
    asOf: evaluatedAt,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/pin-setup-status');
    const done = metrics.request('/api/pin-setup-status');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = pinSetupQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const evaluatedAt = new Date().toISOString();
    const date = parsed.data.date ?? null;
    const mode: 'live' | 'historical' = date ? 'historical' : 'live';

    try {
      const snap = await getLatestPinSetup(date);

      // No data at all (cold DB, weekend with no prior session, or
      // historical date with no rows): return a benign NOT_TRIGGERED
      // informational response with directional recommendations.
      if (snap.strikes.length === 0 || snap.spot == null) {
        setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
        done({ status: 200 });
        return res
          .status(200)
          .json(
            noSignalResponse(
              evaluatedAt,
              date,
              mode,
              snap.snapshotTs,
              snap.spot,
            ),
          );
      }

      // Identify the dominant +γ strike. The query returns the top 25
      // by abs(net γ), so a strictly-positive entry must be among them
      // if one exists. If none exists (every top-25 strike has
      // non-positive net γ — a regime where there's no magnet at all),
      // short-circuit to NOT_TRIGGERED so we don't leak misleading
      // anti-magnet metadata to the UI.
      const positive = snap.strikes.find((s) => s.netGammaM > 0);
      if (!positive) {
        const cacheS = mode === 'historical' ? 3600 : isMarketOpen() ? 30 : 300;
        setCacheHeaders(res, cacheS, 60);
        done({ status: 200 });
        return res
          .status(200)
          .json(
            noSignalResponse(
              evaluatedAt,
              date,
              mode,
              snap.snapshotTs,
              snap.spot,
            ),
          );
      }
      const magnet = positive;

      const netGammaAtMagnetM = magnet.netGammaM;
      const magnetStrike = magnet.strike;
      const distanceSigned = snap.spot - magnetStrike;

      const netGammaMet = netGammaAtMagnetM >= NET_GAMMA_THRESHOLD_M;
      const isRound50 = magnetStrike % ROUND_NUMBER_STEP === 0;
      const distanceMet = Math.abs(distanceSigned) <= DISTANCE_THRESHOLD;

      const metCount =
        (netGammaMet ? 1 : 0) + (isRound50 ? 1 : 0) + (distanceMet ? 1 : 0);
      const state: PinSetupState =
        metCount === 3 ? 'ARMED' : metCount === 2 ? 'WATCH' : 'NOT_TRIGGERED';

      const bias = classifyBias(state, snap.spot, magnetStrike);
      const { recommended, avoided } = tradeTypesFor(bias);

      // Downsample trajectory if it exceeds the limit.
      const traj = snap.trajectory;
      const step = Math.max(1, Math.ceil(traj.length / TRAJECTORY_LIMIT));
      const downsampled = traj
        .filter((_, i) => i % step === 0)
        .map((p) => ({
          ts: formatCtTime(p.ts),
          gammaDirM: p.gammaDirM,
          spot: p.spot,
        }));

      const outcome: PinSetupOutcome | null =
        mode === 'historical' && snap.settle != null
          ? {
              settle: snap.settle,
              // Round to 2dp to avoid 0.9999996 float artifacts in JSON.
              settleVsMagnet:
                Math.round((snap.settle - magnetStrike) * 100) / 100,
            }
          : null;

      const response: PinSetupStatusResponse = {
        evaluatedAt,
        date,
        mode,
        snapshotTs: snap.snapshotTs,
        staleMinutes: staleMinutesFrom(snap.snapshotTs, evaluatedAt),
        state,
        conditions: {
          netGammaAtMagnetM,
          netGammaThresholdM: NET_GAMMA_THRESHOLD_M,
          netGammaMet,
          magnetStrike,
          isRound50,
          distanceToMagnet: distanceSigned,
          distanceThreshold: DISTANCE_THRESHOLD,
          distanceMet,
        },
        spot: snap.spot,
        bias,
        recommendedTradeTypes: recommended,
        avoidedTradeTypes: avoided,
        trajectory: downsampled,
        outcome,
        asOf: evaluatedAt,
      };

      // Live mode: short cache during market for fast tile updates.
      // Historical mode: settled data, long cache fine.
      const cacheS = mode === 'historical' ? 3600 : isMarketOpen() ? 30 : 300;
      setCacheHeaders(res, cacheS, 60);
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'pin-setup-status: query failed');
      done({ status: 500 });
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
