#!/usr/bin/env node

/**
 * Local backfill script for per-strike Greek exposure across ALL expirations.
 * Stores with expiry = '1970-01-01' sentinel to distinguish from 0DTE rows.
 *
 * It applies the rules api/cron/fetch-strike-all.ts applies, for a past date
 * (Task R1 of docs/superpowers/plans/2026-10-23-uw-rest-fixes.md):
 *   1. Spot is the newest row of /stock/SPX/spot-exposures?date=D.
 *   2. The ladder is requested with min_strike/max_strike = spot ± 200,
 *      limit=500, and 0-based page. The walk continues only while a page
 *      holds exactly 500 rows, and fails past 10 pages. Without the window
 *      UW's strike-ordered 500-row page ended well below spot and the stored
 *      ladder missed every strike near it.
 *   3. Strikes outside spot ± 200 are dropped, stored price = spot, and the
 *      snapshot timestamp is the newest row time floored to 5 minutes.
 *   4. It stops on the first error (a UW error, a ladder that is not from
 *      date D, a failed insert). Nothing is half-written for a date: its
 *      insert is one transaction.
 *
 * Only UW's end-of-day board is recoverable for a past date, not the
 * intraday snapshots the cron stores. ON CONFLICT DO NOTHING keeps a re-run
 * idempotent, but it also keeps any row already stored for that bucket, so
 * a day that already holds the wrong ladder needs those rows deleted first.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-strike-all.mjs
 *
 * Options:
 *   node scripts/backfill-strike-all.mjs 5    # last 5 weekdays instead of 30
 *   --from YYYY-MM-DD --to YYYY-MM-DD         # a range of NYSE trading days
 *                                             # (both, inclusive) instead of a lookback
 *   --limit N                                 # only the first N of those days
 *   --dry-run                                 # fetch and check, insert nothing
 *   --allow-market-hours                      # run 08:15-15:30 CT on a weekday
 * Run it after the close: its UW calls skip the shared Redis semaphore and
 * compete with the live crons for the key's concurrency cap.
 */

import { neon } from '@neondatabase/serverless';

import { getETDateStr } from '../src/utils/timezone.ts';
import {
  EXIT_BAD_ARGS,
  marketHoursRefusal,
  parseRangeArgs,
  selectDates,
} from './_lib/backfill-cli.mjs';
import {
  ATM_RANGE,
  PAGE_SIZE,
  fiveMinuteBucket,
  newestRowTime,
  newestSpot,
  strikeWindow,
  walkLadderPages,
} from './_lib/strike-all-backfill.mjs';

// A leading bare number is the old DAYS lookback; everything else is a flag.
const argv = process.argv.slice(2);
const legacyDays =
  argv[0] !== undefined && !argv[0].startsWith('--') ? argv.shift() : undefined;

let args;
let dates;
try {
  args = parseRangeArgs(argv);
  ({ dates } = selectDates(args, Number.parseInt(legacyDays ?? '30', 10)));
  if (args.limit != null) dates = dates.slice(0, args.limit);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(EXIT_BAD_ARGS);
}
const refusal = marketHoursRefusal(args);
if (refusal) {
  console.error(refusal);
  process.exit(EXIT_BAD_ARGS);
}

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const UW_BASE = 'https://api.unusualwhales.com/api';
const UW_USER_AGENT = 'strike-calculator-strike-all-backfill (node)';
const ALL_EXPIRY_SENTINEL = '1970-01-01';

// ── UW GET ──────────────────────────────────────────────────

