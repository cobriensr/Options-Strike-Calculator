#!/usr/bin/env tsx
/**
 * One-shot backfill of ws_gamma_setup_fires from historical SPX 1-min
 * candles + periscope_snapshots + futures_bars (ES) + vol_realized.
 *
 * Walks every RTH minute since the index_candles_1m table was populated
 * (~2026-02-26) and simulates what the live `detect-gamma-setups` cron
 * would have inserted at each minute. Uses the production
 * `api/_lib/gamma-detector.ts` pure functions directly so the backfill
 * is cycle-accurate with what live will produce going forward.
 *
 * After the bar-by-bar pass completes, also fills ret_15/30/60m/eod
 * for every inserted fire by replaying the EOD-outcome backfill logic
 * inline (so we end up with a fully-resolved historical ledger in one
 * pass).
 *
 * The logic is in scripts/_lib/gamma-fires-backfill.ts (its header says what
 * each mode does); this file loads the env, opens the DB handle and calls it.
 * It READS and WRITES the database DATABASE_URL points at: production, in
 * .env.local.
 *
 * Run:   npx tsx scripts/backfill-gamma-setup-fires.ts
 * Args:  --from YYYY-MM-DD --to YYYY-MM-DD  (default: all available history).
 *          Inclusive ET session dates. Passing either one also limits the
 *          outcome fill to that window; with neither it stays table-wide.
 *        --include-gexbot  also read GEXBot-era Periscope rows (see below)
 *        --dry-run         print `date  fires` per session date and write
 *                          nothing; never reads ws_gamma_setup_fires
 *        --outcomes-only   no detection, no insert: fill ret_* of the fires
 *                          in the window (not clamped to the cutover)
 *        --context-only    no detection, no insert, no outcome fill: recompute
 *                          prior_5d_ret, prior_iv_rank, pre_day_filter_fires,
 *                          open_gap_pct and confidence_tier of each date's
 *                          fires. Needs --from and --to; with --dry-run it
 *                          prints stored and new values and writes nothing
 *                          (the one dry run that reads the table)
 *
 * Exit codes: 0 done, 1 any failure (a DB error included), 2 a bad flag.
 *
 * Scraper-era rows only by default: E1/E5/PCS were tuned on UW Periscope
 * data, and every snapshot since 2026-05-26 is GEXBot taker flow (owner
 * decision D1 revised, 2026-10-29). `--include-gexbot` opts in, with a warning.
 *
 * Idempotent: UNIQUE(fired_at, signal_type, node_strike) on the table +
 * `ON CONFLICT DO NOTHING` on insert means re-running is safe and only
 * inserts new fires. Re-running the outcome fill also only touches rows
 * where ret_30m is still NULL.
 */

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

import { runGammaBackfill } from './_lib/gamma-fires-backfill.js';

async function main(): Promise<number> {
  config({ path: '.env.local' });
  const url =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL_UNPOOLED not set');
  return runGammaBackfill(process.argv.slice(2), neon(url));
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
