/**
 * Neon read helpers for the live 0DTE gamma-regime read path.
 *
 * These are the ONLY I/O for the regime evaluator: each function reads one
 * of the three source tables for a CT trading day and returns the exact
 * input shape the pure evaluator (`regime-0dte.ts`) consumes. The endpoint
 * and the nightly cron both orchestrate through these helpers + the pure
 * evaluator — no SQL lives anywhere else in the read path.
 *
 *   - `getGexStrikes`   → net GEX by strike + spot at a chosen anchor minute
 *                         (`'latest'` EOD by default; `'open'` / `'midday'`).
 *   - `getPutIvSeries`  → nearest-ATM SPXW 0DTE put IV per CT minute.
 *   - `getCandles30`    → 30-min SPX regular-session candles (CT minute-of-day).
 *
 * ⚠️ SIGN CONVENTION: `put_gamma_oi` is stored SIGNED-NEGATIVE in
 * `gex_strike_0dte`, so net dealer GEX = `call_gamma_oi + put_gamma_oi`
 * (NOT `call − put`). The `+` form is calibrated against `GATE_DEEP_NEG`;
 * `call − put` is positive every day and destroys the signal. Do not change.
 *
 * Neon returns NUMERIC columns as strings (full precision), so every value
 * column is coerced through `Number(...)`. CT-local minute-of-day is computed
 * in SQL via `AT TIME ZONE 'America/Chicago'`, the repo's standard idiom.
 */

import { getDb } from './db.js';
import { withRetry } from './api-helpers.js';
import { REGIME_0DTE } from './regime-0dte.js';
import type { GexStrike, IvPoint, Candle30 } from './regime-0dte.js';

// Neon returns NUMERIC columns as strings (full precision), INTEGER/FLOAT8 as
// numbers, and nulls flow through — accept all three at every read boundary.
type Numeric = string | number | null;

// Minute-of-day (0–1439) in CT for a TIMESTAMPTZ column. Computed in SQL so
// the bucketing matches the evaluator's `nowCtMin` convention exactly.
const ctMinExpr = (col: string) =>
  `(extract(hour from ${col} AT TIME ZONE 'America/Chicago') * 60
    + extract(minute from ${col} AT TIME ZONE 'America/Chicago'))::int`;

/**
 * Which minute's strike profile to read for a trading day.
 *   - `'latest'` → the MAX timestamp (EOD profile). Default — the live read
 *     path wants the most recent minute.
 *   - `'open'`   → the MIN timestamp (the day's first GEX minute).
 *   - `'midday'` → the first timestamp whose CT minute-of-day ≥ 750 (12:30 CT);
 *     falls back to the latest minute when no such minute exists (short day).
 *
 * The 0DTE gamma profile migrates with spot through the day, so the gate / GEX
 * fields must each be reconstructed from a TIME-CORRECT profile rather than the
 * single EOD snapshot — otherwise a band centered on the OPEN spot finds no
 * strikes in the EOD profile and reads ~0.
 */
export type GexAnchor = 'latest' | 'open' | 'midday';

/**
 * Net GEX by strike for `dateIso` at the chosen `anchor` minute, plus the spot
 * at that minute. Net GEX = call_gamma_oi + put_gamma_oi (put is signed-negative;
 * see header). DEFAULT `anchor` is `'latest'` — the live endpoint relies on it.
 */
