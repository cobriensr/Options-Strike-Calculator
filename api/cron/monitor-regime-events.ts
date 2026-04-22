/**
 * GET /api/cron/monitor-regime-events
 *
 * Phase 2A.3 — server-side equivalent of the Phase 1E alert engine.
 *
 * Runs every minute during RTH CT. Reads the latest GEX + OI + futures
 * snapshot, reconstructs the `AlertState` shape consumed by the shared
 * pure engine in `src/components/FuturesGammaPlaybook/alerts.ts`, and
 * calls `detectAlertEdges(prev, next, nowIso)`.
 *
 * Every edge is:
 *  1. Checked against a per-(type:key) cooldown stored in the
 *     singleton `regime_monitor_state` row.
 *  2. Inserted into `regime_events` for history / diagnostics.
 *  3. Pushed to every row in `push_subscriptions` via web-push.
 *
 * ## Concurrency caveat (acknowledged, not fixed in v1)
 *
 * Vercel can fire two cron invocations back-to-back if one overruns.
 * We don't wrap the read/update of `regime_monitor_state` in a
 * `FOR UPDATE` lock — a rare overlap window can produce duplicate
 * alerts. In practice the Phase 1E cooldowns on the client AND the
 * per-type cooldown stored on the server make this a nuisance, not
 * a correctness issue. We'll revisit if we see >1 duplicate/day in
 * the `regime_events` table.
 *
 * Environment: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
 * VAPID_SUBJECT.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { sendPushToAll } from '../_lib/web-push-client.js';
import type {
  AlertEvent,
  AlertState,
} from '../../src/components/FuturesGammaPlaybook/alerts.js';
import { detectAlertEdges } from '../../src/components/FuturesGammaPlaybook/alerts.js';
import type {
  EsLevel,
  GexRegime,
  SessionPhase,
} from '../../src/components/FuturesGammaPlaybook/types.js';
import {
  classifyRegime,
  classifySessionPhase,
} from '../../src/components/FuturesGammaPlaybook/playbook.js';
import { evaluateTriggers } from '../../src/components/FuturesGammaPlaybook/triggers.js';
import { translateSpxToEs } from '../../src/components/FuturesGammaPlaybook/basis.js';
import { computeZeroGammaStrike } from '../../src/utils/zero-gamma.js';
import { computeMaxPain } from '../../src/utils/max-pain.js';

// ── Constants ──────────────────────────────────────────────────────

export const ALERT_COOLDOWN_SECONDS = 90;
const SINGLETON_KEY = 'current';
const ES_SYMBOL = 'ES';

// ── Types for persisted state ──────────────────────────────────────

interface SerializedAlertState {
  regime: GexRegime;
  phase: SessionPhase;
  levels: EsLevel[];
  firedTriggers: string[];
  esPrice: number | null;
}

interface PersistedMonitorState {
  state: SerializedAlertState | null;
  cooldowns: Record<string, number>;
}

// ── DB shape helpers ───────────────────────────────────────────────

/** Neon returns NUMERIC columns as strings — both string and number forms appear. */
type NumericCol = string | number;
type NullableNumericCol = NumericCol | null;

interface SpotExposureRow {
  timestamp: string;
  price: NumericCol;
  gamma_oi: NullableNumericCol;
}

interface GexStrikeRow {
  strike: NumericCol;
  call_gamma_oi: NullableNumericCol;
  put_gamma_oi: NullableNumericCol;
}

interface OiStrikeRow {
  strike: NumericCol;
  call_oi: NullableNumericCol;
  put_oi: NullableNumericCol;
}

interface FuturesSnapshotRow {
  symbol: string;
  price: NumericCol;
}

interface MonitorStateRow {
  prev_state: unknown;
}

// ── State read / write ─────────────────────────────────────────────

