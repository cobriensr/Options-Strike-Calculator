#!/usr/bin/env npx tsx

/**
 * Local backfill script for `zero_gamma_levels`. Reads existing
 * `strike_exposures` snapshots written by `backfill-strike-exposure.mjs`
 * (or by the live cron), computes the zero-gamma level + curve in memory
 * using the same `computeZeroGammaLevel` calculator the live cron uses,
 * and inserts one `zero_gamma_levels` row per (ticker, snapshot timestamp).
 *
 * Per-ticker behavior mirrors the live `compute-zero-gamma` cron:
 *   - SPX/SPY/QQQ → primary expiry = the snapshot's `date`
 *   - NDX → primary expiry = front Mon/Wed/Fri (handled by getPrimaryExpiry)
 *
 * Confidence gating identical to the live cron: zero_gamma is stored NULL
 * when confidence < 0.5; the row + curve are still preserved for diagnostics.
 *
 * Idempotency: deletes existing `zero_gamma_levels` rows in the date range
 * for each ticker before re-inserting. Safe to re-run with the same window.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/backfill-zero-gamma.ts
 *
 * Options:
 *   npx tsx scripts/backfill-zero-gamma.ts 5    # 5 days instead of 30
 *
 * Prerequisite:
 *   `strike_exposures` must be populated for the target date range. Run
 *   `node scripts/backfill-strike-exposure.mjs N` first.
 */

import { neon } from '@neondatabase/serverless';
import {
  computeZeroGammaLevel,
  type GexStrike,
} from '../api/_lib/zero-gamma.ts';
import {
  ZERO_GAMMA_TICKERS,
  getPrimaryExpiry,
  type ZeroGammaTicker,
} from '../api/_lib/zero-gamma-tickers.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const CONFIDENCE_MIN = 0.5;

const days = Number.parseInt(process.argv[2] ?? '30', 10);

// ── Helpers ─────────────────────────────────────────────────

function getTradingDays(count: number): string[] {
  const dates: string[] = [];
  const d = new Date();

  const today = d.getDay();
  if (today !== 0 && today !== 6) {
    dates.push(d.toISOString().slice(0, 10));
  }

  while (dates.length < count) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    dates.push(d.toISOString().slice(0, 10));
  }

  return dates.reverse();
}

function netGammaAtSpot(
  curve: Array<{ spot: number; netGamma: number }>,
  spot: number,
): number | null {
  if (curve.length === 0) return null;
  let best = curve[0]!;
  let bestDist = Math.abs(best.spot - spot);
  for (let i = 1; i < curve.length; i += 1) {
    const pt = curve[i]!;
    const dist = Math.abs(pt.spot - spot);
    if (dist < bestDist) {
      best = pt;
      bestDist = dist;
    }
  }
  return best.netGamma;
}

// ── Snapshot loader ─────────────────────────────────────────

interface StrikeRow {
  strike: string | number;
  price: string | number;
  call_gamma_oi: string | number | null;
  put_gamma_oi: string | number | null;
  timestamp: string | Date;
}

interface Snapshot {
  ts: string;
  spot: number;
  strikes: GexStrike[];
}

/**
 * Load every distinct snapshot for (ticker, date, expiry). One row per
 * unique `timestamp` in `strike_exposures`. Backfill runs typically yield
 * 1 timestamp per date (UW returns a single most-recent snapshot); live
 * data yields up to 78 timestamps per date.
 */
