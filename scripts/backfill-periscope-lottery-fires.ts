/**
 * Historical backfill for periscope_lottery_fires.
 *
 * Walks distinct expiry values in periscope_snapshots and runs the v3
 * strict filter (the same logic the live cron uses) across EVERY
 * slice-pair in each day, not just the latest. Upserts qualifying
 * fires with ON CONFLICT DO NOTHING — idempotent re-runs.
 *
 * Outcomes (peak_px, peak_pct, realized_r_*) are NOT filled here —
 * `ws_option_trades` retention is 2 days, so historical days have no
 * trade data on hand. Run `scripts/backfill_periscope_lottery_outcomes.py`
 * after this script to backfill realized outcomes from the local
 * parquet archive.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfill-periscope-lottery-fires.ts
 *   npx tsx scripts/backfill-periscope-lottery-fires.ts --dry-run
 *   npx tsx scripts/backfill-periscope-lottery-fires.ts --start 2026-04-13 --end 2026-05-16
 *   npx tsx scripts/backfill-periscope-lottery-fires.ts 2026-04-23
 */

import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';

// Load DATABASE_URL from .env.local before the lib initializes getDb().
loadEnv({ path: '.env.local' });

import {
  detectCallLotteryAllForDate,
  detectPutLotteryAllForDate,
} from '../api/_lib/periscope-lottery-finder.js';
import type { PeriscopeLotteryFire } from '../api/_lib/periscope-lottery-types.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL — copy .env.local from Vercel first.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ── Args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const startIdx = args.indexOf('--start');
const endIdx = args.indexOf('--end');
const startDate = startIdx >= 0 ? args[startIdx + 1] : null;
const endDate = endIdx >= 0 ? args[endIdx + 1] : null;
// Date-shaped tokens that are NOT the value of --start/--end.
const consumedByFlags = new Set<number>();
if (startIdx >= 0) consumedByFlags.add(startIdx + 1);
if (endIdx >= 0) consumedByFlags.add(endIdx + 1);
const explicitDates = args.filter(
  (a, i) => /^\d{4}-\d{2}-\d{2}$/.test(a) && !consumedByFlags.has(i),
);

// ── Date discovery ────────────────────────────────────────────────────

async function getDates(): Promise<string[]> {
  if (explicitDates.length > 0) return explicitDates;
  const rows = (await sql`
    SELECT DISTINCT expiry::text AS d
    FROM periscope_snapshots
    WHERE (${startDate}::date IS NULL OR expiry >= ${startDate}::date)
      AND (${endDate}::date IS NULL OR expiry <= ${endDate}::date)
    ORDER BY d
  `) as { d: string }[];
  return rows.map((r) => r.d);
}

// ── Upsert ────────────────────────────────────────────────────────────

async function upsertFire(f: PeriscopeLotteryFire): Promise<boolean> {
  const result = (await sql`
    INSERT INTO periscope_lottery_fires (
      fire_type, fire_time, expiry, event_strike, trade_strike,
      spot_at_event, strike_dist, greek_post, greek_delta,
      greek_lvl_rank, greek_chg_rank,
      gex_dollars, call_ratio, qqq_net_prem_balance_30m,
      entry_px, vix,
      v3_strict_pass, v4_badge
    ) VALUES (
      ${f.fireType}, ${f.fireTime.toISOString()}, ${f.expiry},
      ${f.eventStrike}, ${f.tradeStrike},
      ${f.spotAtEvent}, ${f.strikeDist},
      ${f.greekPost}, ${f.greekDelta},
      ${f.greekLvlRank}, ${f.greekChgRank},
      ${f.gexDollars}, ${f.callRatio}, ${f.qqqNetPremBalance30m},
      ${f.entryPx}, ${f.vix},
      ${f.v3StrictPass}, ${f.v4Badge}
    )
    ON CONFLICT (fire_type, fire_time, event_strike) DO NOTHING
    RETURNING id
  `) as { id: number }[];
  return result.length > 0;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dates = await getDates();
  if (dates.length === 0) {
    console.log('No dates found in periscope_snapshots for the given range.');
    return;
  }

  console.log(
    `Backfilling ${dates.length} expiry day(s): ${dates[0]} → ${dates.at(-1)}${
      dryRun ? ' (dry-run)' : ''
    }`,
  );

  const totals = {
    callCandidates: 0,
    callInserted: 0,
    putCandidates: 0,
    putInserted: 0,
  };

  for (const expiry of dates) {
    const calls = await detectCallLotteryAllForDate(expiry);
    const puts = await detectPutLotteryAllForDate(expiry);
    totals.callCandidates += calls.length;
    totals.putCandidates += puts.length;

    let callIns = 0;
    let putIns = 0;
    if (!dryRun) {
      for (const f of calls) if (await upsertFire(f)) callIns += 1;
      for (const f of puts) if (await upsertFire(f)) putIns += 1;
    }
    totals.callInserted += callIns;
    totals.putInserted += putIns;

    console.log(
      `  ${expiry}: calls=${calls.length} (${callIns}↑) · puts=${puts.length} (${putIns}↑)`,
    );
  }

  console.log('\nDone.');
  console.log(`  Call candidates:  ${totals.callCandidates}`);
  console.log(`  Call inserted:    ${totals.callInserted}`);
  console.log(`  Put candidates:   ${totals.putCandidates}`);
  console.log(`  Put inserted:     ${totals.putInserted}`);
  if (dryRun) console.log('  (no DB writes — dry-run mode)');
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
