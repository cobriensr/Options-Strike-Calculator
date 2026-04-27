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
 * The frontend's CLASS_META.signal() mapping is duplicated here (the
 * daemon doesn't import from src/ to avoid Vite-vs-NodeNext resolution
 * differences). Source of truth: src/components/GexLandscape/constants.ts
 * — keep in sync if the frontend's signal labels change.
 */

import { neon } from '@neondatabase/serverless';
import type { Logger } from 'pino';

const SPOT_BAND_DOLLARS = 12;

type Direction = 'ceiling' | 'floor' | 'atm';
type GexClassification =
  | 'max-launchpad'
  | 'fading-launchpad'
  | 'sticky-pin'
  | 'weakening-pin';

// Duplicated from src/components/GexLandscape/constants.ts (CLASS_META.signal).
function classSignal(cls: GexClassification, dir: Direction): string {
  if (cls === 'max-launchpad') {
    return dir === 'ceiling'
      ? 'Ceiling Breakout Risk'
      : dir === 'floor'
        ? 'Floor Collapse Risk'
        : 'Launch Zone';
  }
  if (cls === 'fading-launchpad') {
    return dir === 'ceiling'
      ? 'Weakening Ceiling'
      : dir === 'floor'
        ? 'Weakening Floor'
        : 'Fading Launch';
  }
  if (cls === 'sticky-pin') {
    return dir === 'ceiling'
      ? 'Hard Ceiling'
      : dir === 'floor'
        ? 'Hard Floor'
        : 'Pin Zone';
  }
  // weakening-pin
  return dir === 'ceiling'
    ? 'Softening Ceiling'
    : dir === 'floor'
      ? 'Softening Floor'
      : 'Weak Pin';
}

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

  // Find the closest snapshot at-or-before capturedAt.
  const tsRows = (await sql`
    SELECT timestamp::text AS ts
    FROM gex_strike_0dte
    WHERE date = ${etDate} AND timestamp <= ${capturedAt}
    ORDER BY timestamp DESC
    LIMIT 1
  `) as Array<{ ts: string }>;
  const snapshotTs = tsRows[0]?.ts;
  if (!snapshotTs) {
    logger.warn(
      { etDate, capturedAt },
      'No gex_strike_0dte snapshot at-or-before capturedAt — skipping',
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
  const priorAt = async (minutesAgo: number): Promise<Map<number, number>> => {
    const target = new Date(
      new Date(snapshotTs).getTime() - minutesAgo * 60_000,
    ).toISOString();
    const priorTsRows = (await sql`
      SELECT timestamp::text AS ts
      FROM gex_strike_0dte
      WHERE date = ${etDate} AND timestamp <= ${target}
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
      map.set(
        Number(r.strike),
        Number(r.call_gamma_oi) + Number(r.put_gamma_oi),
      );
    }
    return map;
  };

  const [prev1m, prev5m] = await Promise.all([priorAt(1), priorAt(5)]);

  const strikes: DaemonStrikeRow[] = rawRows.map((r) => {
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

  // ATM strike — nearest strike to spot.
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
    strikes,
    snapshotSpot,
    snapshotTs,
  };
}
