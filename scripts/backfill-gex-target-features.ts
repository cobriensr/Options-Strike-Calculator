#!/usr/bin/env npx tsx

/**
 * Local backfill script for gex_target_features (Phase 4, subagent 4B).
 *
 * Iterates historical gex_strike_0dte snapshots for the last N trading
 * days and calls the shared Wave 1 helper (api/_lib/gex-target-features)
 * at each distinct timestamp. The helper is the same code path the live
 * fetch-gex-0dte cron uses, so online and backfilled feature rows are
 * byte-for-byte identical.
 *
 * Every call produces up to 30 rows (10 strikes × 3 modes) and writes
 * them with ON CONFLICT (date, timestamp, mode, strike, math_version)
 * DO NOTHING — so re-runs are safe and a mid-run crash leaves a clean
 * partial state that a second run picks up from.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/backfill-gex-target-features.ts
 *
 * Options:
 *   npx tsx scripts/backfill-gex-target-features.ts 7     # 7 days instead of 30
 *
 * Environment:
 *   DATABASE_URL   Neon Postgres URL (required)
 *
 * Rate limiting: none — this backfill only talks to Neon (no external
 * API), so the loop is left tight. If Neon connection pooling ever
 * becomes a problem, add a small sleep inside processDay.
 *
 * Expected throughput: ~480 snapshots/day × 30 days × ~200ms/snapshot
 * ≈ 15–48 minutes wall-clock for a full 30-day run. Progress is logged
 * every 100 snapshots within a day so the operator can watch it move.
 *
 * Idempotent: safe to run multiple times. Safe to interrupt.
 */

import { neon } from '@neondatabase/serverless';
import {
  loadSnapshotHistory,
  writeFeatureRows,
} from '../api/_lib/gex-target-features.js';

// ── Env ─────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

// Local neon client used ONLY to enumerate distinct timestamps per day.
// The helper's loadSnapshotHistory / writeFeatureRows go through the
// shared getDb() singleton from api/_lib/db.ts, which picks up
// DATABASE_URL from the same process.env — so both paths hit the same
// Neon instance with the same credentials.
const sql = neon(DATABASE_URL);

// ── Config ──────────────────────────────────────────────────

const DEFAULT_DAYS_TO_BACKFILL = 30;

// Match GEX_TARGET_CONFIG.horizonOffsets.h60m + 1 (current) so the
// helper has enough history to compute all four delta horizons at the
// latest snapshot. Short windows near the open simply return fewer
// valid horizons — the helper handles that gracefully.
const HISTORY_SIZE = 61;

// How often to print progress within a single day.
const LOG_EVERY = 100;

// ── Types ───────────────────────────────────────────────────

interface Totals {
  daysProcessed: number;
  daysWithData: number;
  snapshotsProcessed: number;
  rowsWritten: number;
  rowsSkipped: number;
  errors: number;
}

interface TimestampRow {
  ts: string;
}

// ── ET timezone helpers ─────────────────────────────────────
//
// Trading days are computed in ET, not UTC. Using
// Date.toISOString().slice(0,10) gives a UTC date, which is wrong when
// the script is run after 19:00 ET (= 00:00 UTC) — the walk-backward
// iteration would land on the wrong day. These helpers mirror
// scripts/backfill-spx-candles-1m.mjs so the two backfills agree on
// what "last 30 trading days" means.

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ET_DAY_OF_WEEK_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
});

/** Get the ET calendar date for a Date instance, as 'YYYY-MM-DD'. */
function getETDateStr(date: Date): string {
  return ET_DATE_FORMATTER.format(date);
}

/** Get the ET day of week (0=Sun, 6=Sat) for a Date instance. */
function getETDayOfWeek(date: Date): number {
  const name = ET_DAY_OF_WEEK_FORMATTER.format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[name] ?? 0;
}

// ── Generate last N trading days (ending yesterday in ET) ───