async function loadPrevState(): Promise<PersistedMonitorState> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT prev_state FROM regime_monitor_state
      WHERE singleton_key = ${SINGLETON_KEY}
    `) as MonitorStateRow[];
    const raw = rows[0]?.prev_state;
    if (!raw || typeof raw !== 'object') {
      return { state: null, cooldowns: {} };
    }
    const parsed = raw as Partial<PersistedMonitorState>;
    return {
      state: parsed.state ?? null,
      cooldowns:
        parsed.cooldowns && typeof parsed.cooldowns === 'object'
          ? (parsed.cooldowns as Record<string, number>)
          : {},
    };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err }, 'monitor-regime-events: loadPrevState failed');
    return { state: null, cooldowns: {} };
  }
}

async function savePrevState(next: PersistedMonitorState): Promise<void> {
  const sql = getDb();
  const payload = JSON.stringify(next);
  await sql`
    INSERT INTO regime_monitor_state (singleton_key, prev_state, last_run)
    VALUES (${SINGLETON_KEY}, ${payload}::jsonb, now())
    ON CONFLICT (singleton_key) DO UPDATE
      SET prev_state = EXCLUDED.prev_state,
          last_run = EXCLUDED.last_run
  `;
}

// ── Data source loaders (each resilient to empty / broken input) ───

async function loadSpotExposure(
  today: string,
): Promise<{ netGex: number | null; spot: number | null }> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT timestamp, price, gamma_oi
      FROM spot_exposures
      WHERE date = ${today} AND ticker = 'SPX'
      ORDER BY timestamp DESC
      LIMIT 1
    `) as SpotExposureRow[];
    if (rows.length === 0) return { netGex: null, spot: null };
    const row = rows[0]!;
    const price = Number.parseFloat(String(row.price));
    const gammaOi =
      row.gamma_oi == null ? null : Number.parseFloat(String(row.gamma_oi));
    return {
      netGex: Number.isFinite(gammaOi) ? (gammaOi as number) : null,
      spot: Number.isFinite(price) ? price : null,
    };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err }, 'monitor-regime-events: loadSpotExposure failed');
    return { netGex: null, spot: null };
  }
}

async function loadGexStrikes(
  today: string,
): Promise<{
  strikes: Array<{ strike: number; netGamma: number }>;
  callWall: number | null;
  putWall: number | null;
  gammaPin: number | null;
}> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT strike, call_gamma_oi, put_gamma_oi
      FROM gex_strike_0dte
      WHERE date = ${today}
        AND timestamp = (
          SELECT MAX(timestamp) FROM gex_strike_0dte WHERE date = ${today}
        )
    `) as GexStrikeRow[];

    if (rows.length === 0) {
      return { strikes: [], callWall: null, putWall: null, gammaPin: null };
    }

    const strikes = rows.map((r) => {
      const strike = Number.parseFloat(String(r.strike));
      const callGamma =
        r.call_gamma_oi == null
          ? 0
          : Number.parseFloat(String(r.call_gamma_oi)) || 0;
      const putGamma =
        r.put_gamma_oi == null
          ? 0
          : Number.parseFloat(String(r.put_gamma_oi)) || 0;
      return {
        strike,
        callGamma,
        putGamma,
        netGamma: callGamma + putGamma,
      };
    });

    // Walls: largest |call gamma| strike = call wall; largest |put gamma| = put wall.
    // gammaPin: strike with largest |netGamma| — mirrors GexLandscape/bias.ts
    // gravity and is the charm-drift magnet. Null when every strike is zero.
    let callWall: number | null = null;
    let putWall: number | null = null;
    let gammaPin: number | null = null;
    let bestCall = 0;
    let bestPut = 0;
    let bestNet = 0;
    for (const s of strikes) {
      if (Math.abs(s.callGamma) > bestCall) {
        bestCall = Math.abs(s.callGamma);
        callWall = s.strike;
      }
      if (Math.abs(s.putGamma) > bestPut) {
        bestPut = Math.abs(s.putGamma);
        putWall = s.strike;
      }
      if (Math.abs(s.netGamma) > bestNet) {
        bestNet = Math.abs(s.netGamma);
        gammaPin = s.strike;
      }
    }

    return {
      strikes: strikes.map((s) => ({ strike: s.strike, netGamma: s.netGamma })),
      callWall,
      putWall,
      gammaPin,
    };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err }, 'monitor-regime-events: loadGexStrikes failed');
    return { strikes: [], callWall: null, putWall: null, gammaPin: null };
  }
}

async function loadMaxPain(today: string): Promise<number | null> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT strike, call_oi, put_oi
      FROM oi_per_strike
      WHERE date = ${today}
    `) as OiStrikeRow[];
    if (rows.length === 0) return null;
    const input = rows.map((r) => ({
      strike: Number.parseFloat(String(r.strike)),
      callOi:
        r.call_oi == null ? 0 : Number.parseInt(String(r.call_oi), 10) || 0,
      putOi:
        r.put_oi == null ? 0 : Number.parseInt(String(r.put_oi), 10) || 0,
    }));
    return computeMaxPain(input);
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err }, 'monitor-regime-events: loadMaxPain failed');
    return null;
  }
}

