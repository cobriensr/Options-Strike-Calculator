/**
 * Backfill opening_flow_signals for a date range.
 *
 * Phase 6 of opening-flow-signal-historical-persistence-2026-05-19. The
 * capture cron only fills forward from the day it ships, but
 * `ws_option_trades` retains 2 days. Run this script on deploy day to
 * land yesterday's snapshot in the table before the trades age out.
 *
 * What it does for each date in the requested range:
 *   1. Calls `evaluateOpeningFlow(date)` — same evaluator the live
 *      endpoint and the cron use, so payload shape is byte-identical.
 *   2. UPSERTs one row per (date, ticker) into `opening_flow_signals`
 *      with the same `ON CONFLICT DO UPDATE` clause the cron uses.
 *   3. Logs a one-line summary per date.
 *
 * Usage:
 *     set -a; source .env.local; set +a
 *     # Single date:
 *     npx tsx scripts/backfill-opening-flow-signal.ts 2026-05-18
 *     # Date range (inclusive):
 *     npx tsx scripts/backfill-opening-flow-signal.ts 2026-05-12 2026-05-16
 *
 * Idempotent — the cron's ON CONFLICT clause means re-running this
 * script overwrites with a fresher snapshot. Safe to run on dates that
 * already have a row.
 *
 * Limitation: only works for dates still inside the `ws_option_trades`
 * retention window. Dates beyond T+2 will produce an empty
 * `windowStatus='closed'` payload (which still gets written — see spec
 * open-question #1) and the UI will render "Data not captured" for
 * those rows.
 */

import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateOpeningFlow } from '../api/_lib/opening-flow-evaluator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

loadEnv({ path: join(REPO_ROOT, '.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set — load .env.local first');
  process.exit(1);
}

// Local SQL setup mirrors the cron's writer. Import getDb dynamically
// AFTER env is loaded so the singleton picks up the right DATABASE_URL.
const { getDb } = await import('../api/_lib/db.js');
const db = getDb();

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function nextDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return dt.toISOString().slice(0, 10);
}

function dateRange(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  let cur = startYmd;
  while (cur <= endYmd) {
    out.push(cur);
    cur = nextDate(cur);
  }
  return out;
}

async function backfillDate(date: string): Promise<{
  date: string;
  rowsWritten: number;
  windowStatus: string;
  hasAnyTicketData: boolean;
}> {
  const result = await evaluateOpeningFlow(date);

  let rowsWritten = 0;
  let hasAnyTicketData = false;
  for (const [ticker, payload] of Object.entries(result.tickers)) {
    if (payload.slice1 || payload.signal) hasAnyTicketData = true;
    await db`
      INSERT INTO opening_flow_signals (
        date, ticker, window_status,
        slice1, slice2, signal,
        as_of_utc, stop_pct, exit_minutes_from_entry,
        updated_at
      ) VALUES (
        ${date}::date, ${ticker}, ${result.windowStatus},
        ${payload.slice1 ? JSON.stringify(payload.slice1) : null}::jsonb,
        ${payload.slice2 ? JSON.stringify(payload.slice2) : null}::jsonb,
        ${payload.signal ? JSON.stringify(payload.signal) : null}::jsonb,
        ${result.asOfUtc}::timestamptz,
        ${result.stopPct},
        ${result.exitMinutesFromEntry},
        NOW()
      )
      ON CONFLICT (date, ticker) DO UPDATE SET
        window_status = EXCLUDED.window_status,
        slice1 = EXCLUDED.slice1,
        slice2 = EXCLUDED.slice2,
        signal = EXCLUDED.signal,
        as_of_utc = EXCLUDED.as_of_utc,
        stop_pct = EXCLUDED.stop_pct,
        exit_minutes_from_entry = EXCLUDED.exit_minutes_from_entry,
        updated_at = NOW()
    `;
    rowsWritten += 1;
  }

  return {
    date,
    rowsWritten,
    windowStatus: result.windowStatus,
    hasAnyTicketData,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length > 2) {
    console.error(
      'Usage: npx tsx scripts/backfill-opening-flow-signal.ts <date> [end-date]',
    );
    console.error('  date format: YYYY-MM-DD (inclusive range)');
    process.exit(1);
  }
  const startYmd = args[0]!;
  const endYmd = args[1] ?? startYmd;
  if (!isYmd(startYmd) || !isYmd(endYmd)) {
    console.error('Dates must be in YYYY-MM-DD format');
    process.exit(1);
  }
  if (endYmd < startYmd) {
    console.error(`end date ${endYmd} is before start ${startYmd}`);
    process.exit(1);
  }

  const dates = dateRange(startYmd, endYmd);
  const rangeLabel = dates.length > 1 ? `${startYmd} .. ${endYmd}` : startYmd;
  console.log(
    `Backfilling opening_flow_signals for ${dates.length} date(s): ${rangeLabel}`,
  );

  let totalRows = 0;
  let totalWithData = 0;
  for (const date of dates) {
    try {
      const r = await backfillDate(date);
      totalRows += r.rowsWritten;
      if (r.hasAnyTicketData) totalWithData += 1;
      const dataTag = r.hasAnyTicketData ? 'data' : 'empty';
      console.log(
        `  ${date}: status=${r.windowStatus} rows=${r.rowsWritten} (${dataTag})`,
      );
    } catch (err) {
      console.error(`  ${date}: FAILED — ${(err as Error).message}`);
    }
  }

  console.log(
    `Done. wrote ${totalRows} row(s) across ${dates.length} date(s); ` +
      `${totalWithData} date(s) had ticker data, ${dates.length - totalWithData} were empty.`,
  );
}

await main();