export async function getGexStrikes(
  dateIso: string,
  anchor: GexAnchor = 'latest',
): Promise<{ strikes: GexStrike[]; spot: number | null }> {
  const sql = getDb();

  // Guard against rows mis-stamped into the wrong `date`: gex_strike_0dte carries
  // a stray prior-evening snapshot under the NEXT trading day's `date` column, so
  // a bare min/max(timestamp) WHERE date=... picks that stray row (e.g. a 06-04
  // 15:14 CT row labeled 06-05) instead of the day's real open/midday/close
  // profile. Restricting every anchor to rows whose ACTUAL CT date == the trading
  // day excludes it. (`timestamp` is unqualified inside these CTEs.)
  const ctDate = sql.unsafe(`date(timestamp AT TIME ZONE 'America/Chicago')`);

  // The anchor CTE selects the single timestamp whose profile we read. Each
  // arm resolves to one `ts`; the outer query then pulls that minute's strikes.
  const anchorCte =
    anchor === 'open'
      ? sql`
          SELECT min(timestamp) AS ts
          FROM gex_strike_0dte
          WHERE date = ${dateIso}::date AND ${ctDate} = ${dateIso}::date
        `
      : anchor === 'midday'
        ? sql`
            SELECT min(timestamp) AS ts
            FROM gex_strike_0dte
            WHERE date = ${dateIso}::date AND ${ctDate} = ${dateIso}::date
              AND ${sql.unsafe(ctMinExpr('timestamp'))} >= ${REGIME_0DTE.MIDDAY_AFTER_MIN}
          `
        : sql`
            SELECT max(timestamp) AS ts
            FROM gex_strike_0dte
            WHERE date = ${dateIso}::date AND ${ctDate} = ${dateIso}::date
          `;

  // For `'midday'`, fall back to the latest minute when no minute reached
  // 12:30 CT (a short/early-close session). COALESCE keeps it a single query.
  const fallbackTs =
    anchor === 'midday'
      ? sql`
          , latest_fallback AS (
            SELECT max(timestamp) AS ts
            FROM gex_strike_0dte
            WHERE date = ${dateIso}::date AND ${ctDate} = ${dateIso}::date
          )`
      : sql``;
  const tsExpr =
    anchor === 'midday'
      ? sql`COALESCE((SELECT ts FROM anchor), (SELECT ts FROM latest_fallback))`
      : sql`(SELECT ts FROM anchor)`;

  const rows = (await withRetry(
    () => sql`
      WITH anchor AS (${anchorCte})${fallbackTs}
      SELECT g.strike, g.call_gamma_oi, g.put_gamma_oi, g.price
      FROM gex_strike_0dte g
      WHERE g.date = ${dateIso}::date AND g.timestamp = ${tsExpr}
      ORDER BY g.strike
    `,
  )) as {
    strike: Numeric;
    call_gamma_oi: Numeric;
    put_gamma_oi: Numeric;
    price: Numeric;
  }[];

  const strikes: GexStrike[] = rows.map((r) => ({
    strike: Number(r.strike),
    netGex: Number(r.call_gamma_oi ?? 0) + Number(r.put_gamma_oi ?? 0),
  }));
  const first = rows[0];
  const spot = first && first.price != null ? Number(first.price) : null;
  return { strikes, spot };
}

/**
 * Nearest-to-spot SPXW 0DTE put IV per CT minute for `dateIso`.
 * One point per minute (the strike closest to that minute's spot), with
 * obviously-broken IVs (≤0 or ≥3) filtered out.
 */
export async function getPutIvSeries(dateIso: string): Promise<IvPoint[]> {
  const sql = getDb();
  const rows = (await withRetry(
    () => sql`
      WITH pts AS (
        SELECT ${sql.unsafe(ctMinExpr('ts'))} AS ct_min,
               iv_mid,
               abs(strike - spot) AS dist
        FROM strike_iv_snapshots
        WHERE ticker = 'SPXW'
          AND side = 'put'
          AND expiry = ${dateIso}::date
          AND date(ts AT TIME ZONE 'America/Chicago') = ${dateIso}::date
      )
      SELECT DISTINCT ON (ct_min) ct_min, iv_mid
      FROM pts
      ORDER BY ct_min, dist
    `,
  )) as { ct_min: Numeric; iv_mid: Numeric }[];

  return rows
    .map((r) => ({ ctMin: Number(r.ct_min), iv: Number(r.iv_mid ?? 0) }))
    .filter((p) => p.iv > 0 && p.iv < 3);
}

/**
 * 30-min SPX regular-session candles for `dateIso`, bucketed by CT
 * minute-of-day. Each bucket takes the first 1-min bar's open and the last
 * 1-min bar's close. `ctMin` is the bucket start (e.g. 510 = 08:30 CT).
 */
export async function getCandles30(dateIso: string): Promise<Candle30[]> {
  const sql = getDb();
  const rows = (await withRetry(
    () => sql`
      WITH b AS (
        SELECT (${sql.unsafe(ctMinExpr('timestamp'))} / 30) * 30 AS ct_min,
               ${sql.unsafe(ctMinExpr('timestamp'))} AS m,
               open, close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND date = ${dateIso}::date
          AND market_time = 'r'
      )
      SELECT ct_min,
             (array_agg(open ORDER BY m ASC))[1]  AS bopen,
             (array_agg(close ORDER BY m DESC))[1] AS bclose
      FROM b
      GROUP BY ct_min
      ORDER BY ct_min
    `,
  )) as {
    ct_min: Numeric;
    bopen: Numeric;
    bclose: Numeric;
  }[];

  return rows.map((r) => ({
    ctMin: Number(r.ct_min),
    open: Number(r.bopen ?? 0),
    close: Number(r.bclose ?? 0),
  }));
}
