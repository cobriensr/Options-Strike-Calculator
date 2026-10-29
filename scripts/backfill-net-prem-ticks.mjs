#!/usr/bin/env node

/**
 * Historical backfill of `net_flow_per_ticker_history` from UW REST
 * `/stock/{ticker}/net-prem-ticks?date=`. Pulls per-minute net-flow
 * deltas (NCP, NPP, NCV, NPV plus per-ticker bid/ask side splits) for
 * the lottery universe.
 *
 * Specs: docs/superpowers/specs/lottery-net-flow-eda-2026-05-03.md
 *        Phase 1 Task 1.2 (the lookback);
 *        docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md Phase 1
 *        (--from/--to and the guards of scripts/backfill-range-pos.mjs).
 *
 * Which dates:
 *   - default: the last DAYS weekdays ending today, the original
 *     behavior. Resumable: queries MAX(ts) per ticker first and skips a
 *     ticker's dates before its newest one (BYPASS_RESUME=1 fetches them).
 *   - --from/--to: every NYSE trading day in the range, inclusive
 *     (holidays from src/data/marketHours.ts). Fetches every ticker-day:
 *     the resume rule would skip a whole past gap.
 *
 * Idempotent: ON CONFLICT (ticker, ts, source) DO NOTHING, BATCH_SIZE rows
 * per INSERT; a re-run only adds what is missing.
 *
 * Filters (matching session-window memory rules):
 *   - 08:30–15:00 CT (13:30–20:00 UTC) — drop pre/after-market ticks
 *   - skip empty (ticker, date) responses (weekends/holidays)
 *
 * UW: at most UW_REQUESTS_PER_MINUTE (300) requests a minute over
 * CONCURRENCY lanes, one retry on a 5xx/429/network error/timeout. A 4xx or
 * a malformed answer counts as a failed ticker-day (exit 1), never as an
 * empty one. Refuses to start 08:15–15:30 CT on a weekday, and stops
 * taking ticker-days (report, exit 3) when that window opens mid-run: its
 * calls skip the shared Redis semaphore and compete with the production
 * crons.
 *
 * Runs against whatever DATABASE_URL points at (.env.local = PRODUCTION).
 *
 * Usage (from the repo root; the key and URL are never printed):
 *   node --env-file=.env.local scripts/backfill-net-prem-ticks.mjs [flags]
 *
 * Flags:
 *   --dry-run             fetch and parse, write nothing (or DRY_RUN=1)
 *   --limit N             at most N ticker-days (date order); prints the
 *                         projected time for the whole plan
 *   --from YYYY-MM-DD     first trading date (inclusive); needs --to
 *   --to YYYY-MM-DD       last trading date (inclusive); needs --from
 *   --allow-market-hours  start even inside the 08:15–15:30 CT window
 *
 * Optional env:
 *   DAYS=90              — lookback in weekdays when there's no --from/--to
 *   TICKERS=TSLA,NVDA    — comma-separated subset of the lottery list
 *   BATCH_SIZE=500       — rows per batched INSERT
 *   CONCURRENCY=3        — concurrent ticker-day fetches
 *   BYPASS_RESUME=1      — lookback only: fetch the dates resume would skip
 *
 * The lottery ticker universe below is the union of LOTTERY_V3_TICKERS
 * and LOTTERY_EXTENDED_TICKERS in api/_lib/lottery-finder.ts.
 * KEEP IN SYNC with that source — this is a one-shot backfill so a
 * snapshot copy is acceptable; for live ingest, the WS daemon already
 * handles per-ticker subscriptions.
 */

import { neon } from '@neondatabase/serverless';

import {
  NET_FLOW_SOURCE,
  UW_REQUESTS_PER_MINUTE,
  createRequestThrottle,
  fetchNetPremTicks,
  marketHoursRefusal,
  parseArgs,
  planPairs,
  runTickerDays,
  selectDates,
  storeBatch,
  summarizeByDay,
} from './_lib/net-prem-ticks-backfill.mjs';
import {
  redact,
  retryTransientDb,
  summarizeFailures,
} from './_lib/range-pos-backfill.mjs';

// ── Args, guard, env ────────────────────────────────────────

