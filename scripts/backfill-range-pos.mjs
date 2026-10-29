#!/usr/bin/env node

/**
 * Backfill lottery_finder_fires.range_pos_at_trigger: the fire's spot
 * position in its underlying's session range at trigger time, behind the
 * "NEW HIGH" badge. The cron stopped filling it on 2026-05-18 (it called
 * UW without a key and swallowed the 401); spec:
 * docs/superpowers/specs/range-pos-fix-and-backfill-2026-10-28.md, Phase 2.
 *
 * For each (underlying, date) with NULL rows:
 *   1. one UW GET /stock/{ticker}/ohlc/1m?date= (3 at a time, one retry on
 *      5xx / 429 / network / timeout);
 *   2. range_pos per fire with the cron's computeRangePos, from the fire's
 *      trigger time and spot_at_first;
 *   3. batched `UPDATE … FROM unnest(...)` in ≤500-row chunks, guarded by
 *      `range_pos_at_trigger IS NULL`, so a re-run (or a killed run) only
 *      fills what is still empty.
 *
 * Skipped by design: cash-index roots (UW answers 422,
 * `cboe_index_access_missing`) and today's in-progress session. A day UW
 * has no candles for, a fire with no candle before its trigger, a flat
 * range or a NULL spot stays NULL and is counted in the report.
 *
 * Runs against whatever DATABASE_URL points at (.env.local = PRODUCTION).
 * Refuses to start 08:15–15:30 CT on weekdays: its 3 UW calls in flight
 * skip the shared Redis semaphore and compete with the production crons
 * for the key's concurrency cap (see isMarketHoursCt).
 *
 * Usage (from the repo root; the key and URL are never printed):
 *   node --env-file=.env.local scripts/backfill-range-pos.mjs [flags]
 *
 * Flags:
 *   --dry-run             fetch and compute, write nothing
 *   --limit N             at most N ticker-days (newest first); prints the
 *                         projected time for every ticker-day still NULL
 *   --from YYYY-MM-DD     first trading date (inclusive)
 *   --to YYYY-MM-DD       last trading date (inclusive)
 *   --allow-market-hours  start even inside the 08:15–15:30 CT window
 */

import { neon } from '@neondatabase/serverless';

import {
  CASH_INDEX_ROOTS,
  chunk,
  fetchDayCandles,
  isMarketHoursCt,
  mergeMonthCounts,
  parseArgs,
  rangePosUpdates,
  redact,
  retryTransientDb,
  runPool,
  selectionWindow,
  summarizeFailures,
  takeReadyChunks,
} from './_lib/range-pos-backfill.mjs';

/** UW's plan allows 3 requests in flight per key. */
const UW_CONCURRENCY = 3;
/** Rows per UPDATE (R5). */
const UPDATE_CHUNK = 500;
/** Progress heartbeat when no batch has been written for a while. */
const HEARTBEAT_EVERY_DAYS = 100;

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

if (isMarketHoursCt() && !args.allowMarketHours) {
  console.error(
    'Refusing to run 08:15–15:30 CT on a weekday: the backfill would compete ' +
      "with the live crons for UW's concurrency cap. Run after the close, or " +
      'pass --allow-market-hours (e.g. on a market holiday).',
  );
  process.exit(3);
}

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
for (const [name, value] of [
  ['UW_API_KEY', UW_API_KEY],
  ['DATABASE_URL', DATABASE_URL],
]) {
  if (!value) {
    console.error(`Missing ${name} (run with --env-file=.env.local)`);
    process.exit(1);
  }
}

const secrets = { uwKey: UW_API_KEY, databaseUrl: DATABASE_URL };
const say = (line = '') => console.log(redact(line, secrets));

const sql = neon(DATABASE_URL);
const { from, to, before } = selectionWindow(args);
const indexRoots = [...CASH_INDEX_ROOTS];

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

async function monthCounts() {
  return retryTransientDb(
    () => sql`
      SELECT
        to_char(date, 'YYYY-MM') AS month,
        COUNT(*)::int AS fires,
        COUNT(*) FILTER (WHERE range_pos_at_trigger IS NULL)::int AS null_all,
        COUNT(*) FILTER (
          WHERE range_pos_at_trigger IS NULL
            AND underlying_symbol = ANY(${indexRoots}::text[])
        )::int AS null_index
      FROM lottery_finder_fires
      WHERE date < ${before}::date
        AND (${from}::date IS NULL OR date >= ${from}::date)
        AND (${to}::date IS NULL OR date <= ${to}::date)
      GROUP BY 1
      ORDER BY 1
    `,
  );
}