function getTradingDays(count: number): string[] {
  const dates: string[] = [];
  const d = new Date();

  // Walk backward in ET, never landing on today's ET date. Subtract one
  // calendar day in UTC first; then the while-loop handles the rare
  // midnight-rollover edge case by checking the ET date explicitly.
  const todayET = getETDateStr(new Date());
  d.setUTCDate(d.getUTCDate() - 1);
  while (getETDateStr(d) === todayET) {
    d.setUTCDate(d.getUTCDate() - 1);
  }

  while (dates.length < count) {
    const day = getETDayOfWeek(d);
    if (day !== 0 && day !== 6) {
      dates.push(getETDateStr(d));
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }

  return dates.reverse();
}

// ── Per-day processing ──────────────────────────────────────

async function processDay(date: string, totals: Totals): Promise<void> {
  // Enumerate every distinct snapshot timestamp for this day. The
  // helper's loadSnapshotHistory walks backward from `asOfTimestamp`,
  // so we feed it each timestamp in chronological order — this
  // produces the same feature-row sequence the cron would have written
  // if it had been running continuously.
  let tsRows: TimestampRow[];
  try {
    // Note: ORDER BY must reference the SELECT-list expression
    // (`ts`), not the raw `timestamp` column — Postgres rejects
    // SELECT DISTINCT + ORDER BY on a non-selected column.
    tsRows = (await sql`
      SELECT DISTINCT timestamp::text AS ts
      FROM gex_strike_0dte
      WHERE date = ${date}
      ORDER BY ts ASC
    `) as TimestampRow[];
  } catch (err) {
    console.warn(
      `  [${date}] timestamp enumeration failed: ${(err as Error).message}`,
    );
    totals.errors++;
    return;
  }

  const timestamps = tsRows.map((r) => r.ts);
  if (timestamps.length === 0) {
    console.log(`  [${date}] no data (holiday or pre-data-pipeline)`);
    return;
  }

  let written = 0;
  let skipped = 0;
  let errors = 0;
  let tooShort = 0;

  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i];
    if (timestamp === undefined) continue;

    try {
      const snapshots = await loadSnapshotHistory(
        date,
        timestamp,
        HISTORY_SIZE,
      );
      if (snapshots.length < 2) {
        // First snapshot of the day has no prior — helper would return
        // zeros anyway, but skipping here avoids the wasted round-trip.
        tooShort++;
        continue;
      }
      const result = await writeFeatureRows(snapshots, date, timestamp);
      written += result.written;
      skipped += result.skipped;
    } catch (err) {
      // writeFeatureRows is defensive and swallows its own errors, so
      // this catch is for truly unexpected failures (e.g. network).
      errors++;
      console.warn(
        `    [${date} ${timestamp}] unexpected error: ${(err as Error).message}`,
      );
    }

    if ((i + 1) % LOG_EVERY === 0) {
      process.stdout.write(
        `  [${date}] ${i + 1}/${timestamps.length} snapshots processed...\r`,
      );
    }
  }

  // Clear the progress line before printing the per-day summary.
  process.stdout.write('\r\x1b[K');

  console.log(
    `  [${date}] ${timestamps.length} snapshots: ${written} rows written, ` +
      `${skipped} skipped (ON CONFLICT), ${tooShort} too-short, ${errors} errors`,
  );

  totals.daysWithData++;
  totals.snapshotsProcessed += timestamps.length;
  totals.rowsWritten += written;
  totals.rowsSkipped += skipped;
  totals.errors += errors;
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const daysArg = args[0];
  const daysToBackfill = daysArg
    ? Number.parseInt(daysArg, 10)
    : DEFAULT_DAYS_TO_BACKFILL;

  if (!Number.isFinite(daysToBackfill) || daysToBackfill <= 0) {
    console.error(
      `Invalid days argument: "${daysArg}". Must be a positive integer.`,
    );
    process.exit(1);
  }

  const startMs = Date.now();
  const tradingDays = getTradingDays(daysToBackfill);

  console.log(
    `Backfilling gex_target_features (${daysToBackfill} trading days)`,
  );
  console.log(
    `Range: ${tradingDays[0]} to ${tradingDays.at(-1)} (skipping weekends)\n`,
  );

  const totals: Totals = {
    daysProcessed: 0,
    daysWithData: 0,
    snapshotsProcessed: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    errors: 0,
  };

  for (const date of tradingDays) {
    totals.daysProcessed++;
    await processDay(date, totals);
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log(`\nBackfill complete.`);
  console.log(`  Days processed:       ${totals.daysProcessed}`);
  console.log(`  Days with data:       ${totals.daysWithData}`);
  console.log(`  Snapshots processed:  ${totals.snapshotsProcessed}`);
  console.log(`  Rows written:         ${totals.rowsWritten}`);
  console.log(`  Rows skipped:         ${totals.rowsSkipped}`);
  console.log(`  Errors:               ${totals.errors}`);
  console.log(`  Duration:             ${durationSec}s`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