/** GET a UW path and return its `data` array. Any failure throws. */
async function uwGet(path) {
  const res = await fetch(`${UW_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${UW_API_KEY}`,
      'User-Agent': UW_USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status} for ${path}: ${text.slice(0, 100)}`);
  }
  const body = await res.json();
  if (!Array.isArray(body.data)) {
    throw new Error(`UW API answered ${path} without a data array`);
  }
  return body.data;
}

// ── Fetch the windowed ladder for one date ──────────────────

async function fetchStrikeAll(date) {
  const spotRows = await uwGet(`/stock/SPX/spot-exposures?date=${date}`);
  const spot = newestSpot(spotRows);
  if (spot === null) {
    throw new Error(
      `${date}: no usable SPX spot (${spotRows.length} spot rows), refusing to guess a strike window`,
    );
  }

  const { minStrike, maxStrike } = strikeWindow(spot.price, ATM_RANGE);
  const { rows, pages } = await walkLadderPages((page) => {
    const params = new URLSearchParams({
      date,
      min_strike: String(minStrike),
      max_strike: String(maxStrike),
      limit: String(PAGE_SIZE),
      page: String(page),
    });
    return uwGet(`/stock/SPX/spot-exposures/strike?${params}`);
  });

  return { spot, rows, pages };
}

// ── Store strikes ───────────────────────────────────────────

async function storeStrikes(rows, date, spot, dryRun) {
  const minStrike = spot.price - ATM_RANGE;
  const maxStrike = spot.price + ATM_RANGE;
  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });
  if (filtered.length === 0) return { stored: 0, filtered: 0, strikes: null };

  const snapshotTime = newestRowTime(filtered);
  if (snapshotTime === null) {
    throw new Error(`${date}: no strike row carries a parseable time`);
  }
  // The ladder must be the board of the date asked for. A different ET day
  // is the F5 failure (a previous session's ladder labelled with this date).
  const dataEtDate = getETDateStr(new Date(snapshotTime));
  if (dataEtDate !== date) {
    throw new Error(
      `${date}: UW answered with a ladder from ${dataEtDate} (${snapshotTime}), not storing it`,
    );
  }
  const timestamp = fiveMinuteBucket(snapshotTime);

  const strikeValues = filtered.map((r) => Number.parseFloat(r.strike));
  const strikes = {
    min: Math.min(...strikeValues),
    max: Math.max(...strikeValues),
  };
  if (dryRun) return { stored: 0, filtered: filtered.length, strikes };

  // One transaction per date: all of its strikes land or none do. A failure
  // throws out of main() and stops the run.
  const results = await sql.transaction((txn) =>
    filtered.map(
      (row) => txn`
        INSERT INTO strike_exposures (
          date, timestamp, ticker, expiry, strike, price,
          call_gamma_oi, put_gamma_oi,
          call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
          call_charm_oi, put_charm_oi,
          call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
          call_delta_oi, put_delta_oi,
          call_vanna_oi, put_vanna_oi
        )
        VALUES (
          ${date}, ${timestamp}, 'SPX', ${ALL_EXPIRY_SENTINEL}, ${row.strike}, ${spot.price},
          ${row.call_gamma_oi}, ${row.put_gamma_oi},
          ${row.call_gamma_ask}, ${row.call_gamma_bid},
          ${row.put_gamma_ask}, ${row.put_gamma_bid},
          ${row.call_charm_oi}, ${row.put_charm_oi},
          ${row.call_charm_ask}, ${row.call_charm_bid},
          ${row.put_charm_ask}, ${row.put_charm_bid},
          ${row.call_delta_oi}, ${row.put_delta_oi},
          ${row.call_vanna_oi}, ${row.put_vanna_oi}
        )
        ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
        RETURNING id
      `,
    ),
  );
  const stored = results.filter((r) => r.length > 0).length;

  return { stored, filtered: filtered.length, strikes };
}

// ── Format value for display ────────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n) || n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log(
    `Backfilling SPX All-Expiry Per-Strike Greek Exposure${args.dryRun ? ' (DRY RUN, nothing is inserted)' : ''}`,
  );
  console.log(`Days: ${dates.length} (${dates[0]} to ${dates.at(-1)})\n`);

  let totalStored = 0;

  for (const date of dates) {
    await new Promise((r) => setTimeout(r, 400));

    const { spot, rows, pages } = await fetchStrikeAll(date);
    if (rows.length === 0) {
      console.log(
        `  ${date}: no strike rows (${pages} page), SPX ${spot.price}`,
      );
      continue;
    }
    const result = await storeStrikes(rows, date, spot, args.dryRun);

    totalStored += result.stored;

    // Find peak positive and negative gamma for logging
    let peakGamma = { strike: 0, val: 0 };
    let troughGamma = { strike: 0, val: 0 };

    for (const row of rows) {
      const s = Number.parseFloat(row.strike);
      if (Math.abs(s - spot.price) > ATM_RANGE) continue;
      const netG =
        Number.parseFloat(row.call_gamma_oi) +
        Number.parseFloat(row.put_gamma_oi);
      if (netG > peakGamma.val) peakGamma = { strike: s, val: netG };
      if (netG < troughGamma.val) troughGamma = { strike: s, val: netG };
    }

    const range = result.strikes
      ? `${result.strikes.min}-${result.strikes.max}`
      : 'none';
    const newRows = args.dryRun ? 'dry run' : `${result.stored} new`;
    console.log(
      `  ${date}: ${pages} page(s), ${rows.length} total → ${result.filtered} in ±${ATM_RANGE} (${newRows}) | strikes ${range} | SPX: ${spot.price} | Peak γ: ${peakGamma.strike} (${fmt(peakGamma.val)}) | Trough γ: ${troughGamma.strike} (${fmt(troughGamma.val)})`,
    );
  }

  console.log(`\nDone!`);
  console.log(
    args.dryRun
      ? '  Dry run: nothing was inserted.'
      : `  Total strike rows stored: ${totalStored}`,
  );
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed, stopping at the first error:', err);
  process.exit(1);
}