async function selectTickerDays(limit) {
  return retryTransientDb(
    () => sql`
      SELECT
        underlying_symbol AS ticker,
        to_char(date, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS fires
      FROM lottery_finder_fires
      WHERE range_pos_at_trigger IS NULL
        AND NOT (underlying_symbol = ANY(${indexRoots}::text[]))
        AND date < ${before}::date
        AND (${from}::date IS NULL OR date >= ${from}::date)
        AND (${to}::date IS NULL OR date <= ${to}::date)
      GROUP BY underlying_symbol, date
      ORDER BY date DESC, underlying_symbol
      LIMIT ${limit}::int
    `,
  );
}

async function readNullFires(day) {
  return retryTransientDb(
    () => sql`
      SELECT id, trigger_time_ct, spot_at_first::float8 AS spot
      FROM lottery_finder_fires
      WHERE underlying_symbol = ${day.ticker}
        AND date = ${day.date}::date
        AND range_pos_at_trigger IS NULL
    `,
  );
}

/**
 * One UPDATE for up to UPDATE_CHUNK rows. Positions go over as text into
 * numeric[] so each stored value matches what the cron's numeric bind
 * writes. Returns how many rows were still NULL and got filled.
 */
async function writeChunk(ids, positions) {
  if (args.dryRun) return ids.length;
  const [{ n }] = await retryTransientDb(
    () => sql`
      WITH filled AS (
        UPDATE lottery_finder_fires AS f
        SET range_pos_at_trigger = v.pos
        FROM unnest(
          ${ids}::bigint[],
          ${positions.map(String)}::numeric[]
        ) AS v(id, pos)
        WHERE f.id = v.id
          AND f.range_pos_at_trigger IS NULL
        RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM filled
    `,
  );
  return n;
}

const stats = {
  daysTotal: 0,
  daysDone: 0,
  daysOk: 0,
  rowsComputed: 0,
  rowsWritten: 0,
  rowsAlreadyFilled: 0,
  rowsLeftNull: 0,
  batches: 0,
};
const noCandleDays = [];
const failures = [];
let pending = { ids: [], positions: [] };
const startedAt = Date.now();

function progress(prefix) {
  const elapsed = Date.now() - startedAt;
  const pct = ((stats.daysDone / Math.max(1, stats.daysTotal)) * 100).toFixed(
    1,
  );
  const perDay = elapsed / Math.max(1, stats.daysDone);
  const eta = formatDuration(perDay * (stats.daysTotal - stats.daysDone));
  say(
    `${prefix} · ticker-days ${stats.daysDone}/${stats.daysTotal} (${pct}%)` +
      ` · elapsed ${formatDuration(elapsed)} · eta ${eta}`,
  );
}

/**
 * Write every full chunk in `pending`, or everything when `final`. The
 * swap to `rest` happens before the first await, so the 3 lanes can
 * never write the same rows twice.
 */
async function flush(final) {
  const { chunks, rest } = takeReadyChunks(pending, UPDATE_CHUNK, final);
  pending = rest;
  for (const c of chunks) {
    const written = await writeChunk(c.ids, c.positions);
    stats.batches++;
    stats.rowsWritten += written;
    stats.rowsAlreadyFilled += c.ids.length - written;
    const verb = args.dryRun ? 'would write' : 'wrote';
    progress(
      `[batch ${stats.batches}] ${verb} ${written}/${c.ids.length} rows`,
    );
  }
}

async function processTickerDay(day) {
  const outcome = await fetchDayCandles(UW_API_KEY, day.ticker, day.date);
  if (outcome.kind === 'error') {
    failures.push({ ticker: day.ticker, date: day.date, ...outcome });
    stats.rowsLeftNull += day.fires;
  } else if (outcome.kind === 'empty') {
    noCandleDays.push(`${day.ticker} ${day.date}`);
    stats.rowsLeftNull += day.fires;
  } else {
    stats.daysOk++;
    const fires = await readNullFires(day);
    const { ids, positions, leftNull } = rangePosUpdates(
      fires,
      outcome.candles,
    );
    stats.rowsComputed += ids.length;
    stats.rowsLeftNull += leftNull;
    for (let k = 0; k < ids.length; k++) {
      pending.ids.push(ids[k]);
      pending.positions.push(positions[k]);
    }
    await flush(false);
  }
  stats.daysDone++;
  if (stats.daysDone % HEARTBEAT_EVERY_DAYS === 0) progress('[progress]');
}

