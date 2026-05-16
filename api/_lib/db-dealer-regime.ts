/**
 * Read helper for the Dealer Regime Tile (Phase 2 of strike-battle-map).
 *
 * The tile needs the latest `zero_gamma_levels` row per ticker for the
 * set defined in `zero-gamma-tickers.ts` (SPX, SPY, QQQ — NDX was dropped
 * 2026-05-16; see that file's header for rationale). Each row carries the
 * inputs the classifier consumes — `spot`, `zero_gamma`, `confidence`,
 * `net_gamma_at_spot`, plus the row's `ts` for the staleness gate.
 *
 * Implementation uses `DISTINCT ON (ticker)` so a single query returns
 * the latest row across all three tickers. The cron writes every 5 min
 * during market hours, so this picks up fresh data on every poll.
 *
 * Read-only; ingestion is owned by `api/cron/compute-zero-gamma.ts`.
 */

import { getDb } from './db.js';
import {
  ZERO_GAMMA_TICKERS,
  type ZeroGammaTicker,
} from './zero-gamma-tickers.js';

type NumericFromDb = string | number | null;

interface RawRow {
  ticker: string;
  ts: string | Date;
  spot: string | number;
  zero_gamma: NumericFromDb;
  confidence: NumericFromDb;
  net_gamma_at_spot: NumericFromDb;
}

export interface DealerRegimeRow {
  ticker: ZeroGammaTicker;
  ts: string;
  spot: number;
  zeroGamma: number | null;
  confidence: number | null;
  netGammaAtSpot: number | null;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function parseNumOrNull(value: NumericFromDb): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r: RawRow): DealerRegimeRow {
  return {
    ticker: r.ticker as ZeroGammaTicker,
    ts: toIso(r.ts),
    spot: Number(r.spot),
    zeroGamma: parseNumOrNull(r.zero_gamma),
    confidence: parseNumOrNull(r.confidence),
    netGammaAtSpot: parseNumOrNull(r.net_gamma_at_spot),
  };
}

export interface FetchOpts {
  /** Optional ET calendar date — restrict rows to that day. */
  date?: string | null;
  /** Optional ISO timestamp — latest row per ticker at-or-before this. */
  at?: string | null;
}

/**
 * Latest `zero_gamma_levels` row per ticker for the active ticker set.
 *
 * Returns up to one row per ticker. A ticker with no rows in the table
 * (e.g. cron has not yet run for it) is simply absent from the result —
 * the classifier maps absence to `uncertain`. Rows are ordered so they
 * come back in the same sequence as `ZERO_GAMMA_TICKERS` for stable
 * downstream consumption.
 *
 * `date` and `at` are independent filters — neither, either, or both
 * may be set:
 *   - neither: latest per ticker across all history (live mode)
 *   - `date`: latest per ticker within that ET calendar date
 *   - `at`:   latest per ticker at-or-before the timestamp
 *   - both:   latest per ticker within the date AND at-or-before `at`
 */
export async function getLatestDealerRegime(
  opts: FetchOpts = {},
): Promise<DealerRegimeRow[]> {
  const sql = getDb();
  const tickers = [...ZERO_GAMMA_TICKERS] as readonly string[];
  const { date, at } = opts;

  let rows: RawRow[];
  if (date && at) {
    rows = (await sql`
      SELECT DISTINCT ON (ticker)
        ticker, ts, spot, zero_gamma, confidence, net_gamma_at_spot
      FROM zero_gamma_levels
      WHERE ticker = ANY(${tickers}::text[])
        AND (ts AT TIME ZONE 'America/New_York')::date = ${date}::date
        AND ts <= ${at}::timestamptz
      ORDER BY ticker, ts DESC
    `) as RawRow[];
  } else if (date) {
    rows = (await sql`
      SELECT DISTINCT ON (ticker)
        ticker, ts, spot, zero_gamma, confidence, net_gamma_at_spot
      FROM zero_gamma_levels
      WHERE ticker = ANY(${tickers}::text[])
        AND (ts AT TIME ZONE 'America/New_York')::date = ${date}::date
      ORDER BY ticker, ts DESC
    `) as RawRow[];
  } else if (at) {
    rows = (await sql`
      SELECT DISTINCT ON (ticker)
        ticker, ts, spot, zero_gamma, confidence, net_gamma_at_spot
      FROM zero_gamma_levels
      WHERE ticker = ANY(${tickers}::text[])
        AND ts <= ${at}::timestamptz
      ORDER BY ticker, ts DESC
    `) as RawRow[];
  } else {
    rows = (await sql`
      SELECT DISTINCT ON (ticker)
        ticker, ts, spot, zero_gamma, confidence, net_gamma_at_spot
      FROM zero_gamma_levels
      WHERE ticker = ANY(${tickers}::text[])
      ORDER BY ticker, ts DESC
    `) as RawRow[];
  }

  // Re-order to match ZERO_GAMMA_TICKERS so the API response is stable.
  const byTicker = new Map(rows.map((r) => [r.ticker, mapRow(r)]));
  const ordered: DealerRegimeRow[] = [];
  for (const t of ZERO_GAMMA_TICKERS) {
    const row = byTicker.get(t);
    if (row) ordered.push(row);
  }
  return ordered;
}