async function loadSnapshots(
  ticker: ZeroGammaTicker,
  date: string,
  expiry: string,
): Promise<Snapshot[]> {
  const tsRows = (await sql`
    SELECT DISTINCT timestamp AS ts
    FROM strike_exposures
    WHERE date = ${date}
      AND ticker = ${ticker}
      AND expiry = ${expiry}
    ORDER BY timestamp ASC
  `) as Array<{ ts: string | Date }>;

  if (tsRows.length === 0) return [];

  const snapshots: Snapshot[] = [];
  for (const { ts } of tsRows) {
    const tsIso =
      ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();

    const rows = (await sql`
      SELECT strike, price, call_gamma_oi, put_gamma_oi, timestamp
      FROM strike_exposures
      WHERE date = ${date}
        AND ticker = ${ticker}
        AND expiry = ${expiry}
        AND timestamp = ${tsIso}
      ORDER BY strike ASC
    `) as StrikeRow[];

    if (rows.length === 0) continue;

    const spot = Number(rows[0]!.price);
    if (!Number.isFinite(spot) || spot <= 0) continue;

    const strikes: GexStrike[] = [];
    for (const r of rows) {
      const strike = Number(r.strike);
      if (!Number.isFinite(strike)) continue;
      const callGamma = r.call_gamma_oi == null ? 0 : Number(r.call_gamma_oi);
      const putGamma = r.put_gamma_oi == null ? 0 : Number(r.put_gamma_oi);
      const gamma =
        (Number.isFinite(callGamma) ? callGamma : 0) +
        (Number.isFinite(putGamma) ? putGamma : 0);
      if (gamma === 0) continue;
      strikes.push({ strike, gamma });
    }

    if (strikes.length === 0) continue;

    snapshots.push({ ts: tsIso, spot, strikes });
  }

  return snapshots;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);
  const startDate = tradingDays[0]!;
  const endDate = tradingDays.at(-1)!;

  console.log(
    `Backfilling zero_gamma_levels for ${ZERO_GAMMA_TICKERS.join(', ')}`,
  );
  console.log(`Days: ${tradingDays.length} (${startDate} to ${endDate})\n`);

  // Idempotency: clear existing rows in the date range per ticker so a
  // re-run produces the same data without duplicates.
  for (const ticker of ZERO_GAMMA_TICKERS) {
    const deleted = (await sql`
      DELETE FROM zero_gamma_levels
      WHERE ticker = ${ticker}
        AND ts >= ${startDate}::date
        AND ts < (${endDate}::date + INTERVAL '1 day')
      RETURNING id
    `) as Array<{ id: number }>;
    if (deleted.length > 0) {
      console.log(`  cleared ${deleted.length} existing ${ticker} rows`);
    }
  }
  console.log('');

  const totals: Record<
    string,
    { snapshots: number; stored: number; lowConf: number }
  > = {};
  for (const ticker of ZERO_GAMMA_TICKERS) {
    totals[ticker] = { snapshots: 0, stored: 0, lowConf: 0 };
  }

  for (const date of tradingDays) {
    const dailySummary: string[] = [];
    for (const ticker of ZERO_GAMMA_TICKERS) {
      const expiry = getPrimaryExpiry(ticker, date);
      const snapshots = await loadSnapshots(ticker, date, expiry);

      if (snapshots.length === 0) {
        dailySummary.push(`${ticker}: no snapshot`);
        continue;
      }

      let storedHere = 0;
      let lowConfHere = 0;
      let lastLevel: number | null = null;
      let lastSpot: number | null = null;

      for (const snap of snapshots) {
        const result = computeZeroGammaLevel(snap.strikes, snap.spot);
        const zeroGamma =
          result.level != null && result.confidence >= CONFIDENCE_MIN
            ? result.level
            : null;
        if (zeroGamma == null) lowConfHere += 1;
        const netGamma = netGammaAtSpot(result.curve, snap.spot);

        await sql`
          INSERT INTO zero_gamma_levels (
            ticker, spot, zero_gamma, confidence,
            net_gamma_at_spot, gamma_curve, ts
          )
          VALUES (
            ${ticker}, ${snap.spot}, ${zeroGamma}, ${result.confidence},
            ${netGamma}, ${JSON.stringify(result.curve)}::jsonb, ${snap.ts}
          )
        `;
        storedHere += 1;
        lastLevel = zeroGamma;
        lastSpot = snap.spot;
      }

      totals[ticker]!.snapshots += snapshots.length;
      totals[ticker]!.stored += storedHere;
      totals[ticker]!.lowConf += lowConfHere;

      const levelDisplay =
        lastLevel != null
          ? `ZG=${lastLevel.toFixed(2)} (Δ${(lastSpot! - lastLevel).toFixed(2)})`
          : `ZG=null`;
      dailySummary.push(
        `${ticker}: ${storedHere} snap${storedHere === 1 ? '' : 's'}, ${levelDisplay}`,
      );
    }
    console.log(`  ${date}: ${dailySummary.join(' | ')}`);
  }

  console.log('\nDone!');
  for (const ticker of ZERO_GAMMA_TICKERS) {
    const t = totals[ticker]!;
    const pct = t.stored > 0 ? Math.round((t.lowConf / t.stored) * 100) : 0;
    console.log(
      `  ${ticker}: ${t.stored} rows stored (${t.lowConf} low-confidence = ${pct}%)`,
    );
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