async function loadEsBasis(
  spot: number | null,
): Promise<{ esPrice: number | null; basis: number | null }> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT symbol, price
      FROM futures_snapshots
      WHERE symbol = ${ES_SYMBOL}
      ORDER BY ts DESC
      LIMIT 1
    `) as FuturesSnapshotRow[];
    if (rows.length === 0) return { esPrice: null, basis: null };
    const esPrice = Number.parseFloat(String(rows[0]!.price));
    if (!Number.isFinite(esPrice)) return { esPrice: null, basis: null };
    const basis = spot !== null ? esPrice - spot : null;
    return { esPrice, basis };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err }, 'monitor-regime-events: loadEsBasis failed');
    return { esPrice: null, basis: null };
  }
}

// ── AlertState construction ────────────────────────────────────────

/**
 * Build the level list consumed by `detectAlertEdges`. Each level gets
 * its status classified by proximity to current ES price (no priorHistory
 * — the server doesn't track a distances series yet; `classifyLevelStatus`
 * degrades to proximity-only with a single argument). The engine only
 * reads `.kind` and `.status`, so approximate distances are fine.
 */
function buildEsLevels(input: {
  esPrice: number | null;
  basis: number | null;
  spxCallWall: number | null;
  spxPutWall: number | null;
  spxZeroGamma: number | null;
  spxMaxPain: number | null;
}): EsLevel[] {
  const { esPrice, basis } = input;
  if (esPrice === null || basis === null) return [];
  const levels: EsLevel[] = [];

  const maybePush = (
    kind: EsLevel['kind'],
    spxStrike: number | null,
  ): void => {
    if (spxStrike === null) return;
    const esLevelPrice = translateSpxToEs(spxStrike, basis);
    const distance = esLevelPrice - esPrice;
    // Proximity-only classification: within 5 pts = APPROACHING, else IDLE.
    // The engine's REGIME_FLIP / PHASE_TRANSITION detectors don't care, and
    // the LEVEL_APPROACH edge fires on IDLE → APPROACHING regardless of
    // how we picked the current status (the prev state supplies IDLE).
    const status: EsLevel['status'] =
      Math.abs(distance) <= 5 ? 'APPROACHING' : 'IDLE';
    levels.push({
      kind,
      spxStrike,
      esPrice: esLevelPrice,
      distanceEsPoints: distance,
      status,
    });
  };

  maybePush('CALL_WALL', input.spxCallWall);
  maybePush('PUT_WALL', input.spxPutWall);
  maybePush('ZERO_GAMMA', input.spxZeroGamma);
  maybePush('MAX_PAIN', input.spxMaxPain);

  return levels;
}

// ── Cooldown key (mirrors Phase 1E `cooldownKeyFor`) ───────────────

function cooldownKeyForEvent(event: AlertEvent): string {
  const parts = event.id.split(':');
  if (
    event.type === 'LEVEL_APPROACH' ||
    event.type === 'LEVEL_BREACH' ||
    event.type === 'TRIGGER_FIRE'
  ) {
    return `${event.type}:${parts[1] ?? ''}`;
  }
  return `${event.type}:`;
}

// ── Event persistence ──────────────────────────────────────────────

async function insertRegimeEvent(
  event: AlertEvent,
  deliveredCount: number,
): Promise<void> {
  const sql = getDb();
  const payload = JSON.stringify(event);
  await sql`
    INSERT INTO regime_events (
      ts, type, severity, title, body, payload, delivered_count
    )
    VALUES (
      ${event.ts}, ${event.type}, ${event.severity},
      ${event.title}, ${event.body}, ${payload}::jsonb, ${deliveredCount}
    )
  `;
}

// ── Handler ────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;

  const startedAt = Date.now();

  try {
    // ── 1. Load prev state + all live inputs in parallel ─────────
    const prev = await loadPrevState();

    const [{ netGex, spot }, gexStrikes, spxMaxPain] = await Promise.all([
      loadSpotExposure(guard.today),
      loadGexStrikes(guard.today),
      loadMaxPain(guard.today),
    ]);

    const { esPrice, basis } = await loadEsBasis(spot);

    // ── 2. Derive structural levels (SPX domain) ──────────────────
    const spxZeroGamma =
      spot !== null && gexStrikes.strikes.length >= 2
        ? computeZeroGammaStrike(gexStrikes.strikes, spot)
        : null;

    const esLevels = buildEsLevels({
      esPrice,
      basis,
      spxCallWall: gexStrikes.callWall,
      spxPutWall: gexStrikes.putWall,
      spxZeroGamma,
      spxMaxPain,
    });

    // ── 3. Assemble AlertState ───────────────────────────────────
    // netGex guard: engine treats `0` as "no directional gamma" which
    // composes correctly with classifyRegime's zero-gamma fallback.
    const regime: GexRegime =
      netGex !== null && spot !== null
        ? classifyRegime(netGex, spxZeroGamma, spot)
        : 'TRANSITIONING';
    const phase: SessionPhase = classifySessionPhase(new Date());

    // Translate gamma-pin to ES for the charm-drift trigger. Not rendered
    // as a level row server-side; consumed only by evaluateTriggers.
    const esGammaPin =
      gexStrikes.gammaPin !== null && basis !== null
        ? translateSpxToEs(gexStrikes.gammaPin, basis)
        : null;

    // Run the shared trigger evaluator so the server knows which named
    // setups are ACTIVE right now. Pre Phase 2D this was hardcoded to []
    // which meant TRIGGER_FIRE edges could never fire — the regime_events
    // table got flow-events (approach/breach/regime/phase) but no
    // trigger-fire events, and the TodaysFiredStrip rendered empty.
    //
    // Server-side callers do NOT pass `flowSignals` — the cron has no
    // per-strike snapshot buffer to compute priceTrend from. This means
    // the cron may fire TRIGGER_FIRE pushes for fade/lift triggers the
    // client UI has suppressed under drift-override. Follow-up: either
    // compute priceTrend server-side from gex_strike_0dte history, or
    // forward the client's priceTrend through `PlaybookBias` and store
    // it alongside regime snapshots.
    const triggerStates = evaluateTriggers({
      regime,
      phase,
      esPrice,
      levels: esLevels,
      esGammaPin,
    });
    const firedTriggers = triggerStates
      .filter((t) => t.status === 'ACTIVE')
      .map((t) => t.id);

    const nextState: AlertState = {
      regime,
      phase,
      levels: esLevels,
      firedTriggers,
      esPrice,
    };

    // ── 4. Detect edges via shared engine ─────────────────────────
    const nowIso = new Date().toISOString();
    const edges = detectAlertEdges(prev.state, nextState, nowIso);

    // ── 5. Apply cooldowns + deliver + persist events ─────────────
    const nowMs = Date.now();
    const nextCooldowns: Record<string, number> = { ...prev.cooldowns };
    let delivered = 0;
    let errors = 0;

    for (const edge of edges) {
      const key = cooldownKeyForEvent(edge);
      const last = nextCooldowns[key] ?? 0;
      if (nowMs - last < ALERT_COOLDOWN_SECONDS * 1000) continue;
      nextCooldowns[key] = nowMs;

      try {
        const pushResult = await sendPushToAll(edge);
        delivered += pushResult.delivered;
        errors += pushResult.errors;
        await insertRegimeEvent(edge, pushResult.delivered);
      } catch (err) {
        // Individual edge persistence shouldn't kill the whole run —
        // preserve cooldown so we don't re-fire, skip the event row,
        // and continue with the next edge.
        Sentry.setTag('cron.job', 'monitor-regime-events');
        Sentry.captureException(err);
        logger.warn(
          { err, edge: edge.id },
          'monitor-regime-events: edge persist failed',
        );
        errors += 1;
      }
    }

    // ── 6. Persist new state (strip dynamic fields the engine writes) ──
    const serialized: SerializedAlertState = {
      regime: nextState.regime,
      phase: nextState.phase,
      levels: nextState.levels,
      firedTriggers: nextState.firedTriggers,
      esPrice: nextState.esPrice,
    };

    // Prune cooldown entries older than 10× the cooldown window so
    // the JSONB blob can't grow without bound across months of runs.
    const COOLDOWN_PRUNE_AGE_MS = ALERT_COOLDOWN_SECONDS * 1000 * 10;
    const prunedCooldowns: Record<string, number> = {};
    for (const [k, v] of Object.entries(nextCooldowns)) {
      if (nowMs - v < COOLDOWN_PRUNE_AGE_MS) prunedCooldowns[k] = v;
    }

    await savePrevState({
      state: serialized,
      cooldowns: prunedCooldowns,
    });

    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        edges: edges.length,
        delivered,
        errors,
        durationMs,
        regime,
        phase,
      },
      'monitor-regime-events completed',
    );

    res.status(200).json({
      ok: true,
      edges: edges.length,
      delivered,
      errors,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'monitor-regime-events');
    Sentry.captureException(err);
    logger.error({ err }, 'monitor-regime-events error');
    res.status(500).json({ error: 'Internal error' });
  }
}

