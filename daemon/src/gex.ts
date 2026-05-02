/**
 * GEX landscape query for the live daemon.
 *
 * Mirrors the data flow used by `scripts/smoke-trace-live.ts` (which mirrors
 * the frontend GEX Landscape component). Reads `gex_strike_0dte` from Neon,
 * fetches the closest snapshot at-or-before the capture timestamp, computes
 * 1m + 5m delta percentages from prior snapshots, classifies each strike
 * via the same kebab-case keys the frontend uses, and emits a payload
 * shaped like `TraceGexLandscape` from `api/_lib/trace-live-types.ts`.
 *
 * Classification + signal labels come from the shared
 * `src/utils/gex-classification.ts` module — both the GexLandscape
 * frontend and this daemon read the same source of truth.
 *
 * `fetchGexLandscape` orchestrates 4 helpers (each unit-testable in
 * isolation with a mocked sql client):
 *   - findClosestSnapshotTs — snapshot lookup within ±5 min
 *   - fetchPriorGammaMap    — prior snapshot map for delta% computation
 *   - enrichStrikes         — per-strike enrichment with delta% + class
 *   - computeAggregates     — totals + drift targets + ATM
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Logger } from 'pino';
import {
  classSignal,
  type Direction,
  type GexClassification,
} from '../../src/utils/gex-classification.js';

const SPOT_BAND_DOLLARS = 12;

type SqlClient = NeonQueryFunction<false, false>;

function classify(netGamma: number, netCharm: number): GexClassification {
  if (netGamma < 0 && netCharm >= 0) return 'max-launchpad';
  if (netGamma < 0 && netCharm < 0) return 'fading-launchpad';
  if (netGamma >= 0 && netCharm >= 0) return 'sticky-pin';
  return 'weakening-pin';
}

function getDirection(strike: number, spot: number): Direction {
  const offset = strike - spot;
  if (offset > SPOT_BAND_DOLLARS) return 'ceiling';
  if (offset < -SPOT_BAND_DOLLARS) return 'floor';
  return 'atm';
}

function pctChange(current: number, prior: number | undefined): number | null {
  if (prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

interface RawStrikeRow {
  strike: number;
  price: number;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_charm_oi: string | null;
  put_charm_oi: string | null;
}

export interface DaemonStrikeRow {
  strike: number;
  dollarGamma: number;
  charm?: number;
  classification?: GexClassification;
  signal?: string;
  delta1m?: number;
  delta5m?: number;
}

export interface DaemonGexLandscape {
  regime: string;
  netGex: number;
  totalPosGex: number;
  totalNegGex: number;
  atmStrike: number;
  driftTargetsUp: number[];
  driftTargetsDown: number[];
  strikes: DaemonStrikeRow[];
  /** SPX spot reported by the snapshot itself (sanity-check the TRACE header). */
  snapshotSpot: number;
  /** Postgres timestamp of the snapshot we read. */
  snapshotTs: string;
}

/**
 * Find the closest snapshot timestamp within ±5 min of `capturedAt` for
 * the given ET trading day. Returns null if none exists.
 *
 * Symmetric (not strict at-or-before) because the first GEX cron row of
 * a session is timestamped a few seconds AFTER the slot boundary
 * (e.g., 13:35:32Z when we ask for 13:35:00Z), which strict ≤ misses.
 * ±5 min covers the cron drift without crossing into adjacent slots.
 */
export async function findClosestSnapshotTs(
  sql: SqlClient,
  etDate: string,
  capturedAt: string,
): Promise<string | null> {
  const tsRows = (await sql`
    SELECT timestamp::text AS ts,
           ABS(EXTRACT(EPOCH FROM (timestamp - ${capturedAt}::timestamptz))) AS diff_sec
    FROM gex_strike_0dte
    WHERE date = ${etDate}
      AND timestamp BETWEEN
        (${capturedAt}::timestamptz - INTERVAL '5 minutes')
        AND (${capturedAt}::timestamptz + INTERVAL '5 minutes')
    ORDER BY diff_sec ASC
    LIMIT 1
  `) as Array<{ ts: string }>;
  return tsRows[0]?.ts ?? null;
}

/**
 * Build a {strike → totalGamma} map for the snapshot at-or-before
 * `targetIso` on `etDate`. Returns an empty map if no prior snapshot
 * exists (e.g., we're asking for 1m before market open).
 */
export async function fetchPriorGammaMap(
  sql: SqlClient,
  etDate: string,
  targetIso: string,
): Promise<Map<number, number>> {
  const priorTsRows = (await sql`
    SELECT timestamp::text AS ts
    FROM gex_strike_0dte
    WHERE date = ${etDate} AND timestamp <= ${targetIso}
    ORDER BY timestamp DESC
    LIMIT 1
  `) as Array<{ ts: string }>;
  const priorTs = priorTsRows[0]?.ts;
  if (!priorTs) return new Map();
  const priorRows = (await sql`
    SELECT strike, call_gamma_oi, put_gamma_oi
    FROM gex_strike_0dte
    WHERE date = ${etDate} AND timestamp = ${priorTs}
  `) as Array<{
    strike: number;
    call_gamma_oi: string;
    put_gamma_oi: string;
  }>;
  const map = new Map<number, number>();
  for (const r of priorRows) {
    map.set(Number(r.strike), Number(r.call_gamma_oi) + Number(r.put_gamma_oi));
  }
  return map;
}

/**
 * Enrich each raw strike row with dollarGamma, delta% vs prior 1m / 5m
 * snapshots, and (when charm OI is present) classification + signal.
 */