const DAYS = Number.parseInt(process.env.DAYS ?? '90', 10);
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE ?? '500', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '3', 10);
const BYPASS_RESUME = process.env.BYPASS_RESUME === '1';
/** Progress line every this many ticker-days. */
const HEARTBEAT_EVERY = 100;

let args;
let selection;
try {
  args = parseArgs(process.argv.slice(2));
  selection = selectDates(args, DAYS);
  for (const [name, value] of [
    ['BATCH_SIZE', BATCH_SIZE],
    ['CONCURRENCY', CONCURRENCY],
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a whole number ≥ 1, got ${value}`);
    }
  }
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const refusal = marketHoursRefusal(args);
if (refusal) {
  console.error(refusal);
  process.exit(3);
}

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = args.dryRun || process.env.DRY_RUN === '1';

if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY (run with --env-file=.env.local)');
  process.exit(1);
}
if (!DRY_RUN && !DATABASE_URL) {
  console.error('Missing DATABASE_URL (or pass --dry-run to skip writes)');
  process.exit(1);
}

const secrets = { uwKey: UW_API_KEY, databaseUrl: DATABASE_URL };
const say = (line = '') => console.log(redact(line, secrets));
const sql = DRY_RUN ? null : neon(DATABASE_URL);
const waitForSlot = createRequestThrottle(UW_REQUESTS_PER_MINUTE);

// LOTTERY_V3_TICKERS ∪ LOTTERY_EXTENDED_TICKERS (deduped) — see header.
// Last sync: 2026-05-15 (Greek Heatmap Phase 2 backfill kickoff).
const LOTTERY_TICKERS_ALL = [
  'AAOI',
  'AAPL',
  'AMD',
  'AMZN',
  'APLD',
  'APP',
  'ARM',
  'ASTS',
  'AVGO',
  'BA',
  'BABA',
  'BE',
  'CAR',
  'COIN',
  'CRCL',
  'CRWD',
  'CRWV',
  'CSCO',
  'CVNA',
  'DELL',
  'GME',
  'GOOG',
  'GOOGL',
  'HIMS',
  'HOOD',
  'IBIT',
  'IBM',
  'INTC',
  'IONQ',
  'IREN',
  'IWM',
  'LITE',
  'LLY',
  'META',
  'MRVL',
  'MSFT',
  'MSTR',
  'MU',
  'NBIS',
  'NDXP',
  'NFLX',
  'NOW',
  'NVDA',
  'NVTS',
  'OKLO',
  'ORCL',
  'PLTR',
  'POET',
  'QCOM',
  'QQQ',
  'RBLX',
  'RDDT',
  'RGTI',
  'RIOT',
  'RIVN',
  'RKLB',
  'RUTW',
  'SHOP',
  'SLV',
  'SMCI',
  'SMH',
  'SNDK',
  'SNOW',
  'SOFI',
  'SOUN',
  'SOXL',
  'SOXS',
  'SPXW',
  'SPY',
  'SQQQ',
  'STX',
  'TEAM',
  'TLT',
  'TNA',
  'TQQQ',
  'TSLA',
  'TSLL',
  'TSM',
  'UBER',
  'UNH',
  'USAR',
  'USO',
  'WDC',
  'WMT',
  'WULF',
  'XOM',
];

const TICKER_FILTER = (process.env.TICKERS ?? '')
  .split(',')
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
const tickers =
  TICKER_FILTER.length > 0
    ? LOTTERY_TICKERS_ALL.filter((t) => TICKER_FILTER.includes(t))
    : LOTTERY_TICKERS_ALL;
if (tickers.length === 0) {
  console.error(
    `TICKERS=${process.env.TICKERS} matches none of the lottery list`,
  );
  process.exit(2);
}

// ── Session-window filter (08:30–15:00 CT) ───────────────────

// CT == UTC-6 (CDT) or UTC-5 (CST). Easiest robust check: convert
// the row's UTC `tape_time` into the wall-clock minute-of-day in
// America/Chicago and gate on [510, 899] (08:30 .. 14:59 inclusive).
function isInSessionCT(tapeTimeUtc) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  // Parts: [{type:'hour',value:'8'}, {type:'literal',value:':'}, {type:'minute',value:'30'}]
  const parts = fmt.formatToParts(new Date(tapeTimeUtc));
  const h = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '-1',
    10,
  );
  const m = Number.parseInt(
    parts.find((p) => p.type === 'minute')?.value ?? '-1',
    10,
  );
  if (h < 0 || m < 0) return false;
  // Intl returns "24" for midnight when hour12:false — clamp.
  const hh = h === 24 ? 0 : h;
  const mod = hh * 60 + m;
  return mod >= 510 && mod < 900; // 08:30 .. 14:59
}

// ── Resumability (lookback only): newest stored date per ticker ──

async function getMaxDateByTicker() {
  const map = new Map();
  if (DRY_RUN || selection.mode !== 'lookback') return map;
  const rows = await retryTransientDb(
    () => sql`
      SELECT ticker, MAX(ts)::text AS max_ts
      FROM net_flow_per_ticker_history
      WHERE source = ${NET_FLOW_SOURCE}
      GROUP BY ticker
    `,
  );
  for (const r of rows) map.set(r.ticker, r.max_ts.slice(0, 10));
  return map;
}

// ── Parse + filter ───────────────────────────────────────────

// UW response columns (per OpenAPI line 4956):
//   tape_time (ISO UTC), date, net_call_premium (string), net_call_volume,
//   net_put_premium (string), net_put_volume,
//   call_volume, call_volume_ask_side, call_volume_bid_side,
//   put_volume, put_volume_ask_side, put_volume_bid_side
function parseRow(ticker, raw) {
  return {
    ticker,
    ts: raw.tape_time,
    netCallPrem: Number.parseFloat(raw.net_call_premium ?? '0') || 0,
    netCallVol: raw.net_call_volume ?? 0,
    netPutPrem: Number.parseFloat(raw.net_put_premium ?? '0') || 0,
    netPutVol: raw.net_put_volume ?? 0,
    callVolume: raw.call_volume ?? 0,
    callVolumeAsk: raw.call_volume_ask_side ?? 0,
    callVolumeBid: raw.call_volume_bid_side ?? 0,
    putVolume: raw.put_volume ?? 0,
    putVolumeAsk: raw.put_volume_ask_side ?? 0,
    putVolumeBid: raw.put_volume_bid_side ?? 0,
  };
}

// ── Per ticker-day ──────────────────────────────────────────

const results = [];
const failures = [];
let done = 0;
let planTotal = 0;
const startedAt = Date.now();

function minutes(ms) {
  return `${(ms / 60_000).toFixed(1)} min`;
}

function progress(prefix) {
  const pct = ((done / Math.max(1, planTotal)) * 100).toFixed(1);
  say(
    `${prefix} · ticker-days ${done}/${planTotal} (${pct}%) · ` +
      `elapsed ${minutes(Date.now() - startedAt)}`,
  );
}

async function processPair({ ticker, date }) {
  const outcome = await fetchNetPremTicks(
    UW_API_KEY,
    ticker,
    date,
    waitForSlot,
  );
  if (outcome.kind === 'error') {
    failures.push({
      ticker,
      date,
      status: outcome.status,
      detail: outcome.detail,
    });
    results.push({ date, kind: 'error', fetched: 0, kept: 0, stored: 0 });
  } else if (outcome.kind === 'empty') {
    results.push({ date, kind: 'empty', fetched: 0, kept: 0, stored: 0 });
  } else {
    const kept = outcome.rows
      .filter((r) => isInSessionCT(r.tape_time))
      .map((r) => parseRow(ticker, r));
    const stored = await storeBatch(sql, kept, {
      batchSize: BATCH_SIZE,
      dryRun: DRY_RUN,
    });
    results.push({
      date,
      kind: 'ok',
      fetched: outcome.rows.length,
      kept: kept.length,
      stored,
    });
  }
  done++;
  if (done % HEARTBEAT_EVERY === 0) progress('[progress]');
}

// ── Report ──────────────────────────────────────────────────

const DAY_COLUMNS = [
  'tickers',
  'ok',
  'empty',
  'failed',
  'fetched',
  'kept',
  'stored',
];

function dayLine(label, row) {
  return (
    label.padEnd(12) +
    DAY_COLUMNS.map((k) => String(row[k]).padStart(9)).join('')
  );
}

function windowLine() {
  const { dates } = selection;
  const span = `${dates[0]} → ${dates.at(-1)}`;
  return selection.mode === 'range'
    ? `window: --from ${args.from} --to ${args.to}, ${dates.length} trading days (${span})`
    : `window: last ${dates.length} weekdays (DAYS=${DAYS}), ${span}`;
}

function printReport(plan) {
  const limited =
    plan.pairs.length < plan.planned
      ? ` (--limit; ${plan.planned} planned)`
      : '';
  say();
  say(
    `── net-prem-ticks backfill report (${DRY_RUN ? 'DRY RUN' : 'write'}) ──`,
  );
  say(windowLine());
  say(
    `ticker-days: ${done}/${plan.pairs.length} done${limited} · ` +
      `${plan.skipped} skipped by resume · ${failures.length} failed`,
  );
  say(
    `elapsed: ${minutes(Date.now() - startedAt)} · ` +
      `≤${UW_REQUESTS_PER_MINUTE} UW requests/min · ${CONCURRENCY} lanes`,
  );

  say();
  say(
    `per day (stored = ${DRY_RUN ? 'rows that would be written' : 'new rows'}):`,
  );
  say('date'.padEnd(12) + DAY_COLUMNS.map((h) => h.padStart(9)).join(''));
  const total = Object.fromEntries(DAY_COLUMNS.map((k) => [k, 0]));
  for (const day of summarizeByDay(results)) {
    for (const k of DAY_COLUMNS) total[k] += day[k];
    say(dayLine(day.date, day));
  }
  say(dayLine('total', total));

  say();
  say(`UW failures by status (${failures.length}):`);
  for (const f of summarizeFailures(failures)) {
    const e = f.example;
    say(
      `  ${f.status.padEnd(10)} ${String(f.count).padStart(5)}  e.g. ${e.ticker} ${e.date}: ${e.detail}`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  say(
    'Backfilling /stock/{ticker}/net-prem-ticks → net_flow_per_ticker_history' +
      (DRY_RUN ? ' (DRY RUN: no writes)' : ''),
  );
  say(`  ${windowLine()}`);

  const maxDateByTicker = await getMaxDateByTicker();
  if (maxDateByTicker.size > 0 && !BYPASS_RESUME) {
    say(
      `  resume: ${maxDateByTicker.size} tickers have prior data; ` +
        'skipping their dates before it',
    );
  }
  const plan = planPairs({
    mode: selection.mode,
    dates: selection.dates,
    tickers,
    maxDateByTicker,
    bypassResume: BYPASS_RESUME,
    limit: args.limit,
  });
  planTotal = plan.pairs.length;
  say(
    `  tickers: ${tickers.length} · ticker-days: ${plan.pairs.length} of ` +
      `${plan.planned} planned · concurrency ${CONCURRENCY} · ` +
      `batch ${BATCH_SIZE} · limit ${args.limit ?? 'none'}`,
  );

  // The market-hours guard is re-checked before every ticker-day, so a run
  // started at 08:05 CT stops at 08:15 instead of competing with the crons.
  const stoppedBy = await runTickerDays(
    plan.pairs,
    { concurrency: CONCURRENCY, allowMarketHours: args.allowMarketHours },
    processPair,
  );
  printReport(plan);
  if (stoppedBy != null) {
    console.error(
      `Stopped after ${done}/${plan.pairs.length} ticker-days: ${stoppedBy} ` +
        'Re-run after the close; inserts are ON CONFLICT DO NOTHING.',
    );
    process.exitCode = 3;
    return;
  }

  // Timing probe: scale this run's pace to the whole plan.
  if (args.limit != null && done > 0 && plan.planned > done) {
    const perPair = (Date.now() - startedAt) / done;
    const floorMs = (plan.planned * 60_000) / UW_REQUESTS_PER_MINUTE;
    say();
    say(
      `projection: ${plan.planned} ticker-days in the plan; at this pace a ` +
        `full run takes ≈ ${minutes(perPair * plan.planned)} (the throttle ` +
        `alone needs ≥ ${minutes(floorMs)})`,
    );
  }

  // Failures are worth a re-run: every insert is ON CONFLICT DO NOTHING.
  if (failures.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(redact(`backfill aborted: ${err?.message ?? err}`, secrets));
  console.error(
    redact(
      `progress so far: ${done}/${planTotal} ticker-days; re-run to resume ` +
        '(inserts are ON CONFLICT DO NOTHING)',
      secrets,
    ),
  );
  process.exitCode = 1;
}