function printReport(beforeCounts, afterCounts) {
  const elapsed = Date.now() - startedAt;
  say();
  say(`── range_pos backfill report (${args.dryRun ? 'DRY RUN' : 'write'}) ──`);
  say(
    `window: ${from ?? 'start'} → ${to ?? 'latest'}, before ${before} (CT today); ` +
      `index roots skipped: ${indexRoots.join(', ')}`,
  );
  say(
    `ticker-days: ${stats.daysDone}/${stats.daysTotal} done · ` +
      `${stats.daysOk} with candles · ${noCandleDays.length} without · ` +
      `${failures.length} failed`,
  );
  const writeVerb = args.dryRun ? 'would write' : 'written';
  say(
    `fires: ${stats.rowsComputed} computed · ${stats.rowsWritten} ${writeVerb} · ` +
      `${stats.rowsAlreadyFilled} already filled · ` +
      `${stats.rowsLeftNull} left NULL`,
  );
  // "Already filled" = rows another run filled first, or rows of a chunk
  // whose UPDATE committed but whose response was lost (timeout, blip), so
  // the retry found them filled. A stat only; the stored values are right.
  say(
    '  (already filled: by another run, or by an UPDATE that committed ' +
      'before its response was lost and was retried; the data is correct)',
  );
  const minutes = Math.max(elapsed, 1_000) / 60_000;
  const rate = stats.daysDone / minutes;
  say(
    `elapsed: ${formatDuration(elapsed)} · ${rate.toFixed(1)} ticker-days/min · ` +
      `${stats.batches} batches`,
  );

  const rows = mergeMonthCounts(beforeCounts, afterCounts);
  say();
  say(
    afterCounts == null
      ? 'NULL range_pos by month (dry run: unchanged):'
      : 'NULL range_pos by month (before → after):',
  );
  say(
    'month    ' +
      ['fires', 'null before', 'null after', 'filled', 'null index']
        .map((h) => h.padStart(12))
        .join(''),
  );
  const totals = {
    fires: 0,
    nullBefore: 0,
    nullAfter: 0,
    filled: 0,
    nullIndex: 0,
  };
  for (const r of rows) {
    for (const key of Object.keys(totals)) totals[key] += r[key];
    say(
      r.month.padEnd(9) +
        [r.fires, r.nullBefore, r.nullAfter, r.filled, r.nullIndex]
          .map((v) => String(v).padStart(12))
          .join(''),
    );
  }
  say(
    'total    ' +
      [
        totals.fires,
        totals.nullBefore,
        totals.nullAfter,
        totals.filled,
        totals.nullIndex,
      ]
        .map((v) => String(v).padStart(12))
        .join(''),
  );

  say();
  say(`ticker-days with no candles from UW (${noCandleDays.length}):`);
  for (const line of chunk(noCandleDays.sort(), 6))
    say(`  ${line.join(' · ')}`);

  say();
  say(`UW failures by status (${failures.length}):`);
  for (const f of summarizeFailures(failures)) {
    const e = f.example;
    say(
      `  ${f.status.padEnd(10)} ${String(f.count).padStart(5)}  e.g. ${e.ticker} ${e.date}: ${e.detail}`,
    );
  }
}

async function main() {
  say(
    `range_pos backfill${args.dryRun ? ' (DRY RUN: no writes)' : ''} · ` +
      `limit ${args.limit ?? 'none'}`,
  );
  const beforeCounts = await monthCounts();
  const days = await selectTickerDays(args.limit);
  stats.daysTotal = days.length;
  say(
    `${days.length} ticker-days to fill (${days.reduce((n, d) => n + d.fires, 0)} NULL fires)`,
  );

  await runPool(days, UW_CONCURRENCY, processTickerDay);
  await flush(true);

  const afterCounts = args.dryRun ? null : await monthCounts();
  printReport(beforeCounts, afterCounts);

  // Timing probe: scale this run's pace to every ticker-day still NULL in
  // the window (after a write run, that excludes the ones just filled).
  if (args.limit != null && stats.daysDone > 0) {
    const eligible = (await selectTickerDays(null)).length;
    const perDay = (Date.now() - startedAt) / stats.daysDone;
    say();
    say(
      `projection: ${eligible} ticker-days still NULL in the window; at ` +
        `this pace a full run takes ≈ ${formatDuration(perDay * eligible)}`,
    );
  }

  // Failures are worth a re-run (it only touches rows still NULL).
  if (failures.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(redact(`backfill aborted: ${err?.message ?? err}`, secrets));
  console.error(
    redact(
      `progress so far: ${stats.daysDone}/${stats.daysTotal} ticker-days, ` +
        `${stats.rowsWritten} rows written; re-run to resume`,
      secrets,
    ),
  );
  process.exitCode = 1;
}