export function enrichStrikes(
  rawRows: RawStrikeRow[],
  snapshotSpot: number,
  prev1m: Map<number, number>,
  prev5m: Map<number, number>,
): DaemonStrikeRow[] {
  return rawRows.map((r) => {
    const strike = Number(r.strike);
    const dollarGamma = Number(r.call_gamma_oi) + Number(r.put_gamma_oi);
    const dir = getDirection(strike, snapshotSpot);
    const base: DaemonStrikeRow = { strike, dollarGamma };
    const d1 = pctChange(dollarGamma, prev1m.get(strike));
    if (d1 != null) base.delta1m = d1;
    const d5 = pctChange(dollarGamma, prev5m.get(strike));
    if (d5 != null) base.delta5m = d5;
    if (r.call_charm_oi == null || r.put_charm_oi == null) return base;
    const charm = Number(r.call_charm_oi) + Number(r.put_charm_oi);
    const cls = classify(dollarGamma, charm);
    return {
      ...base,
      charm,
      classification: cls,
      signal: classSignal(cls, dir),
    };
  });
}

export interface GexAggregates {
  regime: string;
  netGex: number;
  totalPosGex: number;
  totalNegGex: number;
  atmStrike: number;
  driftTargetsUp: number[];
  driftTargetsDown: number[];
}

/**
 * Compute totals (netGex, regime, signed totals) + the top-2 drift
 * targets above and below spot + ATM strike (nearest to spot, with
 * ties resolved to the higher strike — the SQL ORDER BY strike DESC
 * + strict `<` keeps the first candidate matching the frontend's
 * GexLandscape behavior).
 */
export function computeAggregates(
  strikes: DaemonStrikeRow[],
  snapshotSpot: number,
): GexAggregates {
  let totalPosGex = 0;
  let totalNegGex = 0;
  for (const s of strikes) {
    if (s.dollarGamma > 0) totalPosGex += s.dollarGamma;
    else totalNegGex += s.dollarGamma;
  }
  const netGex = totalPosGex + totalNegGex;
  const regime =
    netGex > 0 ? 'positive_gamma' : netGex < 0 ? 'negative_gamma' : 'neutral';

  const driftTargetsUp = strikes
    .filter((s) => s.strike > snapshotSpot)
    .sort((a, b) => Math.abs(b.dollarGamma) - Math.abs(a.dollarGamma))
    .slice(0, 2)
    .map((s) => s.strike);
  const driftTargetsDown = strikes
    .filter((s) => s.strike < snapshotSpot)
    .sort((a, b) => Math.abs(b.dollarGamma) - Math.abs(a.dollarGamma))
    .slice(0, 2)
    .map((s) => s.strike);

  let atmStrike = strikes[0]!.strike;
  let atmDist = Math.abs(atmStrike - snapshotSpot);
  for (const s of strikes) {
    const d = Math.abs(s.strike - snapshotSpot);
    if (d < atmDist) {
      atmDist = d;
      atmStrike = s.strike;
    }
  }

  return {
    regime,
    netGex,
    totalPosGex,
    totalNegGex,
    atmStrike,
    driftTargetsUp,
    driftTargetsDown,
  };
}

/**
 * Build a GEX landscape payload for the given capture moment.
 * Returns null if there's no snapshot for the requested date — the daemon
 * should skip this cycle (cron may not have run yet, or pipeline paused).
 */
export async function fetchGexLandscape(args: {
  databaseUrl: string;
  capturedAt: string;
  logger: Logger;
}): Promise<DaemonGexLandscape | null> {
  const { databaseUrl, capturedAt, logger } = args;
  const sql = neon(databaseUrl);

  // Postgres `date` column for gex_strike_0dte stores the ET trading day.
  // Derive it from the UTC timestamp via the Postgres TZ-aware cast — same
  // convention as /api/trace-live-list.
  const dateRows = (await sql`
    SELECT TO_CHAR(${capturedAt}::timestamptz AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS et_date
  `) as Array<{ et_date: string }>;
  const etDate = dateRows[0]?.et_date;
  if (!etDate) {
    logger.warn({ capturedAt }, 'Could not derive ET date from capturedAt');
    return null;
  }

  const snapshotTs = await findClosestSnapshotTs(sql, etDate, capturedAt);
  if (!snapshotTs) {
    logger.warn(
      { etDate, capturedAt },
      'No gex_strike_0dte snapshot within ±5min of capturedAt — skipping',
    );
    return null;
  }

  // Fetch full snapshot.
  const rawRows = (await sql`
    SELECT strike, price,
           call_gamma_oi, put_gamma_oi,
           call_charm_oi, put_charm_oi
    FROM gex_strike_0dte
    WHERE date = ${etDate} AND timestamp = ${snapshotTs}
    ORDER BY strike DESC
  `) as RawStrikeRow[];

  if (rawRows.length === 0) {
    logger.warn({ etDate, snapshotTs }, 'gex_strike_0dte rows empty');
    return null;
  }

  const snapshotSpot = Number(rawRows[0]!.price);

  // Prior gamma maps for delta% computation.
  const target1m = new Date(
    new Date(snapshotTs).getTime() - 1 * 60_000,
  ).toISOString();
  const target5m = new Date(
    new Date(snapshotTs).getTime() - 5 * 60_000,
  ).toISOString();
  const [prev1m, prev5m] = await Promise.all([
    fetchPriorGammaMap(sql, etDate, target1m),
    fetchPriorGammaMap(sql, etDate, target5m),
  ]);

  const strikes = enrichStrikes(rawRows, snapshotSpot, prev1m, prev5m);
  const aggregates = computeAggregates(strikes, snapshotSpot);

  return {
    ...aggregates,
    strikes,
    snapshotSpot,
    snapshotTs,
  };
}
